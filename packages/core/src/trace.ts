import type { Tx } from '../../storage/src/index.js';
import type { SessionTrace } from '../../contracts/src/trace.js';
import { iso } from './common.js';

const maybe = (value: unknown) => (value === null || value === undefined ? null : iso(value));
/** The latest runs of a session with their steps and every model request, newest run first. */
export async function sessionTrace(tx: Tx, sessionId: string, limit = 5): Promise<SessionTrace> {
  const runs = await tx.rows('SELECT * FROM app.runs WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [
    sessionId,
    limit,
  ]);
  const ids = runs.map((run) => run.id);
  const steps = await tx.rows('SELECT * FROM app.run_steps WHERE run_id=ANY($1::text[]) ORDER BY finished_at,name', [
    ids,
  ]);
  const calls = await tx.rows('SELECT * FROM app.model_calls WHERE run_id=ANY($1::text[]) ORDER BY id', [ids]);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      state: run.state,
      attempts: run.generation,
      createdAt: iso(run.created_at),
      startedAt: maybe(run.started_at),
      finishedAt: maybe(run.finished_at),
      modelCalls: run.model_calls,
      maxModelCalls: run.max_model_calls,
      maxSeconds: run.max_seconds,
      error: run.error,
      resumeFrom: typeof run.input?.resumeFrom === 'string' ? run.input.resumeFrom : null,
      steps: steps
        .filter((item) => item.run_id === run.id)
        .map((item) => ({
          name: item.name,
          startedAt: maybe(item.started_at),
          finishedAt: iso(item.finished_at),
          reusedFrom: item.reused_from,
        })),
      calls: calls
        .filter((item) => item.run_id === run.id)
        .map((item) => ({
          step: item.step,
          profile: item.profile,
          model: item.model,
          attempt: item.generation,
          structured: item.structured,
          startedAt: iso(item.started_at),
          firstByteMs: item.first_byte_ms,
          latencyMs: item.latency_ms,
          promptTokens: item.prompt_tokens,
          completionTokens: item.completion_tokens,
          reasoningTokens: item.reasoning_tokens,
          outcome: item.outcome,
          errorCode: item.error_code,
        })),
    })),
  };
}
