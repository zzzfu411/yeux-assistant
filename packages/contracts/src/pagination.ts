import { z } from 'zod';
import type { Attempt, Goal, PlanRevision } from './index.js';

const cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
  .optional();
const limit = z.coerce.number().int().min(1).max(50).default(30);
const q = z.string().trim().max(200).default('');
export const GoalListQuery = z
  .object({ cursor, limit, q, status: z.enum(['all', 'active', 'paused', 'completed']).default('all') })
  .strict();
export const SessionListQuery = z
  .object({
    cursor,
    limit,
    q,
    goalId: z.string().min(1).max(160).optional(),
    kind: z.enum(['all', 'study', 'work', 'manage']).default('all'),
    state: z
      .enum([
        'all',
        'pending',
        'queued',
        'running',
        'waiting_feedback',
        'ready',
        'completed',
        'failed',
        'cancelled',
        'archived',
      ])
      .default('all'),
  })
  .strict();
export const AttemptListQuery = z.object({ cursor, limit }).strict();
export const SessionSummary = z
  .object({
    id: z.string(),
    goalId: z.string().nullable(),
    title: z.string(),
    kind: z.enum(['study', 'work', 'manage']),
    state: z.enum(['queued', 'running', 'waiting_feedback', 'ready', 'completed', 'failed', 'cancelled', 'archived']),
    promptPreview: z.string().max(320),
    errorPreview: z.string().max(480),
    flow: z.enum(['mail-reply', 'errand']).nullable(),
    isResearch: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummary>;
export type CursorPage<T> = { items: T[]; total: number; pageCursor: string; nextCursor: string | null };
export type GoalOverview = { goal: Goal; plan: PlanRevision | null; sessionTotal: number; attemptTotal: number };
export type TodayOverview = {
  goalTotal: number;
  activeGoalTotal: number;
  pendingTotal: number;
  sessions: SessionSummary[];
  unread: number;
  modelConfigured: boolean;
  workerOnline: boolean;
  backgroundIssues: number;
  /** Reply drafts ready for the owner to check, plus approvals waiting for a decision. */
  mailWaiting: number;
  /** New, unhandled mail threads. */
  mailNew: number;
  mailMode: 'off' | 'imap' | 'simulation';
};
export type GoalPage = CursorPage<Goal>;
export type SessionPage = CursorPage<SessionSummary>;
export type AttemptPage = CursorPage<Attempt>;
