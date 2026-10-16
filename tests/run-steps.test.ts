import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../packages/storage/src/index.js';
import { claimRun, commitNode, StaleRun, step } from '../packages/core/src/runtime-state.js';
import { executorKind } from '../packages/core/src/executors.js';

describe('one executor per session kind', () => {
  it('routes research, both flows and everything else', () => {
    expect(executorKind({ research: { effort: 'low' }, flow: null })).toBe('research');
    expect(executorKind({ flow: 'mail-reply' })).toBe('mail-reply');
    expect(executorKind({ flow: 'errand' })).toBe('errand');
    expect(executorKind({ flow: null })).toBe('learning');
    expect(executorKind({})).toBe('learning');
  });
});

const url = process.env.RUNTIME_TEST_DATABASE_URL;
describe.runIf(Boolean(url))('step receipts on PostgreSQL', () => {
  let store: Store;
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Isolated runtime test DB required');
    store = new Store(url!);
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
  });
  afterEach(async () => {
    await store.close();
  });
  async function run(sessionId = randomUUID(), input: Record<string, unknown> = {}) {
    const runId = randomUUID();
    await store.transaction(async (tx) => {
      if (!(await tx.one('SELECT id FROM app.sessions WHERE id=$1', [sessionId])))
        await tx.exec("INSERT INTO app.sessions(id,title,kind,prompt) VALUES($1,'合成步骤','work','回执回归')", [
          sessionId,
        ]);
      await tx.exec('INSERT INTO app.runs(id,session_id,graph_thread,input) VALUES($1,$2,$2,$3)', [
        runId,
        sessionId,
        JSON.stringify(input),
      ]);
      await tx.exec('UPDATE app.sessions SET current_run_id=$2 WHERE id=$1', [sessionId, runId]);
    });
    const claimed = (await claimRun(store, runId))!;
    return { sessionId, runId, identity: { runId, generation: claimed.generation as number } };
  }

  it('replays a finished step within the run and commits its effects with the receipt', async () => {
    const { identity, sessionId } = await run();
    let computed = 0;
    const work = () =>
      step(
        store,
        identity,
        'plan',
        { input: ['同一输入'] },
        async () => ({ n: ++computed, at: new Date('2026-10-16T00:00:00Z') }),
        async (tx, value) => {
          await tx.exec('UPDATE app.sessions SET content=$2 WHERE id=$1', [sessionId, 'plan ' + value.n]);
        },
      );
    // The live value has the receipt's JSON shape, so replay and first run read alike.
    expect(await work()).toEqual({ n: 1, at: '2026-10-16T00:00:00.000Z' });
    expect(await work()).toEqual({ n: 1, at: '2026-10-16T00:00:00.000Z' });
    expect(computed).toBe(1);
    expect((await store.one('SELECT content FROM app.sessions WHERE id=$1', [sessionId]))!.content).toBe('plan 1');
    const receipt = (await store.one('SELECT * FROM app.run_steps WHERE run_id=$1', [identity.runId]))!;
    expect(receipt).toMatchObject({ name: 'plan', output: { n: 1 }, reused_from: null });
    expect(receipt.started_at).not.toBeNull();
  });

  it('leaves no receipt when the effects fail, so the step runs again', async () => {
    const { identity } = await run();
    let computed = 0;
    await expect(
      step(
        store,
        identity,
        'mail',
        {},
        async () => ++computed,
        async () => {
          throw new Error('合成写入失败');
        },
      ),
    ).rejects.toThrow('合成写入失败');
    expect(await store.rows('SELECT * FROM app.run_steps WHERE run_id=$1', [identity.runId])).toEqual([]);
    expect(await step(store, identity, 'mail', {}, async () => ++computed)).toBe(2);
  });

  it('a restarted run reuses only unchanged steps of the run it continues, never another session', async () => {
    const first = await run();
    await step(store, first.identity, 'plan', { input: ['资料 A'] }, async () => 'old plan');
    await step(store, first.identity, 'mail', { input: ['信 A'] }, async () => 'old letter');
    await step(store, first.identity, 'note', {}, async () => 'no digest');
    await store.exec("UPDATE app.runs SET state='failed' WHERE id=$1", [first.runId]);
    const second = await run(first.sessionId, { resumeFrom: first.runId });
    let computed = 0;
    const effects: string[] = [];
    expect(
      await step(
        store,
        second.identity,
        'plan',
        { input: ['资料 A'] },
        async () => (computed++, 'new plan'),
        async (_tx, value) => void effects.push(value),
      ),
    ).toBe('old plan');
    // A changed input means new information: the step is done again.
    expect(
      await step(store, second.identity, 'mail', { input: ['信 B'] }, async () => (computed++, 'new letter')),
    ).toBe('new letter');
    // A step without an input digest cannot prove it is unchanged.
    expect(await step(store, second.identity, 'note', {}, async () => (computed++, 'fresh'))).toBe('fresh');
    expect(computed).toBe(2);
    // Reused results still apply to the current run.
    expect(effects).toEqual(['old plan']);
    expect(
      await store.rows('SELECT name,reused_from FROM app.run_steps WHERE run_id=$1 ORDER BY name', [second.runId]),
    ).toEqual([
      { name: 'mail', reused_from: null },
      { name: 'note', reused_from: null },
      { name: 'plan', reused_from: first.runId },
    ]);

    const other = await run(undefined, { resumeFrom: first.runId });
    expect(await step(store, other.identity, 'plan', { input: ['资料 A'] }, async () => 'own plan')).toBe('own plan');
  });

  it('rejects the result of a run that was cancelled or replaced while the step was working', async () => {
    const { identity, runId } = await run();
    await expect(
      step(store, identity, 'plan', {}, async () => {
        await store.exec('UPDATE app.runs SET generation=generation+1 WHERE id=$1', [runId]);
        return 'late';
      }),
    ).rejects.toBeInstanceOf(StaleRun);
    expect(await store.rows('SELECT * FROM app.run_steps WHERE run_id=$1', [runId])).toEqual([]);
    await expect(commitNode(store, identity, 'prepare', async () => ({ late: true }))).rejects.toBeInstanceOf(StaleRun);
  });

  it('migration 0016 moves runtime receipts out of the settings table and keeps everything else', async () => {
    const { runId } = await run();
    await store.exec(
      'DROP TABLE app.model_calls; DROP TABLE app.run_steps; DELETE FROM app.migrations WHERE version=16',
    );
    await store.exec(
      `INSERT INTO app.settings(key,value) VALUES
      ('runtime:${runId}:prepare','{"stepId":"s1","waits":true}'),
      ('runtime:${runId}:late-after-recovery','{"late":true}'),
      ('runtime:missing-run:plan','{"kept":true}'),
      ('assessment:a1','{"verdict":"pass"}')`,
    );
    await store.migrate();
    expect(await store.rows('SELECT name,output FROM app.run_steps WHERE run_id=$1 ORDER BY name', [runId])).toEqual([
      { name: 'late-after-recovery', output: { late: true } },
      { name: 'prepare', output: { stepId: 's1', waits: true } },
    ]);
    expect((await store.rows('SELECT key FROM app.settings ORDER BY key')).map((row) => row.key)).toEqual([
      'assessment:a1',
      'runtime:missing-run:plan',
    ]);
  });
});
