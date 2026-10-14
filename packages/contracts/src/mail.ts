import { z } from 'zod';

export const MailAddress = z
  .string()
  .trim()
  .max(320)
  .regex(/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/);

/**
 * `simulation` keeps a file mailbox under private/mail-sim so every step can be verified without
 * a real account; `imap` is the real smail connection. The password is write-only: empty keeps it.
 */
export const MailSettingsInput = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['off', 'imap', 'simulation']),
    address: z.string().trim().max(320),
    password: z.string().max(1000).default(''),
    imap_host: z.string().trim().max(255).default(''),
    imap_port: z.number().int().min(1).max(65535).default(993),
    smtp_host: z.string().trim().max(255).default(''),
    smtp_port: z.number().int().min(1).max(65535).default(465),
    poll: z.boolean().default(false),
    auto_draft: z.enum(['none', 'direct', 'all']).default('direct'),
    daily_limit: z.number().int().min(0).max(100).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== 'off' && !MailAddress.safeParse(value.address).success)
      ctx.addIssue({ code: 'custom', path: ['address'], message: '请填写有效的邮箱地址。' });
  });
export type MailSettingsView = {
  mode: 'off' | 'imap' | 'simulation';
  address: string;
  has_password: boolean;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  poll: boolean;
  auto_draft: 'none' | 'direct' | 'all';
  daily_limit: number;
  revision: string;
};

export const MailTriage = z.enum(['new', 'drafting', 'replied', 'ignored', 'bulk', 'errand']);
export type MailThreadSummary = {
  id: string;
  subject: string;
  participants: string[];
  lastMessageAt: string;
  triage: z.infer<typeof MailTriage>;
  messageCount: number;
  latestFrom: string;
  preview: string;
  sessionId: string | null;
  sessionState: string | null;
  revision: number;
};
export type MailMessageView = {
  id: string;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  sentAt: string | null;
  body: string;
  bodyOrigin: 'plain' | 'html' | 'composed';
  bulk: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  sourceId: string | null;
};
export type MailThreadDetail = {
  thread: MailThreadSummary;
  messages: MailMessageView[];
  sessions: Array<{ id: string; title: string; state: string; flow: string | null; createdAt: string }>;
};
export const MailThreadAction = z.object({ revision: z.number().int().positive() }).strict();
export const MailTriageInput = z
  .object({ revision: z.number().int().positive(), triage: z.enum(['new', 'ignored']) })
  .strict();
export const MailSimulateInput = z
  .object({
    from: MailAddress,
    name: z.string().trim().max(80).default(''),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    replyToThread: z.string().max(160).optional(),
  })
  .strict();

/** What the model may propose for a reply. Recipients are never chosen by the model. */
export const ModelMailDraft = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    sourceIds: z.array(z.string().max(160)).max(8),
    questions: z.array(z.string().trim().min(1).max(300)).max(3),
  })
  .strict();
export type ModelMailDraft = z.infer<typeof ModelMailDraft>;

/** Stored on a reply session; bound into the exact send approval. */
export const SessionMail = z
  .object({
    threadId: z.string(),
    replyTo: z.string().nullable(),
    inReplyTo: z.string().nullable(),
    references: z.array(z.string()).max(20),
    cc: z.array(MailAddress).max(10).default([]),
    questions: z.array(z.string()).max(3).default([]),
  })
  .strict();
export type SessionMail = z.infer<typeof SessionMail>;

export const PushSubscriptionInput = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2000)
      .refine((value) => value.startsWith('https://'), '推送地址必须是 HTTPS。'),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
    label: z.string().trim().max(80).default(''),
  })
  .strict();
export const PushRemoveInput = z.object({ endpoint: z.string().max(2000) }).strict();
export type PushDeviceView = { endpointHost: string; label: string; createdAt: string; lastSuccessAt: string | null };
