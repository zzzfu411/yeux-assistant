import { createHash, randomUUID } from 'node:crypto';
import type { Tx, Row } from '../../storage/src/index.js';

export class AppError extends Error { constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); } }
export const id = () => randomUUID();
export function canonical(value: unknown): string { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Row)[k])).join(',') + '}'; return JSON.stringify(value) ?? 'null'; }
export const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(value as string | number).toISOString();
export async function event(tx: Tx, kind: string, entityId: string | null, data: Row = {}) { await tx.exec('INSERT INTO app.events(kind,entity_id,data) VALUES($1,$2,$3)', [kind, entityId, JSON.stringify(data)]); }
export async function notify(tx: Tx, key: string, sessionId: string | null, title: string, body = '') { await tx.exec('INSERT INTO app.notifications(id,dedupe_key,session_id,title,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING', [id(), key, sessionId, title, body]); await event(tx, 'notification', sessionId); }
export async function requireRow(tx: Tx, query: string, values: unknown[] = []) { const row = await tx.one(query, values); if (!row) throw new AppError('记录不存在。', 404, 'not_found'); return row; }
export function checkVersion(row: Row, version: number) { if (Number(row.revision ?? row.version) !== version) throw new AppError('内容已更新，请载入最新版本；当前输入会保留。', 409, 'version_conflict'); }
export async function once<T>(tx: Tx, key: string, operation: string, input: unknown, work: () => Promise<T>): Promise<T> {
  if (!key || key.length > 160) throw new AppError('需要有效的 Idempotency-Key。');
  await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['command:' + key]);
  const hash = digest(input), prior = await tx.one('SELECT * FROM app.commands WHERE key=$1', [key]);
  if (prior) { if (prior.operation !== operation || prior.digest !== hash) throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict'); return prior.response as T; }
  const response = await work();
  await tx.exec('INSERT INTO app.commands(key,operation,digest,response) VALUES($1,$2,$3,$4)', [key, operation, hash, JSON.stringify(response)]);
  return response;
}
export function goalDTO(r: Row) { return { id:r.id, title:r.title, outcome:r.outcome, status:r.status, revision:r.revision, sourceIds:r.source_ids, intervals:r.intervals, reviewStage:r.review_stage, nextReview:r.next_review ? iso(r.next_review) : null, createdAt:iso(r.created_at), updatedAt:iso(r.updated_at) }; }
export function sessionDTO(r: Row) { return { id:r.id, goalId:r.goal_id, title:r.title, kind:r.kind, prompt:r.prompt, state:r.state, revision:r.revision, currentRunId:r.current_run_id, content:r.content, citations:r.citations, error:r.error, recipient:r.recipient, createdAt:iso(r.created_at), updatedAt:iso(r.updated_at) }; }
export function attemptDTO(r: Row) { return { id:r.id, sessionId:r.session_id, answer:r.answer, verdict:r.verdict, feedback:r.feedback, evidence:r.evidence, source:r.source, createdAt:iso(r.created_at) }; }
export function planDTO(r: Row | undefined) { return r ? { id:r.id, goalId:r.goal_id, version:r.version, steps:r.steps, rationale:r.rationale, createdAt:iso(r.created_at) } : null; }
