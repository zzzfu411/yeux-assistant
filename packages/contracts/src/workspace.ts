import { z } from 'zod';

export const RuleScope = z.enum([
  'preference',
  'fact',
  'correction',
  'all',
  'study',
  'work',
  'manage',
  'mail',
  'errand',
]);
export const RuleHeader = z
  .object({
    key: z.string().min(1).max(100),
    scope: RuleScope,
    enabled: z.boolean(),
    created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    origin: z.string().max(200).optional(),
  })
  .strict();
export const FlowDefinition = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    title: z.string().trim().min(1).max(100),
    version: z.number().int().positive(),
    enabled: z.boolean().default(true),
    trigger: z
      .object({
        manual: z.boolean(),
        mail: z
          .object({ subject_any: z.array(z.string().min(1).max(100)).min(1).max(20) })
          .strict()
          .optional(),
      })
      .strict(),
    steps: z
      .array(z.enum(['extract_notice', 'retrieve', 'ask_user', 'draft_mail', 'ehall_prepare', 'calendar', 'archive']))
      .min(1)
      .max(7),
    ehall_profile: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
      .optional(),
  })
  .strict()
  .superRefine((flow, ctx) => {
    if (new Set(flow.steps).size !== flow.steps.length) ctx.addIssue({ code: 'custom', message: '流程步骤不能重复。' });
    if (flow.steps[0] !== 'extract_notice' || flow.steps.at(-1) !== 'archive')
      ctx.addIssue({ code: 'custom', message: '流程必须从通知抽取开始，以归档结束。' });
    if (flow.steps.includes('ehall_prepare') && !flow.ehall_profile)
      ctx.addIssue({ code: 'custom', message: '准备 ehall 表单需要已审核的事务配置。' });
  });
export const WorkspaceCommitInput = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    message: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
  })
  .strict();
export const SaveFlowInput = z
  .object({
    definition: FlowDefinition,
    instructions: z.string().trim().max(12000),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type RuleUsage = { runId: string; key: string; version: number; commitSha: string | null; content: string };
export type WorkspaceView = {
  head: string;
  revision: string;
  changes: Array<{ path: string; status: string; digest: string | null }>;
  locked: boolean;
  rules: number;
  flows: number;
};
export const ModelRuleProposal = z
  .object({
    key: z.string().min(1).max(100),
    scope: RuleScope,
    content: z.string().trim().min(1).max(3000),
    rationale: z.string().max(1000),
  })
  .strict();
