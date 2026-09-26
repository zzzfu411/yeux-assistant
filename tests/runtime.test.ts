import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fork, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../packages/storage/src/index.js';
import { Application } from '../packages/core/src/application.js';
import { createBoss } from '../packages/core/src/queue.js';
import { initializeData } from '../packages/core/src/config.js';
import { openCheckpoints } from '../packages/core/src/learning.js';
import { RunSupervisor, startWorker } from '../packages/core/src/runtime.js';
import { putSource } from '../packages/core/src/knowledge.js';
import { digest } from '../packages/core/src/common.js';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Condition did not become true within the test deadline');
};

describe.runIf(Boolean(url))('supervised execution processes', () => {
  let store: Store, boss: Awaited<ReturnType<typeof createBoss>>, app: Application, folder: string, supervisor: RunSupervisor, worker: Awaited<ReturnType<typeof startWorker>> | undefined, server: Server | undefined, parent: ChildProcess | undefined;
  let calls: number, holding: boolean, awaitingRequests: Array<() => void>, concurrent: number, maximum: number;
  const previousURL = process.env.DATABASE_URL, previousFolder = process.env.ASSISTANT_DATA;
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Runtime tests require an isolated *_runtime_test database');
    store = new Store(url!); await store.pool.query('DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS app CASCADE'); await store.migrate();
    boss = await createBoss(url!, false);
    const saver = await openCheckpoints(url!, true); await saver.end();
    folder = await mkdtemp(join(tmpdir(), 'assistant-process-')); const token = await initializeData(folder); app = new Application(store, boss, folder, token);
    process.env.DATABASE_URL = url!; process.env.ASSISTANT_DATA = folder;
    supervisor = new RunSupervisor(store);
    calls = 0; holding = false; awaitingRequests = []; concurrent = 0; maximum = 0;
  });
  afterEach(async () => {
    if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); parent = undefined;
    if (worker) await worker.stop(); worker = undefined;
    await supervisor.stop(); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined;
    await boss.stop(); await store.close(); await rm(folder, { recursive: true, force: true });
    if (previousURL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousURL;
    if (previousFolder === undefined) delete process.env.ASSISTANT_DATA; else process.env.ASSISTANT_DATA = previousFolder;
  });
  async function localModel() {
    server = createServer(async (request, response) => {
      let body = ''; for await (const piece of request) body += piece;
      const input = JSON.parse(body), instruction = input.messages[0].content; calls++; concurrent++; maximum = Math.max(maximum, concurrent);
      let ended = false;
      response.once('close', () => { if (!ended) { ended = true; concurrent--; } });
      const finish = () => {
        if (response.destroyed) return;
        const content = instruction.includes('拆成 1–6') ? { steps: [{ title: '理解需求', objective: '解释需求' }], rationale: '从一个问题开始。' } : { content: '请解释什么是需求，并举例。', sourceIds: [] };
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      };
      if (holding) awaitingRequests.push(finish); else finish();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    await writeFile(join(folder, 'config.json'), JSON.stringify({ llm: { base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', model: 'mock' } }));
  }
  it('runs the actual child graph and frees its slot while waiting for an answer', async () => {
    const created = await app.addGoal('first', { title: '理解软件工程需求' });
    await supervisor.handle(created.runId);
    expect((await app.session(created.sessionId)).session.state).toBe('waiting_feedback');
    expect(supervisor.children.size).toBe(0);
    expect((await store.one('SELECT state FROM app.runs WHERE id=$1', [created.runId]))!.state).toBe('succeeded');
  });
  it('honors empty goal bindings and keeps course/page provenance on selected-source fallback', async () => {
    const content='关系代数使用选择和投影表达查询。';
    await store.transaction(async tx=>{
      await putSource(tx,{id:'course-synthetic',title:'数据库讲义',content,metadata:{course:'database',courseName:'数据库',originPath:'database/slides/synthetic.pdf',originHash:digest('original'),format:'pdf',extraction:'test',warnings:[],pages:[{number:3,start:0,end:content.length}]}});
      await putSource(tx,{id:'unselected',title:'其他课程',content:'关系代数的未选中材料'});
    });
    const empty=await app.addGoal('empty-bindings',{title:'关系代数',sourceIds:[]});await supervisor.handle(empty.runId);
    expect((await app.session(empty.sessionId)).session.citations).toEqual([]);
    const selected=await app.addGoal('selected-bindings',{title:'UnmatchedTopic',sourceIds:['course-synthetic']});await supervisor.handle(selected.runId);
    const citations=(await app.session(selected.sessionId)).session.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({sourceId:'course-synthetic',course:'database',location:'第 3 页',quote:content});
  });
  it('kills a hanging child at the persisted hard deadline and leaves another task usable', async () => {
    holding = true; await localModel();
    const created = await app.addGoal('first', { title: '理解软件工程需求' });
    await store.exec("UPDATE app.runs SET deadline=now()+interval '2 seconds' WHERE id=$1", [created.runId]);
    await supervisor.handle(created.runId);
    expect(calls).toBeGreaterThan(0); expect(supervisor.children.size).toBe(0);
    expect((await app.session(created.sessionId)).session.state).toBe('failed');
    holding = false;
    const another = await app.addGoal('second', { title: '理解测试' }); await supervisor.handle(another.runId);
    expect((await app.session(another.sessionId)).session.state).toBe('waiting_feedback');
  });
  it('reaps a cancelled model call before freeing its execution slot', async () => {
    holding = true; await localModel();
    const created = await app.addGoal('first', { title: '理解软件工程需求' });
    const running = supervisor.handle(created.runId);
    await waitUntil(() => calls > 0); const pid = supervisor.children.get(created.runId)!.pid!;
    await app.cancel('cancel', created.runId); await running;
    expect(() => process.kill(pid, 0)).toThrow(); expect(supervisor.children.size).toBe(0);
    expect((await store.one('SELECT count(*) n FROM app.artifacts WHERE session_id=$1', [created.sessionId]))!.n).toBe('0');
    expect((await app.session(created.sessionId)).session.state).toBe('cancelled');
  });
  it('limits real pg-boss work to two children and continues queued goals as slots free', async () => {
    holding = true; await localModel();
    for (let i = 0; i < 3; i++) await app.addGoal('goal-' + i, { title: '理解需求 ' + i });
    worker = await startWorker(store, boss, folder);
    await waitUntil(() => calls >= 2);
    expect(worker.supervisor.children.size).toBe(2); expect(calls).toBe(2);
    holding = false; awaitingRequests.splice(0).forEach(finish => finish());
    await waitUntil(async () => Number((await store.one("SELECT count(*) n FROM app.sessions WHERE state='waiting_feedback'"))!.n) === 3);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(await store.one("SELECT name FROM app.health WHERE name='worker'")).toBeDefined();
  });
  it('a child exits when its supervisor dies and the same run resumes with its original model budget', async () => {
    holding = true; await localModel();
    const created = await app.addGoal('first', { title: '理解软件工程需求' });
    const claimedJobs = await boss.fetch('learning', { batchSize: 1 });
    expect(claimedJobs).toHaveLength(1);
    const entry = join(folder, 'supervisor-fixture.mjs');
    await writeFile(entry, `import {Store} from ${JSON.stringify(pathToFileURL(resolve('packages/storage/src/index.ts')).href)};
import {RunSupervisor} from ${JSON.stringify(pathToFileURL(resolve('packages/core/src/runtime.ts')).href)};
const store=new Store(), supervisor=new RunSupervisor(store);
const task=supervisor.handle(process.argv[2]);
const timer=setInterval(()=>{const child=supervisor.children.get(process.argv[2]);if(child?.pid)process.send({childPid:child.pid});},20);
await task;clearInterval(timer);await store.close();process.exit(0);`);
    let childPid = 0;
    parent = fork(entry, [created.runId], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
    parent.on('message', (value: any) => { if (value.childPid) childPid = value.childPid; });
    await waitUntil(() => calls === 1 && childPid > 0);
    const killed = new Promise<void>(resolve => parent!.once('close', () => resolve())); parent.kill('SIGKILL'); await killed;
    await waitUntil(() => { try { process.kill(childPid, 0); return false; } catch { return true; } });
    holding = false;
    worker = await startWorker(store, boss, folder);
    await waitUntil(async () => (await store.one('SELECT state FROM app.runs WHERE id=$1', [created.runId]))!.state === 'succeeded');
    const run = (await store.one('SELECT * FROM app.runs WHERE id=$1', [created.runId]))!;
    expect(run.generation).toBe(2); expect(run.model_calls).toBe(3); expect(run.state).toBe('succeeded');
    expect((await app.session(created.sessionId)).session.state).toBe('waiting_feedback');
    expect((await boss.findJobs('learning', { id: claimedJobs[0]!.id }))[0]!.state).toBe('cancelled');
  });
});
