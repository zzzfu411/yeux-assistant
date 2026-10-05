import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { setAdministrator } from '../packages/core/src/auth.js';
import { Application } from '../packages/core/src/application.js';
import { digest } from '../packages/core/src/common.js';
import { type AgentScope } from '../packages/contracts/src/agents.js';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('external Agent identity and bounded operations', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, cookie: string, adminToken: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated *_test DB required');
    const store = new Store(url);
    await store.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-agent-'));
    built = await buildServer({ url, folder, assets: false });
    await setAdministrator(folder, 'fixture-owner', 'Synthetic-only-owner-password');
    adminToken = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
    const login = await built.server.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: 'fixture-owner', password: 'Synthetic-only-owner-password' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  beforeEach(async () => {
    await built.store.exec('TRUNCATE app.agent_audit,app.agent_credentials');
    await built.store.exec("DELETE FROM app.commands WHERE key LIKE 'agent%'");
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const admin = (method: 'GET' | 'POST', path: string, payload?: unknown, key = 'fixture-key-0001') =>
    built.server.inject({ method, url: '/api/v2/agents' + path, headers: { cookie, 'idempotency-key': key }, payload });
  const issue = async (scopes: AgentScope[] = ['workspace:read'], key = 'fixture-key-0001', dailyWriteLimit = 10) => {
    const result = await admin('POST', '', { name: 'Synthetic Hermes', scopes, dailyWriteLimit }, key);
    expect(result.statusCode).toBe(200);
    return result.json() as { credential: { id: string }; token: string };
  };
  const tools = (token: string) =>
    built.server.inject({ url: '/api/agent/v1/tools', headers: { authorization: 'Bearer ' + token } });
  const invoke = (token: string, name: string, payload: unknown = {}) =>
    built.server.inject({
      method: 'POST',
      url: '/api/agent/v1/tools/' + name,
      headers: { authorization: 'Bearer ' + token },
      payload,
    });

  it('issues only through an administrator session, stores hashes, and retries issuance without persisting the secret', async () => {
    const result = await issue();
    const row = await built.store.one('SELECT * FROM app.agent_credentials');
    expect(row!.token_hash).toBe(digest(result.token));
    expect(JSON.stringify(row)).not.toContain(result.token);
    const commands = await built.store.rows('SELECT * FROM app.commands');
    expect(JSON.stringify(commands)).not.toContain(result.token);
    const listed = await admin('GET', '');
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(result.token);
    expect(listed.body).not.toContain('token_hash');
    const retried = await issue();
    expect(retried.credential.id).toBe(result.credential.id);
    expect(retried.token).toBeNull();
    expect(
      (await built.server.inject({ url: '/api/v2/agents', headers: { authorization: 'Bearer ' + adminToken } }))
        .statusCode,
    ).toBe(403);
    expect((await built.server.inject({ url: '/api/v2/agents' })).statusCode).toBe(401);
  });
  it('does not mix browser and Agent identities and never accepts admin credentials at the Agent entry', async () => {
    const { token } = await issue();
    for (const headers of [
      { cookie, authorization: 'Bearer ' + token },
      { cookie, authorization: 'Bearer invalid' },
    ]) {
      expect((await built.server.inject({ url: '/api/v2/today', headers })).statusCode).toBe(401);
    }
    expect((await tools(adminToken)).statusCode).toBe(401);
    expect((await built.server.inject({ url: '/api/agent/v1/tools', headers: { cookie } })).statusCode).toBe(401);
    expect((await tools(token)).headers['cache-control']).toBe('no-store');
  });
  it('advertises only granted tools and denies ungranted writes before creating work', async () => {
    const { token } = await issue();
    expect((await tools(token)).json().tools.map((tool: any) => tool.name)).toEqual([
      'get_status',
      'list_goals',
      'get_goal',
      'list_tasks',
      'get_task',
    ]);
    const before = await built.store.one('SELECT count(*) n FROM app.goals');
    expect(
      (await invoke(token, 'create_goal', { requestKey: 'read-only-key', title: 'Must not create' })).statusCode,
    ).toBe(403);
    expect((await invoke(token, 'search_sources', { q: 'example' })).statusCode).toBe(403);
    expect((await built.store.one('SELECT count(*) n FROM app.goals'))!.n).toBe(before!.n);
    expect((await built.agents.audit()).items.every((item) => item.outcome === 'denied')).toBe(true);
  });
  it.each([
    '/sessions/example/feedback',
    '/goals/example',
    '/memories',
    '/settings/model',
    '/approvals/example/decision',
    '/devices/example',
    '/agents',
  ])('does not let an Agent access the owner route %s', async (path) => {
    const { token } = await issue(['workspace:read', 'sources:read', 'goals:create', 'tasks:create']);
    const response = await built.server.inject({
      method: 'POST',
      url: '/api/v2' + path,
      headers: { authorization: 'Bearer ' + token, cookie },
      payload: {},
    });
    expect([401, 404]).toContain(response.statusCode);
  });
  it('serializes duplicate creates and namespaces identical request keys by Agent', async () => {
    const a = await issue(['workspace:read', 'goals:create']),
      b = await issue(['workspace:read', 'goals:create'], 'fixture-key-0002');
    const input = { requestKey: 'same-request-0001', title: 'Synthetic goal for idempotency' };
    const [first, second] = await Promise.all([
      invoke(a.token, 'create_goal', input),
      invoke(a.token, 'create_goal', input),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const third = await invoke(b.token, 'create_goal', input);
    expect(third.statusCode).toBe(200);
    expect(third.json().goalId).not.toBe(first.json().goalId);
    expect(
      (await built.store.one("SELECT count(*) n FROM queue.job WHERE name='learning' AND data->>'runId'=$1", [
        first.json().runId,
      ]))!.n,
    ).toBe('1');
    expect(
      (await built.store.one('SELECT writes_today FROM app.agent_credentials WHERE id=$1', [a.credential.id]))!
        .writes_today,
    ).toBe(1);
    const conflict = await invoke(a.token, 'create_goal', { ...input, title: 'Changed request' });
    expect(conflict.statusCode).toBe(409);
    const audit = await built.agents.audit();
    expect(audit.items.filter((item) => item.entityId === first.json().goalId)).toHaveLength(2);
  });
  it('applies a transactional daily budget, including concurrent writes, and permits receipt replay at the limit', async () => {
    const { token, credential } = await issue(['workspace:read', 'tasks:create'], 'fixture-key-0001', 1);
    const make = (requestKey: string) =>
      invoke(token, 'create_task', { requestKey, prompt: 'Prepare a synthetic checklist' });
    const results = await Promise.all([make('first-request'), make('second-request')]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 429]);
    const successfulKey = results[0]!.statusCode === 200 ? 'first-request' : 'second-request';
    expect((await make(successfulKey)).statusCode).toBe(200);
    expect(
      (await built.store.one('SELECT writes_today FROM app.agent_credentials WHERE id=$1', [credential.id]))!
        .writes_today,
    ).toBe(1);
    await built.store.exec("UPDATE app.agent_credentials SET write_day=(now() AT TIME ZONE 'UTC')::date-1");
    expect((await make('next-day-request')).statusCode).toBe(200);
  });
  it('rolls back the business result, queue and quota if its audit receipt cannot commit', async () => {
    const { token } = await issue(['workspace:read', 'goals:create']);
    const before = await built.store.one('SELECT count(*) n FROM app.goals');
    await built.store.exec(
      "CREATE FUNCTION app.fail_agent_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.command_key IS NOT NULL THEN RAISE EXCEPTION ''synthetic audit failure''; END IF; RETURN NEW; END'",
    );
    await built.store.exec(
      'CREATE TRIGGER fail_audit BEFORE UPDATE ON app.agent_audit FOR EACH ROW EXECUTE FUNCTION app.fail_agent_audit()',
    );
    try {
      const response = await invoke(token, 'create_goal', {
        requestKey: 'audit-rollback',
        title: 'Must roll back with audit',
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('synthetic audit failure');
      expect((await built.store.one('SELECT count(*) n FROM app.goals'))!.n).toBe(before!.n);
      expect((await built.store.one('SELECT writes_today FROM app.agent_credentials'))!.writes_today).toBe(0);
      expect((await built.store.one("SELECT count(*) n FROM app.commands WHERE key LIKE 'agent:%'"))!.n).toBe('0');
    } finally {
      await built.store.exec('DROP TRIGGER fail_audit ON app.agent_audit');
      await built.store.exec('DROP FUNCTION app.fail_agent_audit()');
    }
    expect(
      (await invoke(token, 'create_goal', { requestKey: 'audit-rollback', title: 'Must roll back with audit' }))
        .statusCode,
    ).toBe(200);
  });
  it('rejects expired and revoked identities, including a previously admitted write', async () => {
    const { token, credential } = await issue(['workspace:read', 'goals:create']);
    const actor = await built.agents.authenticate('Bearer ' + token);
    expect((await admin('POST', '/' + credential.id + '/revoke')).statusCode).toBe(200);
    expect((await tools(token)).statusCode).toBe(401);
    const writer = new Application(
      built.store,
      built.boss,
      folder,
      adminToken,
      built.agents.boundary(actor, 'goals:create', 'synthetic-not-created'),
    );
    await expect(writer.addGoal('revoked-write', { title: 'No late commit' })).rejects.toMatchObject({ status: 401 });
    const second = await issue(['workspace:read'], 'fixture-key-0002');
    await built.store.exec("UPDATE app.agent_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [
      second.credential.id,
    ]);
    expect((await tools(second.token)).statusCode).toBe(401);
  });
  it('bounds requests and checks Origin without trusting forwarded headers', async () => {
    const { token } = await issue();
    await built.store.exec('UPDATE app.agent_credentials SET request_count=60,request_window=now()');
    const limited = await tools(token);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    await built.store.exec("UPDATE app.agent_credentials SET request_window=now()-interval '2 minutes'");
    expect((await tools(token)).statusCode).toBe(200);
    const cross = await built.server.inject({
      method: 'POST',
      url: '/api/agent/v1/tools/list_goals',
      headers: {
        authorization: 'Bearer ' + token,
        origin: 'https://foreign.example',
        'x-forwarded-host': 'foreign.example',
        'x-forwarded-proto': 'https',
      },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });
  it('bounds source content and pins versions while never returning approval payloads or learning answers', async () => {
    const { token } = await issue(['workspace:read', 'sources:read']);
    const source = await built.app.importSource('fixture-source-agent', {
      title: 'Synthetic course',
      content: '初始版本'.repeat(3000),
    });
    await built.app.updateSource('fixture-source-agent-v2', source.id, {
      revision: source.revision,
      content: '新版内容',
    });
    const first = await invoke(token, 'read_source', { id: source.id, version: 1, limit: 20 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 1, start: 0, end: 20, nextOffset: 20 });
    expect(first.json().content).toHaveLength(20);
    expect(first.json().content).toContain('初始版本');
    expect((await invoke(token, 'read_source', { id: source.id, offset: 100 })).json()).toMatchObject({
      content: '',
      start: 4,
      end: 4,
      nextOffset: null,
    });
    expect((await invoke(token, 'read_source', { id: source.id, limit: 100000 })).statusCode).toBe(400);
    const session = await built.app.addSession('fixture-private-task', {
      prompt: 'Synthetic private draft',
      kind: 'work',
    });
    await built.store.exec(
      "INSERT INTO app.attempts(id,session_id,answer,source) VALUES('synthetic-answer',$1,'Do not expose this answer','ungraded')",
      [session.sessionId],
    );
    const detail = await invoke(token, 'get_task', { id: session.sessionId });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('Do not expose this answer');
    expect(detail.json()).not.toHaveProperty('approvals');
  });
  it('validates creation input without allowing progress evidence or hidden fields', async () => {
    const { token } = await issue(['workspace:read', 'goals:create', 'tasks:create']);
    expect(
      (await invoke(token, 'create_task', { requestKey: 'invalid-kind', prompt: 'Test', kind: 'study' })).statusCode,
    ).toBe(400);
    expect(
      (await invoke(token, 'create_goal', { requestKey: 'invalid-status', title: 'Test', status: 'completed' }))
        .statusCode,
    ).toBe(400);
    expect((await invoke(token, 'create_goal', { title: 'Missing request key' })).statusCode).toBe(400);
    expect((await built.store.one('SELECT writes_today FROM app.agent_credentials'))!.writes_today).toBe(0);
  });
  it('supports a real SDK client across API restart, including initialization, tools, writes, polling and revocation', async () => {
    const issued = await issue(['workspace:read', 'goals:create']);
    await built.server.close();
    built = await buildServer({ url, folder, assets: false });
    await built.server.listen({ host: '127.0.0.1', port: 0 });
    const address = built.server.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP');
    const client = new Client({ name: 'synthetic-agent-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/agent/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + issued.token } },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.some((tool) => tool.name === 'create_goal')).toBe(true);
      const denied = await client.callTool({ name: 'search_sources', arguments: { q: 'no permission' } });
      expect(denied.isError).toBe(true);
      expect(
        (await built.agents.audit()).items.some(
          (item) => item.operation === 'search_sources' && item.outcome === 'denied',
        ),
      ).toBe(true);
      const args = { title: 'SDK round trip', requestKey: 'mcp-repeated-create' };
      const first = await client.callTool({ name: 'create_goal', arguments: args });
      expect(first.isError).not.toBe(true);
      const value = JSON.parse((first.content as any[])[0].text);
      const repeated = await client.callTool({ name: 'create_goal', arguments: args });
      expect(JSON.parse((repeated.content as any[])[0].text)).toEqual(value);
      const read = await client.callTool({ name: 'get_task', arguments: { id: value.sessionId } });
      expect(JSON.parse((read.content as any[])[0].text).state).toBe('queued');
      await built.agents.revoke(issued.credential.id);
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
