import { z } from 'zod';

const title = z.string().trim().min(1).max(200);
const content = z.string().min(1).max(2000000);
const revision = z.number().int().positive();

export const SourceInput = z.object({ title, content, allowDuplicate: z.boolean().optional() }).strict();
export const SourceUpdateInput = z.object({ revision, title: title.optional(), content: content.optional() }).strict()
  .refine(input => input.title !== undefined || input.content !== undefined, '请填写标题或正文。');
export const SourceArchiveInput = z.object({ revision, archived: z.boolean() }).strict();
export type SourceImportResult = { id: string; version: number; revision: number; duplicate: boolean; archivedAt: string | null };
