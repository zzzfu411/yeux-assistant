import { describe, expect, it } from 'vitest';
import { modelEndpoint, providerReason, readModelResponse } from '../packages/core/src/model-http.js';

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
  it('assembles a streamed reply from content deltas, ignoring reasoning and keeping usage', async () => {
    const sse = (chunks: string[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      );
    const delta = (value: Record<string, unknown>) =>
      'data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n';
    // Chunk boundaries fall inside a line and inside a multi-byte character.
    const text = delta({ role: 'assistant' }) + delta({ reasoning_content: '想一想' }) + delta({ content: '{"ok":' });
    const bytes = new TextEncoder().encode(text + delta({ content: '中文}' }));
    await expect(
      readModelResponse(
        sse([
          new TextDecoder().decode(bytes.slice(0, 50)),
          new TextDecoder().decode(bytes.slice(50)),
          ': keep-alive\n\ndata: ' + JSON.stringify({ choices: [], usage: { total_tokens: 9 } }) + '\r\n\r\n',
          'data: [DONE]\n\n',
        ]),
      ),
    ).resolves.toEqual({ content: '{"ok":中文}', usage: { total_tokens: 9 } });
    await expect(readModelResponse(sse([delta({ role: 'assistant' }), 'data: [DONE]\n\n']))).rejects.toThrow(
      '没有返回可用内容',
    );
    await expect(
      readModelResponse(sse([delta({ content: 'a' }), 'data: {"error":{"message":"x"}}\n\n'])),
    ).rejects.toThrow('返回错误');
    await expect(readModelResponse(sse(['data: {oops\n\n']))).rejects.toThrow('格式无效');
  });
  it('reports a short provider reason without credentials', async () => {
    expect(
      await providerReason(
        new Response(JSON.stringify({ error: { message: 'upstream busy, retry later' } }), { status: 500 }),
      ),
    ).toBe('upstream busy, retry later');
    expect(await providerReason(new Response('<html><b>Bad gateway</b></html>', { status: 502 }))).toBe('Bad gateway');
    expect(await providerReason(new Response('invalid key sk-abcdef123456 used', { status: 401 }))).toBe(
      'invalid key sk-*** used',
    );
    expect((await providerReason(new Response('x'.repeat(5000), { status: 500 }))).length).toBe(160);
    expect(await providerReason(new Response(null, { status: 500 }))).toBe('');
  });
});
