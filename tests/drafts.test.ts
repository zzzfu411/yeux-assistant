import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('the unsent Today entry follows the owner between devices', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, token: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated test database required');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-drafts-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const call = (method: 'GET' | 'PUT' | 'POST', path: string, payload?: unknown, auth = true) =>
    built.server.inject({
      method,
      url: '/api/v2' + path,
      headers: auth ? { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const content = (text: string) => ({ text, mode: 'goal', locked: true, outcome: '能解释', sourceIds: ['source-1'] });

  it('saves on top of the version a device saw, refuses a stale save, and clears only that version', async () => {
    expect((await call('GET', '/drafts/compose')).json()).toEqual({ content: null, revision: 0, updatedAt: null });
    const phone = await call('PUT', '/drafts/compose', { revision: 0, content: content('手机上写了一半') });
    expect(phone.statusCode).toBe(200);
    expect(phone.json()).toMatchObject({ revision: 1, content: content('手机上写了一半') });
    // The computer still believes nothing was saved; its write must not erase the phone's text.
    const stale = await call('PUT', '/drafts/compose', { revision: 0, content: content('电脑上的旧内容') });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('draft_conflict');
    expect((await call('GET', '/drafts/compose')).json()).toMatchObject({
      revision: 1,
      content: { text: '手机上写了一半' },
    });
    const computer = await call('PUT', '/drafts/compose', { revision: 1, content: content('在电脑上接着写完') });
    expect(computer.json().revision).toBe(2);
    expect(
      (await built.store.rows("SELECT data FROM app.events WHERE kind='draft.updated' ORDER BY id")).map(
        (row) => row.data,
      ),
    ).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect((await call('POST', '/drafts/compose/clear', { revision: 1 })).json()).toEqual({ cleared: false });
    expect((await call('POST', '/drafts/compose/clear', { revision: 2 })).json()).toEqual({ cleared: true });
    expect((await call('GET', '/drafts/compose')).json().content).toBeNull();
  });
  it('validates the draft and requires a signed-in caller', async () => {
    expect(
      (await call('PUT', '/drafts/compose', { revision: 0, content: { ...content('x'), mode: 'shell' } })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/drafts/compose', { revision: 0, content: { ...content('x'), extra: 1 } })).statusCode,
    ).toBe(400);
    expect((await call('GET', '/drafts/compose', undefined, false)).statusCode).toBe(401);
  });
});
