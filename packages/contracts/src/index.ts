import { z } from 'zod';

export const Id = z.string().min(1).max(160);
export const Text = z.string().trim().min(1).max(30000);
export const Version = z.number().int().positive();
export const Revision = z.number().int().nonnegative();
export const GoalStatus = z.enum(['active', 'paused', 'completed']);
export const SessionState = z.enum([
  'queued',
  'running',
  'waiting_feedback',
  'ready',
  'completed',
  'failed',
  'cancelled',
  'archived',
]);
const SourcePage = z
  .object({
    number: z.number().int().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((page) => page.end >= page.start, { message: '页码范围的结束位置不能早于开始位置。', path: ['end'] });
/** Page ranges use UTF-16 offsets in the extracted text, matching Citation.start/end. */
export const SourceMetadata = z
  .object({
    course: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)
      .refine((value) => value !== 'unclassified', 'unclassified 是未分类资料的保留标识。'),
    courseName: z.string().min(1).max(200),
    originPath: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !/^[a-zA-Z]:/.test(path) &&
          !path.includes('\\') &&
          !path.split('/').some((part) => !part || part === '.' || part === '..'),
        '原始路径必须是仓库内的相对 POSIX 路径。',
      ),
    originHash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((value) => value.toLowerCase()),
    format: z.string().min(1).max(100),
    extraction: z.string().min(1).max(300),
    warnings: z.array(z.string().max(4000)),
    pages: z.array(SourcePage),
    assetKey: z
      .string()
      .regex(/^[a-f0-9]{64}\.(pdf|ppt|pptx|doc|docx|html|md|txt)$/)
      .optional(),
  })
  .strict()
  .refine((metadata) => !metadata.assetKey || metadata.assetKey.slice(0, 64) === metadata.originHash, {
    message: '原文件标识与原文哈希不一致。',
    path: ['assetKey'],
  });
