import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../packages/storage/src/index.js';
import { Application } from '../packages/core/src/application.js';
import { createBoss } from '../packages/core/src/queue.js';
import { initializeData } from '../packages/core/src/config.js';
import { executeLearningRun, localLesson, nextReview, openCheckpoints } from '../packages/core/src/learning.js';
import { claimRun, commitNode, failRun, StaleRun } from '../packages/core/src/runtime-state.js';
import { boundedContext, ModelGateway } from '../packages/core/src/model.js';
import { ModelLesson } from '../packages/contracts/src/index.js';
import { Scheduler, nextScheduledTime } from '../packages/core/src/scheduler.js';

describe('learning policy', () => {
  it('uses 1, 3, 7 days and resets on an incorrect or ungraded answer', () => {
    const intervals = [86400, 259200, 604800];
    expect(nextReview(0, intervals, 'pass', 0)).toEqual({ stage: 1, at: new Date(86400000) });
    expect(nextReview(1, intervals, 'pass', 0).at.getTime()).toBe(259200000);
    expect(nextReview(2, intervals, 'retry', 0)).toEqual({ stage: 0, at: new Date(86400000) });
    expect(nextReview(2, intervals, 'unclear', 0).stage).toBe(0);
  });
  it('coalesces missed schedule periods to the next future occurrence', () => {
    expect(nextScheduledTime(new Date(0), 60, new Date(241000))).toEqual(new Date(300000));
  });
  it('keeps the complete bounded source excerpt, including Unicode at the old clipping boundary', () => {
    const quote = '原'.repeat(1599) + '😀' + '资料末尾';
    const lesson = localLesson('原始资料练习', [{ sourceId: 'source', version: 1, title: '测试讲义', start: 0, end: quote.length, quote, digest: 'synthetic' }]);
    expect(lesson).toContain(quote);
    expect(lesson).toContain('没有经过模型讲解或评阅');
  });
  it('preserves confirmed rules and latest corrections, visibly bounds older context', () => {
    const result = boundedContext({ task: '学习', latest: '最新纠正', rules: ['请用中文'], previous: '旧回答'.repeat(20000), notes: [], sources: [] });
    expect(result.text).toContain('最新纠正'); expect(result.text).toContain('请用中文');
    expect(result.text.length).toBeLessThanOrEqual(24000); expect(result.trimmed).toBe(true);
    expect(() => boundedContext({ task: '', latest: '', rules: ['规则'.repeat(15000)], previous: '', notes: [], sources: [] })).toThrow('上下文上限');
  });
});

