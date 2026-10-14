import type { PgBoss } from 'pg-boss';
import type { Tx, Row } from '../../storage/src/index.js';
import { RESEARCH_BUDGETS, ResearchOptions } from '../../contracts/src/research.js';
import { AppError, id, event, requireRow } from './common.js';
import { enqueue } from './queue.js';
// Shared commands and goal → session locking for HTTP, scheduler and executors.
export const FLOW_BUDGETS = {
  'mail-reply': { calls: 3, seconds: 300 },
  errand: { calls: 5, seconds: 480 },
} as const;
/** Per-request wait inside those budgets; still bounded by the run's remaining time. */
export const FLOW_CALL_TIMEOUT_MS = 180000;
export async function createRun(tx: Tx, boss: PgBoss, sessionId: string, input: Row = {}) {
  const runId = id();
  const session = await requireRow(tx, 'SELECT research,flow FROM app.sessions WHERE id=$1', [sessionId]);
  const options = session.research ? ResearchOptions.parse(session.research) : null;
  // Real models need 40–110 s per structured answer; notice handling makes two such calls.
  const budget = options
    ? RESEARCH_BUDGETS[options.effort]
    : (FLOW_BUDGETS[session.flow as keyof typeof FLOW_BUDGETS] ?? { calls: 5, seconds: 180 });
  await tx.exec(
    'INSERT INTO app.runs(id,session_id,input,graph_thread,max_model_calls,max_seconds) VALUES($1,$2,$3,$4,$5,$6)',
    [
      runId,
      sessionId,
      JSON.stringify(input),
      input.freshThread ? sessionId + ':' + runId : sessionId,
      budget.calls,
      budget.seconds,
    ],
  );
  await tx.exec("UPDATE app.sessions SET current_run_id=$2,state='queued',error='',updated_at=now() WHERE id=$1", [
    sessionId,
    runId,
  ]);
  await enqueue(boss, tx, runId, budget.seconds);
  await event(tx, 'run.queued', sessionId, { runId });
  return runId;
}
export async function createSession(
  tx: Tx,
  boss: PgBoss,
  data: {
    title: string;
    prompt: string;
    kind: string;
    goalId?: string;
    sessionId?: string;
    research?: ResearchOptions;
  },
) {
  const sessionId = data.sessionId || id();
  if (data.research?.sourceIds.length) {
    const found = await tx.rows(
      "SELECT id FROM app.sources WHERE id=ANY($1::text[]) AND archived_at IS NULL AND missing_at IS NULL AND (path IS NULL OR path NOT LIKE 'workspace/profile/%')",
      [data.research.sourceIds],
    );
    if (found.length !== new Set(data.research.sourceIds).size)
      throw new AppError('所选资料已不可用，请刷新资料列表。', 409, 'source_conflict');
  }
  await tx.exec('INSERT INTO app.sessions(id,goal_id,title,kind,prompt,research) VALUES($1,$2,$3,$4,$5,$6)', [
    sessionId,
    data.goalId || null,
    data.title || data.prompt.slice(0, 60),
    data.kind,
    data.prompt,
    data.research ? JSON.stringify(data.research) : null,
  ]);
  const runId = await createRun(tx, boss, sessionId, { type: 'initial' });
  return { sessionId, runId };
}
export async function lockSession(tx: Tx, sessionId: string) {
  const before = await requireRow(tx, 'SELECT goal_id FROM app.sessions WHERE id=$1', [sessionId]);
  if (before.goal_id) await tx.one('SELECT id FROM app.goals WHERE id=$1 FOR UPDATE', [before.goal_id]);
  return requireRow(tx, 'SELECT * FROM app.sessions WHERE id=$1 FOR UPDATE', [sessionId]);
}
