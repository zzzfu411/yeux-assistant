import { AsyncLocalStorage } from 'node:async_hooks';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import { AppError, digest, event, notify } from './common.js';
import { lockSession } from './sessions.js';

export class StaleRun extends Error {
  constructor() {
    super('执行已取消或被新的操作替代。');
  }
}
export class RuntimeLimit extends AppError {
  constructor(message: string) {
    super(message, 409, 'runtime_limit');
  }
}
export type RunIdentity = { runId: string; generation: number };

/** The goal → session → run lock order is shared with interactive commands. */
export async function fence(tx: Tx, identity: RunIdentity) {
  const before = await tx.one('SELECT session_id FROM app.runs WHERE id=$1', [identity.runId]);
  if (!before) throw new StaleRun();
  const session = await lockSession(tx, before.session_id);
  const run = await tx.one('SELECT * FROM app.runs WHERE id=$1 FOR UPDATE', [identity.runId]);
  if (!run || run.generation !== identity.generation || run.state !== 'running' || session.current_run_id !== run.id)
    throw new StaleRun();
  const goal = session.goal_id ? await tx.one('SELECT * FROM app.goals WHERE id=$1', [session.goal_id]) : null;
  if (goal && goal.status !== 'active') throw new StaleRun();
  if (!run.deadline || new Date(run.deadline).getTime() <= Date.now())
    throw new RuntimeLimit('本次运行已达到时间上限，已保存的进度可查看。');
  return { run, session, goal };
}

export async function readContext(store: Store, identity: RunIdentity) {
  return store.transaction((tx) => fence(tx, identity));
}

type Fenced = Awaited<ReturnType<typeof fence>>;
/** The step a model request belongs to, so every call in the trace has a name. */
export const currentStep = new AsyncLocalStorage<{ name: string }>();
export const traced = <T>(name: string, work: () => Promise<T>) => currentStep.run({ name }, work);

/** A receipt and all business effects commit together; replay returns that receipt. */
export async function commitNode<T>(
  store: Store,
  identity: RunIdentity,
  node: string,
  work: (tx: Tx, context: Fenced) => Promise<T>,
): Promise<T> {
  return store.transaction(async (tx) => {
    const context = await fence(tx, identity);
    const saved = await tx.one('SELECT output FROM app.run_steps WHERE run_id=$1 AND name=$2', [identity.runId, node]);
    if (saved) return saved.output as T;
    const result = await work(tx, context);
    await tx.exec('INSERT INTO app.run_steps(run_id,name,output) VALUES($1,$2,$3)', [
      identity.runId,
      node,
      JSON.stringify(result ?? null),
    ]);
    return result;
  });
}

export async function nodeReceipt<T>(store: Store, identity: RunIdentity, node: string): Promise<T | undefined> {
  return store.transaction(async (tx) => {
    await fence(tx, identity);
    return (await tx.one('SELECT output FROM app.run_steps WHERE run_id=$1 AND name=$2', [identity.runId, node]))
      ?.output as T | undefined;
  });
}

/**
 * One step of any flow. The work runs outside a transaction (model calls belong there); its result
 * and `commit` effects then land in one fenced transaction with the receipt. A retry of the same run
 * replays the receipt. A run the owner restarted (`input.resumeFrom`) reuses the earlier run's
 * receipt only when the step's input digest is unchanged, so new answers always get fresh work.
 */
export async function step<T>(
  store: Store,
  identity: RunIdentity,
  name: string,
  options: { input?: unknown },
  compute: () => Promise<T>,
  commit?: (tx: Tx, value: T, context: Fenced) => Promise<void>,
): Promise<T> {
  const inputDigest = options.input === undefined ? '' : digest(options.input);
  const found = await store.transaction(async (tx) => {
    const context = await fence(tx, identity);
    const own = await tx.one('SELECT output FROM app.run_steps WHERE run_id=$1 AND name=$2', [identity.runId, name]);
    if (own) return { value: own.output as T };
    const prior = typeof context.run.input?.resumeFrom === 'string' ? context.run.input.resumeFrom : null;
    if (!prior || !inputDigest) return null;
    const earlier = await tx.one(
      `SELECT st.output FROM app.run_steps st JOIN app.runs r ON r.id=st.run_id
      WHERE st.run_id=$1 AND st.name=$2 AND st.input_digest=$3 AND r.session_id=$4`,
      [prior, name, inputDigest, context.session.id],
    );
    if (!earlier) return null;
    await tx.exec(
      'INSERT INTO app.run_steps(run_id,name,input_digest,output,reused_from,started_at) VALUES($1,$2,$3,$4,$5,now())',
      [identity.runId, name, inputDigest, JSON.stringify(earlier.output), prior],
    );
    await commit?.(tx, earlier.output as T, context);
    return { value: earlier.output as T };
  });
  if (found) return found.value;
  const started = new Date();
  // A receipt is JSON; the live value takes the same shape so replay and first run behave alike.
  const value = JSON.parse(JSON.stringify((await traced(name, compute)) ?? null)) as T;
  return store.transaction(async (tx) => {
    const context = await fence(tx, identity);
    const inserted = await tx.one(
      'INSERT INTO app.run_steps(run_id,name,input_digest,output,started_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,name) DO NOTHING RETURNING name',
      [identity.runId, name, inputDigest, JSON.stringify(value), started],
    );
    if (!inserted)
      return (await tx.one('SELECT output FROM app.run_steps WHERE run_id=$1 AND name=$2', [identity.runId, name]))!
        .output as T;
    await commit?.(tx, value, context);
    return value;
  });
}

