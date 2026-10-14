import { z } from 'zod';

// Only this synthetic profile is registered. A real ehall profile requires separate account discovery.
export const ehallProfile = {
  id: 'lab1-simulation',
  version: '1',
  title: '模拟在读证明',
  consequences: '仅在本机模拟站点生成申请记录，不向学校提交；提交后助手不提供撤回操作。',
} as const;
export const EhallBase = z.object({ profile: z.literal(ehallProfile.id), profileVersion: z.literal('1') }).strict();
export const EhallFields = z
  .object({ applicant: z.string().trim().min(1).max(80), purpose: z.string().trim().min(1).max(300) })
  .strict();
export const EhallPrepare = EhallBase.extend({
  fields: EhallFields,
  sources: z.object({ applicant: z.literal('本人填写'), purpose: z.literal('本人填写') }).strict(),
}).strict();
export const EhallSubmit = EhallPrepare.extend({
  preparedCommandId: z.string().uuid(),
  formDigest: z.string().regex(/^[a-f0-9]{64}$/),
  screenshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const EhallState = EhallBase.extend({
  simulation: z.literal(true),
  loggedIn: z.boolean(),
  account: z.string().max(80).nullable(),
  phase: z.enum(['session', 'query', 'form', 'status']),
  fields: EhallFields.optional(),
  formDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  screenshotDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  rows: z
    .array(z.object({ course: z.string().max(100), time: z.string().max(100) }).strict())
    .max(20)
    .optional(),
  application: z
    .object({
      id: z.string().uuid(),
      state: z.literal('待审核（模拟）'),
      formDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .optional(),
}).strict();
export type EhallState = z.infer<typeof EhallState>;
export const EhallCapability = z.enum([
  'ehall.session.check',
  'ehall.query',
  'ehall.form.prepare',
  'ehall.form.submit',
]);
export const ehallArguments = {
  'ehall.session.check': EhallBase,
  'ehall.query': EhallBase,
  'ehall.form.prepare': EhallPrepare,
  'ehall.form.submit': EhallSubmit,
} as const;
export const bridgeVersions = { 'macos.audio': '1', 'browser.ehall': '1' } as const;
export function bridgeGrantMs(adapter: string) {
  return adapter === 'browser.ehall' ? 30000 : 5000;
}
