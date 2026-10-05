import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeStatus } from '../packages/core/src/health.js';
import { RuntimeStatus } from '../packages/contracts/src/health.js';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';

const now = new Date('2026-10-04T01:00:00Z');
const names = ['worker', 'scheduler', 'knowledge', 'exports', 'devices'];
const healthy = () => names.map((name) => ({ name, heartbeat: now, error: '' }));

describe('runtime diagnostics', () => {
  it('distinguishes not checked, healthy, stale, and failed checks without returning raw errors', () => {
    expect(runtimeStatus([], now).state).toBe('starting');
    expect(runtimeStatus([], now).components.every((item) => item.state === 'unknown')).toBe(true);
    expect(runtimeStatus(healthy(), now).state).toBe('ok');
    const rows = healthy();
    rows[1]!.heartbeat = new Date(now.getTime() - 90_001);
    rows[2]!.error = 'synthetic-secret-that-must-not-leave-server';
    const value = RuntimeStatus.parse(runtimeStatus(rows, now));
    expect(value.state).toBe('degraded');
    expect(value.issueCount).toBe(2);
    expect(value.components[1]!.state).toBe('stale');
    expect(value.components[2]!.state).toBe('error');
    expect(JSON.stringify(value)).not.toContain(rows[2]!.error);
    expect(value.components[2]!.message).toContain('读取权限');
  });
  it('uses a shorter freshness threshold for the Worker and clears recovered errors', () => {
    const rows = healthy().map((row) => ({ ...row, heartbeat: new Date(now.getTime() - 20_001) }));
    expect(runtimeStatus(rows, now).components.map((item) => item.state)).toEqual(['stale', 'ok', 'ok', 'ok', 'ok']);
    expect(runtimeStatus(healthy(), now).issueCount).toBe(0);
  });
});

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('health and scoped API authentication', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, token: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated *_test DB required');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-health-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it('keeps liveness independent of readiness and exposes no database failure details', async () => {
    expect((await built.server.inject('/readyz')).statusCode).toBe(200);
    const query = vi
      .spyOn(built.store.pool, 'query')
      .mockRejectedValueOnce(new Error('synthetic-private-connection-string') as never);
    try {
      const failed = await built.server.inject('/readyz');
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ ok: false });
      expect((await built.server.inject('/healthz')).statusCode).toBe(200);
    } finally {
      query.mockRestore();
    }
    expect((await built.server.inject('/readyz')).json()).toEqual({ ok: true });
  });
  it.each([
    ['GET', '/today/overview'],
    ['POST', '/goals'],
    ['GET', '/sources'],
    ['POST', '/memories'],
    ['GET', '/schedules'],
    ['PATCH', '/settings/model'],
    ['GET', '/devices'],
    ['POST', '/approvals/sample/decision'],
    ['GET', '/events'],
    ['GET', '/status'],
    ['GET', '/auth/session'],
    ['POST', '/auth/logout'],
  ])('requires authentication before %s %s runs or validates its body', async (method, path) => {
    const response = await built.server.inject({ method: method as 'GET', url: '/api/v2' + path });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('shows an actionable background failure even while the Worker is alive, and clears it after recovery', async () => {
    for (const name of names)
      await built.store.exec('INSERT INTO app.health(name,heartbeat,error) VALUES($1,now(),$2)', [
        name,
        name === 'knowledge' ? 'synthetic-private-path' : '',
      ]);
    const headers = { authorization: 'Bearer ' + token };
    const response = await built.server.inject({ url: '/api/v2/status', headers });
    expect(response.statusCode).toBe(200);
    expect(RuntimeStatus.parse(response.json()).issueCount).toBe(1);
    expect(response.body).not.toContain('synthetic-private-path');
    const overview = await built.server.inject({ url: '/api/v2/today/overview', headers });
    expect(overview.json()).toMatchObject({ workerOnline: true, backgroundIssues: 1 });
    await built.store.exec("UPDATE app.health SET error='' WHERE name='knowledge'");
    expect((await built.server.inject({ url: '/api/v2/status', headers })).json().state).toBe('ok');
  });
});