/** A provider-side failure that may succeed when the same step is asked again. */
export const transient = (error: unknown) =>
  error instanceof AppError && error.status >= 500 && error.code !== 'model_time_budget';

export async function claimRun(store: Store, runId: string): Promise<Row | null> {
  return store.transaction(async (tx) => {
    const before = await tx.one('SELECT session_id FROM app.runs WHERE id=$1', [runId]);
    if (!before) return null;
    const session = await lockSession(tx, before.session_id);
    const run = await tx.one('SELECT * FROM app.runs WHERE id=$1 FOR UPDATE', [runId]);
    if (!run || !['queued', 'running'].includes(run.state) || session.current_run_id !== runId) return null;
    if (
      session.goal_id &&
      (await tx.one('SELECT status FROM app.goals WHERE id=$1', [session.goal_id]))?.status !== 'active'
    )
      return null;
    if (run.generation >= 3 || (run.deadline && new Date(run.deadline).getTime() <= Date.now())) {
      const message =
        run.generation >= 3 ? '本次运行重试次数已用完，请查看后重试。' : '本次运行已达到时间上限，已保存的进度可查看。';
      await tx.exec("UPDATE app.runs SET state='failed',error=$2,finished_at=now() WHERE id=$1", [runId, message]);
      await tx.exec(
        "UPDATE app.sessions SET state='failed',error=$2,revision=revision+1,updated_at=now() WHERE id=$1",
        [session.id, message],
      );
      await notify(tx, `failed:${runId}`, session.id, '这次学习需要处理', message);
      await event(tx, 'run.failed', session.id, { runId, error: message });
      return null;
    }
    const claimed = (await tx.one(
      `UPDATE app.runs SET state='running',generation=generation+1,
      started_at=coalesce(started_at,now()),deadline=coalesce(deadline,now()+max_seconds*interval '1 second'),error=''
      WHERE id=$1 RETURNING *`,
      [runId],
    ))!;
    await tx.exec("UPDATE app.sessions SET state='running',error='',updated_at=now() WHERE id=$1", [session.id]);
    await event(tx, 'run.started', session.id, { runId, attempt: claimed.generation });
    return { ...claimed, goalId: session.goal_id };
  });
}

export async function failRun(store: Store, identity: RunIdentity, error: string, permanent: boolean) {
  return store.transaction(async (tx) => {
    const before = await tx.one('SELECT session_id FROM app.runs WHERE id=$1', [identity.runId]);
    if (!before) return false;
    const session = await lockSession(tx, before.session_id);
    const run = await tx.one('SELECT * FROM app.runs WHERE id=$1 FOR UPDATE', [identity.runId]);
    if (!run || run.state !== 'running' || run.generation !== identity.generation || session.current_run_id !== run.id)
      return false;
    const final = permanent || run.generation >= 3 || new Date(run.deadline).getTime() <= Date.now();
    await tx.exec(
      'UPDATE app.runs SET state=$2,error=$3,finished_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1',
      [run.id, final ? 'failed' : 'queued', error, final],
    );
    await tx.exec('UPDATE app.sessions SET state=$2,error=$3,revision=revision+1,updated_at=now() WHERE id=$1', [
      session.id,
      final ? 'failed' : 'queued',
      error,
    ]);
    await event(tx, final ? 'run.failed' : 'run.retrying', session.id, { runId: run.id, error });
    if (final) await notify(tx, `failed:${run.id}`, session.id, '这次学习需要处理', error);
    return !final;
  });
}

export const publicRuntimeError = (error: unknown) =>
  error instanceof AppError || error instanceof StaleRun ? error.message : '执行遇到错误，已保留进度；稍后重试。';
