import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { DeviceActions, DEVICE_QUEUE } from '../packages/core/src/devices/service.js';
import { DeviceNotApplied, SimulatedLamp, type DeviceAdapter } from '../packages/core/src/devices/adapters.js';
import { digest } from '../packages/core/src/common.js';
import { setTimeout as delay } from 'node:timers/promises';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('device commands on real isolated PostgreSQL', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, token: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated *_test database required');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-devices-test-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
  });
  beforeEach(async () => {
    await built.store.exec('DELETE FROM app.device_commands');
    await built.store.exec('DELETE FROM app.device_simulation_state');
    await built.store.exec('DELETE FROM app.devices');
    await built.store.exec('UPDATE app.device_control SET enabled=true,revision=revision+1');
    await built.store.exec("DELETE FROM queue.job WHERE name='device-execute'");
    await built.store.exec("DELETE FROM app.health WHERE name='worker'");
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  async function call(method: string, path: string, payload?: unknown, key = randomUUID()) {
    const response = await built.server.inject({
      method: method as any,
      url: '/api/v2' + path,
      headers: { authorization: 'Bearer ' + token, 'idempotency-key': key },
      payload,
    });
    return { status: response.statusCode, body: response.json() };
  }
  async function device() {
    const result = await call('POST', '/devices/simulated', { name: '测试台灯' });
    expect(result.status).toBe(200);
    return result.body.deviceId as string;
  }
  async function pending(deviceId: string, power = true) {
    const result = await call('POST', '/devices/' + deviceId + '/commands', {
      revision: 1,
      capability: 'power.set',
      arguments: { power },
    });
    expect(result.status).toBe(200);
    return result.body;
  }
  async function approved(deviceId: string, power = true) {
    const command = await pending(deviceId, power);
    const result = await call('POST', '/device-commands/' + command.id + '/decision', {
      revision: command.revision,
      digest: command.digest,
      approve: true,
    });
    expect(result.status).toBe(200);
    return result.body;
  }
  const record = (id: string) => built.store.one('SELECT * FROM app.device_commands WHERE id=$1', [id]);
  function adapted(overrides: Partial<DeviceAdapter>, timeoutMs = 2000) {
    const base = new SimulatedLamp(built.store);
    const adapter: DeviceAdapter = {
      id: base.id,
      version: base.version,
      mode: base.mode,
      capabilities: base.capabilities,
      execute: (...args) => base.execute(...args),
      readState: (...args) => base.readState(...args),
      ...overrides,
    };
    return new DeviceActions(built.store, built.boss, { adapters: new Map([[adapter.id, adapter]]), timeoutMs });
  }
  async function until(check: () => Promise<boolean>, milliseconds = 1200) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error('Device condition did not become observable');
  }
  it('reports Worker availability and server time from the database clock', async () => {
    const before = new Date((await built.store.one('SELECT now() AS time'))!.time).getTime();
    const offline = await built.devices.list();
    expect(offline.workerOnline).toBe(false);
    await built.store.exec(
      "INSERT INTO app.health(name,heartbeat,error) VALUES('worker',now()-interval '10 seconds','')",
    );
    const online = await built.devices.list();
    expect(online.workerOnline).toBe(true);
    const after = new Date((await built.store.one('SELECT now() AS time'))!.time).getTime();
    expect(Date.parse(online.serverTime)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(online.serverTime)).toBeLessThanOrEqual(after);
    await built.store.exec("UPDATE app.health SET heartbeat=now()-interval '21 seconds' WHERE name='worker'");
    expect((await built.devices.list()).workerOnline).toBe(false);
  });
  it('reads a single retained command even after it leaves the recent-history window', async () => {
    const did = await device(),
      old = await pending(did);
    await call('POST', '/device-commands/' + old.id + '/decision', {
      revision: old.revision,
      digest: old.digest,
      approve: false,
    });
    await built.store.exec(
      "INSERT INTO app.device_commands(id,device_id,payload,digest,summary,expires_at,state,created_at) SELECT gen_random_uuid()::text,device_id,payload,digest,summary,expires_at,'cancelled',created_at+n*interval '1 millisecond' FROM app.device_commands CROSS JOIN generate_series(1,55) n WHERE id=$1",
      [old.id],
    );
    expect((await built.devices.history()).find((row) => row.id === old.id)).toBeUndefined();
    expect(await built.devices.getCommand(old.id)).toMatchObject({ id: old.id, state: 'rejected' });
    await expect(built.devices.getCommand(randomUUID())).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
  it('migrates repeatedly without data loss and enforces one unresolved command per device', async () => {
    const did = await device(),
      command = await pending(did);
    await built.store.migrate();
    expect((await record(command.id))!.state).toBe('pending');
    await expect(
      built.store.exec(
        'INSERT INTO app.device_commands(id,device_id,payload,digest,summary,expires_at) SELECT $1,device_id,payload,digest,summary,expires_at FROM app.device_commands WHERE id=$2',
        [randomUUID(), command.id],
      ),
    ).rejects.toThrow();
    expect(
      (
        await call('POST', '/devices/' + did + '/commands', {
          revision: 1,
          capability: 'power.set',
          arguments: { power: false },
        })
      ).status,
    ).toBe(409);
  });
  it('authenticates APIs and rejects undeclared abilities, extra parameters and stale versions', async () => {
    expect((await built.server.inject({ url: '/api/v2/devices' })).statusCode).toBe(401);
    const did = await device();
    for (const body of [
      { revision: 1, capability: 'shell.run', arguments: { command: 'echo unsafe' } },
      { revision: 1, capability: 'power.set', arguments: { power: true, url: 'http://elsewhere' } },
    ])
      expect((await call('POST', '/devices/' + did + '/commands', body)).status).toBe(400);
    expect(
      (
        await call('POST', '/devices/' + did + '/commands', {
          revision: 99,
          capability: 'power.set',
          arguments: { power: true },
        })
      ).status,
    ).toBe(409);
    expect(await built.devices.history()).toEqual([]);
  });
  it('does not execute previews or rejected commands', async () => {
    const did = await device(),
      command = await pending(did);
    await built.devices.process(command.id);
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
    expect(
      (
        await call('POST', '/device-commands/' + command.id + '/decision', {
          revision: 1,
          digest: command.digest,
          approve: false,
        })
      ).body.state,
    ).toBe('rejected');
    await built.devices.process(command.id);
    expect((await record(command.id))!.state).toBe('rejected');
  });
  it('binds approval to the exact snapshot and commits one approval/job under concurrent retries', async () => {
    const did = await device(),
      command = await pending(did),
      path = '/device-commands/' + command.id + '/decision';
    expect((await call('POST', path, { revision: 1, digest: '0'.repeat(64), approve: true })).status).toBe(409);
    const input = { revision: 1, digest: command.digest, approve: true },
      key = randomUUID();
    const [a, b] = await Promise.all([call('POST', path, input, key), call('POST', path, input, key)]);
    expect(a.body).toEqual(b.body);
    expect(a.body.state).toBe('approved');
    expect(
      (await built.store.one("SELECT count(*) n FROM queue.job WHERE name=$1 AND data->>'commandId'=$2", [
        DEVICE_QUEUE,
        command.id,
      ]))!.n,
    ).toBe('1');
    expect((await call('POST', path, { ...input, approve: false }, key)).status).toBe(409);
  });
  it('verifies independent state and ignores duplicate queue deliveries', async () => {
    const did = await device(),
      command = await approved(did),
      base = new SimulatedLamp(built.store);
    let calls = 0,
      reads = 0;
    const service = adapted({
      execute: async (...args) => {
        calls++;
        await base.execute(...args);
      },
      readState: async (...args) => {
        reads++;
        return base.readState(...args);
      },
    });
    await Promise.all([service.process(command.id), service.process(command.id)]);
    await service.process(command.id);
    const row = (await record(command.id))!;
    expect(calls).toBe(1);
    expect(reads).toBe(2);
    expect(row.state).toBe('succeeded');
    expect(row.receipt).toMatchObject({
      source: 'simulation',
      before: { power: false },
      after: { power: true },
      outcome: 'verified',
    });
    expect((await service.list()).devices[0]!.observedState).toEqual({ power: true });
  });
  it('expires stale previews before approval and stale jobs before dispatch', async () => {
    const did = await device(),
      command = await pending(did);
    await built.store.exec("UPDATE app.device_commands SET expires_at=now()-interval '1 second' WHERE id=$1", [
      command.id,
    ]);
    expect(
      (
        await call('POST', '/device-commands/' + command.id + '/decision', {
          revision: 1,
          digest: command.digest,
          approve: true,
        })
      ).body.state,
    ).toBe('expired');
    const next = await approved(did);
    await built.store.exec("UPDATE app.device_commands SET expires_at=now()-interval '1 second' WHERE id=$1", [
      next.id,
    ]);
    await built.devices.process(next.id);
    expect((await record(next.id))!.state).toBe('expired');
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
  });
  it.each(['decide', 'claim'] as const)(
    'expires an approval whose %s transaction waits past its deadline',
    async (stage) => {
      const did = await device(),
        command = stage === 'decide' ? await pending(did) : await approved(did);
      const blocker = await built.store.pool.connect(),
        base = new SimulatedLamp(built.store);
      let calls = 0,
        completion: Promise<unknown> | undefined;
      const service = adapted({
        execute: async (...args) => {
          calls++;
          await base.execute(...args);
        },
      });
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT singleton FROM app.device_control WHERE singleton=true FOR UPDATE');
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const deadline = (await built.store.one(
          "UPDATE app.device_commands SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1 RETURNING expires_at",
          [command.id],
        ))!.expires_at;
        completion =
          stage === 'decide'
            ? call('POST', '/device-commands/' + command.id + '/decision', {
                revision: command.revision,
                digest: command.digest,
                approve: true,
              })
            : service.process(command.id);
        await until(async () =>
          Boolean(
            await built.store.one('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [
              blockerPid,
            ]),
          ),
        );
        const waiting = await built.store.one(
          'SELECT xact_start<$2::timestamptz AS started_before_deadline FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',
          [blockerPid, deadline],
        );
        expect(waiting?.started_before_deadline).toBe(true);
        await until(
          async () =>
            Boolean(
              (await built.store.one('SELECT clock_timestamp()>$1::timestamptz AS expired', [deadline]))!.expired,
            ),
          2000,
        );
        await blocker.query('ROLLBACK');
        await completion;
        expect(await record(command.id)).toMatchObject({ state: 'expired', execution_token: null, started_at: null });
        expect(calls).toBe(0);
        expect(
          (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
        ).toBe(false);
        if (stage === 'decide')
          expect(
            (await built.store.one("SELECT count(*) n FROM queue.job WHERE name=$1 AND data->>'commandId'=$2", [
              DEVICE_QUEUE,
              command.id,
            ]))!.n,
          ).toBe('0');
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await completion;
      }
    },
  );
  it('cancel and per-device disable invalidate queued actions without replay on re-enable', async () => {
    const did = await device(),
      first = await approved(did);
    expect(
      (await call('POST', '/device-commands/' + first.id + '/cancel', { revision: first.revision })).body.state,
    ).toBe('cancelled');
    await built.devices.process(first.id);
    const second = await approved(did);
    expect((await call('PATCH', '/devices/' + did, { revision: 1, enabled: false })).status).toBe(200);
    await built.devices.process(second.id);
    expect((await record(second.id))!.state).toBe('cancelled');
    expect((await call('PATCH', '/devices/' + did, { revision: 2, enabled: true })).status).toBe(200);
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
    expect(
      (
        await call('POST', '/devices/' + did + '/commands', {
          revision: 1,
          capability: 'power.set',
          arguments: { power: true },
        })
      ).status,
    ).toBe(409);
  });
  it('global pause stops all queued actions and resuming does not revive them', async () => {
    const did = await device(),
      command = await approved(did),
      control = (await built.devices.list()).control;
    const paused = await call('PATCH', '/device-control', { revision: control.revision, enabled: false });
    expect(paused.body.enabled).toBe(false);
    await built.devices.process(command.id);
    expect((await record(command.id))!.state).toBe('cancelled');
    expect(
      (
        await call('POST', '/devices/' + did + '/commands', {
          revision: 1,
          capability: 'power.set',
          arguments: { power: true },
        })
      ).status,
    ).toBe(409);
    await call('PATCH', '/device-control', { revision: paused.body.revision, enabled: true });
    await built.devices.process(command.id);
    expect((await record(command.id))!.state).toBe('cancelled');
  });
  it('does not treat an accepted write or a mismatched readback as success', async () => {
    const did = await device(),
      command = await approved(did);
    let calls = 0;
    const service = adapted({
      execute: async () => {
        calls++;
      },
    });
    await service.process(command.id);
    expect((await record(command.id))!.state).toBe('uncertain');
    expect((await record(command.id))!.receipt).toBe(null);
    await service.process(command.id);
    expect(calls).toBe(1);
    expect(
      (
        await call('POST', '/devices/' + did + '/commands', {
          revision: 1,
          capability: 'power.set',
          arguments: { power: false },
        })
      ).status,
    ).toBe(409);
  });
  it('distinguishes proven pre-write failures from failures after the device changed', async () => {
    const did = await device(),
      first = await approved(did);
    await adapted({
      execute: async () => {
        throw new DeviceNotApplied('private adapter details');
      },
    }).process(first.id);
    expect((await record(first.id))!.state).toBe('failed');
    expect((await record(first.id))!.error).not.toContain('private');
    const second = await approved(did),
      base = new SimulatedLamp(built.store);
    let reads = 0;
    await adapted({
      readState: async (...args) => {
        if (++reads === 2) throw new DeviceNotApplied('reading failed after write');
        return base.readState(...args);
      },
    }).process(second.id);
    expect((await record(second.id))!.state).toBe('uncertain');
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(true);
    expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
    const current = (await record(second.id))!;
    await built.devices.resolve(randomUUID(), second.id, {
      revision: current.revision,
      outcome: 'executed',
      note: '合成测试确认灯已经开启。',
    });
    expect((await built.devices.getCommand(second.id)).receipt?.source).toBe('user_report');
    expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
  });
  it('bounds execution time and leaves uncertain writes for manual verification', async () => {
    const did = await device(),
      command = await approved(did);
    const service = adapted(
      {
        execute: async (_id, _name, _input, ctx) => {
          await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
        },
      },
      40,
    );
    await service.process(command.id);
    expect((await record(command.id))!.state).toBe('uncertain');
    const current = (await record(command.id))!;
    expect(
      (
        await call('POST', '/device-commands/' + command.id + '/resolve', {
          revision: current.revision,
          outcome: 'not_executed',
          note: '检查演示灯仍为关闭。',
        })
      ).body,
    ).toMatchObject({ state: 'resolved', receipt: { source: 'user_report', outcome: 'not_executed' } });
  });
  it('cancel during execution keeps late results from replacing the uncertain record', async () => {
    const did = await device(),
      command = await approved(did);
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>((r) => (entered = r)),
      waiting = new Promise<void>((r) => (release = r));
    const service = adapted({
      execute: async () => {
        entered();
        await waiting;
      },
    });
    const processing = service.process(command.id);
    await began;
    const current = (await record(command.id))!;
    expect(
      (await call('POST', '/device-commands/' + command.id + '/cancel', { revision: current.revision })).body.state,
    ).toBe('uncertain');
    release();
    await processing;
    expect((await record(command.id))!.state).toBe('uncertain');
    expect((await record(command.id))!.receipt).toBe(null);
  });
  it.each(['cancel', 'pause', 'disable'] as const)(
    'keeps a real applied write uncertain when %s precedes its late successful readback',
    async (cause) => {
      const did = await device(),
        command = await approved(did),
        base = new SimulatedLamp(built.store);
      let release!: () => void,
        readPending = false,
        reads = 0,
        returnedState: unknown,
        settled = false;
      const waiting = new Promise<void>((resolve) => (release = resolve));
      const service = adapted({
        readState: async (...args) => {
          const state = await base.readState(...args);
          if (++reads === 2) {
            readPending = true;
            await waiting;
            returnedState = state;
          }
          return state;
        },
      });
      const processing = service.process(command.id).finally(() => {
        settled = true;
      });
      try {
        await until(async () => readPending);
        // Unlike a no-op fake, the registered simulator has committed the requested physical analogue.
        expect(
          (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
        ).toBe(true);
        if (cause === 'cancel') {
          const current = (await record(command.id))!;
          expect(
            (await call('POST', '/device-commands/' + command.id + '/cancel', { revision: current.revision })).status,
          ).toBe(200);
        } else if (cause === 'pause') {
          const control = (await built.devices.list()).control;
          expect((await call('PATCH', '/device-control', { revision: control.revision, enabled: false })).status).toBe(
            200,
          );
        } else expect((await call('PATCH', '/devices/' + did, { revision: 1, enabled: false })).status).toBe(200);
        const current = (await record(command.id))!;
        expect(current).toMatchObject({ state: 'uncertain', receipt: null });
        expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
        const input = {
          revision: current.revision,
          outcome: 'executed',
          note: '核实模拟状态为开启，保留已执行的事实。',
        };
        const denied = await call('POST', '/device-commands/' + command.id + '/resolve', input);
        expect(denied.status).toBe(409);
        expect(denied.body.error.code).toBe('device_execution_active');
        expect(settled).toBe(false);
        release();
        await processing;
        expect(returnedState).toEqual({ power: true });
        expect(await record(command.id)).toMatchObject({ state: 'uncertain', receipt: null });
        expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
        const resolved = await call('POST', '/device-commands/' + command.id + '/resolve', input);
        expect(resolved.body).toMatchObject({
          state: 'resolved',
          receipt: { source: 'user_report', outcome: 'executed', note: input.note },
        });
        const preserved = await record(command.id);
        await service.process(command.id);
        await built.devices.sweep();
        expect(await record(command.id)).toEqual(preserved);
        expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
      } finally {
        release();
        await processing;
      }
    },
  );
  it.each(['cancel', 'timeout'] as const)(
    'retains the execution lock through a real SQL wait after %s',
    async (cause) => {
      const did = await device(),
        command = await approved(did),
        blocker = await built.store.pool.connect();
      let processing: Promise<void> | undefined,
        settled = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT device_id FROM app.device_simulation_state WHERE device_id=$1 FOR UPDATE', [did]);
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const service = cause === 'timeout' ? adapted({}, 250) : built.devices;
        processing = service.process(command.id).finally(() => {
          settled = true;
        });
        await until(async () =>
          Boolean(
            await built.store.one('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [
              blockerPid,
            ]),
          ),
        );
        expect((await built.devices.list()).devices[0]).toMatchObject({ observedState: null, observedAt: null });
        if (cause === 'cancel') {
          const current = (await record(command.id))!;
          expect(
            (await call('POST', '/device-commands/' + command.id + '/cancel', { revision: current.revision })).body
              .state,
          ).toBe('uncertain');
          // Let the cancellation poll run; it must not release the slot while PostgreSQL is still waiting.
          await delay(150);
        } else await until(async () => (await record(command.id))!.state === 'uncertain');
        expect(settled).toBe(false);
        const current = (await record(command.id))!;
        const input = { revision: current.revision, outcome: 'not_executed', note: '锁等待期间尚未执行。' };
        const denied = await call('POST', '/device-commands/' + command.id + '/resolve', input);
        expect(denied.status).toBe(409);
        expect(denied.body.error.code).toBe('device_execution_active');
        expect(
          (
            await call('POST', '/devices/' + did + '/commands', {
              revision: 1,
              capability: 'power.set',
              arguments: { power: false },
            })
          ).status,
        ).toBe(409);
        await blocker.query('ROLLBACK');
        await processing;
        expect(
          (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
        ).toBe(false);
        expect((await record(command.id))!.state).toBe('uncertain');
        expect((await call('POST', '/device-commands/' + command.id + '/resolve', input)).body.state).toBe('resolved');
        const next = await approved(did);
        await built.devices.process(next.id);
        expect((await record(next.id))!.state).toBe('succeeded');
        expect(
          (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
        ).toBe(true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await processing;
      }
    },
  );
  it('bounds a blocked simulator transaction without changing its target', async () => {
    const did = await device(),
      command = await approved(did),
      blocker = await built.store.pool.connect();
    let processing: Promise<void> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT device_id FROM app.device_simulation_state WHERE device_id=$1 FOR UPDATE', [did]);
      processing = built.devices.process(command.id);
      await processing;
      expect((await record(command.id))!.state).toBe('failed');
      expect(
        (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
      ).toBe(false);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await processing;
    }
  });
  it('recovers interrupted dispatch and lost terminal receipts without replay', async () => {
    const did = await device(),
      command = await approved(did);
    await built.store.exec(
      "UPDATE app.device_commands SET state='executing',execution_token=$2,execution_deadline=now()-interval '10 seconds' WHERE id=$1",
      [command.id, randomUUID()],
    );
    await built.devices.recover();
    expect((await record(command.id))!.state).toBe('uncertain');
    await built.devices.process(command.id);
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
    const current = (await record(command.id))!;
    await built.devices.resolve(randomUUID(), command.id, {
      revision: current.revision,
      outcome: 'not_executed',
      note: '合成中断测试，确认没有执行。',
    });
    const next = await approved(did);
    await built.store.exec(
      "UPDATE app.device_commands SET state='executing',execution_token=$2,execution_deadline=now()-interval '10 seconds' WHERE id=$1",
      [next.id, randomUUID()],
    );
    await built.devices.sweep();
    expect((await record(next.id))!.state).toBe('uncertain');
  });
  it('keeps old unresolved commands visible beyond the recent-history limit', async () => {
    const did = await device(),
      command = await pending(did);
    await built.store.exec(
      "INSERT INTO app.device_commands(id,device_id,payload,digest,summary,expires_at,state,created_at) SELECT gen_random_uuid()::text,device_id,payload,digest,summary,expires_at,'cancelled',created_at+n*interval '1 millisecond' FROM app.device_commands CROSS JOIN generate_series(1,55) n WHERE id=$1",
      [command.id],
    );
    const history = await built.devices.history();
    expect(history).toHaveLength(51);
    expect(history[0]!.id).toBe(command.id);
    expect(history.filter((row) => row.state === 'cancelled')).toHaveLength(50);
  });
  it('finishes an unavailable adapter before dispatch without retrying it', async () => {
    const did = await device(),
      command = await approved(did),
      service = new DeviceActions(built.store, built.boss, { adapters: new Map() });
    await service.process(command.id);
    expect((await record(command.id))!.state).toBe('failed');
    await service.sweep();
    await service.process(command.id);
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
  });
  it('binds adapter and capability versions at preview, approval and dispatch', async () => {
    const did = await device(),
      first = await pending(did),
      base = new SimulatedLamp(built.store);
    let calls = 0;
    expect((await record(first.id))!.payload).toMatchObject({
      adapterVersion: base.version,
      capabilityVersion: base.capabilities[0]!.version,
    });
    const changedAdapter = adapted({
      version: 'next',
      execute: async () => {
        calls++;
      },
    });
    const result = await changedAdapter.decide(randomUUID(), first.id, {
      revision: first.revision,
      digest: first.digest,
      approve: true,
    });
    expect(result).toMatchObject({ state: 'cancelled', error: expect.stringContaining('版本') });
    const second = await approved(did);
    const changedCapability = adapted({
      capabilities: base.capabilities.map((item) => ({ ...item, version: 'next' })),
      execute: async () => {
        calls++;
      },
    });
    await changedCapability.process(second.id);
    expect((await record(second.id))!.state).toBe('cancelled');
    expect(calls).toBe(0);
    expect(
      (await built.store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [did]))!.power,
    ).toBe(false);
  });
  it('cancels unversioned legacy approvals while preserving ended history', async () => {
    const pendingId = await device(),
      approvedId = await device(),
      endedId = await device();
    const preview = await pending(pendingId),
      queued = await approved(approvedId),
      ended = await pending(endedId);
    await call('POST', '/device-commands/' + ended.id + '/decision', {
      revision: ended.revision,
      digest: ended.digest,
      approve: false,
    });
    for (const command of [preview, queued, ended]) {
      const payload = { ...(await record(command.id))!.payload };
      delete payload.adapterVersion;
      delete payload.capabilityVersion;
      await built.store.exec('UPDATE app.device_commands SET payload=$2,digest=$3 WHERE id=$1', [
        command.id,
        JSON.stringify(payload),
        digest(payload),
      ]);
    }
    const preserved = await record(ended.id),
      legacyPreview = (await record(preview.id))!;
    expect(
      (
        await built.devices.decide(randomUUID(), preview.id, {
          revision: legacyPreview.revision,
          digest: legacyPreview.digest,
          approve: true,
        })
      ).state,
    ).toBe('cancelled');
    await built.devices.sweep();
    await built.devices.process(queued.id);
    expect((await record(queued.id))!.state).toBe('cancelled');
    expect((await record(queued.id))!.error).toContain('版本');
    expect(await record(ended.id)).toEqual(preserved);
    expect((await built.devices.getCommand(ended.id)).state).toBe('rejected');
    expect(
      (await built.store.rows('SELECT power FROM app.device_simulation_state')).every((row) => row.power === false),
    ).toBe(true);
  });
  it('rejects changed capability snapshots immediately before dispatch', async () => {
    const did = await device(),
      command = await approved(did),
      row = (await record(command.id))!;
    const tampered = { ...row.payload, arguments: { power: false } };
    expect(digest(tampered)).not.toBe(command.digest);
    await built.store.exec('UPDATE app.device_commands SET payload=$2 WHERE id=$1', [
      command.id,
      JSON.stringify(tampered),
    ]);
    await built.devices.process(command.id);
    expect((await record(command.id))!.state).toBe('cancelled');
  });
});
