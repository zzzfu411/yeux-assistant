import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../packages/storage/src/index.js';
import { claimRun, failRun } from '../packages/core/src/runtime-state.js';
import { boundedContext, forgetRefusals, ModelGateway, type ModelContext } from '../packages/core/src/model.js';
import { traced } from '../packages/core/src/runtime-state.js';

const context: ModelContext = {
  task: '合成题',
  latest: '本人回答',
  previous: '题目：说明原子性。',
  rules: [],
  notes: [],
  sources: [],
};
describe('assessment context integrity', () => {
  it('keeps the beginning and end of a complete twelve-thousand-character exercise', () => {
    const previous = '问题在开头：解释事务回滚。' + '补'.repeat(11980) + '结束';
    const result = boundedContext({ ...context, previous }, 24000, true);
    expect(result.exerciseComplete).toBe(true);
    expect(JSON.parse(result.text.split('\n')[1]!).generatedConversationContext).toBe(previous);
    expect(result.text.length).toBeLessThanOrEqual(24000);
    expect(boundedContext({ ...context, previous }).text).not.toContain('问题在开头');
  });
  it('omits an oversized exercise entirely rather than silently grading its tail', () => {
    const result = boundedContext({ ...context, previous: '不允许截断'.repeat(3000) }, 24000, true);
    expect(result.exerciseComplete).toBe(false);
    expect(JSON.parse(result.text.split('\n')[1]!).generatedConversationContext).toBe('');
    expect(result.trimmed).toBe(true);
  });
  it('omits a question that cannot fit alongside mandatory user input', () => {
    const result = boundedContext({ ...context, latest: '答'.repeat(19000), previous: '题'.repeat(6000) }, 24000, true);
    expect(result.exerciseComplete).toBe(false);
    expect(result.text).toContain('答'.repeat(19000));
    expect(JSON.parse(result.text.split('\n')[1]!).generatedConversationContext).toBe('');
  });
  it('accounts for JSON escaping without marking an omitted exercise complete', () => {
    const result = boundedContext({ ...context, previous: '"'.repeat(12000) }, 24000, true);
    expect(result.exerciseComplete).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(24000);
  });
  it('tracks the exact surviving citation ranges when several chunks have the same source ID', () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({
      sourceId: 'same-source',
      title: '合成讲义',
      version: 1,
      start: i * 1800,
      end: (i + 1) * 1800,
      quote: String(i).repeat(1800),
      digest: 'synthetic',
    }));
    const result = boundedContext({ ...context, latest: '答'.repeat(16000), sources });
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations.length).toBeLessThan(6);
    expect(
      result.citations.map(({ sourceId, version, start, end, quote }) => ({ sourceId, version, start, end, quote })),
    ).toEqual(
      result.sources.map(({ sourceId, version, start, end, quote }) => ({ sourceId, version, start, end, quote })),
    );
    expect(result.trimmed).toBe(true);
  });
});

