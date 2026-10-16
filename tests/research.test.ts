import { describe, expect, it } from 'vitest';
import { CreateSession } from '../packages/contracts/src/index.js';
import { ResearchAnswer, ResearchReview, type ResearchReview as Review } from '../packages/contracts/src/research.js';
import {
  advanceResearch,
  initialResearch,
  ModelResearchAnswer,
  ModelResearchComparison,
  ModelResearchReview,
  researchStepName,
  STRATEGIES,
  summarizeUsage,
  verifyResearchCitations,
  type ResearchModel,
} from '../packages/core/src/research/engine.js';
import { parseModelJSON, type ModelContext } from '../packages/core/src/model.js';
import { researchEvaluationArgs, shuffled } from '../scripts/evaluate-research.js';

const source = {
  sourceId: 's1',
  version: 1,
  title: '合成资料',
  start: 0,
  end: 17,
  quote: '默认隔离级别不等于可串行化。',
  digest: 'a'.repeat(64),
};
const context: ModelContext = {
  task: '比较隔离级别',
  latest: '比较隔离级别',
  previous: '',
  rules: [],
  notes: [],
  sources: [source],
};
function review(score: number): Review {
  return {
    scores: { coverage: score, evidence: score, challenges: score, usability: score },
    issues: ['补充反例。'],
    queries: ['并发反例'],
    rationale: '核对每一项要求。',
    satisfied: false,
  };
}
type Handler = (instruction: string, ctx: ModelContext, options?: Record<string, unknown>) => unknown;
/** A scripted model: the handler returns raw JSON, the schema parses it as the gateway would. */
function scripted(handler: Handler, provided = [source]): ResearchModel {
  return {
    async call(schema, instruction, ctx, options) {
      return { value: schema.parse(await handler(instruction, ctx, options)), providedCitations: provided };
    },
  };
}
const answer = (content: string) => ({
  content,
  citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }],
  limitations: [],
});
/** A judge preferring the answer whose content carries the larger number; the order shown must not matter. */
function judge(ctx: ModelContext, extra: Record<string, unknown> = {}) {
  const shown = JSON.parse(ctx.previous) as { A: { content: string }; B: { content: string } };
  const n = (text: string) => Number(/(\d+)/.exec(text)?.[1] ?? 0);
  return {
    scores: { A: review(2).scores, B: review(3).scores },
    winner: n(shown.A.content) > n(shown.B.content) ? 'A' : 'B',
    reasons: ['覆盖更完整。'],
    issues: ['补充反例。'],
    queries: ['并发反例'],
    satisfied: false,
    ...extra,
  };
}
async function run(state: ReturnType<typeof initialResearch>, model: ResearchModel, random = () => 0.9) {
  while (state.phase !== 'finished') state = await advanceResearch(state, model, context, { random });
  return state;
}
describe('research search and evidence', () => {
  it('requires explicit live evaluation arguments and keeps blind labels separate', () => {
    expect(researchEvaluationArgs([])).toEqual({ live: false, file: '', selected: '', efforts: [], maxCalls: 13 });
    expect(() => researchEvaluationArgs(['--live'])).toThrow();
    expect(() => researchEvaluationArgs(['--live', '--config', 'config.json'])).toThrow();
    expect(() => researchEvaluationArgs(['--budget', '999'])).toThrow();
    expect(researchEvaluationArgs(['--live', '--config', 'config.json', '--case', 'isolation']).live).toBe(true);
    expect(researchEvaluationArgs(['--effort', 'low', '--effort', 'high', '--max-calls', '10'])).toMatchObject({
      efforts: ['low', 'high'],
      maxCalls: 10,
    });
    expect(() => researchEvaluationArgs(['--max-calls', '14'])).toThrow();
    expect(() => researchEvaluationArgs(['--max-calls', '0'])).toThrow();
    expect(() => researchEvaluationArgs(['--effort', 'low', '--effort', 'low'])).toThrow();
    const input = ['A', 'B', 'C'];
    expect(shuffled(input).sort()).toEqual(input);
    expect(input).toEqual(['A', 'B', 'C']);
  });
  it('preserves existing requests and validates the new scope and effort', () => {
    expect(CreateSession.parse({ prompt: '原有学习' }).research).toBeUndefined();
    expect(CreateSession.parse({ prompt: '研究', kind: 'work', research: {} }).research).toEqual({
      effort: 'low',
      sourceIds: [],
    });
    expect(CreateSession.safeParse({ prompt: '研究', kind: 'study', research: {} }).success).toBe(false);
    expect(CreateSession.safeParse({ prompt: '研究', kind: 'work', research: { effort: 'unlimited' } }).success).toBe(
      false,
    );
  });
  it('resolves short quotations to exact original offsets and drops hallucinated versions or quotes', () => {
    const answer = {
      content: '说明',
      citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }],
      limitations: [],
    };
    expect(verifyResearchCitations(answer, [source]).citations[0]).toMatchObject({
      start: 6,
      end: 13,
      quote: '不等于可串行化',
    });
    const wrongVersion = verifyResearchCitations({ ...answer, citations: [{ ...answer.citations[0]!, version: 2 }] }, [
      source,
    ]);
    expect(wrongVersion).toMatchObject({ citations: [], verified: [], dropped: ['不等于可串行化'] });
    const invented = verifyResearchCitations(
      { ...answer, citations: [{ ...answer.citations[0]!, quote: '总是安全' }] },
      [source],
    );
    expect(invented.citations).toEqual([]);
    expect(invented.dropped).toEqual(['总是安全']);
    expect(verifyResearchCitations(answer, []).dropped).toHaveLength(1);
  });
  it('tolerates re-spaced and full-width quotations but stores the exact original text', () => {
    const spaced = { ...source, quote: 'READ COMMITTED (RC) 不等于\n可串行化。', end: 31 };
    const result = verifyResearchCitations(
      {
        content: '说明',
        citations: [
          { sourceId: 's1', version: 1, quote: 'ＲＣ） 不等于可串行化' },
          { sourceId: 's1', version: 1, quote: 'RC) 不等于 可串行化' },
        ],
        limitations: [],
      },
      [spaced],
    );
    // Both references resolve to the same original span and are kept once.
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.quote).toBe('RC) 不等于\n可串行化');
    expect(spaced.quote.slice(result.citations[0]!.start, result.citations[0]!.end)).toBe(result.citations[0]!.quote);
    expect(result.dropped).toEqual([]);
  });
  it('keeps a candidate whose quotations partly fail the check, and tells the reviewer', async () => {
    const latest: string[] = [];
    const model = scripted((instruction, ctx) => {
      latest.push(ctx.latest);
      return instruction.includes('LAB2_SOLVE')
        ? {
            content: '候选',
            citations: [
              { sourceId: 's1', version: 1, quote: '不等于可串行化' },
              { sourceId: 's1', version: 1, quote: '资料里没有的句子' },
            ],
            limitations: [],
          }
        : review(3);
    });
    let state = await advanceResearch(initialResearch('low'), model, context);
    expect(state.candidates[0]).toMatchObject({ droppedCitations: ['资料里没有的句子'] });
    expect(state.candidates[0]!.answer.citations).toEqual([{ sourceId: 's1', version: 1, quote: '不等于可串行化' }]);
    state = await advanceResearch(state, model, context);
    expect(state.best).toBe(0);
    expect(latest[1]).toContain('1 条引文无法在给定资料中找到');
  });
  it('repairs harmless format slips without inventing missing fields', () => {
    const answer = ModelResearchAnswer.parse({
      content: '  答案  ',
      citations: [{ sourceId: 's1', version: '1', quote: ' 不等于可串行化 ', page: 3 }, { quote: 'x' }],
      limitations: Array.from({ length: 9 }, (_, i) => '缺口 ' + i),
      confidence: 'high',
    });
    expect(answer).toEqual({
      content: '答案',
      citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }],
      limitations: ['缺口 0', '缺口 1', '缺口 2', '缺口 3', '缺口 4', '缺口 5'],
    });
    const long = ModelResearchAnswer.parse({
      content: ('第一段。'.repeat(500) + '\n\n').repeat(4),
      citations: [],
      limitations: [],
    });
    expect(long.content.length).toBeLessThanOrEqual(6000);
    expect(long.limitations.at(-1)).toContain('已在段落处截断');
    const parsed = ModelResearchReview.parse({
      scores: { coverage: '3', evidence: 4.4, challenges: -1, usability: 9 },
      issues: ['', '补充反例'],
      queries: ['a', 'b', 'c', 'd'],
      rationale: '依据',
      satisfied: 'false',
      extra: true,
    });
    expect(parsed.scores).toEqual({ coverage: 3, evidence: 4, challenges: 0, usability: 4 });
    expect(parsed).toMatchObject({ issues: ['补充反例'], queries: ['a', 'b', 'c'], satisfied: false });
    expect(ModelResearchReview.safeParse({ scores: { coverage: 3 }, rationale: '缺分数' }).success).toBe(false);
    const compared = ModelResearchComparison.parse({
      scores: { A: { coverage: '3', evidence: 4.4, challenges: 2, usability: 3 }, B: review(1).scores },
      winner: ' a ',
      reasons: ['依据', ''],
      issues: [],
      queries: [],
      satisfied: 'false',
      note: '多余字段',
    });
    expect(compared).toMatchObject({ winner: 'A', reasons: ['依据'], satisfied: false });
    expect(compared.scores.A).toEqual({ coverage: 3, evidence: 4, challenges: 2, usability: 3 });
    expect(ModelResearchComparison.parse({ ...compared, winner: '平局' }).winner).toBe('tie');
    expect(ModelResearchComparison.safeParse({ ...compared, winner: 'C' }).success).toBe(false);
    expect(ModelResearchAnswer.safeParse({ citations: [], limitations: [] }).success).toBe(false);
  });
  it('sends reviews to the reviewer role and solving to the main model, with step profiles', async () => {
    const roles: Array<[unknown, unknown]> = [];
    const model = scripted((instruction, ctx, options) => {
      roles.push([options?.role, options?.profile]);
      return instruction.includes('LAB2_SOLVE')
        ? answer('候选 ' + roles.length)
        : instruction.includes('LAB2_COMPARE')
          ? judge(ctx)
          : review(2);
    });
    await run(initialResearch('low'), model);
    expect(roles).toEqual([
      [undefined, 'solve'],
      ['review', undefined],
      [undefined, 'solve'],
      ['review', undefined],
    ]);
  });
  it('reads one JSON object wrapped in prose or a code fence', () => {
    expect(parseModelJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJSON('结果如下：{"a":"含 } 与 \\" 的文本","b":{"c":2}} 以上。')).toEqual({
      a: '含 } 与 " 的文本',
      b: { c: 2 },
    });
    expect(() => parseModelJSON('没有对象')).toThrow();
    expect(() => parseModelJSON('{"a":')).toThrow();
  });
  it.each([
    ['direct', 1, 'direct'],
    ['low', 4, 'budget'],
    ['high', 7, 'budget'],
  ] as const)('%s runs its bounded solve / compare schedule', async (effort, expected, stop) => {
    const seen: Array<{ instruction: string; previous: string }> = [];
    const model = scripted((instruction, ctx) => {
      seen.push({ instruction, previous: ctx.previous });
      if (instruction.includes('LAB2_SOLVE')) return answer('候选 ' + seen.length);
      return instruction.includes('LAB2_COMPARE') ? judge(ctx) : review(3);
    });
    const state = await run(initialResearch(effort), model);
    expect(seen).toHaveLength(expected);
    expect(state.stopReason).toBe(stop);
    if (effort === 'high') {
      // Two independent roots, neither anchored on an earlier answer, then a comparison of the two.
      expect(seen.slice(0, 2).map((call) => call.previous)).toEqual(['', '']);
      expect(seen[0]!.instruction).toContain(STRATEGIES.direct);
      expect(seen[1]!.instruction).toContain('探索另一方向');
      expect(seen[2]!.instruction).toContain('LAB2_COMPARE');
      expect(seen[5]!.instruction).toContain('最简单的反例');
      expect(state.candidates.map((c) => [c.parent, c.branch])).toEqual([
        [null, 0],
        [null, 1],
        [1, 1],
        [2, 1],
      ]);
      // The newer answer always wins this judge, so each revision replaces the version it improved.
      expect(state.best).toBe(3);
      expect(state.candidates.map((c) => c.comparison?.winner ?? null)).toEqual([null, 'new', 'new', 'new']);
    }
  });
  it('shows the two answers in a random order and keeps the incumbent on a tie', async () => {
    const orders: string[] = [];
    const model = scripted((instruction, ctx) => {
      if (instruction.includes('LAB2_SOLVE')) return answer(ctx.previous ? '修改版' : '首版');
      if (!instruction.includes('LAB2_COMPARE')) return review(3);
      orders.push(JSON.parse(ctx.previous).A.content);
      return judge(ctx, { winner: 'tie' });
    });
    for (const [random, first] of [
      [0.1, '修改版'],
      [0.9, '首版'],
    ] as const) {
      const state = await run(initialResearch('low'), model, () => random);
      expect(state.best).toBe(0);
      expect(state.candidates[1]!.comparison).toMatchObject({
        against: 0,
        winner: 'tie',
        order: random < 0.5 ? 'new-first' : 'incumbent-first',
      });
      expect(orders.at(-1)).toBe(first);
      expect(state.candidates[1]!.reviewNote).toContain('不分高下');
    }
  });
  it('stops as a plateau when two revisions in a row do not win', async () => {
    let roots = 5;
    const model = scripted((instruction, ctx) =>
      instruction.includes('LAB2_SOLVE')
        ? answer(ctx.previous ? '修改 0' : '根 ' + roots++)
        : // The judge prefers the larger number; revisions carry 0 and always lose.
          judge(ctx),
    );
    const state = await run(initialResearch('high'), model);
    expect(state.stopReason).toBe('plateau');
    expect(state.candidates.slice(2).map((c) => c.comparison?.winner)).toEqual(['incumbent', 'incumbent']);
    expect(state.best).toBeLessThan(2);
  });
  it('continues with one direction when the other root fails', async () => {
    const model = scripted((instruction) => {
      if (instruction.includes('探索另一方向')) throw new Error('合成的流中断');
      return instruction.includes('LAB2_SOLVE') ? answer('直接 1') : review(3);
    });
    const state = await advanceResearch(initialResearch('high'), model, context, { callsLeft: 8 });
    expect(state.candidates).toHaveLength(1);
    expect(state.warnings.join()).toContain('另一方向的求解没有完成');
    expect(researchStepName(state)).toBe('review:0');
  });
  it('starts with a single root when the budget cannot pay for comparing two', () => {
    expect(researchStepName(initialResearch('high'), 8)).toBe('roots');
    expect(researchStepName(initialResearch('high'), 2)).toBe('solve:0');
    expect(researchStepName(initialResearch('low'), 4)).toBe('solve:0');
  });
  it('accepts high effort early only after the two directions were compared', async () => {
    let calls = 0;
    const model = scripted((instruction, ctx) => {
      calls++;
      return instruction.includes('LAB2_SOLVE')
        ? answer('满足要求 ' + calls)
        : judge(ctx, { issues: [], satisfied: true, scores: { A: review(4).scores, B: review(4).scores } });
    });
    const state = await run(initialResearch('high'), model);
    expect(calls).toBe(3);
    expect(state.stopReason).toBe('accepted');
    expect(state.candidates).toHaveLength(2);
  });
  it('does not let a self-reported perfect answer without evidence trigger acceptance', async () => {
    const model = scripted(
      (instruction, ctx) =>
        instruction.includes('LAB2_SOLVE')
          ? { content: '无证据结论 ' + Math.random(), citations: [], limitations: [] }
          : judge(ctx, { issues: [], satisfied: true, scores: { A: review(4).scores, B: review(4).scores } }),
      [],
    );
    let state = initialResearch('high');
    for (let n = 0; n < 2; n++) state = await advanceResearch(state, model, { ...context, sources: [] });
    expect(state.phase).toBe('solve');
    expect(state.candidates[state.best!]!.score).toBe(13);
  });
  it('keeps old state immutable, never adopts an unreviewed version, and does not resume a version-one record', async () => {
    const state = initialResearch('low');
    const model = scripted(() => ({ content: '候选', citations: [], limitations: [] }));
    const next = await advanceResearch(state, model, context);
    expect(state.candidates).toEqual([]);
    expect(next.best).toBeNull();
    expect(next.candidates[0]!.review).toBeNull();
    await expect(advanceResearch({ ...next, version: 1 }, model, context)).rejects.toMatchObject({
      code: 'research_version',
    });
  });
  it('reports missing usage instead of claiming zero actual tokens', () => {
    expect(summarizeUsage([{ total_tokens: 10 }, {}], 2)).toMatchObject({
      totalTokens: 10,
      reportedCalls: 1,
      complete: false,
    });
    expect(summarizeUsage([{ total_tokens: -10 }], 1)).toMatchObject({
      totalTokens: 0,
      reportedCalls: 0,
      complete: false,
    });
    expect(summarizeUsage([{ total_tokens: 10 }], 1).complete).toBe(true);
  });
  it('bounds model answers and review data at the contract', () => {
    expect(ResearchAnswer.safeParse({ content: 'x'.repeat(6001), citations: [], limitations: [] }).success).toBe(false);
    expect(ResearchReview.safeParse({ ...review(2), scores: { ...review(2).scores, evidence: 9 } }).success).toBe(
      false,
    );
  });
});
