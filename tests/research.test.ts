import { describe, expect, it } from 'vitest';
import { CreateSession } from '../packages/contracts/src/index.js';
import { ResearchAnswer, ResearchReview, type ResearchReview as Review } from '../packages/contracts/src/research.js';
import {
  advanceResearch,
  initialResearch,
  ModelResearchAnswer,
  ModelResearchReview,
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
    const model: ResearchModel = {
      providedCitations: [source],
      async json(schema, instruction, ctx) {
        latest.push(ctx.latest);
        return schema.parse(
          instruction.includes('LAB2_SOLVE')
            ? {
                content: '候选',
                citations: [
                  { sourceId: 's1', version: 1, quote: '不等于可串行化' },
                  { sourceId: 's1', version: 1, quote: '资料里没有的句子' },
                ],
                limitations: [],
              }
            : review(3),
        );
      },
    };
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
    expect(ModelResearchAnswer.safeParse({ citations: [], limitations: [] }).success).toBe(false);
  });
  it('sends reviews to the reviewer role and solving to the main model', async () => {
    const roles: Array<string | undefined> = [];
    const model: ResearchModel = {
      providedCitations: [source],
      async json(schema, instruction, _ctx, options) {
        roles.push(options?.role);
        return schema.parse(
          instruction.includes('LAB2_SOLVE')
            ? { content: '候选', citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }], limitations: [] }
            : review(2),
        );
      },
    };
    let state = await advanceResearch(initialResearch('low'), model, context);
    state = await advanceResearch(state, model, context);
    expect(roles).toEqual([undefined, 'review']);
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
    ['direct', 1],
    ['low', 4],
    ['high', 8],
  ] as const)('%s uses an actual bounded solve / review schedule', async (effort, expected) => {
    let calls = 0;
    const scores = [3, 1, 4, 2];
    const instructions: string[] = [];
    const model: ResearchModel = {
      providedCitations: [source],
      async json(schema, instruction) {
        instructions.push(instruction);
        calls++;
        return schema.parse(
          instruction.includes('LAB2_SOLVE')
            ? {
                content: '候选 ' + calls,
                citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }],
                limitations: [],
              }
            : review(scores[Math.floor(calls / 2) - 1]!),
        );
      },
    };
    let state = initialResearch(effort);
    while (state.phase !== 'finished') state = await advanceResearch(state, model, context);
    expect(calls).toBe(expected);
    if (effort === 'high') {
      expect(state.best).toBe(2);
      expect(state.candidates.map((c) => c.accepted)).toEqual([true, false, true, false]);
      expect(instructions[2]).toContain('探索另一方向');
      expect(instructions[6]).toContain('最简单的反例');
      expect(state.candidates[2]!.parent).toBe(0);
    }
  });
  it('stops high effort after exploring another direction when the retained version already meets the rubric', async () => {
    const model: ResearchModel = {
      providedCitations: [source],
      async json(schema, instruction) {
        return schema.parse(
          instruction.includes('LAB2_SOLVE')
            ? {
                content: '已满足要求的候选',
                citations: [{ sourceId: 's1', version: 1, quote: '不等于可串行化' }],
                limitations: [],
              }
            : { ...review(4), issues: [], satisfied: true },
        );
      },
    };
    let state = initialResearch('high');
    for (let n = 0; n < 4; n++) state = await advanceResearch(state, model, context);
    expect(state.phase).toBe('finished');
    expect(state.stopReason).toBe('accepted');
    expect(state.best).toBe(0);
    expect(state.candidates[1]!.accepted).toBe(false);
  });
  it('does not let a self-reported perfect answer without evidence trigger acceptance', async () => {
    const model: ResearchModel = {
      providedCitations: [],
      async json(schema, instruction) {
        return schema.parse(
          instruction.includes('LAB2_SOLVE')
            ? { content: '无证据结论', citations: [], limitations: [] }
            : { ...review(4), issues: [], satisfied: true },
        );
      },
    };
    let state = initialResearch('high');
    for (let n = 0; n < 4; n++) state = await advanceResearch(state, model, { ...context, sources: [] });
    expect(state.phase).toBe('solve');
    expect(state.candidates[0]!.score).toBe(13);
  });
  it('keeps old state immutable and does not replace a good version with an unreviewed one', async () => {
    const state = initialResearch('low');
    const model: ResearchModel = {
      providedCitations: [source],
      async json(schema) {
        return schema.parse({ content: '候选', citations: [], limitations: [] });
      },
    };
    const next = await advanceResearch(state, model, context);
    expect(state.candidates).toEqual([]);
    expect(next.best).toBeNull();
    expect(next.candidates[0]!.review).toBeNull();
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
