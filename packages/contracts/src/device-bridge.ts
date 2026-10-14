import { z } from 'zod';
import { EhallState, EhallCapability, ehallArguments } from './ehall.js';

// The server and local executor agree on reviewed profiles, never arbitrary scripts or URLs.
export const BridgeAdapterId = z.enum(['macos.audio', 'browser.ehall']);
export const AudioState = z.object({ volume: z.number().int().min(0).max(100), muted: z.boolean() }).strict();
export const AudioInput = z.object({ percent: z.number().int().min(0).max(50) }).strict();
export const CreateDeviceBridge = z
  .object({
    name: z.string().trim().min(1).max(80),
    adapter: BridgeAdapterId,
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export const BridgeConfig = z
  .object({
    server: z.string().url(),
    deviceId: z.string().uuid(),
    adapter: BridgeAdapterId,
    token: z.string().regex(/^yeux_device_[a-f0-9]{64}$/),
  })
  .strict();
export type BridgeConfig = z.infer<typeof BridgeConfig>;
export const BridgePoll = z.object({ adapter: BridgeAdapterId, version: z.literal('1') }).strict();
export const BridgeLease = z.object({ lease: z.string().uuid() }).strict();
export const BridgeResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: z.union([AudioState, EhallState]).optional() }).strict(),
  z.object({ ok: z.literal(false), effect: z.enum(['not_applied', 'unknown', 'blocked', 'login_required']) }).strict(),
]);
export type BridgeResult = z.infer<typeof BridgeResult>;
export const BridgeReport = BridgeLease.extend({ result: BridgeResult }).strict();
const AudioCall = z
  .object({
    id: z.string().uuid(),
    lease: z.string().uuid(),
    deviceId: z.string().uuid(),
    commandId: z.string().uuid(),
    adapter: z.literal('macos.audio'),
    version: z.literal('1'),
    kind: z.enum(['read', 'execute']),
    capability: z.literal('audio.volume.set'),
    arguments: AudioInput,
  })
  .strict();
export const EhallCall = AudioCall.omit({ adapter: true, capability: true, arguments: true })
  .extend({
    adapter: z.literal('browser.ehall'),
    capability: EhallCapability,
    phase: z.enum(['before', 'write', 'after']),
    arguments: z.unknown(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!ehallArguments[data.capability].safeParse(data.arguments).success)
      ctx.addIssue({ code: 'custom', message: 'ehall 参数与已登记能力不匹配。' });
  });
export const BridgeCall = z.discriminatedUnion('adapter', [AudioCall, EhallCall]);
export type BridgeCall = z.infer<typeof BridgeCall>;
export const BridgeEvidence = BridgeLease.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  png: z
    .string()
    .max(2796204)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type IssuedDeviceBridge = {
  deviceId: string;
  token: string | null;
  adapter: z.infer<typeof BridgeAdapterId>;
  expiresAt: string;
};
