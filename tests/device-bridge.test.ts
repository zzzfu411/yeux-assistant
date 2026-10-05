import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { setAdministrator } from '../packages/core/src/auth.js';
import { DeviceActions } from '../packages/core/src/devices/service.js';
import { digest } from '../packages/core/src/common.js';
import { runDeviceBridge } from '../apps/device-bridge/src/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('outbound device bridge on isolated PostgreSQL (synthetic hardware)', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, cookie: string, address: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
    const store = new Store(url); await store.exec('DROP SCHEMA IF EXISTS queue CASCADE'); await store.exec('DROP SCHEMA IF EXISTS app CASCADE'); await store.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-bridge-')); built = await buildServer({ url, folder, assets: false });
    await setAdministrator(folder, 'fixture-owner', 'Synthetic-only-password');
    const login = await built.server.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { username: 'fixture-owner', password: 'Synthetic-only-password' } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    address = await built.server.listen({ host: '127.0.0.1', port: 0 });
  });
  beforeEach(async () => {
    await built.store.exec('TRUNCATE app.device_bridge_calls,app.device_bridges,app.device_commands,app.device_simulation_state,app.devices,app.commands,app.agent_credentials,app.agent_audit,app.notifications');
    await built.store.exec('UPDATE app.device_control SET enabled=true,revision=1');
    await built.store.exec("DELETE FROM queue.job WHERE name='device-execute'");
  });
  afterAll(async () => { await built?.server.close(); if (folder) await rm(folder, { recursive: true, force: true }); });
  const owner = (path: string, payload: unknown, key = randomUUID()) => built.server.inject({ method: 'POST', url: '/api/v2' + path, headers: { cookie, 'idempotency-key': key }, payload });
  async function pair(key = randomUUID()) { const r = await owner('/devices/bridges', { name: 'Synthetic Mac audio', adapter: 'macos.audio' }, key); expect(r.statusCode).toBe(200); return r.json(); }
  const bridge = (token: string, path: string, payload: unknown = { adapter: 'macos.audio', version: '1' }) => built.server.inject({ method: 'POST', url: '/api/device/v1' + path, headers: { authorization: 'Bearer ' + token }, payload });
  const record = (id: string) => built.store.one('SELECT * FROM app.device_commands WHERE id=$1', [id]);
  async function approve(deviceId: string) { const pending = await built.devices.request(randomUUID(), deviceId, { revision: 1, capability: 'audio.volume.set', arguments: { percent: 25 } }); return built.devices.decide(randomUUID(), pending.id, { revision: pending.revision, digest: pending.digest, approve: true }); }
  async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, timeout = 4000) { const end = Date.now() + timeout; for (;;) { const value = await read(); if (test(value)) return value; if (Date.now() > end) throw new Error('Bridge condition timed out'); await delay(25); } }
  async function next(token: string) { return until(async () => (await bridge(token, '/poll')).json().call, value => Boolean(value)); }
  async function reply(token: string, call: any, result: unknown) { expect((await bridge(token, '/calls/' + call.id + '/start', { lease: call.lease })).statusCode).toBe(200); const r = await bridge(token, '/calls/' + call.id + '/result', { lease: call.lease, result }); expect(r.statusCode).toBe(200); }

  it('issues hashed device-specific credentials only to the owner, with safe lost-response replay', async () => {
    const key = randomUUID(), issued = await pair(key);
    const row = await built.store.one('SELECT * FROM app.device_bridges'); expect(row!.token_hash).toBe(digest(issued.token));
    expect(JSON.stringify(await built.store.rows('SELECT * FROM app.commands'))).not.toContain(issued.token);
    expect((await pair(key))).toEqual({ ...issued, token: null });
    expect((await built.devices.list()).devices[0]).toMatchObject({ mode: 'physical', available: false, connection: { online: false } });
    expect((await bridge(issued.token, '/poll')).statusCode).toBe(200);
    expect((await built.devices.list()).devices[0]).toMatchObject({ available: true, observedState: null, connection: { online: true } });
    expect((await built.server.inject({ method: 'POST', url: '/api/v2/devices/bridges', headers: { authorization: 'Bearer ' + built.app.settings.token, 'idempotency-key': randomUUID() }, payload: { name: 'wrong identity', adapter: 'macos.audio' } })).statusCode).toBe(403);
    expect((await built.server.inject({ url: '/api/v2/devices', headers: { cookie, authorization: 'Bearer ' + issued.token } })).statusCode).toBe(401);
    expect((await bridge(built.app.settings.token, '/poll')).statusCode).toBe(401);
    await built.store.migrate(); expect(await built.store.one('SELECT device_id FROM app.device_bridges')).toBeTruthy();
  });
  it('runs the real HTTP protocol and local executor with a synthetic driver, requiring independent readback', async () => {
    const issued = await pair(), controller = new AbortController(); let volume = 10, writes = 0;
    const worker = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url!, ASSISTANT_DATA: folder }, stdio: 'ignore' });
    const task = runDeviceBridge({ ...issued, server: address }, { read: async () => ({ volume, muted: true }), execute: async (input: any) => { volume = input.percent; writes++; } }, join(folder, issued.deviceId), controller.signal);
    try {
      const pending = await built.devices.request(randomUUID(), issued.deviceId, { revision: 1, capability: 'audio.volume.set', arguments: { percent: 25 } });
      await delay(100); expect(writes).toBe(0);
      await built.devices.decide(randomUUID(), pending.id, { revision: 1, digest: pending.digest, approve: true });
      await until(() => record(pending.id), row => row?.state === 'succeeded', 12000);
      expect(await record(pending.id)).toMatchObject({ state: 'succeeded', receipt: { source: 'device', before: { volume: 10, muted: true }, after: { volume: 25, muted: true } } });
      await built.devices.process(pending.id); expect(writes).toBe(1);
      expect((await built.store.rows('SELECT phase,state FROM app.device_bridge_calls ORDER BY created_at')).map(r => r.phase)).toEqual(['before', 'write', 'after']);
    } finally {
      controller.abort(); await task;
      worker.kill('SIGTERM');
      try { await until(async () => worker.exitCode !== null || worker.signalCode !== null, Boolean, 7000); }
      catch { worker.kill('SIGKILL'); await until(async () => worker.exitCode !== null || worker.signalCode !== null, Boolean); }
    }
  });
  it('fences each claim by identity, one-use start grant, version and command state', async () => {
    const a = await pair(), b = await pair(), command = await approve(a.deviceId), processing = built.devices.process(command.id);
    try {
      const call = await next(a.token);
      expect((await bridge(a.token, '/poll')).json().call).toBeNull();
      expect((await bridge(b.token, '/calls/' + call.id + '/start', { lease: call.lease })).statusCode).toBe(404);
      expect((await bridge(a.token, '/calls/' + call.id + '/start', { lease: randomUUID() })).statusCode).toBe(409);
      expect((await bridge(a.token, '/calls/' + call.id + '/start', { lease: call.lease })).statusCode).toBe(200);
      expect((await bridge(a.token, '/calls/' + call.id + '/start', { lease: call.lease })).statusCode).toBe(409);
      const result = { lease: call.lease, result: { ok: true, state: { volume: 10, muted: true } } };
      expect((await bridge(a.token, '/calls/' + call.id + '/result', result)).statusCode).toBe(200);
      expect((await bridge(a.token, '/calls/' + call.id + '/result', result)).statusCode).toBe(200);
      expect((await bridge(a.token, '/calls/' + call.id + '/result', { ...result, result: { ok: true, state: { volume: 99, muted: false } } })).statusCode).toBe(409);
      const write = await next(a.token); await built.devices.cancel(randomUUID(), command.id, { revision: (await record(command.id))!.revision });
      expect((await bridge(a.token, '/calls/' + write.id + '/start', { lease: write.lease })).statusCode).toBe(409);
    } finally { const row = (await record(command.id))!; if (row.state === 'executing') await built.devices.cancel(randomUUID(), row.id, { revision: row.revision }); await processing; }
  });
  it.each(['disconnect', 'revoke', 'cancel', 'worker-recovery'] as const)('never replays an uncertain write after %s', async cause => {
    const issued = await pair(), command = await approve(issued.deviceId);
    const service = new DeviceActions(built.store, built.boss, { timeoutMs: 1000 }), processing = service.process(command.id);
    const before = await next(issued.token); await reply(issued.token, before, { ok: true, state: { volume: 10, muted: true } });
    const write = await next(issued.token);
    expect((await bridge(issued.token, '/calls/' + write.id + '/start', { lease: write.lease })).statusCode).toBe(200);
    if (cause === 'revoke') expect((await owner('/devices/' + issued.deviceId + '/revoke-bridge', {})).statusCode).toBe(200);
    if (cause === 'cancel') await built.devices.cancel(randomUUID(), command.id, { revision: (await record(command.id))!.revision });
    if (cause === 'worker-recovery') await built.devices.recover();
    await processing; expect((await record(command.id))!.state).toBe('uncertain');
    const response = await bridge(issued.token, '/calls/' + write.id + '/result', { lease: write.lease, result: { ok: true } });
    expect([401, 409]).toContain(response.statusCode);
    await built.devices.process(command.id); await built.devices.sweep();
    expect((await record(command.id))!.state).toBe('uncertain');
    expect((await built.store.one("SELECT count(*) n FROM app.device_bridge_calls WHERE command_id=$1 AND kind='execute'", [command.id]))!.n).toBe('1');
  });
  it.each([{ volume: 10, muted: false }, { volume: 25, muted: true }])('requires both target volume and unchanged mute state: %j', async after => {
    const issued = await pair(), command = await approve(issued.deviceId), processing = built.devices.process(command.id);
    await reply(issued.token, await next(issued.token), { ok: true, state: { volume: 10, muted: false } });
    await reply(issued.token, await next(issued.token), { ok: true });
    await reply(issued.token, await next(issued.token), { ok: true, state: after });
    await processing; expect((await record(command.id))!.state).toBe('uncertain');
    expect((await built.devices.list()).devices[0]!.observedState).toBeNull();
  });
  it('does not grant device write authority to a read-only Agent or expose device credentials', async () => {
    const issued = await pair();
    const agent = (await owner('/agents', { name: 'Read only fixture', scopes: ['devices:read'] })).json();
    const invoke = (name: string, payload: unknown) => built.server.inject({ method: 'POST', url: '/api/agent/v1/tools/' + name, headers: { authorization: 'Bearer ' + agent.token }, payload });
    const listed = await invoke('list_devices', {}); expect(listed.statusCode).toBe(200); expect(listed.body).not.toContain(issued.token); expect(listed.body).not.toContain('token_hash');
    expect((await invoke('request_device_action', { deviceId: issued.deviceId, revision: 1, capability: 'audio.volume.set', arguments: { percent: 25 }, requestKey: 'denied-fixture' })).statusCode).toBe(403);
    expect((await built.store.one('SELECT count(*) n FROM app.device_commands'))!.n).toBe('0');
    expect((await owner('/agents', { name: 'Missing read permission', scopes: ['devices:request'] })).statusCode).toBe(400);
  });
  it('fails an offline initial read before any write and rejects unsupported capabilities', async () => {
    const issued = await pair();
    for (const input of [{ percent: 51 }, { percent: 20, script: 'anything' }, { percent: '20' }]) await expect(built.devices.request(randomUUID(), issued.deviceId, { revision: 1, capability: 'audio.volume.set', arguments: input })).rejects.toThrow();
    const command = await approve(issued.deviceId); await new DeviceActions(built.store, built.boss, { timeoutMs: 100 }).process(command.id);
    expect((await record(command.id))!.state).toBe('failed');
    expect((await built.store.one("SELECT count(*) n FROM app.device_bridge_calls WHERE kind='execute'"))!.n).toBe('0');
    await built.store.exec("UPDATE app.device_bridges SET expires_at=now()-interval '1 second'");
    expect((await bridge(issued.token, '/poll')).statusCode).toBe(401);
    await expect(approve(issued.deviceId)).rejects.toMatchObject({ code: 'device_bridge_unavailable' });
  });
  it('uses the same scoped MCP registry to propose a single pending action without approval authority', async () => {
    const issued = await pair();
    const agent = (await owner('/agents', { name: 'Synthetic external Agent', scopes: ['devices:read', 'devices:request'], dailyWriteLimit: 1 })).json();
    const client = new Client({ name: 'device-protocol-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + '/api/agent/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + agent.token } } }));
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['list_devices', 'get_device_command', 'request_device_action']);
      const input = { deviceId: issued.deviceId, revision: 1, capability: 'audio.volume.set', arguments: { percent: 25 }, requestKey: 'device-fixture-0001' };
      const a = JSON.parse((await client.callTool({ name: 'request_device_action', arguments: input })).content[0].text);
      const b = JSON.parse((await client.callTool({ name: 'request_device_action', arguments: input })).content[0].text);
      expect(a).toMatchObject({ state: 'pending', deviceId: issued.deviceId }); expect(b).toEqual(a);
      expect((await built.store.one('SELECT writes_today FROM app.agent_credentials'))!.writes_today).toBe(1);
      expect((await built.store.one('SELECT count(*) n FROM app.device_bridge_calls'))!.n).toBe('0');
      expect((await built.store.one("SELECT count(*) n FROM app.agent_audit WHERE entity_id=$1 AND outcome='succeeded'", [a.id]))!.n).toBe('2');
      const unauthorized = await built.server.inject({ method: 'POST', url: '/api/v2/device-commands/' + a.id + '/decision', headers: { cookie, authorization: 'Bearer ' + agent.token, 'idempotency-key': randomUUID() }, payload: { revision: a.revision, digest: a.digest, approve: true } });
      expect(unauthorized.statusCode).toBe(401);
      expect((await bridge(agent.token, '/poll')).statusCode).toBe(401);
    } finally { await client.close(); }
  });
});
