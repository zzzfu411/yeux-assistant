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
  it('uses 1, 3, 7 days, resets on incorrect evidence and preserves the stage when unclear', () => {
    const intervals = [86400, 259200, 604800];
    expect(nextReview(0, intervals, 'pass', 0)).toEqual({ stage: 1, at: new Date(86400000) });
    expect(nextReview(1, intervals, 'pass', 0).at.getTime()).toBe(259200000);
    expect(nextReview(2, intervals, 'retry', 0)).toEqual({ stage: 0, at: new Date(86400000) });
    expect(nextReview(2, intervals, 'unclear', 0)).toEqual({stage:2,at:new Date(86400000)});
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
  async function twoStepGoal(state:'pending'|'practiced'='pending') {
    const created=await app.addGoal('two-step-goal',{title:'合成两步学习'});
    await store.exec('INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,1,$3,$4,1)',[
      'two-step-plan',created.goalId,JSON.stringify([{id:'first-step',title:'第一步需求',objective:'解释需求',state},{id:'second-step',title:'第二步测试',objective:'解释测试',state}]),'合成计划']);
    await execute(created.runId);return created;
  }
  async function mockModel(reply: (instruction: string,context:string) => unknown) {
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      const requestBody=JSON.parse(body);const value = reply(requestBody.messages[0].content,requestBody.messages[1].content);
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
  it.each([false,true])('assesses the delivered source version after an update (archived=%s) and prepares only current active sources',async archived=>{
    const source=await app.importSource('pinned-source',{title:'原版概念',content:'original-evidence 原始定义：需求描述希望发生的行为。'});
    const contexts:Array<{instruction:string;text:string}>=[];
    await mockModel((instruction,text)=>{
      contexts.push({instruction,text});
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求定义',objective:'解释需求'}],rationale:'先练习概念'};
      const sources=JSON.parse(text.split('\n')[1]!).originalSources;
      if(instruction.includes('评阅最新'))return {verdict:'retry',feedback:'继续解释具体行为。',evidence:'回答中只有关键词。',answerQuotes:['需求就是行为。'],citationRefs:sources};
      return {content:'根据提供的资料解释需求。',sourceIds:sources.map((citation:{sourceId:string})=>citation.sourceId)};
    });
    const created=await app.addGoal('pinned-goal',{title:'解释需求',sourceIds:[source.id]});await execute(created.runId);
    const first=(await app.session(created.sessionId)).session;expect(first.citations[0]).toMatchObject({version:1,title:'原版概念'});
    const updated=await app.updateSource('new-edition',source.id,{revision:source.revision,title:'新版概念',content:'new-evidence 新版定义：需求描述可观察的行为和约束。'});
    if(archived)await app.archiveSource('archive-edition',source.id,{revision:updated.revision,archived:true});
    const feedback=await app.feedback('pinned-answer',first.id,{revision:first.revision,answer:'需求就是行为。'});await execute(feedback.runId);
    const assessment=contexts.find(call=>call.instruction.includes('评阅最新'))!;
    expect(assessment.text).toContain('original-evidence');expect(assessment.text).toContain('"version":1');expect(assessment.text).toContain('原版概念');expect(assessment.text).not.toContain('new-evidence');
    const next=contexts.filter(call=>call.instruction.includes('准备当前知识点')).at(-1)!;
    const provided=JSON.parse(next.text.split('\n')[1]!).originalSources;
    expect(provided).toEqual(archived?[]:[expect.objectContaining({sourceId:source.id,version:2,title:'新版概念',quote:expect.stringContaining('new-evidence')})]);
    const detail=await app.session(first.id);expect(detail.session.state).toBe('waiting_feedback');expect(detail.attempts[0]).toMatchObject({verdict:'retry',source:'model_estimate'});
    // Archival cannot destroy the original exercise citation or silently remove the goal link.
    expect((await app.source(source.id,1)).content).toContain('original-evidence');
    await app.changeGoal('pause-with-archive',created.goalId,{revision:(await app.goal(created.goalId)).goal.revision,status:'paused'});
    if(archived)await expect(app.addGoal('new-goal-archived',{title:'新目标',sourceIds:[source.id]})).rejects.toThrow('已归档');
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
    await store.exec("INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES('work-only','work','工作事务专属规则',1,true,true),('study-only','study','学习任务专属规则',1,true,true),('correction','correction','先提供数据库反例',1,true,true),('disabled','correction','停用的纠正',1,true,false),('unconfirmed','fact','未确认推测',1,false,true)");
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      const input = JSON.parse(body), instruction = input.messages[0].content; calls++; prompts.push(input.messages[1].content);
      const supplied=JSON.parse(input.messages[1].content.split('\n')[1]!).originalSources;
      const content = instruction.includes('拆成 1–6') ? { steps: [{ title: '理解需求', objective: '说清需求' }, { title: '验证需求', objective: '设计测试' }], rationale: '先理解，再验证。' }
        : instruction.includes('评阅最新') ? { verdict: 'pass', feedback: '回答准确区分了期望行为与验证方法。', evidence: '用户回答提到了需求和测试的不同作用。',answerQuotes:['需求定义期望行为，测试验证实现是否满足需求。'],citationRefs:supplied }
          : { content: '请解释当前知识点，并举例。', sourceIds: supplied.map((item:{sourceId:string})=>item.sourceId) };
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
    expect(prompts.every(p => p.includes('学习任务专属规则') && p.includes('先提供数据库反例') && !p.includes('工作事务专属规则') && !p.includes('停用的纠正'))).toBe(true);
    expect(prompts.every(p => p.split('generatedConversationContext')[0]!.includes('未确认推测'))).toBe(false);
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
    await mockModel((instruction,text) => instruction.includes('拆成 1–6') ? { steps: [{ title: '需求', objective: '解释' }], rationale: '先解释。' } : instruction.includes('评阅最新') ? { verdict: 'pass', feedback: '很好。', evidence: '  ' } : { content: '请解释需求。', sourceIds: JSON.parse(text.split('\n')[1]!).originalSources.map((item:{sourceId:string})=>item.sourceId) });
    const created = await goal(); await execute(created.runId);
    const session = (await app.session(created.sessionId)).session;
    const reply = await app.feedback('answer', session.id, { revision: session.revision, answer: '不确定' }); await execute(reply.runId);
    const detail = await app.goal(created.goalId);
    expect(detail.attempts[0]!.verdict).toBe('unclear'); expect(detail.attempts[0]!.feedback).toContain('可核对');
    expect(detail.plan!.steps[0]!.state).toBe('practicing');
  });
  it('honours disabled source sharing on each call, including a complete endpoint URL', async () => {
    const prompts: string[] = [];
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      prompts.push(JSON.parse(body).messages[1].content);
      response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'合成回答',sourceIds:[]})}}]}));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const llm={base_url:'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/v1/chat/completions',model:'fixture',tools:false};
    await writeFile(join(folder,'config.json'),JSON.stringify({llm}));
    const created=await goal(), run=(await claimRun(store,created.runId))!;
    const gateway=new ModelGateway(store,folder,{runId:created.runId,generation:run.generation});
    const context={task:'练习',latest:'回答',previous:'旧摘录含保密资料标题',rules:['已确认的纠正'],notes:[],sources:[{sourceId:'private',version:1,title:'保密资料标题',start:0,end:9,quote:'不得外发的资料正文',digest:'synthetic'}]};
    await gateway.json(ModelLesson,'测试',context);
    expect(prompts[0]).not.toContain('保密资料标题');expect(prompts[0]).not.toContain('不得外发');expect(gateway.providedSourceIds).toEqual([]);
    expect(gateway.providedCitations).toEqual([]);expect(gateway.exerciseComplete).toBe(false);
    await writeFile(join(folder,'config.json'),JSON.stringify({llm:{...llm,tools:true}}));
    await gateway.json(ModelLesson,'测试',context);
    expect(prompts[1]).toContain('不得外发');expect(gateway.providedSourceIds).toEqual(['private']);
    expect(gateway.providedCitations).toEqual(context.sources);expect(gateway.exerciseComplete).toBe(true);
  });
  it('keeps fabricated model evidence in an audit but does not use it to advance the plan',async()=>{
    await mockModel((instruction,text)=>{
      const supplied=JSON.parse(text.split('\n')[1]!).originalSources;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求',objective:'解释需求'}],rationale:'合成计划'};
      if(instruction.includes('评阅最新'))return {verdict:'pass',feedback:'已经完全掌握。',evidence:'声称用户给出了充分解释。',answerQuotes:['这段完整解释从未由用户提交'],citationRefs:supplied,providerExtra:'保留原始模型返回'};
      return {content:'解释需求与测试的区别。',sourceIds:supplied.map((item:{sourceId:string})=>item.sourceId)};
    });
    const created=await goal();await execute(created.runId);const session=(await app.session(created.sessionId)).session;
    const answer=await app.feedback('fabricated-answer',session.id,{revision:session.revision,answer:'我不知道'});await execute(answer.runId);
    const detail=await app.goal(created.goalId);expect(detail.attempts[0]).toMatchObject({verdict:'unclear',source:'model_estimate'});expect(detail.attempts[0]!.feedback).not.toContain('完全掌握');expect(detail.plan!.steps[0]!.state).toBe('practicing');
    const audits=await store.rows("SELECT content,citations FROM app.artifacts WHERE session_id=$1 AND kind='assessment_audit'",[session.id]);expect(audits).toHaveLength(1);
    const audit=JSON.parse(audits[0]!.content);expect(audit.modelResponse).toMatchObject({verdict:'pass',providerExtra:'保留原始模型返回'});expect(audit.accepted.verdict).toBe('unclear');expect(audit.reasons).toContain('invalid_answer_quote');expect(audit.providedCitations[0].version).toBe(1);expect(audit.exercise.complete).toBe(true);
    expect(await claimRun(store,answer.runId)).toBeNull();expect((await store.one("SELECT count(*) n FROM app.artifacts WHERE kind='assessment_audit'"))!.n).toBe('1');
  });
  it('does not automatically pass when sharing is disabled after the exercise was delivered',async()=>{
    const contexts:string[]=[];
    await mockModel((instruction,text)=>{
      const supplied=JSON.parse(text.split('\n')[1]!).originalSources;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求',objective:'解释需求'}],rationale:'合成计划'};
      if(instruction.includes('评阅最新')){contexts.push(text);return {verdict:'pass',feedback:'正确',evidence:'模型自由判断',answerQuotes:['需求是期望行为'],citationRefs:[]};}
      return {content:'私有练习标记：解释需求与测试。',sourceIds:supplied.map((item:{sourceId:string})=>item.sourceId)};
    });
    const created=await goal();await execute(created.runId);const session=(await app.session(created.sessionId)).session;
    const configPath=join(folder,'config.json'),settings=JSON.parse(await (await import('node:fs/promises')).readFile(configPath,'utf8'));settings.llm.tools=false;await writeFile(configPath,JSON.stringify(settings));
    const answer=await app.feedback('private-evidence',session.id,{revision:session.revision,answer:'需求是期望行为'});await execute(answer.runId);
    expect(contexts[0]).not.toContain('私有练习标记');expect(contexts[0]).not.toContain('测试可以检验');expect((await app.goal(created.goalId)).attempts[0]!.verdict).toBe('unclear');
    const audit=JSON.parse((await store.one("SELECT content FROM app.artifacts WHERE kind='assessment_audit'"))!.content);expect(audit.reasons).toContain('missing_exercise');expect(audit.reasons).toContain('missing_sources');
  });
  it('sends the complete long exercise to assessment and records only actually supplied citation chunks',async()=>{
    const exercises:string[]=[],deliveredSources:Array<Array<{sourceId:string;start:number;end:number}>>=[];
    const exercise='题目开头必须可见：说明需求。'+'解释'.repeat(4500)+'练习结尾。';
    await mockModel((instruction,text)=>{
      const prior=JSON.parse(text.split('\n')[1]!),supplied=prior.originalSources;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求',objective:'解释'}],rationale:'合成计划'};
      if(instruction.includes('评阅最新')){exercises.push(prior.generatedConversationContext);return {verdict:'pass',feedback:'与给定定义一致',evidence:'回答中的期望行为对应资料定义。',answerQuotes:['需求是期望行为'],citationRefs:supplied};}
      deliveredSources.push(supplied);return {content:exercise,sourceIds:supplied.map((item:{sourceId:string})=>item.sourceId)};
    });
    const created=await goal();await execute(created.runId);const session=(await app.session(created.sessionId)).session;
    const feedback=await app.feedback('long-exercise',session.id,{revision:session.revision,answer:'需求是期望行为'});await execute(feedback.runId);
    expect(exercises).toEqual([exercise]);expect((await app.goal(created.goalId)).attempts[0]!.verdict).toBe('pass');
    expect(session.citations.map(({sourceId,start,end}:{sourceId:string;start:number;end:number})=>({sourceId,start,end}))).toEqual(deliveredSources[0]!.map(({sourceId,start,end})=>({sourceId,start,end})));
  });
  it.each([true,false])('updates a practiced step only when an incorrect review has traceable evidence (valid=%s)',async valid=>{
    await mockModel((instruction,text)=>{
      const supplied=JSON.parse(text.split('\n')[1]!).originalSources,answer=JSON.parse(text.split('\n')[0]!).latestUserInput;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求',objective:'解释'}],rationale:'合成计划'};
      if(instruction.includes('评阅最新'))return {verdict:answer==='错误回答'?'retry':'pass',feedback:answer==='错误回答'?'需要重新区分需求和测试。':'与定义一致。',evidence:'合成评阅说明',answerQuotes:[answer==='错误回答'&&!valid?'伪造的用户陈述':answer],citationRefs:supplied};
      return {content:'说明需求和测试的区别。',sourceIds:supplied.map((item:{sourceId:string})=>item.sourceId)};
    });
    const created=await goal();await execute(created.runId);const first=(await app.session(created.sessionId)).session;
    const passed=await app.feedback('first-pass',first.id,{revision:first.revision,answer:'需求定义期望行为，测试检验这些行为。'});await execute(passed.runId);expect((await app.goal(created.goalId)).plan!.steps[0]!.state).toBe('practiced');
    await store.exec("UPDATE app.goals SET next_review=now()-interval '1 second' WHERE id=$1",[created.goalId]);await new Scheduler(store,boss).tick();
    const queued=(await store.one("SELECT * FROM app.sessions WHERE goal_id=$1 AND state='queued'",[created.goalId]))!;await execute(queued.current_run_id);const review=(await app.session(queued.id)).session;
    const wrong=await app.feedback('review-wrong',review.id,{revision:review.revision,answer:'错误回答'});await execute(wrong.runId);
    const result=await app.goal(created.goalId);expect(result.plan!.steps[0]!.state).toBe(valid?'practicing':'practiced');expect(result.goal.reviewStage).toBe(valid?0:1);expect(result.goal.status).toBe('active');expect(result.attempts.map(row=>row.verdict).sort()).toEqual(['pass',valid?'retry':'unclear']);
    expect((await store.rows('SELECT steps FROM app.plans WHERE goal_id=$1',[created.goalId])).some(row=>row.steps[0].state==='practiced')).toBe(true);expect((await app.session(review.id)).session.state).toBe('waiting_feedback');
  });
  it.each((['pass','retry','unclear'] as const).flatMap(verdict=>[false,true].map(legacy=>({verdict,legacy}))))('continues after committed $verdict without applying the old answer again (legacy receipt=$legacy)',async({verdict,legacy})=>{
    let assessments=0,lessons=0,failPreparation=true;
    const preparedTasks:string[]=[];
    await mockModel((instruction,text)=>{
      const supplied=JSON.parse(text.split('\n')[1]!).originalSources;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'第一步需求',objective:'解释需求'},{title:'第二步测试',objective:'设计测试'}],rationale:'两步合成计划'};
      if(instruction.includes('评阅最新')){
        assessments++;
        return {verdict,feedback:'原始评阅反馈',evidence:'原始评阅解释',answerQuotes:['需求是期望行为'],citationRefs:supplied,providerExtra:'应保持不变'};
      }
      lessons++;preparedTasks.push(JSON.parse(text.split('\n')[0]!).task);
      return {content:'第 '+lessons+' 次准备练习',sourceIds:failPreparation&&lessons>1?['not-provided']:supplied.map((item:{sourceId:string})=>item.sourceId)};
    });
    const created=await goal();await execute(created.runId);const first=(await app.session(created.sessionId)).session;
    const answer=await app.feedback('old-answer',first.id,{revision:first.revision,answer:'需求是期望行为'});
    await expect(execute(answer.runId)).rejects.toThrow('未提供的资料');
    const current=(await store.one('SELECT generation FROM app.runs WHERE id=$1',[answer.runId]))!;
    await failRun(store,{runId:answer.runId,generation:current.generation},'合成的后续准备失败',true);
    const before=(await app.session(first.id)),attempt=before.attempts[0]!;
    const initialPlan=(await app.goal(created.goalId)).plan!;
    const auditBefore=(await store.one("SELECT * FROM app.artifacts WHERE dedupe_key=$1",['assessment-audit:'+attempt.id]))!;
    const receipt=(await store.one('SELECT value FROM app.settings WHERE key=$1',['assessment:'+attempt.id]))!.value;
    expect(receipt).toMatchObject({attemptId:attempt.id,verdict,assessedStepId:initialPlan.steps[0]!.id,stepId:initialPlan.steps[verdict==='pass'?1:0]!.id,done:false});
    expect(JSON.parse(auditBefore.content)).toMatchObject({attemptId:attempt.id,stepId:receipt.assessedStepId,accepted:{verdict},exercise:{artifactId:receipt.artifactId}});
    if(legacy)await store.exec('DELETE FROM app.settings WHERE key=$1',['assessment:'+attempt.id]);
    // A later artifact with no binding cannot redirect an already committed
    // assessment. Recovery must use the attempt receipt, including legacy ones.
    await store.exec("INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,dedupe_key) VALUES('later-unbound-lesson',$1,NULL,'lesson','稍后出现的合成材料','local_guidance','later-unbound-lesson')",[first.id]);
    failPreparation=false;
    const resumed=await app.retry('manual-retry',first.id,before.session.revision);await execute(resumed.runId);
    const after=await app.session(first.id),plan=(await app.goal(created.goalId)).plan!;
    expect(assessments).toBe(1);expect(after.attempts).toEqual(before.attempts);expect(after.session.state).toBe('waiting_feedback');
    expect(plan.steps.map(step=>step.state)).toEqual(verdict==='pass'?['practiced','practicing']:['practicing','pending']);
    expect(preparedTasks.at(-1)).toContain(verdict==='pass'?'第二步测试':'第一步需求');
    expect((await store.rows("SELECT * FROM app.artifacts WHERE kind='assessment_audit' AND session_id=$1",[first.id]))).toEqual([auditBefore]);
    expect((await store.one("SELECT count(*) n FROM app.events WHERE kind='attempt.assessed' AND data->>'attemptId'=$1",[attempt.id]))!.n).toBe('1');
  });
  it('closes a completed two-step study instead of applying a new answer to another review point',async()=>{
    const created=await twoStepGoal();
    for(let index=0;index<2;index++){
      const session=(await app.session(created.sessionId)).session;
      const answer=await app.feedback('two-step-answer-'+index,session.id,{revision:session.revision,answer:'本人已练习这一步',selfReport:'understood'});await execute(answer.runId);
    }
    const before=await app.session(created.sessionId),planBefore=(await app.goal(created.goalId)).plan;
    expect(before.session.state).toBe('completed');expect(planBefore!.steps.map(step=>step.state)).toEqual(['practiced','practiced']);
    const delivered=(await store.one("SELECT content FROM app.artifacts WHERE session_id=$1 AND kind='lesson' ORDER BY created_at DESC,id DESC LIMIT 1",[created.sessionId]))!;
    expect(delivered.content).toContain('第二步测试');
    const runsBefore=await store.rows('SELECT * FROM app.runs WHERE session_id=$1 ORDER BY created_at,id',[created.sessionId]);
    await expect(app.feedback('closed-two-step',created.sessionId,{revision:before.session.revision,answer:'第二步还需要练习',selfReport:'need_practice'})).rejects.toMatchObject({code:'state_conflict'});
    expect(await app.session(created.sessionId)).toEqual(before);expect((await app.goal(created.goalId)).plan).toEqual(planBefore);
    expect(await store.rows('SELECT * FROM app.runs WHERE session_id=$1 ORDER BY created_at,id',[created.sessionId])).toEqual(runsBefore);
  });
  it('binds a pending answer to its delivered step when manual retry sees a different review index',async()=>{
    const created=await twoStepGoal('practiced'),first=(await app.session(created.sessionId)).session;
    expect(first.content).toContain('第一步需求');
    const answer=await app.feedback('pending-review',first.id,{revision:first.revision,answer:'第一步还需要练习',selfReport:'need_practice'});
    const claimed=(await claimRun(store,answer.runId))!;await failRun(store,{runId:answer.runId,generation:claimed.generation},'评阅前合成中断',true);
    await store.exec("INSERT INTO app.settings(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",['review-index:'+created.goalId]);
    const failed=(await app.session(first.id)).session,resumed=await app.retry('resume-pending-review',first.id,failed.revision);await execute(resumed.runId);
    const result=await app.goal(created.goalId),receipt=(await store.one('SELECT value FROM app.settings WHERE key=$1',['assessment:'+answer.attemptId]))!.value;
    expect(receipt).toMatchObject({assessedStepId:'first-step',stepId:'first-step',verdict:'retry'});
    expect(result.plan!.steps.map(step=>step.state)).toEqual(['practicing','practiced']);expect((await app.session(first.id)).session.content).toContain('第一步需求');
  });
  it.each(['missing_receipt','missing_run','foreign_run','removed_step'])('preserves a pending answer and learning facts when its exercise binding is %s',async fault=>{
    const created=await twoStepGoal(),first=(await app.session(created.sessionId)).session;
    const delivered=(await store.one("SELECT * FROM app.artifacts WHERE session_id=$1 AND kind='lesson' ORDER BY created_at DESC,id DESC LIMIT 1",[first.id]))!;
    if(fault==='missing_receipt')await store.exec('DELETE FROM app.settings WHERE key=$1',['runtime:'+delivered.run_id+':prepare']);
    if(fault==='missing_run')await store.exec('UPDATE app.artifacts SET run_id=NULL WHERE id=$1',[delivered.id]);
    if(fault==='foreign_run'){
      const foreign=await app.addSession('foreign-work',{prompt:'另一个会话',kind:'work'});
      await store.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)',['runtime:'+foreign.runId+':prepare',JSON.stringify({stepId:'first-step',waits:true,done:false})]);
      await store.exec('UPDATE app.artifacts SET run_id=$2 WHERE id=$1',[delivered.id,foreign.runId]);
    }
    if(fault==='removed_step'){
      const latest=(await app.goal(created.goalId)).plan!;
      await store.exec('INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,$3,$4,$5,1)',['replaced-plan',created.goalId,latest.version+1,JSON.stringify([{id:'replacement-step',title:'替换后的学习点',objective:'新的目标',state:'pending'}]),'合成的旧学习点已不存在']);
    }
    const answer=await app.feedback('unbound-'+fault,first.id,{revision:first.revision,answer:'保留这份回答',selfReport:'understood'});
    const attemptBefore=await store.one('SELECT * FROM app.attempts WHERE id=$1',[answer.attemptId]),goalBefore=(await app.goal(created.goalId)).goal;
    const plansBefore=await store.rows('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version',[created.goalId]),artifactsBefore=await store.rows('SELECT * FROM app.artifacts WHERE session_id=$1 ORDER BY created_at,id',[first.id]);
    await expect(execute(answer.runId)).rejects.toMatchObject({code:'exercise_binding_missing'});
    expect(await store.one('SELECT * FROM app.attempts WHERE id=$1',[answer.attemptId])).toEqual(attemptBefore);
    expect((await app.goal(created.goalId)).goal).toEqual(goalBefore);expect(await store.rows('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version',[created.goalId])).toEqual(plansBefore);
    expect(await store.rows('SELECT * FROM app.artifacts WHERE session_id=$1 ORDER BY created_at,id',[first.id])).toEqual(artifactsBefore);
    expect(await store.one('SELECT value FROM app.settings WHERE key=$1',['assessment:'+answer.attemptId])).toBeUndefined();
    expect((await store.one('SELECT model_calls FROM app.runs WHERE id=$1',[answer.runId]))!.model_calls).toBe(0);
    if(fault==='missing_receipt'){
      const failedRun=(await store.one('SELECT generation FROM app.runs WHERE id=$1',[answer.runId]))!;
      await failRun(store,{runId:answer.runId,generation:failedRun.generation},'这份练习的学习步骤无法核对',true);
      const pause=await app.changeGoal('pause-unbound-goal',created.goalId,{revision:goalBefore.revision,status:'paused'});
      await app.changeGoal('resume-unbound-goal',created.goalId,{revision:pause.revision,status:'active'});
      const fresh=(await store.one("SELECT * FROM app.sessions WHERE goal_id=$1 AND state='queued'",[created.goalId]))!;
      expect(fresh.id).not.toBe(first.id);await execute(fresh.current_run_id);
      const restored=(await app.session(fresh.id)).session;expect(restored.state).toBe('waiting_feedback');
      const lesson=(await store.one("SELECT a.run_id,r.session_id FROM app.artifacts a JOIN app.runs r ON r.id=a.run_id WHERE a.session_id=$1 AND a.kind='lesson' ORDER BY a.created_at DESC,a.id DESC LIMIT 1",[fresh.id]))!;
      const prepared=(await store.one('SELECT value FROM app.settings WHERE key=$1',['runtime:'+lesson.run_id+':prepare']))!.value;
      expect(lesson.session_id).toBe(fresh.id);expect(prepared).toMatchObject({stepId:'first-step',waits:true,done:false});
      expect((await app.goal(created.goalId)).plan!.steps.some(step=>step.id===prepared.stepId)).toBe(true);
      await expect(commitNode(store,{runId:answer.runId,generation:failedRun.generation},'late-after-recovery',async tx=>{
        await tx.exec("UPDATE app.attempts SET verdict='pass' WHERE id=$1",[answer.attemptId]);return {late:true};
      })).rejects.toBeInstanceOf(StaleRun);
      expect(await store.one('SELECT * FROM app.attempts WHERE id=$1',[answer.attemptId])).toEqual(attemptBefore);
      expect((await app.session(first.id)).session.state).toBe('failed');
    }
  });
  it('never attaches clipped chunks merely because their source ID was provided',async()=>{
    const supplied:Array<Array<{sourceId:string;start:number;end:number}>>=[];
    await store.exec("INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES('large-rule','study',$1,1,true,true)",['合成偏好'.repeat(4000)]);
    await mockModel((instruction,text)=>{
      const citations=JSON.parse(text.split('\n')[1]!).originalSources;
      if(instruction.includes('拆成 1–6'))return {steps:[{title:'需求',objective:'解释'}],rationale:'合成计划'};
      supplied.push(citations);return {content:'请解释需求。',sourceIds:[...new Set(citations.map((item:{sourceId:string})=>item.sourceId))]};
    });
    const original=await app.importSource('long-source',{title:'需求讲义',content:'需求定义与测试验证。'.repeat(1600)});
    const created=await app.addGoal('long-source-goal',{title:'需求',sourceIds:[original.id]});await execute(created.runId);
    const lesson=(await app.session(created.sessionId)).session;
    expect(supplied[0]!.length).toBeGreaterThan(0);expect(supplied[0]!.length).toBeLessThan(6);
    expect(lesson.citations.map(({sourceId,start,end}:{sourceId:string;start:number;end:number})=>({sourceId,start,end}))).toEqual(supplied[0]!.map(({sourceId,start,end})=>({sourceId,start,end})));
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