const url = process.env.RUNTIME_TEST_DATABASE_URL;
describe.runIf(Boolean(url))('model request timeouts share persisted PostgreSQL run budgets', () => {
  let store: Store, folder: string;
  const schema = z.object({ result: z.string() });
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test'))
      throw new Error('Model tests require an isolated *_runtime_test database');
    forgetRefusals();
    store = new Store(url!);
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'assistant-model-budget-'));
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({ llm: { base_url: 'http://127.0.0.1:1/v1', model: 'synthetic-budget-test' } }),
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await store?.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  async function run() {
    const sessionId = randomUUID(),
      runId = randomUUID();
    await store.transaction(async (tx) => {
      await tx.exec(
        "INSERT INTO app.sessions(id,title,kind,prompt,current_run_id) VALUES($1,'合成预算','study','预算回归',$2)",
        [sessionId, runId],
      );
      await tx.exec('INSERT INTO app.runs(id,session_id,graph_thread) VALUES($1,$2,$2)', [runId, sessionId]);
    });
    const claimed = (await claimRun(store, runId))!;
    return { runId, claimed, gateway: new ModelGateway(store, folder, { runId, generation: claimed.generation }) };
  }
  function clockedModel(delay: number, ignoreAbort = false) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Budget elapsed', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve(
              new Response(
                JSON.stringify({
                  choices: [{ message: { content: JSON.stringify({ result: 'synthetic-response' }) } }],
                  usage: { total_tokens: 3 },
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
            );
          }, delay);
          if (!ignoreAbort) {
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }
          entered();
        }),
    );
    vi.stubGlobal('fetch', request);
    return { started, request, timeout };
  }
  it('asks for structured streaming output, then drops each field a provider rejects, and remembers it', async () => {
    const { runId, gateway } = await run();
    const bodies: Array<Record<string, unknown>> = [];
    const answer = JSON.stringify({ result: 'plain' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.response_format) return new Response('{"error":"response_format unsupported"}', { status: 400 });
        if (body.stream) return new Response('{"error":"stream unsupported"}', { status: 400 });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: answer } }], usage: { total_tokens: 4 } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );
    await expect(gateway.json(schema, '返回结构化结果', context)).resolves.toEqual({ result: 'plain' });
    expect(bodies.map((body) => [body.stream, Boolean(body.response_format)])).toEqual([
      [true, true],
      [true, false],
      [undefined, false],
    ]);
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true });
    expect((bodies[0]!.response_format as any).json_schema.schema.properties.result).toBeTruthy();
    // The rejected attempts generated nothing; the run is charged one call.
    expect((await store.one('SELECT model_calls,usage FROM app.runs WHERE id=$1', [runId]))!).toEqual({
      model_calls: 1,
      usage: [{ total_tokens: 4 }],
    });
    // The same process does not ask again in a form this provider already refused.
    await gateway.json(schema, '返回结构化结果', context);
    expect(bodies.slice(3).map((body) => [body.stream, Boolean(body.response_format)])).toEqual([[undefined, false]]);
  });
  it('traces every call with its step, profile, timing, reasoning tokens and outcome', async () => {
    const { runId, gateway } = await run();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        call++;
        expect(body.temperature).toBe(0);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: call === 1 ? JSON.stringify({ result: 'ok' }) : 'not json' } }],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    await traced('extract', () => gateway.json(schema, '抽取', context, { profile: 'extract' }));
    await expect(
      traced('extract', () => gateway.json(schema, '抽取', context, { profile: 'extract' })),
    ).rejects.toMatchObject({ code: 'model_invalid' });
    const rows = await store.rows('SELECT * FROM app.model_calls WHERE run_id=$1 ORDER BY id', [runId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      step: 'extract',
      profile: 'extract',
      model: 'synthetic-budget-test',
      structured: 'json_schema',
      prompt_tokens: 11,
      completion_tokens: 7,
      reasoning_tokens: 5,
      outcome: 'ok',
    });
    expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.first_byte_ms).toBeGreaterThanOrEqual(0);
    expect(rows[1]).toMatchObject({ outcome: 'invalid', error_code: 'model_invalid' });
  });
  it('accepts a 60-second response within the original 180-second run deadline', async () => {
    const { runId, claimed, gateway } = await run(),
      mock = clockedModel(60000);
    const pending = gateway.json(schema, '返回结构化结果', context);
    await mock.started;
    await vi.advanceTimersByTimeAsync(60000);
    await expect(pending).resolves.toEqual({ result: 'synthetic-response' });
    expect(mock.timeout).toHaveBeenCalledWith(90000);
    const saved = (await store.one('SELECT model_calls,deadline,usage FROM app.runs WHERE id=$1', [runId]))!;
    expect(saved.model_calls).toBe(1);
    expect(saved.deadline).toEqual(claimed.deadline);
    expect(saved.usage).toEqual([{ total_tokens: 3 }]);
  });
  it('allows a research call beyond 90 seconds without extending the persisted run deadline', async () => {
    const { runId, claimed, gateway } = await run(),
      mock = clockedModel(95000);
    const pending = gateway.json(schema, '返回结构化结果', context, { timeoutMs: 180000 });
    await mock.started;
    await vi.advanceTimersByTimeAsync(95000);
    await expect(pending).resolves.toEqual({ result: 'synthetic-response' });
    expect(mock.timeout.mock.calls[0]![0]).toBeGreaterThan(95000);
    expect(mock.timeout.mock.calls[0]![0]).toBeLessThanOrEqual(180000);
    const saved = (await store.one('SELECT model_calls,deadline FROM app.runs WHERE id=$1', [runId]))!;
    expect(saved.model_calls).toBe(1);
    expect(saved.deadline).toEqual(claimed.deadline);
  });
  it('aborts a response beyond 90 seconds without consuming a retry or extending the run deadline', async () => {
    const { runId, claimed, gateway } = await run(),
      mock = clockedModel(95000);
    const pending = gateway.json(schema, '返回结构化结果', context);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'model_unavailable' });
    await mock.started;
    await vi.advanceTimersByTimeAsync(90000);
    await rejected;
    expect(mock.request).toHaveBeenCalledTimes(1);
    const saved = (await store.one('SELECT model_calls,deadline,usage FROM app.runs WHERE id=$1', [runId]))!;
    expect(saved.model_calls).toBe(1);
    expect(saved.deadline).toEqual(claimed.deadline);
    expect(saved.usage).toEqual([]);
  });
  it('limits a later call to the persisted remaining time and refuses calls after the total deadline', async () => {
    const { runId, claimed, gateway } = await run(),
      mock = clockedModel(60000);
    vi.setSystemTime(new Date(claimed.deadline).getTime() - 20000);
    const pending = gateway.json(schema, '返回结构化结果', context, { timeoutMs: 180000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'model_unavailable' });
    await mock.started;
    expect(mock.timeout).toHaveBeenCalledWith(20000);
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    await expect(gateway.json(schema, '返回结构化结果', context)).rejects.toMatchObject({ code: 'runtime_limit' });
    expect(mock.request).toHaveBeenCalledTimes(1);
    const saved = (await store.one('SELECT model_calls,deadline FROM app.runs WHERE id=$1', [runId]))!;
    expect(saved.model_calls).toBe(1);
    expect(saved.deadline).toEqual(claimed.deadline);
  });
  it('rejects a late provider result even if the transport ignores cancellation', async () => {
    const { runId, claimed, gateway } = await run(),
      mock = clockedModel(10000, true);
    vi.setSystemTime(new Date(claimed.deadline).getTime() - 5000);
    const pending = gateway.json(schema, '返回结构化结果', context);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_limit' });
    await mock.started;
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect((await store.one('SELECT usage FROM app.runs WHERE id=$1', [runId]))!.usage).toEqual([]);
  });
  it('keeps the five-call ceiling across a retry with the same deadline', async () => {
    const { runId, claimed, gateway } = await run();
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ result: 'synthetic-response' }) } }] }),
        ),
    );
    vi.stubGlobal('fetch', request);
    for (let index = 0; index < 4; index++) await gateway.json(schema, '返回结构化结果', context);
    await failRun(store, { runId, generation: claimed.generation }, 'synthetic retry', false);
    const retry = (await claimRun(store, runId))!,
      resumed = new ModelGateway(store, folder, { runId, generation: retry.generation });
    expect(retry.deadline).toEqual(claimed.deadline);
    expect(retry.model_calls).toBe(4);
    await resumed.json(schema, '返回结构化结果', context);
    await expect(resumed.json(schema, '返回结构化结果', context)).rejects.toMatchObject({ code: 'runtime_limit' });
    expect(request).toHaveBeenCalledTimes(5);
    expect((await store.one('SELECT model_calls,deadline FROM app.runs WHERE id=$1', [runId]))!).toMatchObject({
      model_calls: 5,
      deadline: claimed.deadline,
    });
  });
});
