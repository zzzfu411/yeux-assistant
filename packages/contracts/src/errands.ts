import { z } from 'zod';

/** Every extracted value carries the sentence it came from; code checks the quote against the notice. */
const Quoted = z.object({ value: z.string().trim().max(300).nullable(), quote: z.string().max(300) }).strict();
const When = z
  .object({
    value: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/)
      .nullable(),
    quote: z.string().max(300),
  })
  .strict();
export const ModelNoticeFacts = z
  .object({
    title: z.string().trim().min(1).max(200),
    organizer: Quoted,
    eventStart: When,
    eventEnd: When,
    registrationDeadline: When,
    submissionDeadline: When,
    location: Quoted,
    contact: Quoted,
    materials: z
      .array(
        z
          .object({ name: z.string().trim().min(1).max(200), quote: z.string().max(300), required: z.boolean() })
          .strict(),
      )
      .max(15),
    actions: z
      .array(
        z
          .object({
            action: z.string().trim().min(1).max(200),
            quote: z.string().max(300),
            channel: z.enum(['email', 'ehall', 'offline', 'online', 'other']),
          })
          .strict(),
      )
      .max(10),
    unknowns: z.array(z.string().trim().min(1).max(200)).max(10),
  })
  .strict();
export type ModelNoticeFacts = z.infer<typeof ModelNoticeFacts>;

export const ModelErrandPlan = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    checklist: z
      .array(
        z
          .object({
            item: z.string().trim().min(1).max(200),
            status: z.enum(['ready', 'missing', 'check']),
            note: z.string().max(400),
            sourceIds: z.array(z.string().max(160)).max(4),
          })
          .strict(),
      )
      .max(15),
    questions: z.array(z.string().trim().min(1).max(300)).max(4),
    mail: z
      .object({
        needed: z.boolean(),
        subject: z.string().max(200),
        body: z.string().max(8000),
      })
      .strict(),
    todos: z
      .array(z.object({ title: z.string().trim().min(1).max(200), due: z.string().max(40).nullable() }).strict())
      .max(10),
  })
  .strict();
export type ModelErrandPlan = z.infer<typeof ModelErrandPlan>;

export type VerifiedField = { value: string | null; quote: string; start: number | null; note: string };
export type ErrandFacts = {
  title: string;
  organizer: VerifiedField;
  eventStart: VerifiedField;
  eventEnd: VerifiedField;
  registrationDeadline: VerifiedField;
  submissionDeadline: VerifiedField;
  location: VerifiedField;
  contact: VerifiedField;
  materials: Array<{ name: string; quote: string; required: boolean; verified: boolean }>;
  actions: Array<{ action: string; quote: string; channel: string; verified: boolean }>;
  unknowns: string[];
};
export type ErrandState = {
  version: 1;
  /** The model's raw extraction, re-verified by every run so improved guards apply without a new call. */
  extracted?: ModelNoticeFacts | null;
  facts: ErrandFacts | null;
  warnings: string[];
  plan:
    | (Omit<ModelErrandPlan, 'mail'> & {
        mail: { needed: boolean; subject: string; body: string; to: string | null };
      })
    | null;
  questions: string[];
  answers: Array<{ answer: string; at: string; attemptId?: string }>;
  calendar: Array<{ kind: 'start' | 'end' | 'deadline'; title: string; at: string; allDay: boolean }>;
  mailSessionId: string | null;
  steps: string[];
};
export type ErrandNotice = {
  title: string;
  text: string;
  sourceId: string | null;
  sourceVersion: number | null;
  origin: { kind: 'paste' | 'mail' | 'source'; messageId?: string; threadId?: string; from?: string };
  flow: { id: string; version: number; title: string; steps: string[]; instructions: string } | null;
};
export type ErrandDetail = {
  notice: ErrandNotice;
  state: ErrandState;
  archivedPath: string | null;
  archivedCommit: string | null;
  revision: number;
  mailSession: { id: string; title: string; state: string; recipient: string } | null;
};
export const CreateErrandInput = z
  .object({
    text: z.string().trim().min(10).max(30000),
    title: z.string().trim().max(200).default(''),
    flowId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
      .optional(),
  })
  .strict();
export const ErrandActionInput = z.object({ revision: z.number().int().positive() }).strict();
