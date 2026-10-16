import { z } from 'zod';
import { Effort } from './research.js';

export const DraftKey = z.enum(['compose']);
/** What the Today composer holds before it is sent; the same shape the page keeps in the browser. */
export const ComposeDraftContent = z
  .object({
    text: z.string().max(30000),
    mode: z.enum(['research', 'goal', 'study', 'errand', 'work', 'manage']),
    locked: z.boolean(),
    outcome: z.string().max(4000),
    sourceIds: z.array(z.string().min(1).max(160)).max(100),
    effort: Effort.optional(),
    flowId: z.string().min(1).max(160).optional(),
  })
  .strict();
export type ComposeDraftContent = z.infer<typeof ComposeDraftContent>;
/** `revision` is the version the device last saw; 0 means it has seen none. */
export const SaveComposeDraft = z.object({ revision: z.number().int().min(0), content: ComposeDraftContent }).strict();
export const ClearComposeDraft = z.object({ revision: z.number().int().min(1) }).strict();
export const ComposeDraft = z.object({
  content: ComposeDraftContent.nullable(),
  revision: z.number().int().min(0),
  updatedAt: z.string().nullable(),
});
export type ComposeDraft = z.infer<typeof ComposeDraft>;