export type SourceMetadata = z.infer<typeof SourceMetadata>;
export const Citation = z.object({
  sourceId: Id,
  version: Version,
  title: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string(),
  digest: z.string(),
  course: z.string().optional(),
  courseName: z.string().optional(),
  originPath: z.string().optional(),
  location: z.string().optional(),
});
export type Citation = z.infer<typeof Citation>;
export const PlanStep = z.object({
  id: Id,
  title: z.string().min(1).max(200),
  objective: z.string().max(2000),
  state: z.enum(['pending', 'practicing', 'practiced']).default('pending'),
});
export const PlanRevision = z.object({
  id: Id,
  goalId: Id,
  version: Version,
  steps: z.array(PlanStep).min(1).max(12),
  rationale: z.string(),
  createdAt: z.string(),
});
export type PlanRevision = z.infer<typeof PlanRevision>;
export const Goal = z.object({
  id: Id,
  title: z.string(),
  outcome: z.string(),
  status: GoalStatus,
  revision: Version,
  sourceIds: z.array(Id),
  intervals: z.array(z.number().int().positive()).min(1).max(10),
  reviewStage: z.number().int(),
  nextReview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof Goal>;
export const LearningSession = z.object({
  id: Id,
  goalId: Id.nullable(),
  title: z.string(),
  kind: z.enum(['study', 'work', 'manage']),
  prompt: z.string(),
  state: SessionState,
  revision: Revision,
  currentRunId: Id.nullable(),
  content: z.string(),
  citations: z.array(Citation),
  error: z.string(),
  recipient: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LearningSession = z.infer<typeof LearningSession>;
export const Attempt = z.object({
  id: Id,
  sessionId: Id,
  answer: z.string(),
  verdict: z.enum(['pending', 'pass', 'retry', 'unclear']),
  feedback: z.string(),
  evidence: z.string(),
  source: z.enum(['model_estimate', 'user_report', 'ungraded']),
  createdAt: z.string(),
});
export type Attempt = z.infer<typeof Attempt>;
export const RunEvent = z.object({
  id: z.string(),
  kind: z.string(),
  entityId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;
export const CreateGoal = z
  .object({
    title: z.string().trim().min(1).max(200),
    outcome: z.string().trim().max(4000).default(''),
    sourceIds: z.array(Id).max(100).default([]),
    intervals: z.array(z.number().int().min(3600).max(31536000)).min(1).max(10).default([86400, 259200, 604800]),
  })
  .strict();
export const UpdateGoal = z
  .object({
    revision: Version,
    status: GoalStatus.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    outcome: z.string().max(4000).optional(),
    sourceIds: z.array(Id).max(100).optional(),
    intervals: z.array(z.number().int().min(3600).max(31536000)).min(1).max(10).optional(),
  })
  .strict();
export const Feedback = z
  .object({ revision: Revision, answer: Text, selfReport: z.enum(['understood', 'need_practice']).optional() })
  .strict();
export const CreateSession = z
  .object({
    title: z.string().max(200).default(''),
    prompt: Text,
    kind: z.enum(['study', 'work', 'manage']).default('study'),
  })
  .strict();
export const MemoryInput = z
  .object({
    key: z.string().min(1).max(100),
    content: Text,
    scope: z.enum(['preference', 'fact', 'correction', 'all', 'study', 'work', 'manage']).default('preference'),
    confirmed: z.boolean().default(true),
    enabled: z.boolean().default(true),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const ScheduleInput = z
  .object({
    title: z.string().min(1).max(200),
    prompt: Text,
    kind: z.enum(['study', 'work', 'manage']).default('study'),
    intervalSeconds: z.number().int().min(0).max(31536000),
    nextRun: z.iso.datetime(),
    enabled: z.boolean().default(true),
    revision: z.number().int().nonnegative().default(0),
  })
  .strict();
export const DraftInput = z
  .object({ revision: Revision, content: z.string().max(100000), recipient: z.string().max(320).default('') })
  .strict();
export const ModelSettingsInput = z
  .object({
    revision: z.string().min(1),
    base_url: z.string().max(2000),
    model: z.string().max(300),
    api_key: z.string().max(10000).default(''),
    tools: z.boolean().default(true),
  })
  .strict();
export const ApprovalDecision = z.object({ digest: z.string().length(64), approve: z.boolean() }).strict();
export const ApprovalResolution = z.object({ sent: z.boolean(), note: z.string().trim().min(1).max(2000) }).strict();
export const ModelPlan = z.object({
  steps: z
    .array(z.object({ title: z.string().min(1).max(200), objective: z.string().min(1).max(2000) }))
    .min(1)
    .max(6),
  rationale: z.string().max(2000),
});
export const ModelLesson = z.object({ content: z.string().min(1).max(12000), sourceIds: z.array(z.string()).max(8) });
export { ModelAssessment, AssessmentCitation } from './assessment.js';

export type GoalDetail = { goal: Goal; plan: PlanRevision | null; sessions: LearningSession[]; attempts: Attempt[] };
export type SessionDetail = {
  session: LearningSession;
  attempts: Attempt[];
  artifacts: Array<{ id: string; content: string; kind: string; provenance: string; createdAt: string }>;
  approvals: Array<{ id: string; state: string; digest: string; payload: Record<string, unknown>; error: string }>;
  legacy: Record<string, unknown> | null;
};
export type SourceSummary = {
  id: string;
  title: string;
  version: number;
  digest: string;
  updatedAt: string;
  metadata?: Pick<SourceMetadata, 'course' | 'courseName' | 'format'> | null;
  revision?: number;
  archivedAt?: string | null;
  managed?: boolean;
};
export type SourceDetail = {
  id: string;
  title: string;
  version: number;
  current_version: number;
  content: string;
  digest: string;
  metadata?: SourceMetadata | null;
  revision: number;
  archivedAt: string | null;
  managed: boolean;
  editableText: boolean;
  versions: Array<{ version: number; title: string; createdAt: string }>;
};
export type Today = {
  goals: Goal[];
  sessions: LearningSession[];
  unread: number;
  modelConfigured: boolean;
  workerOnline: boolean;
};

export const LoginInput = z
  .object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(1024) })
  .strict();

export * from './devices.js';
export * from './source-inputs.js';

export * from './pagination.js';
