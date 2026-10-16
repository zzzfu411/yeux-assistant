import { FAST_PROFILES, modelFor } from './config.js';

export { FAST_PROFILES };

/**
 * What a step asks of the model. Each step names one profile; the defaults keep the earlier
 * behaviour (4096 output tokens) and differ only in temperature: extraction and review should be
 * repeatable, while a research branch that is meant to explore needs some spread.
 */
export const MODEL_PROFILES = {
  default: { maxTokens: 4096, temperature: 0.2 },
  extract: { maxTokens: 4096, temperature: 0 },
  plan: { maxTokens: 4096, temperature: 0.2 },
  draft: { maxTokens: 4096, temperature: 0.3 },
  solve: { maxTokens: 4096, temperature: 0.3 },
  explore: { maxTokens: 4096, temperature: 0.8 },
  review: { maxTokens: 4096, temperature: 0 },
  assess: { maxTokens: 4096, temperature: 0 },
  lesson: { maxTokens: 4096, temperature: 0.2 },
} as const;
export type ModelProfile = keyof typeof MODEL_PROFILES;
const EFFORTS = new Set(['low', 'medium', 'high']);

export type ResolvedModel = Record<string, any> & {
  base_url: string;
  model: string;
  independent: boolean;
  profile: ModelProfile;
  max_tokens: number;
  temperature: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
};

/**
 * Settings for one request. The endpoint and key always come from `modelFor`, so a profile can
 * swap the model name on the same service but never moves a key to another address. An
 * independent reviewer keeps its own model; a profile only tunes its sampling.
 */
export function resolveModel(llm: Record<string, any> | undefined, profile: ModelProfile): ResolvedModel {
  const endpoint = modelFor(llm, profile === 'review' ? 'review' : 'solve');
  const override =
    llm?.profiles &&
    typeof llm.profiles === 'object' &&
    llm.profiles[profile] &&
    typeof llm.profiles[profile] === 'object'
      ? (llm.profiles[profile] as Record<string, unknown>)
      : {};
  const defaults = MODEL_PROFILES[profile];
  const tokens = Number(override.max_tokens),
    temperature = Number(override.temperature);
  return {
    ...endpoint,
    base_url: endpoint.base_url,
    model:
      !endpoint.independent && typeof override.model === 'string' && override.model.trim()
        ? override.model.trim()
        : endpoint.model,
    profile,
    max_tokens: Number.isInteger(tokens) && tokens >= 256 && tokens <= 32768 ? tokens : defaults.maxTokens,
    temperature:
      Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : defaults.temperature,
    ...(typeof override.reasoning_effort === 'string' && EFFORTS.has(override.reasoning_effort)
      ? { reasoning_effort: override.reasoning_effort as 'low' | 'medium' | 'high' }
      : {}),
  };
}
