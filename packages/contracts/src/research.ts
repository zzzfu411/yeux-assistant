import { z } from 'zod';
import type { Citation } from './index.js';

export const Effort = z.enum(['direct', 'low', 'high']);
export type Effort = z.infer<typeof Effort>;
// Wall-clock ceilings leave room for slow providers (real calls took 40–110 s each);
// the call budget is what bounds cost, and runs still stop early once accepted.
export const RESEARCH_BUDGETS = {
  direct: { calls: 1, seconds: 150, candidates: 1, label: '直接' },
  low: { calls: 4, seconds: 420, candidates: 2, label: '标准' },
  high: { calls: 8, seconds: 840, candidates: 4, label: '深入' },
} as const;
export const ResearchOptions = z
  .object({
    effort: Effort.default('low'),
    sourceIds: z.array(z.string().min(1).max(160)).max(100).default([]),
  })
  .strict();
export type ResearchOptions = z.infer<typeof ResearchOptions>;
export const ResearchAnswer = z
  .object({
    content: z.string().trim().min(1).max(6000),
    citations: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(160),
            version: z.number().int().positive(),
            quote: z.string().trim().min(2).max(400),
          })
          .strict(),
      )
      .max(8),
    limitations: z.array(z.string().max(400)).max(6),
  })
  .strict();
export type ResearchAnswer = z.infer<typeof ResearchAnswer>;
export const RUBRIC = {
  coverage: '覆盖用户明确提出的要求，逐项检查遗漏。',
  evidence: '关键事实有给定资料支持，区分原文、推断与证据不足。',
  challenges: '检查相反证据、边界条件和最可疑的假设。',
  usability: '结论清楚，建议可执行，不声称执行了外部操作。',
} as const;
export const ResearchReview = z
  .object({
    scores: z
      .object({
        coverage: z.number().int().min(0).max(4),
        evidence: z.number().int().min(0).max(4),
        challenges: z.number().int().min(0).max(4),
        usability: z.number().int().min(0).max(4),
      })
      .strict(),
    issues: z.array(z.string().min(1).max(500)).max(6),
    queries: z.array(z.string().min(1).max(160)).max(3),
    rationale: z.string().min(1).max(1500),
    satisfied: z.boolean(),
  })
  .strict();
export type ResearchReview = z.infer<typeof ResearchReview>;
export type ResearchCandidate = {
  index: number;
  strategy: string;
  parent: number | null;
  answer: ResearchAnswer;
  citations: Citation[];
  review: ResearchReview | null;
  score: number | null;
  accepted: boolean;
  reviewNote: string;
  /** Quotations the model claimed but the program could not find in the provided sources. */
  droppedCitations?: string[];
};
export type ResearchState = {
  version: 1;
  effort: Effort;
  candidates: ResearchCandidate[];
  best: number | null;
  phase: 'solve' | 'review' | 'finished';
  stopReason: 'accepted' | 'budget' | 'direct' | 'error' | null;
  warnings: string[];
  /** Reviewed candidates carried over from an earlier run of the same research; the new budget counts the rest. */
  offset?: number;
  /** Steps of this run repeated after a transient provider failure. */
  retried?: number;
};
/** One transient failure per four calls may repeat the same step instead of ending the run. */
export const stepRetries = (effort: Effort) => Math.min(2, Math.floor(RESEARCH_BUDGETS[effort].calls / 4));
export type ResearchDetail = {
  runId: string;
  state: ResearchState;
  calls: number;
  maxCalls: number;
  /** Persisted time ceiling of this run; older clients may omit it. */
  maxSeconds?: number;
  elapsedMs: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reportedCalls: number;
    complete: boolean;
  };
  model: string;
  /** Independent reviewer model, when configured; otherwise the solver reviews too. */
  reviewModel?: string;
  sourceVersions: Array<{ id: string; version: number; digest: string; title: string }>;
};
