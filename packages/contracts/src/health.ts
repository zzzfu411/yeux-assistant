import { z } from 'zod';

export const RuntimeComponentName = z.enum(['worker', 'scheduler', 'knowledge', 'exports', 'devices']);
export const RuntimeComponent = z.object({
  name: RuntimeComponentName,
  label: z.string(),
  state: z.enum(['ok', 'error', 'stale', 'unknown']),
  checkedAt: z.string().nullable(),
  message: z.string(),
}).strict();
export const RuntimeStatus = z.object({
  checkedAt: z.string(),
  state: z.enum(['ok', 'degraded', 'starting']),
  issueCount: z.number().int().nonnegative(),
  components: z.array(RuntimeComponent),
}).strict();
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;
