import { z } from 'zod';

/** One model request as the trace recorded it; timing and tokens are what the provider reported. */
export const TraceCall = z.object({
  step: z.string(),
  profile: z.string(),
  model: z.string(),
  attempt: z.number().int(),
  structured: z.enum(['none', 'json_schema']),
  startedAt: z.string(),
  firstByteMs: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(),
  outcome: z.enum(['pending', 'ok', 'invalid', 'http_error', 'unavailable', 'budget']),
  errorCode: z.string(),
});
export const TraceStep = z.object({
  name: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string(),
  /** The earlier run whose unchanged result this step reused. */
  reusedFrom: z.string().nullable(),
});
export const TraceRun = z.object({
  id: z.string(),
  state: z.string(),
  attempts: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  modelCalls: z.number().int(),
  maxModelCalls: z.number().int(),
  maxSeconds: z.number().int(),
  error: z.string(),
  resumeFrom: z.string().nullable(),
  steps: z.array(TraceStep),
  calls: z.array(TraceCall),
});
export const SessionTrace = z.object({ runs: z.array(TraceRun) });
export type TraceCall = z.infer<typeof TraceCall>;
export type TraceRun = z.infer<typeof TraceRun>;
export type SessionTrace = z.infer<typeof SessionTrace>;
