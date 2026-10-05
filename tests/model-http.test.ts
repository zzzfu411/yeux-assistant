import { describe, expect, it } from 'vitest';
import { modelEndpoint, readModelResponse } from '../packages/core/src/model-http.js';

describe('shared provider response contract', () => {
  it('accepts a base URL or an already complete endpoint without duplicating the path', () => {
    for (const url of [
      'https://model.example/v1',
      'https://model.example/v1/',
      'https://model.example/v1/chat/completions/',
    ])
      expect(modelEndpoint(url)).toBe('https://model.example/v1/chat/completions');
  });
  it('rejects empty, incompatible, malformed and oversized responses', async () => {
    for (const body of [
      '{}',
      '{',
      JSON.stringify({ choices: [{ message: { content: ' ' } }] }),
      JSON.stringify({ choices: [{ message: { content: 'x'.repeat(256001) } }] }),
    ])
      await expect(readModelResponse(new Response(body))).rejects.toThrow();
    await expect(
      readModelResponse(
        new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 3 } })),
      ),
    ).resolves.toEqual({ content: 'OK', usage: { total_tokens: 3 } });
  });
});
