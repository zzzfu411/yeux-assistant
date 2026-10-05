import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ModelAssessment } from '../packages/contracts/src/assessment.js';
import {
  cleanupEvaluation,
  evaluateLearningCases,
  evaluationContext,
  parseEvaluationArgs,
  pickEvaluationModel,
  redactEvaluation,
  selectEvaluationCases,
  validateEvaluationEnvironment,
  type EvaluationCase,
  type EvaluationCall,
} from '../scripts/evaluate-learning.js';

const example: EvaluationCase = {
  id: 'hidden-correct-label',
  course: '课程标签',
  kind: 'correct',
  material: '事务更新全部生效或全部不生效。',
  question: '失败后如何处理转账？',
  answer: '回滚扣款，使事务更新全部不生效。',
  expected: 'pass',
  rubric: '这是不能外发的rubric哨兵',
};
const response = (context: ReturnType<typeof evaluationContext>) =>
  ModelAssessment.parse({
    verdict: 'pass',
    feedback: '回答与给定定义对应。',
    evidence: '回答中的回滚对应资料。',
    answerQuotes: [example.answer],
    citationRefs: context.sources,
  });
const good: EvaluationCall = async (_item, context) => ({
  response: response(context),
  rawResponse: { verdict: 'pass', providerExtra: '保留原始返回' },
  providedCitations: context.sources,
  exerciseComplete: true,
  usage: [{ total_tokens: 42 }],
  modelCalls: 1,
  latencyMs: 7,
});

