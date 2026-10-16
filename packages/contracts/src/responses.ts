import { z } from 'zod';
import { Attempt, Citation, LearningSession, type SessionDetail } from './index.js';
import { SessionSummary, type TodayOverview } from './pagination.js';
import { Effort, ResearchAnswer, ResearchReview, type ResearchDetail } from './research.js';

/**
 * Runtime checks for the responses the main pages read. The TypeScript types stay the source of
 * truth: each schema is declared against its type, so they cannot drift apart silently. Tests parse
 * real API responses and the browser tests' mock responses with the same schemas.
 */
export const TodayOverviewResponse: z.ZodType<TodayOverview> = z
  .object({
    goalTotal: z.number().int().min(0),
    activeGoalTotal: z.number().int().min(0),
    pendingTotal: z.number().int().min(0),
    sessions: z.array(SessionSummary),
    unread: z.number().int().min(0),
    modelConfigured: z.boolean(),
    workerOnline: z.boolean(),
    backgroundIssues: z.number().int().min(0),
    mailWaiting: z.number().int().min(0),
    mailNew: z.number().int().min(0),
    mailMode: z.enum(['off', 'imap', 'simulation']),
  })
  .strict();

const Candidate = z
  .object({
    index: z.number().int().min(0),
    strategy: z.string(),
    parent: z.number().int().nullable(),
    answer: ResearchAnswer,
    citations: z.array(Citation),
    review: ResearchReview.nullable(),
    score: z.number().nullable(),
    accepted: z.boolean(),
    reviewNote: z.string(),
    droppedCitations: z.array(z.string()).optional(),
    branch: z.number().int().optional(),
    comparison: z
      .object({
        against: z.number().int(),
        winner: z.enum(['new', 'incumbent', 'tie']),
        order: z.enum(['new-first', 'incumbent-first']),
        reasons: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ResearchDetailResponse: z.ZodType<ResearchDetail> = z
  .object({
    runId: z.string(),
    state: z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
        effort: Effort,
        candidates: z.array(Candidate),
        best: z.number().int().nullable(),
        phase: z.enum(['solve', 'review', 'finished']),
        stopReason: z.enum(['accepted', 'budget', 'direct', 'error', 'plateau']).nullable(),
        warnings: z.array(z.string()),
        offset: z.number().int().optional(),
        retried: z.number().int().optional(),
      })
      .strict(),
    calls: z.number().int(),
    maxCalls: z.number().int(),
    maxSeconds: z.number().int().optional(),
    elapsedMs: z.number(),
    usage: z
      .object({
        promptTokens: z.number(),
        completionTokens: z.number(),
        totalTokens: z.number(),
        reportedCalls: z.number(),
        complete: z.boolean(),
      })
      .strict(),
    model: z.string(),
    reviewModel: z.string().optional(),
    sourceVersions: z.array(
      z.object({ id: z.string(), version: z.number().int(), digest: z.string(), title: z.string() }).strict(),
    ),
  })
  .strict();

/** The errand record is checked at its top level; its facts and plan come from model contracts. */
const ErrandDetailResponse = z
  .object({
    notice: z
      .object({
        title: z.string(),
        text: z.string(),
        sourceId: z.string().nullable(),
        sourceVersion: z.number().int().nullable(),
        origin: z.object({ kind: z.enum(['paste', 'mail', 'source']) }).passthrough(),
        flow: z
          .object({ id: z.string(), version: z.number().int(), steps: z.array(z.string()) })
          .passthrough()
          .nullable(),
      })
      .strict(),
    state: z
      .object({
        version: z.literal(1),
        facts: z.object({ title: z.string() }).passthrough().nullable(),
        warnings: z.array(z.string()),
        plan: z
          .object({ summary: z.string(), checklist: z.array(z.unknown()) })
          .passthrough()
          .nullable(),
        questions: z.array(z.string()),
        answers: z.array(z.object({ answer: z.string(), at: z.string() }).passthrough()),
        calendar: z.array(z.unknown()),
        mailSessionId: z.string().nullable(),
        steps: z.array(z.string()),
      })
      .passthrough(),
    archivedPath: z.string().nullable(),
    archivedCommit: z.string().nullable(),
    revision: z.number().int(),
    mailSession: z
      .object({ id: z.string(), title: z.string(), state: z.string(), recipient: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export const SessionDetailResponse = z
  .object({
    research: ResearchDetailResponse.nullable().optional(),
    errand: ErrandDetailResponse.nullable().optional(),
    related: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            state: z.string(),
            flow: z.string().nullable(),
            relation: z.enum(['parent', 'child']),
          })
          .strict(),
      )
      .optional(),
    ruleUsage: z
      .array(
        z
          .object({
            runId: z.string(),
            key: z.string(),
            version: z.number().int(),
            commitSha: z.string().nullable(),
            content: z.string(),
          })
          .strict(),
      )
      .optional(),
    session: LearningSession,
    attempts: z.array(Attempt),
    artifacts: z.array(
      z
        .object({
          id: z.string(),
          content: z.string(),
          kind: z.string(),
          provenance: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
    approvals: z.array(
      z
        .object({
          id: z.string(),
          state: z.string(),
          digest: z.string(),
          payload: z.record(z.string(), z.unknown()),
          error: z.string(),
        })
        .strict(),
    ),
    legacy: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict() satisfies z.ZodType<Omit<SessionDetail, 'errand'>>;