const url = process.env.RUNTIME_TEST_DATABASE_URL;
describe.runIf(Boolean(url))('durable learning with PostgreSQL and LangGraph', () => {
  let store: Store, boss: Awaited<ReturnType<typeof createBoss>>, app: Application, folder: string, saver: Awaited<ReturnType<typeof openCheckpoints>>, server: Server | undefined;
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Runtime tests require an isolated *_runtime_test database');
    store = new Store(url!);
    await store.pool.query('DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate(); boss = await createBoss(url!, false); saver = await openCheckpoints(url!, true);
    folder = await mkdtemp(join(tmpdir(), 'assistant-runtime-')); const token = await initializeData(folder); app = new Application(store, boss, folder, token);
  });
  afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; await saver?.end(); await boss?.stop(); await store?.close(); if (folder) await rm(folder, { recursive: true, force: true }); });
  async function execute(runId: string) { const run = (await claimRun(store, runId))!; await executeLearningRun(store, folder, { runId, generation: run.generation }, saver); }
  async function goal() {
    const source = await app.importSource('source', { title: '软件工程讲义', content: '需求是对期望行为的描述。测试可以检验具体行为是否符合需求。' });
    return app.addGoal('goal', { title: '理解软件工程需求', sourceIds: [source.id] });
  }
  async function mockModel(reply: (instruction: string) => unknown) {
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      const value = reply(JSON.parse(body).messages[0].content);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    await writeFile(join(folder, 'config.json'), JSON.stringify({ llm: { base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', model: 'local-test-model' } }));
  }
  it('waits without model calls, survives a checkpoint connection restart and records user evidence without completing the goal', async () => {
    const created = await goal(); await execute(created.runId);
    const first = await app.session(created.sessionId);
    expect(first.session.state).toBe('waiting_feedback'); expect(first.session.content).toContain('尚未配置模型'); expect(first.session.citations).toHaveLength(1);
    expect((await store.one('SELECT model_calls FROM app.runs WHERE id=$1', [created.runId]))!.model_calls).toBe(0);
    await saver.end(); saver = await openCheckpoints(url!);
    const feedback = await app.feedback('answer', created.sessionId, { revision: first.session.revision, answer: '需求描述希望系统做什么，测试用例验证系统是否符合需求。', selfReport: 'understood' });
    await execute(feedback.runId);
    const detail = await app.goal(created.goalId);
    expect(detail.goal.status).toBe('active'); expect(detail.goal.nextReview).not.toBeNull();
    expect(detail.attempts[0]!.source).toBe('user_report'); expect(detail.attempts[0]!.verdict).toBe('pass');
    expect(detail.sessions[0]!.state).toBe('completed'); expect(detail.plan!.steps[0]!.state).toBe('practiced');
    expect((await store.one('SELECT count(*) n FROM checkpoints.checkpoints'))!.n).not.toBe('0');
    expect(await claimRun(store, feedback.runId)).toBeNull();
  });
  it('does not infer mastery from an ungraded answer and keeps one waiting step', async () => {
    const created = await goal(); await execute(created.runId);
    const s = (await app.session(created.sessionId)).session;
    const feedback = await app.feedback('answer', s.id, { revision: s.revision, answer: '我读过了' }); await execute(feedback.runId);
    const detail = await app.goal(created.goalId);
    expect(detail.attempts[0]!.verdict).toBe('unclear'); expect(detail.plan!.steps[0]!.state).toBe('practicing');
    expect(detail.attempts[0]!.source).toBe('ungraded');
    expect((await store.one("SELECT provenance FROM app.artifacts WHERE session_id=$1 AND kind='feedback'", [created.sessionId]))!.provenance).toBe('ungraded');
    expect((await store.one("SELECT data FROM app.events WHERE entity_id=$1 AND kind='attempt.assessed' ORDER BY id DESC LIMIT 1", [created.sessionId]))!.data.source).toBe('ungraded');
    expect(detail.sessions.filter(s => s.state === 'waiting_feedback')).toHaveLength(1);
    await store.exec("UPDATE app.goals SET next_review=now()-interval '2 days' WHERE id=$1", [created.goalId]);
    await new Scheduler(store, boss).tick(); await new Scheduler(store, boss).tick();
    expect((await app.goal(created.goalId)).sessions).toHaveLength(1);
  });
  it('fences cancelled runs and commits node outputs once across automatic retry', async () => {
    const created = await goal(), run = (await claimRun(store, created.runId))!;
    const identity = { runId: created.runId, generation: run.generation };
    let calls = 0;
    const first = await commitNode(store, identity, 'probe', async () => ({ calls: ++calls }));
    expect(await commitNode(store, identity, 'probe', async () => ({ calls: ++calls }))).toEqual(first); expect(calls).toBe(1);
    await store.exec('UPDATE app.runs SET model_calls=4 WHERE id=$1', [created.runId]);
    await failRun(store, identity, '模拟临时中断', false);
    const retry = (await claimRun(store, created.runId))!; expect(retry.model_calls).toBe(4); expect(retry.deadline).toEqual(run.deadline);
    expect(await commitNode(store, { runId: created.runId, generation: retry.generation }, 'probe', async () => ({ calls: ++calls }))).toEqual(first);
    await expect(commitNode(store, identity, 'late', async () => ({}))).rejects.toBeInstanceOf(StaleRun);
    await app.cancel('cancel', created.runId);
    await expect(commitNode(store, { runId: created.runId, generation: retry.generation }, 'late', async () => ({}))).rejects.toBeInstanceOf(StaleRun);
    expect((await app.session(created.sessionId)).session.state).toBe('cancelled');
  });
  it('does not expose feedback until the checkpoint exists, and replays a committed lesson without duplication', async () => {
    const created = await goal(), original = saver.put.bind(saver); let injected = false;
    saver.put = async (...args) => {
      if (!injected && await store.one("SELECT id FROM app.artifacts WHERE session_id=$1 AND kind='lesson'", [created.sessionId])) { injected = true; throw new Error('Injected checkpoint outage'); }
      return original(...args);
    };
    await expect(execute(created.runId)).rejects.toThrow('Injected checkpoint outage');
    const paused = (await app.session(created.sessionId)).session;
    expect(paused.state).toBe('running');
    await expect(app.feedback('early', paused.id, { revision: paused.revision, answer: '提前回答' })).rejects.toThrow('尚不能接收');
    const run = (await store.one('SELECT generation FROM app.runs WHERE id=$1', [created.runId]))!;
    await failRun(store, { runId: created.runId, generation: run.generation }, '模拟检查点连接中断', false);
    saver.put = original; await execute(created.runId);
    expect((await app.session(created.sessionId)).session.state).toBe('waiting_feedback');
    expect((await store.one("SELECT count(*) n FROM app.artifacts WHERE session_id=$1 AND kind='lesson'", [paused.id]))!.n).toBe('1');
    expect((await store.one('SELECT count(*) n FROM app.notifications WHERE session_id=$1', [paused.id]))!.n).toBe('1');
  });
  it('preserves edited schedules while an earlier session waits and coalesces unchanged overdue repeats', async () => {
    const s = await app.saveSchedule('schedule', undefined, { title: '每日练习', prompt: '解释需求', kind: 'study', intervalSeconds: 60, nextRun: new Date(Date.now() - 600000).toISOString() });
    const scheduler = new Scheduler(store, boss); await scheduler.tick();
    let stored = (await store.one('SELECT * FROM app.schedules WHERE id=$1', [s.id]))!;
    const active = stored.active_session;
    expect(new Date(stored.next_run).getTime()).toBeGreaterThan(Date.now());
    await store.exec("UPDATE app.schedules SET next_run=now()-interval '4 minutes' WHERE id=$1", [s.id]); await scheduler.tick();
    expect((await store.one('SELECT count(*) n FROM app.sessions'))!.n).toBe('1');
    await app.saveSchedule('edit', s.id, { title: '新的每日练习', prompt: '解释测试', kind: 'study', intervalSeconds: 60, nextRun: new Date(Date.now() - 600000).toISOString(), revision: s.version });
    await scheduler.tick(); expect((await store.one('SELECT * FROM app.schedules WHERE id=$1', [s.id]))!.active_session).toBe(active);
    await store.exec("UPDATE app.sessions SET state='completed' WHERE id=$1", [active]); await scheduler.tick();
    stored = (await store.one('SELECT * FROM app.schedules WHERE id=$1', [s.id]))!;
    expect(stored.active_session).not.toBe(active); expect((await store.one('SELECT prompt FROM app.sessions WHERE id=$1', [stored.active_session]))!.prompt).toBe('解释测试');
  });
  it('uses model feedback to move to the next point, with a persistent model budget', async () => {
    let calls = 0; const prompts: string[] = [];
    await store.exec("INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES('work-only','work','工作事务专属规则',1,true,true),('study-only','study','学习任务专属规则',1,true,true)");
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      const input = JSON.parse(body), instruction = input.messages[0].content; calls++; prompts.push(input.messages[1].content);
      const content = instruction.includes('拆成 1–6') ? { steps: [{ title: '理解需求', objective: '说清需求' }, { title: '验证需求', objective: '设计测试' }], rationale: '先理解，再验证。' }
        : instruction.includes('评阅最新') ? { verdict: 'pass', feedback: '回答准确区分了期望行为与验证方法。', evidence: '用户回答提到了需求和测试的不同作用。' }
          : { content: '请解释当前知识点，并举例。', sourceIds: [] };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 50 } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    await writeFile(join(folder, 'config.json'), JSON.stringify({ llm: { base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', model: 'local-test-model' } }));
    const created = await goal(); await execute(created.runId);
    const s = (await app.session(created.sessionId)).session;
    const answer = await app.feedback('answer', s.id, { revision: s.revision, answer: '需求定义期望行为，测试验证实现是否满足需求。' }); await execute(answer.runId);
    const detail = await app.goal(created.goalId);
    expect(detail.plan!.steps.map(s => s.state)).toEqual(['practiced', 'practicing']);
    expect(detail.attempts[0]!.source).toBe('model_estimate'); expect(detail.sessions[0]!.state).toBe('waiting_feedback');
    expect(detail.goal.reviewStage).toBe(0);
    expect(calls).toBe(4); expect((await store.one('SELECT model_calls FROM app.runs WHERE id=$1', [answer.runId]))!.model_calls).toBe(2);
    expect(prompts.every(p => p.includes('学习任务专属规则') && !p.includes('工作事务专属规则'))).toBe(true);
  });
  it('rejects invented citations with finite retries instead of silently delivering them', async () => {
    await mockModel(instruction => instruction.includes('拆成 1–6') ? { steps: [{ title: '需求', objective: '解释' }], rationale: '先解释。' } : { content: '声称有来源的回答', sourceIds: ['invented-source'] });
    const created = await goal();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(execute(created.runId)).rejects.toThrow('未提供的资料');
      expect(await failRun(store, { runId: created.runId, generation: attempt }, '模型引用无效。', false)).toBe(attempt < 3);
    }
    expect((await app.session(created.sessionId)).session.state).toBe('failed');
    expect((await store.one('SELECT count(*) n FROM app.artifacts WHERE session_id=$1', [created.sessionId]))!.n).toBe('0');
    expect((await store.one('SELECT model_calls FROM app.runs WHERE id=$1', [created.runId]))!.model_calls).toBe(4);
  });
  it('downgrades a pass without evidence instead of advancing the learning plan', async () => {
    await mockModel(instruction => instruction.includes('拆成 1–6') ? { steps: [{ title: '需求', objective: '解释' }], rationale: '先解释。' } : instruction.includes('评阅最新') ? { verdict: 'pass', feedback: '很好。', evidence: '  ' } : { content: '请解释需求。', sourceIds: [] });
    const created = await goal(); await execute(created.runId);
    const session = (await app.session(created.sessionId)).session;
    const reply = await app.feedback('answer', session.id, { revision: session.revision, answer: '不确定' }); await execute(reply.runId);
    const detail = await app.goal(created.goalId);
    expect(detail.attempts[0]!.verdict).toBe('unclear'); expect(detail.attempts[0]!.feedback).toContain('可核对');
    expect(detail.plan!.steps[0]!.state).toBe('practicing');
  });
  it('allows at most five model calls across retries of the same run', async () => {
    let calls = 0;
    await mockModel(() => { calls++; return { content: '合成测试', sourceIds: [] }; });
    const created = await goal(), first = (await claimRun(store, created.runId))!;
    const context = { task: '练习', latest: '解释', previous: '', rules: [], notes: [], sources: [] };
    let gateway = new ModelGateway(store, folder, { runId: created.runId, generation: first.generation });
    for (let i = 0; i < 4; i++) await gateway.json(ModelLesson, '测试', context);
    await failRun(store, { runId: created.runId, generation: first.generation }, '模拟连接中断', false);
    const retry = (await claimRun(store, created.runId))!;
    gateway = new ModelGateway(store, folder, { runId: created.runId, generation: retry.generation });
    await gateway.json(ModelLesson, '测试', context);
    await expect(gateway.json(ModelLesson, '测试', context)).rejects.toThrow('五次模型调用');
    expect(calls).toBe(5); expect(retry.deadline).toEqual(first.deadline);
  });
});
