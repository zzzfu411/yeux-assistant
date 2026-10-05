import type { Store, Tx, Row } from '../../storage/src/index.js';
import { AppError, event, notify } from './common.js';
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
    throw new RuntimeLimit('本次运行已达到 180 秒上限，请缩小问题后重试。');
  return { run, session, goal };
}

export async function readContext(store: Store, identity: RunIdentity) {
  return store.transaction((tx) => fence(tx, identity));
}

/** A receipt and all business effects commit together; replay returns that receipt. */
export async function commitNode<T>(
  store: Store,
  identity: RunIdentity,
  node: string,
  work: (tx: Tx, context: Awaited<ReturnType<typeof fence>>) => Promise<T>,
): Promise<T> {
  return store.transaction(async (tx) => {
    const context = await fence(tx, identity),
      key = `runtime:${identity.runId}:${node}`;
    const saved = await tx.one('SELECT value FROM app.settings WHERE key=$1', [key]);
    if (saved) return saved.value as T;
    const result = await work(tx, context);
    await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)', [key, JSON.stringify(result)]);
    return result;
  });
}

export async function nodeReceipt<T>(store: Store, identity: RunIdentity, node: string): Promise<T | undefined> {
  return store.transaction(async (tx) => {
    await fence(tx, identity);
    return (await tx.one('SELECT value FROM app.settings WHERE key=$1', [`runtime:${identity.runId}:${node}`]))
      ?.value as T | undefined;
  });
}

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
        run.generation >= 3
          ? '本次运行重试次数已用完，请查看后重试。'
          : '本次运行已达到 180 秒上限，请缩小问题后重试。';
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
      started_at=coalesce(started_at,now()),deadline=coalesce(deadline,now()+interval '180 seconds'),error=''
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
