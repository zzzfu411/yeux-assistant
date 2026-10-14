import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../packages/storage/src/index.js';
import { buildServer } from '../apps/api/src/server.js';
import { RunSupervisor } from '../packages/core/src/runtime.js';
import { claimRun, failRun } from '../packages/core/src/runtime-state.js';
import { executeResearchRun } from '../packages/core/src/research/service.js';
import { putSource } from '../packages/core/src/knowledge.js';
import { openCheckpoints } from '../packages/core/src/learning.js';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
describe.runIf(Boolean(url))('durable research on PostgreSQL and the real API / executor', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, server: Server, supervisor: RunSupervisor;
  let token: string;
  let calls: number, failAt: number, holdAt: number, reserveBudgetAt: number, release: (() => void) | undefined;
  const beforeURL = process.env.DATABASE_URL,
    beforeFolder = process.env.ASSISTANT_DATA;
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Isolated runtime test DB required');
    const setup = new Store(url!);
    await setup.exec(
      'DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS app CASCADE',
    );
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-research-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
    const saver = await openCheckpoints(url!, true);
    await saver.end();
    supervisor = new RunSupervisor(built.store);
    calls = 0;
    failAt = 0;
    holdAt = 0;
    reserveBudgetAt = 0;
    release = undefined;
    process.env.DATABASE_URL = url!;
    process.env.ASSISTANT_DATA = folder;
    server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      calls++;
      const n = calls;
      // Simulate earlier work consuming most of the persisted budget before the next request starts.
      if (n === reserveBudgetAt)
        await built.store.exec("UPDATE app.runs SET deadline=now()+interval '6 seconds' WHERE state='running'");
      const finish = () => {
        const user = JSON.parse(input.messages[1].content.split('\n')[1]);
        const ref = user.originalSources[0];
        const content = input.messages[0].content.includes('LAB2_SOLVE')
          ? {
              content: '第 ' + n + ' 次生成：事务隔离需要结合并发场景。',
              citations: ref ? [{ sourceId: ref.sourceId, version: ref.version, quote: ref.quote.slice(0, 10) }] : [],
              limitations: ['尚需核对适用场景'],
            }
          : {
              scores: { coverage: n === 4 ? 1 : 3, evidence: 3, challenges: 2, usability: 3 },
              issues: ['需要补充反例'],
              queries: ['并发'],
              rationale: '候选的边界讨论仍不完整。',
              satisfied: false,
            };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: n === failAt ? 'invalid JSON' : JSON.stringify(content) } }],
            usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
          }),
        );
      };
      if (n === holdAt) release = finish;
      else finish();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({
        llm: {
          base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1',
          model: 'synthetic-research',
        },
      }),
    );
    await built.store.transaction((tx) =>
      putSource(tx, { id: 'source', title: '合成事务资料', content: '默认隔离级别不等于可串行化，并发反例需要检查。' }),
    );
  });
  afterEach(async () => {
    await supervisor?.stop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
    if (beforeURL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = beforeURL;
    if (beforeFolder === undefined) delete process.env.ASSISTANT_DATA;
    else process.env.ASSISTANT_DATA = beforeFolder;
  });
  async function create(effort = 'high') {
    const response = await built.server.inject({
      method: 'POST',
      url: '/api/v2/sessions',
      headers: { authorization: 'Bearer ' + token, 'idempotency-key': 'research-' + effort },
      payload: { prompt: '比较事务并发隔离', kind: 'work', research: { effort, sourceIds: ['source'] } },
    });
    expect(response.statusCode).toBe(202);
    return response.json() as { sessionId: string; runId: string };
  }
  async function waitFor(work: () => boolean | Promise<boolean>) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await work()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Expected progress not reached');
  }
  it('creates once, executes eight calls in the child, preserves the best, and exports an authenticated workspace', async () => {
    const item = await create();
    expect(await create()).toEqual(item);
    await supervisor.handle(item.runId);
    const detail = await built.app.session(item.sessionId);
    expect(detail.session.state).toBe('ready');
    expect(calls).toBe(8);
    expect(detail.research?.state.best).toBe(0);
    expect(detail.research?.state.candidates).toHaveLength(4);
    expect(detail.research?.usage).toMatchObject({ totalTokens: 400, complete: true });
    await supervisor.handle(item.runId);
    expect(calls).toBe(8);
    expect(
      (await built.store.one('SELECT count(*) n FROM app.artifacts WHERE session_id=$1', [item.sessionId]))?.n,
    ).toBe('1');
    expect(
      (await built.server.inject({ url: '/api/v2/sessions/' + item.sessionId + '/research/export' })).statusCode,
    ).toBe(401);
    const exported = await built.server.inject({
      url: '/api/v2/sessions/' + item.sessionId + '/research/export',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(exported.json().research.state.candidates).toHaveLength(4);
    expect((await built.app.session(item.sessionId)).attempts).toEqual([]);
  });
  it('resumes a saved solve after failure, shares budget, and keeps the old source version', async () => {
    const item = await create('low');
    failAt = 2;
    const claim = (await claimRun(built.store, item.runId))!;
    await expect(
      executeResearchRun(built.store, folder, { runId: item.runId, generation: claim.generation }),
    ).rejects.toThrow();
    expect((await built.app.session(item.sessionId)).research?.state.phase).toBe('review');
    await failRun(built.store, { runId: item.runId, generation: claim.generation }, '模拟进程中断', false);
    await built.store.transaction((tx) =>
      putSource(tx, { id: 'source', title: '改后的资料', content: '资料已经修改。' }),
    );
    await supervisor.handle(item.runId);
    const detail = await built.app.session(item.sessionId);
    expect(detail.session.state).toBe('ready');
    expect(calls).toBe(4);
    expect(detail.research?.state.candidates[0]?.citations[0]?.version).toBe(1);
    expect(detail.research?.state.candidates).toHaveLength(2);
    expect(detail.research?.state.candidates[1]?.review).toBeNull();
    expect(detail.research?.state.best).toBe(0);
    expect(detail.research?.usage.totalTokens).toBe(200); // malformed paid response is counted
  });
  it('cancels a running review without publishing its late response or erasing the saved candidate', async () => {
    const item = await create();
    holdAt = 2;
    const pending = supervisor.handle(item.runId);
    await waitFor(() => Boolean(release));
    await built.app.cancel('cancel', item.runId);
    release!();
    await pending;
    const detail = await built.app.session(item.sessionId);
    expect(detail.session.state).toBe('cancelled');
    expect(detail.research?.state.candidates[0]?.review).toBeNull();
    expect(detail.session.content).toBe('');
    expect(supervisor.children.size).toBe(0);
  });
  it('returns a prior reviewed answer if a later model response is invalid', async () => {
    const item = await create('low');
    failAt = 3;
    await supervisor.handle(item.runId);
    const detail = await built.app.session(item.sessionId);
    expect(detail.session.state).toBe('ready');
    expect(detail.research?.state.stopReason).toBe('error');
    expect(detail.research?.state.best).toBe(0);
    expect(calls).toBe(3);
  });
  it('stops a slow later call before the hard deadline and delivers the retained answer within budget', async () => {
    const item = await create('low');
    reserveBudgetAt = 2;
    holdAt = 3;
    await supervisor.handle(item.runId);
    const detail = await built.app.session(item.sessionId);
    const run = (await built.store.one('SELECT deadline,finished_at FROM app.runs WHERE id=$1', [item.runId]))!;
    expect(detail.session.state).toBe('ready');
    expect(detail.research?.state.stopReason).toBe('budget');
    expect(detail.research?.state.best).toBe(0);
    expect(detail.research?.state.candidates).toHaveLength(1);
    expect(detail.research?.usage).toMatchObject({ complete: false, reportedCalls: 2 });
    expect(calls).toBe(3);
    expect(new Date(run.finished_at).getTime()).toBeLessThan(new Date(run.deadline).getTime());
    expect(supervisor.children.size).toBe(0);
    release?.();
  });
  it('keeps direct solving at one call and refuses invalid source selections', async () => {
    const item = await create('direct');
    await supervisor.handle(item.runId);
    expect(calls).toBe(1);
    expect((await built.app.session(item.sessionId)).research?.state.stopReason).toBe('direct');
    await expect(
      built.app.addSession('invalid-source', { prompt: '研究', kind: 'work', research: { sourceIds: ['missing'] } }),
    ).rejects.toThrow();
  });
});