describe('synthetic evaluation runner isolation and reporting', () => {
  it('requires explicit live and config while dry-run does not open even a nonexistent config path', () => {
    expect(parseEvaluationArgs([])).toEqual({ live: false, config: undefined, help: false, caseIds: [] });
    expect(() => parseEvaluationArgs(['--live'])).toThrow('同时指定');
    expect(() => parseEvaluationArgs(['--live', '--config', '--unknown'])).toThrow();
    expect(() => parseEvaluationArgs(['--live', '--config', 'first', '--config', 'second'])).toThrow();
    const child = spawnSync(
      process.execPath,
      ['scripts/evaluate-learning.mjs', '--config', '/this-model-config-must-not-be-opened.json'],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DATABASE_URL: 'postgres://must-never-connect.invalid/production',
          ASSISTANT_DATA: '/must-never-read-personal-data',
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      mode: 'dry-run',
      cases: 15,
      networkRequests: 0,
      configurationRead: false,
    });
  });
  it('selects only explicit fixed IDs and keeps dry-run independent of configuration', () => {
    expect(parseEvaluationArgs(['--case', 'gse-partial', '--case', 'db-correct']).caseIds).toEqual([
      'gse-partial',
      'db-correct',
    ]);
    for (const args of [['--case'], ['--case', '../config.json'], ['--case', 'gse-partial', '--case', 'gse-partial']])
      expect(() => parseEvaluationArgs(args)).toThrow();
    expect(selectEvaluationCases([example], [])).toEqual([example]);
    expect(selectEvaluationCases([example], [example.id])).toEqual([example]);
    expect(() => selectEvaluationCases([example], ['unknown'])).toThrow('固定清单');
    const child = spawnSync(
      process.execPath,
      [
        'scripts/evaluate-learning.mjs',
        '--case',
        'gse-partial',
        '--case',
        'db-correct',
        '--config',
        '/must-not-read.json',
      ],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 10000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      mode: 'dry-run',
      cases: 2,
      selection: 'subset',
      caseIds: ['gse-partial', 'db-correct'],
      networkRequests: 0,
      configurationRead: false,
      maximumLiveRequests: 2,
    });
    const unknown = spawnSync(process.execPath, ['scripts/evaluate-learning.mjs', '--case', 'unknown-fixed-case'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(unknown.status).toBe(1);
  });
  it('stops after three actual consecutive network failures without miscounting untouched cases', async () => {
    let calls = 0;
    const progress: unknown[] = [];
    const cases = Array.from({ length: 15 }, (_, index) => ({ ...example, id: 'case-' + index }));
    const report = await evaluateLearningCases(
      cases,
      async () => {
        calls++;
        return {
          rawResponse: null,
          providedCitations: [],
          exerciseComplete: false,
          usage: [],
          modelCalls: 1,
          latencyMs: 90000,
          error: calls === 2 ? 'model_http_error' : 'model_unavailable',
        };
      },
      { model: 'fixture', sourceSharing: true, onProgress: (item) => progress.push(item) },
    );
    expect(calls).toBe(3);
    expect(report.status).toBe('completed_with_errors');
    expect(report.stopReason).toBe('consecutive_network_failures');
    expect(report.summary).toMatchObject({
      total: 15,
      evaluated: 0,
      errors: 3,
      networkErrors: 3,
      notRun: 12,
      cancelled: 0,
      modelCalls: 3,
      acceptedAgreement: { matches: 0, total: 15, rate: 0 },
    });
    expect(
      report.results
        .slice(3)
        .every(
          (item) =>
            item.status === 'not_run' &&
            item.error?.code === 'failure_limit_reached' &&
            item.modelCalls === 0 &&
            item.accepted === null,
        ),
    ).toBe(true);
    expect(progress).toContainEqual({ index: 1, total: 15, status: 'running' });
    expect(progress.at(-1)).toEqual({ index: 15, total: 15, status: 'not_run' });
    expect(
      progress.every(
        (item) =>
          Object.keys(item as object)
            .sort()
            .join(',') === 'index,status,total',
      ),
    ).toBe(true);
  });
  it('resets the network failure streak after a response and does not count unconfigured cases as network attempts', async () => {
    const cases = Array.from({ length: 8 }, (_, index) => ({ ...example, id: 'case-' + index }));
    let calls = 0;
    const report = await evaluateLearningCases(
      cases,
      async (item, context, index) => {
        calls++;
        if (index === 2) return good(item, context, index);
        return {
          rawResponse: null,
          providedCitations: [],
          exerciseComplete: false,
          usage: [],
          modelCalls: index === 5 ? 0 : 1,
          latencyMs: 10,
          error: index === 5 ? 'model_unconfigured' : 'model_unavailable',
        };
      },
      { model: 'fixture', sourceSharing: true },
    );
    expect(calls).toBe(8);
    expect(report.summary).toMatchObject({
      total: 8,
      evaluated: 1,
      errors: 7,
      networkErrors: 6,
      notRun: 0,
      modelCalls: 7,
    });
    expect(report.stopReason).toBeNull();
  });
  it('records a manual stop separately and leaves all selected cases in the comparison denominator', async () => {
    const cases = Array.from({ length: 5 }, (_, index) => ({ ...example, id: 'case-' + index }));
    let stopped = false,
      calls = 0;
    const report = await evaluateLearningCases(
      cases,
      async (item, context, index) => {
        calls++;
        stopped = true;
        return good(item, context, index);
      },
      { model: 'fixture', sourceSharing: true, shouldStop: () => stopped },
    );
    expect(calls).toBe(1);
    expect(report.status).toBe('completed_with_errors');
    expect(report.stopReason).toBe('cancelled');
    expect(report.summary).toMatchObject({
      total: 5,
      evaluated: 1,
      errors: 0,
      networkErrors: 0,
      notRun: 0,
      cancelled: 4,
      modelCalls: 1,
      acceptedAgreement: { matches: 1, total: 5, rate: 0.2 },
    });
    expect(report.results.slice(1).every((item) => item.status === 'cancelled' && item.modelCalls === 0)).toBe(true);
  });
  it('refuses inherited connection variables before creating a database or reading model settings', () => {
    expect(() => validateEvaluationEnvironment({ DATABASE_URL: 'postgres://production' })).toThrow('外部数据库');
    expect(() => validateEvaluationEnvironment({ PGSERVICE: 'production' })).toThrow('外部数据库');
    expect(() => validateEvaluationEnvironment({ API_TEST_DATABASE_URL: 'postgres://unrelated_test' })).toThrow();
    expect(() => validateEvaluationEnvironment({ PATH: '/bin' })).not.toThrow();
  });
  it('copies only llm settings and rejects credential-bearing URLs', () => {
    const model = pickEvaluationModel({
      llm: {
        base_url: 'https://model.example/v1',
        model: 'fixture',
        api_key: 'synthetic-key',
        tools: false,
        mail: 'do not copy',
      },
      mail_password: 'mail-secret',
      documents: ['private'],
    });
    expect(model).toEqual({
      base_url: 'https://model.example/v1',
      model: 'fixture',
      api_key: 'synthetic-key',
      tools: false,
    });
    for (const base_url of ['https://user:password@model.example/v1', 'https://model.example/v1?token=secret'])
      expect(() => pickEvaluationModel({ llm: { base_url, model: 'test' } })).toThrow();
  });
  it('sends only question, answer and material with neutral source identifiers, never labels or the rubric', () => {
    const poisoned = { ...example, proposed: 'SENTINEL_PROPOSED', fault: 'SENTINEL_FAULT' };
    const context = evaluationContext(poisoned, 0),
      encoded = JSON.stringify(context);
    expect(encoded).toContain(example.question);
    expect(encoded).toContain(example.answer);
    expect(encoded).toContain(example.material);
    for (const hidden of [
      example.id,
      example.course,
      example.kind,
      example.rubric,
      'SENTINEL_PROPOSED',
      'SENTINEL_FAULT',
    ])
      expect(encoded).not.toContain(hidden);
    expect(context.sources[0]).toMatchObject({
      sourceId: 'evaluation-source-001',
      version: 1,
      start: 0,
      end: example.material.length,
    });
    expect(evaluationContext({ ...example, material: '' }, 1).sources).toEqual([]);
  });
  it('runs at most fifteen cases sequentially, once each, with distinct source IDs', async () => {
    let active = 0,
      maximum = 0,
      calls = 0;
    const sourceIds: string[] = [];
    const cases = Array.from({ length: 15 }, (_, index) => ({ ...example, id: 'case-' + index }));
    const report = await evaluateLearningCases(
      cases,
      async (item, context, index) => {
        active++;
        maximum = Math.max(maximum, active);
        calls++;
        sourceIds.push(context.sources[0]!.sourceId);
        await Promise.resolve();
        const result = await good(item, context, index);
        active--;
        return result;
      },
      { model: 'fixture', sourceSharing: true },
    );
    expect(calls).toBe(15);
    expect(maximum).toBe(1);
    expect(new Set(sourceIds).size).toBe(15);
    expect(report.summary).toMatchObject({
      total: 15,
      evaluated: 15,
      errors: 0,
      modelCalls: 15,
      rawAgreement: { matches: 15, rate: 1 },
      acceptedAgreement: { matches: 15, rate: 1 },
    });
    expect(report.status).toBe('completed');
    expect(report.scope).toContain('不是人工确认');
    await expect(
      evaluateLearningCases([...cases, example], good, { model: 'fixture', sourceSharing: true }),
    ).rejects.toThrow('1–15');
  });
  it('reports errors separately and never excludes them from the overall comparison denominator', async () => {
    const cases = [example, { ...example, id: 'timeout-case' }, { ...example, id: 'unconfigured-case' }];
    const report = await evaluateLearningCases(
      cases,
      async (item, context, index) =>
        index === 0
          ? good(item, context, index)
          : {
              rawResponse: null,
              providedCitations: [],
              exerciseComplete: false,
              usage: [],
              modelCalls: index === 1 ? 1 : 0,
              latencyMs: 10,
              error: index === 1 ? 'model_unavailable' : 'model_unconfigured',
            },
      { model: 'fixture', sourceSharing: true },
    );
    expect(report.status).toBe('completed_with_errors');
    expect(report.summary).toMatchObject({
      total: 3,
      evaluated: 1,
      errors: 2,
      modelCalls: 2,
      acceptedAgreement: { matches: 1, total: 3, rate: 1 / 3 },
    });
    expect(report.results[1]).toMatchObject({
      status: 'error',
      accepted: null,
      rawMatchesExpected: null,
      acceptedMatchesExpected: null,
    });
  });
  it('keeps raw judgment agreement distinct from a rejected citation protocol', async () => {
    const report = await evaluateLearningCases(
      [example],
      async (item, context, index) => {
        const result = await good(item, context, index);
        result.response!.citationRefs[0]!.version = 99;
        return result;
      },
      { model: 'fixture', sourceSharing: true },
    );
    expect(report.summary).toMatchObject({
      rawAgreement: { matches: 1 },
      acceptedAgreement: { matches: 0 },
      guardDowngrades: 1,
      invalidCitationCases: 1,
      engineeringErrors: 1,
    });
    expect(report.results[0]).toMatchObject({
      status: 'evaluated',
      accepted: { verdict: 'unclear' },
      reasons: ['invalid_citation'],
    });
    expect(report.results[0]!.rubric).toBe(example.rubric);
  });
  it('redacts secrets and endpoint paths in raw provider fields and ignores arbitrary thrown error text', async () => {
    const secret = 'SYNTHETIC-KEY',
      endpoint = 'https://model.example/private-route';
    const report = await evaluateLearningCases(
      [example],
      async (item, context, index) => ({
        ...(await good(item, context, index)),
        rawResponse: { debug: secret + ' ' + endpoint, [secret]: 'key name' },
      }),
      { model: 'fixture', sourceSharing: true, secrets: [secret, endpoint] },
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(endpoint);
    expect(JSON.stringify(report)).toContain('[已隐藏]');
    const failed = await evaluateLearningCases(
      [example],
      async () => {
        throw new Error(secret);
      },
      { model: 'fixture', sourceSharing: true },
    );
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failed.results[0]!.error?.code).toBe('unexpected_error');
    expect(redactEvaluation({ nested: [secret] }, [secret])).toEqual({ nested: ['[已隐藏]'] });
  });
  it('rejects malformed responses and records an empty or absent model as an error, not a correct verdict', async () => {
    const report = await evaluateLearningCases(
      [example],
      async () => ({
        response: { verdict: 'pass' } as never,
        rawResponse: { verdict: 'pass' },
        providedCitations: [],
        exerciseComplete: true,
        usage: [],
        modelCalls: 1,
        latencyMs: 1,
      }),
      { model: '', sourceSharing: true },
    );
    expect(report.results[0]).toMatchObject({
      status: 'error',
      error: { code: 'model_invalid' },
      accepted: null,
      modelResponse: { verdict: 'pass' },
    });
    expect(report.summary.acceptedAgreement.matches).toBe(0);
  });
  it('attempts every cleanup even when closing a pool or removing the container fails', async () => {
    const called: string[] = [];
    const result = await cleanupEvaluation({
      closeStore: async () => {
        called.push('store');
        throw new Error('secret');
      },
      closeAdmin: async () => {
        called.push('admin');
      },
      removeContainer: () => {
        called.push('container');
        throw new Error('secret');
      },
      removeConfig: async () => {
        called.push('config');
      },
    });
    expect(called.sort()).toEqual(['admin', 'config', 'container', 'store']);
    expect(result).toEqual({
      ok: false,
      failures: ['store_close_failed', 'container_remove_failed'],
      temporaryConfigRemoved: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
