import type { PgBoss } from 'pg-boss';
import type { Tx, Row } from '../../storage/src/index.js';
import { id, event, requireRow } from './common.js';
import { enqueue } from './queue.js';
// Shared commands and goal → session locking for HTTP, scheduler and executors.
export async function createRun(tx: Tx, boss: PgBoss, sessionId: string, input: Row = {}) {
    const runId = id();
    await tx.exec('INSERT INTO app.runs(id,session_id,input,graph_thread) VALUES($1,$2,$3,$4)', [runId, sessionId, JSON.stringify(input), input.freshThread ? sessionId + ':' + runId : sessionId]);
    await tx.exec("UPDATE app.sessions SET current_run_id=$2,state='queued',error='',updated_at=now() WHERE id=$1", [sessionId, runId]);
    await enqueue(boss, tx, runId);
    await event(tx, 'run.queued', sessionId, { runId });
    return runId;
}
export async function createSession(tx: Tx, boss: PgBoss, data: {
    title: string;
    prompt: string;
    kind: string;
    goalId?: string;
    sessionId?: string;
}) {
    const sessionId = data.sessionId || id();
    await tx.exec('INSERT INTO app.sessions(id,goal_id,title,kind,prompt) VALUES($1,$2,$3,$4,$5)', [sessionId, data.goalId || null, data.title || data.prompt.slice(0, 60), data.kind, data.prompt]);
    const runId = await createRun(tx, boss, sessionId, { type: 'initial' });
    return { sessionId, runId };
}
export async function lockSession(tx: Tx, sessionId: string) {
    const before = await requireRow(tx, 'SELECT goal_id FROM app.sessions WHERE id=$1', [sessionId]);
    if (before.goal_id)
        await tx.one('SELECT id FROM app.goals WHERE id=$1 FOR UPDATE', [before.goal_id]);
    return requireRow(tx, 'SELECT * FROM app.sessions WHERE id=$1 FOR UPDATE', [sessionId]);
}
