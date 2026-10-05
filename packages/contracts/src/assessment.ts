import { z } from 'zod';

export const AssessmentCitation = z.object({
  sourceId: z.string().min(1).max(160), version: z.number().int().positive(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  quote: z.string().min(1).max(12000)
}).refine(value => value.end > value.start, '引用范围不能为空。');

// Empty defaults preserve parsing of older providers; unsupported verdicts are
// downgraded by the evidence guard, never accepted merely for valid JSON.
export const ModelAssessment = z.object({
  verdict: z.enum(['pass', 'retry', 'unclear']),
  feedback: z.string().min(1).max(4000), evidence: z.string().max(4000),
  answerQuotes: z.array(z.string().min(1).max(3000)).max(8).default([]),
  citationRefs: z.array(AssessmentCitation).max(8).default([])
});
export type ModelAssessment = z.infer<typeof ModelAssessment>;
