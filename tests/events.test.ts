import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { event } from '../packages/core/src/common.js';
import { setAdministrator } from '../packages/core/src/auth.js';
import { RunEvent } from '../packages/contracts/src/index.js';

async function bounded<T>(work: Promise<T>, milliseconds = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE test timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class Stream {
  buffer = '';
  readonly decoder = new TextDecoder();
  constructor(
    readonly controller: AbortController,
    readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}
  async frame(): Promise<string | null> {
    while (true) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        return frame;
      }
      const result = await bounded(this.reader.read());
      if (result.done) return null;
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }
  async next() {
    while (true) {
      const frame = await this.frame();
      if (frame === null) return null;
      const line = frame.split('\n').find((line) => line.startsWith('data: '));
      if (line) return RunEvent.parse(JSON.parse(line.slice(6)));
    }
  }
  async close() {
    this.controller.abort();
    await this.reader.cancel().catch(() => {});
  }
}

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('committed event cursors and real HTTP SSE connections', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, token: string, address: string;
  const streams: Stream[] = [];
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated test database required');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-events-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
    address = await built.server.listen({ host: '127.0.0.1', port: 0 });
  });
  beforeEach(async () => {
    await built.store.exec('TRUNCATE app.events RESTART IDENTITY');
    await built.store.exec('UPDATE app.event_stream SET cursor=0');
  });
  afterEach(async () => {
    await Promise.all(streams.splice(0).map((stream) => stream.close()));
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const publish = (kind: string) => built.store.transaction((tx) => event(tx, kind, null));
  async function open(after = '0', cookie?: string) {
    const controller = new AbortController();
    try {
      const response = await bounded(
        fetch(address + '/api/v2/events?after=' + after, {
          headers: cookie ? { cookie } : { authorization: 'Bearer ' + token },
          signal: controller.signal,
        }),
        2000,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const stream = new Stream(controller, response.body!.getReader());
      streams.push(stream);
      return stream;
    } catch (error) {
      controller.abort();
      throw error;
    }
  }
  it('flushes a connection frame immediately even when there are no events', async () => {
    const stream = await open();
    expect(await bounded(stream.frame(), 1500)).toBe(': connected');
    await publish('fixture.ready');
    expect((await stream.next())?.kind).toBe('fixture.ready');
  });
  it('wakes the stream as soon as an event commits instead of waiting for a poll', async () => {
    expect(built.wake.healthy).toBe(true);
    const stream = await open();
    expect(await bounded(stream.frame(), 1500)).toBe(': connected');
    for (const kind of ['fixture.wake-1', 'fixture.wake-2', 'fixture.wake-3']) {
      const started = Date.now();
      await publish(kind);
      expect((await bounded(stream.next(), 900))?.kind).toBe(kind);
      // The safety-net poll runs every ten seconds while listening works; this came from the notification.
      expect(Date.now() - started).toBeLessThan(900);
    }
  });
  it('falls back to polling every second while the listener is down', async () => {
    const stream = await open();
    expect(await bounded(stream.frame(), 1500)).toBe(': connected');
    built.wake.healthy = false;
    try {
      await built.store.exec("INSERT INTO app.events(kind) VALUES('fixture.unannounced')");
      expect((await bounded(stream.next(), 2500))?.kind).toBe('fixture.unannounced');
    } finally {
      built.wake.healthy = true;
    }
  });
  it('delivers a late commit after an earlier allocation without losing it behind the cursor', async () => {
    const early = await built.store.pool.connect();
    try {
      await early.query('BEGIN');
      await early.query("INSERT INTO app.events(kind) VALUES('fixture.late-commit')");
      // As event() does: the wake-up is delivered only when this transaction commits.
      await early.query("SELECT pg_notify('app_events','')");
      await publish('fixture.first-commit');
      const stream = await open(),
        first = await stream.next();
      expect(first).toMatchObject({ id: '1', kind: 'fixture.first-commit' });
      await early.query('COMMIT');
      const second = await stream.next();
      expect(second).toMatchObject({ id: '2', kind: 'fixture.late-commit' });
      expect(await built.store.rows('SELECT id,stream_id FROM app.events ORDER BY stream_id')).toEqual([
        { id: '2', stream_id: '1' },
        { id: '1', stream_id: '2' },
      ]);
    } finally {
      await early.query('ROLLBACK').catch(() => {});
      early.release();
    }
  });
  it('serializes concurrent publishers and delivers more than one page to two real clients', async () => {
    await built.store.exec(
      "INSERT INTO app.events(kind,data) SELECT 'fixture.batch',jsonb_build_object('number',n) FROM generate_series(1,205) n",
    );
    const results = await Promise.all([built.app.events('0'), built.app.events('0')]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toHaveLength(100);
    const [left, right] = await Promise.all([open(), open()]);
    const collect = async (stream: Stream) => {
      const events = [];
      for (let i = 0; i < 205; i++) events.push(await stream.next());
      return events;
    };
    const [a, b] = await Promise.all([collect(left), collect(right)]);
    expect(a).toEqual(b);
    expect(a.map((item) => item?.id)).toEqual(Array.from({ length: 205 }, (_, i) => String(i + 1)));
    expect(a.map((item) => item?.data.number)).toEqual(Array.from({ length: 205 }, (_, i) => i + 1));
    expect((await built.store.one('SELECT cursor FROM app.event_stream'))!.cursor).toBe('205');
  });
  it('resumes a disconnected client only after its last delivered cursor', async () => {
    await publish('fixture.before');
    const first = await open(),
      saved = await first.next();
    await first.close();
    await publish('fixture.offline-one');
    await publish('fixture.offline-two');
    const resumed = await open(saved!.id);
    expect((await resumed.next())?.kind).toBe('fixture.offline-one');
    expect((await resumed.next())?.kind).toBe('fixture.offline-two');
    expect(await built.app.events('3')).toEqual([]);
  });
  it('resets a restored database cursor without inserting a synthetic business event', async () => {
    const stream = await open('900');
    expect(await stream.next()).toMatchObject({ id: '0', kind: 'stream.reset' });
    expect((await built.store.one('SELECT count(*) n FROM app.events'))!.n).toBe('0');
    await publish('fixture.after-restore');
    expect(await stream.next()).toMatchObject({ id: '1', kind: 'fixture.after-restore' });
  });
  it('rejects unauthenticated and unrepresentable cursors before opening a stream', async () => {
    expect((await fetch(address + '/api/v2/events')).status).toBe(401);
    for (const after of ['9223372036854775808', '99999999999999999999', '-1', 'wrong']) {
      const response = await fetch(address + '/api/v2/events?after=' + after, {
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.status).toBe(400);
      await response.body?.cancel();
    }
  });
  it('closes an already open cookie stream when the administrator logs out', async () => {
    const credentials = { username: 'event-fixture', password: 'Synthetic-SSE-password!' };
    await setAdministrator(folder, credentials.username, credentials.password);
    const login = await fetch(address + '/api/v2/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    expect(login.status).toBe(200);
    await login.arrayBuffer();
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const stream = await open('0', cookie);
    expect(await stream.frame()).toBe(': connected');
    const logout = await fetch(address + '/api/v2/auth/logout', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(logout.status).toBe(200);
    await logout.arrayBuffer();
    expect(await stream.next()).toBeNull();
    expect((await fetch(address + '/api/v2/events', { headers: { cookie } })).status).toBe(401);
  });
  it('keeps existing cursors across the stream migration, including rolled-back identity gaps', async () => {
    await built.store.exec('DROP TABLE app.event_stream');
    await built.store.exec('ALTER TABLE app.events DROP COLUMN stream_id');
    await built.store.exec('DELETE FROM app.migrations WHERE version=6');
    await publish('fixture.old-one');
    await expect(
      built.store.transaction(async (tx) => {
        await event(tx, 'fixture.rolled-back', null);
        throw new Error('rollback fixture');
      }),
    ).rejects.toThrow('rollback fixture');
    await publish('fixture.old-three');
    await built.store.migrate();
    expect((await built.app.events('1')).map((item) => ({ id: item.id, kind: item.kind }))).toEqual([
      { id: '3', kind: 'fixture.old-three' },
    ]);
    await publish('fixture.new');
    expect((await built.app.events('3')).map((item) => ({ id: item.id, kind: item.kind }))).toEqual([
      { id: '4', kind: 'fixture.new' },
    ]);
  });
});
