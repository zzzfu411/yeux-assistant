import { z } from 'zod';

// The server and local executor agree on reviewed profiles, never arbitrary scripts or URLs.
export const BridgeAdapterId = z.enum(['macos.audio']);
export const AudioState = z.object({ volume: z.number().int().min(0).max(100), muted: z.boolean() }).strict();
export const AudioInput = z.object({ percent: z.number().int().min(0).max(50) }).strict();
export const CreateDeviceBridge = z.object({ name: z.string().trim().min(1).max(80), adapter: BridgeAdapterId,
  expiresInDays: z.number().int().min(1).max(90).default(30) }).strict();
export const BridgeConfig = z.object({ server: z.string().url(), deviceId: z.string().uuid(), adapter: BridgeAdapterId,
  token: z.string().regex(/^yeux_device_[a-f0-9]{64}$/) }).strict();
export type BridgeConfig = z.infer<typeof BridgeConfig>;
export const BridgePoll = z.object({ adapter: BridgeAdapterId, version: z.literal('1') }).strict();
export const BridgeLease = z.object({ lease: z.string().uuid() }).strict();
export const BridgeResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: AudioState.optional() }).strict(),
  z.object({ ok: z.literal(false), effect: z.enum(['not_applied', 'unknown']) }).strict(),
]);
export type BridgeResult = z.infer<typeof BridgeResult>;
export const BridgeReport = BridgeLease.extend({ result: BridgeResult }).strict();
export const BridgeCall = z.object({ id: z.string().uuid(), lease: z.string().uuid(), deviceId: z.string().uuid(), commandId: z.string().uuid(),
  adapter: BridgeAdapterId, version: z.literal('1'), kind: z.enum(['read', 'execute']),
  capability: z.literal('audio.volume.set'), arguments: AudioInput }).strict();
export type BridgeCall = z.infer<typeof BridgeCall>;
export type IssuedDeviceBridge = { deviceId: string; token: string | null; adapter: z.infer<typeof BridgeAdapterId>; expiresAt: string };
