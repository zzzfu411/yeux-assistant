import {
  ResearchAnswer,
  ResearchComparison,
  ResearchReview,
  RUBRIC,
  RESEARCH_BUDGETS,
  type Effort,
  type ResearchState,
  type ResearchCandidate,
} from '../../../contracts/src/research.js';
import type { Citation } from '../../../contracts/src/index.js';
import type { ModelContext } from '../model.js';
import type { ModelProfile } from '../model-profiles.js';
import { AppError } from '../common.js';
import { z } from 'zod';

export const initialResearch = (effort: Effort): ResearchState => ({
  version: 2,
  effort,
  candidates: [],
  best: null,
  phase: 'solve',
  stopReason: null,
  warnings: [],
});
// Two roots are solved independently, neither sees the other: one answers directly, one deliberately
// starts from another direction. Revisions then deepen whichever version the comparison kept.
export const STRATEGIES = {
  direct: '直接依据资料回答，明确证据不足之处。',
  explore:
    '探索另一方向：先提出一个与常见答案不同的解释或方案，主动寻找支持相反结论的资料，独立求解；资料未提及不构成反证，不必强行得出相反结论。',
  revise: '根据评阅指出的漏洞和补充资料，逐项修改当前较好答案；保留已经正确的部分。',
  counterexample: '构造最简单的反例或边界情况，验证当前较好答案的关键假设，再据此修订。',
} as const;
const revisions = (state: ResearchState) => state.candidates.filter((candidate) => candidate.parent !== null).length;
/** The strategy for the next single solve (roots of a parallel start are chosen in advanceResearch). */
export function strategyFor(state: ResearchState) {
  if (state.best === null) return STRATEGIES.direct;
  return state.effort === 'high' && revisions(state) === 1 ? STRATEGIES.counterexample : STRATEGIES.revise;
}
/** Candidates still waiting for a review or comparison. */
const pending = (state: ResearchState) => state.candidates.filter((candidate) => !candidate.review);
/** Whether the next solve starts two independent directions at once. */
const parallelStart = (state: ResearchState, callsLeft: number) =>
  state.effort === 'high' && state.best === null && !state.candidates.length && callsLeft >= 3;
/**
 * A stable name for the step the state is about to take; it names the step receipt and the
 * model calls in the trace.
 */
export function researchStepName(state: ResearchState, callsLeft = Infinity) {
  if (state.phase === 'solve') return parallelStart(state, callsLeft) ? 'roots' : 'solve:' + state.candidates.length;
  const waiting = pending(state);
  if (state.best === null && waiting.length >= 2) return `compare:${waiting[0]!.index}-${waiting[1]!.index}`;
  if (state.best === null) return 'review:' + (waiting[0]?.index ?? state.candidates.length);
  return `compare:${state.best}-${waiting[0]?.index ?? state.candidates.length}`;
}

// Models often re-space a quotation or switch between full- and half-width punctuation.
// Matching folds those differences, but the stored quote is always the exact original text.
function fold(unit: string) {
  const code = unit.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return (
    ({ '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'", '\u3000': ' ' } as Record<string, string>)[unit] ??
    unit
  );
}
function foldedUnits(text: string) {
  const offsets: number[] = [];
  let folded = '';
  for (let index = 0; index < text.length; index++) {
    const unit = fold(text[index]!);
    if (/\s/.test(unit)) continue;
    offsets.push(index);
    folded += unit;
  }
  return { folded, offsets };
}
export function locateQuote(haystack: string, needle: string): [number, number] | null {
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return [exact, exact + needle.length];
  const source = foldedUnits(haystack),
    target = foldedUnits(needle).folded;
  if (target.length < 2) return null;
  const at = source.folded.indexOf(target);
  if (at < 0) return null;
  return [source.offsets[at]!, source.offsets[at + target.length - 1]! + 1];
}
/** Keep only quotations found in the exact source versions sent to the model. */
export function verifyResearchCitations(answer: ResearchAnswer, provided: Citation[]) {
  const citations: Citation[] = [],
    verified: ResearchAnswer['citations'] = [],
    dropped: string[] = [];
  for (const reference of answer.citations) {
    let found: Citation | null = null;
    for (const source of provided) {
      if (source.sourceId !== reference.sourceId || source.version !== reference.version) continue;
      const range = locateQuote(source.quote, reference.quote);
      if (!range) continue;
      const quote = source.quote.slice(range[0], range[1]);
      found = { ...source, start: source.start + range[0], end: source.start + range[1], quote };
      break;
    }
    if (!found) {
      dropped.push(reference.quote);
      continue;
    }
    if (citations.some((c) => c.sourceId === found.sourceId && c.start === found.start && c.end === found.end))
      continue;
    citations.push(found);
    verified.push({ sourceId: found.sourceId, version: found.version, quote: found.quote });
  }
  return { citations, verified, dropped };
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
const texts = (value: unknown, max: number, count: number) =>
  Array.isArray(value)
    ? value
        .map((item) => text(item, max))
        .filter((item): item is string => Boolean(item))
        .slice(0, count)
    : value;
/** Repair harmless format slips (extra keys, long lists, scores like 3.0) without inventing content. */
export function normalizeAnswer(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  let content = raw.content,
    limitations = texts(raw.limitations, 400, 6);
  if (typeof content === 'string' && content.trim().length > 6000) {
    const body = content.trim(),
      cut = Math.max(body.lastIndexOf('\n\n', 5900), body.lastIndexOf('。', 5900) + 1);
    content = body.slice(0, cut > 3000 ? cut : 5900).trimEnd();
    if (Array.isArray(limitations))
      limitations = [...limitations.slice(0, 5), '答案超过 6000 字，已在段落处截断；可要求精简后重试。'];
  }
  const citations = Array.isArray(raw.citations)
    ? raw.citations
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          sourceId: item.sourceId,
          version: typeof item.version === 'string' && /^\d+$/.test(item.version) ? Number(item.version) : item.version,
          quote: text(item.quote, 400),
        }))
        .filter((item) => typeof item.quote === 'string' && item.quote.length >= 2)
        .slice(0, 8)
    : raw.citations;
  return { content, citations, limitations };
}
export function normalizeReview(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>,
    scores =
      raw.scores && typeof raw.scores === 'object' && !Array.isArray(raw.scores)
        ? (raw.scores as Record<string, unknown>)
        : null;
  const score = (item: unknown) => {
    const number = typeof item === 'string' && item.trim() ? Number(item) : item;
    return typeof number === 'number' && Number.isFinite(number) ? Math.min(4, Math.max(0, Math.round(number))) : item;
  };
  return {
    scores: scores
      ? Object.fromEntries((Object.keys(RUBRIC) as Array<keyof typeof RUBRIC>).map((key) => [key, score(scores[key])]))
      : raw.scores,
    issues: texts(raw.issues, 500, 6),
    queries: texts(raw.queries, 160, 3),
    rationale: text(raw.rationale, 1500),
    satisfied: raw.satisfied === 'true' ? true : raw.satisfied === 'false' ? false : raw.satisfied,
  };
}
export function normalizeComparison(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>,
    scores = raw.scores && typeof raw.scores === 'object' && !Array.isArray(raw.scores) ? (raw.scores as any) : null;
  const side = (key: 'A' | 'B') =>
    scores?.[key] && typeof scores[key] === 'object'
      ? (normalizeReview({ scores: scores[key] }) as { scores: unknown }).scores
      : scores?.[key];
  const winner = typeof raw.winner === 'string' ? raw.winner.trim() : raw.winner;
  return {
    scores: scores ? { A: side('A'), B: side('B') } : raw.scores,
    winner:
      typeof winner === 'string' && /^(a|b|tie)$/i.test(winner)
        ? winner.toLowerCase() === 'tie'
          ? 'tie'
          : winner.toUpperCase()
        : ['平', '平局', '相当'].includes(String(winner))
          ? 'tie'
          : winner,
    reasons: texts(raw.reasons, 400, 4),
    issues: texts(raw.issues, 500, 6),
    queries: texts(raw.queries, 160, 3),
    satisfied: raw.satisfied === 'true' ? true : raw.satisfied === 'false' ? false : raw.satisfied,
  };
}
export const ModelResearchAnswer = z.preprocess(normalizeAnswer, ResearchAnswer);
export const ModelResearchReview = z.preprocess(normalizeReview, ResearchReview);
export const ModelResearchComparison = z.preprocess(normalizeComparison, ResearchComparison);
// Scores only rank model reviews. They are not objective correctness or learning evidence.
export function reviewScore(review: ResearchReview, citationCount: number) {
  return (
    review.scores.coverage +
    Math.min(review.scores.evidence, citationCount ? 4 : 1) +
    review.scores.challenges +
    review.scores.usability
  );
}
export function summarizeUsage(usage: Array<Record<string, unknown>>, calls: number) {
  let promptTokens = 0,
    completionTokens = 0,
    totalTokens = 0,
    reportedCalls = 0;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  for (const entry of usage) {
    if (valid(entry.prompt_tokens)) promptTokens += entry.prompt_tokens;
    if (valid(entry.completion_tokens)) completionTokens += entry.completion_tokens;
    if (valid(entry.total_tokens)) {
      totalTokens += entry.total_tokens;
      reportedCalls++;
    }
  }
  return { promptTokens, completionTokens, totalTokens, reportedCalls, complete: calls > 0 && reportedCalls === calls };
}
type CallOptions = {
  assessment?: boolean;
  requireCompletePrevious?: boolean;
  timeoutMs?: number;
  reserveMs?: number;
  role?: 'solve' | 'review';
  profile?: ModelProfile;
  contextLimit?: number;
  previousLimit?: number;
};
/** The part of ModelGateway research needs; each call reports the sources it actually sent. */
export interface ResearchModel {
  call<T>(
    schema: z.ZodType<T>,
    instruction: string,
    context: ModelContext,
    options?: CallOptions,
  ): Promise<{ value: T; providedCitations: Citation[] }>;
}
export type AdvanceOptions = {
  /** Model calls still available in this run; a parallel start needs room for its comparison. */
  callsLeft?: number;
  /** Chooses which answer is shown first in a comparison; injectable for tests. */
  random?: () => number;
};
const SOLVE_RULES =
  '\n验收维度：' +
  JSON.stringify(RUBRIC) +
  '\n简洁回答用户要求，避免反复列举无关缺口；允许标明前提、推理步骤与局限的推断。citations 只能逐字摘录本次给定资料（sourceId、version、quote）。没有证据就说明局限，不编造链接或引文。limitations 列出未解决问题。';
const JUDGE_RULES =
  '每项 0–4 分：0 缺失、1 严重问题、2 部分满足、3 基本满足、4 充分满足。\n' +
  JSON.stringify(RUBRIC) +
  '\n允许根据资料中的定义进行有明确前提和推理步骤的推断；缺少逐字结论不等于推断错误。若不同意，应指出缺失前提、推理错误或真正冲突的证据，不把资料未提及当成反证。';
const CALL = { assessment: true, requireCompletePrevious: true, timeoutMs: 180000, reserveMs: 5000 } as const;

async function solve(
  state: ResearchState,
  model: ResearchModel,
  context: ModelContext,
  strategy: string,
  base: ResearchCandidate | null,
  branch: number,
  index: number,
): Promise<ResearchCandidate> {
  const { value: answer, providedCitations } = await model.call(
    ModelResearchAnswer,
    'LAB2_SOLVE\n' + strategy + SOLVE_RULES,
    {
      ...context,
      // A root never sees another answer, so the second direction is not anchored on the first.
      previous: base?.answer.content || context.previous,
      latest: context.latest + (base?.review ? '\n已有候选的评阅（待核实）：' + JSON.stringify(base.review) : ''),
    },
    { ...CALL, profile: strategy === STRATEGIES.explore ? 'explore' : 'solve' },
  );
  const { citations, verified, dropped } = verifyResearchCitations(answer, providedCitations);
  return {
    index,
    strategy,
    parent: base?.index ?? null,
    branch,
    // Reviewers only see quotations that passed the program check.
    answer: { ...answer, citations: verified },
    citations,
    ...(dropped.length ? { droppedCitations: dropped } : {}),
    review: null,
    score: null,
    accepted: false,
    reviewNote: '',
  };
}
const dropNote = (candidate: ResearchCandidate, label: string) =>
  candidate.droppedCitations?.length
    ? `\n程序核对：${label}有 ${candidate.droppedCitations.length} 条引文无法在给定资料中找到，已移除；请按剩余证据评分。`
    : '';

/** An absolute review, used only when a single first answer has nothing to be compared with. */
async function reviewAlone(
  state: ResearchState,
  model: ResearchModel,
  context: ModelContext,
  candidate: ResearchCandidate,
) {
  const { value: review } = await model.call(
    ModelResearchReview,
    'LAB2_REVIEW\n独立检查这份候选答案，不因文字流畅或投入较多而提高评分。不要猜测作者思维过程。' +
      JUDGE_RULES +
      'queries 是下一轮应补充检索的关键词。只有所有要求都满足且没有关键漏洞才 satisfied=true。',
    {
      ...context,
      previous: JSON.stringify(candidate.answer),
      latest: context.latest + dropNote(candidate, '候选中'),
    },
    { ...CALL, role: 'review' },
  );
  candidate.review = review;
  candidate.score = reviewScore(review, candidate.citations.length);
  state.best = candidate.index;
  candidate.accepted = true;
  candidate.reviewNote = '首个已评阅版本。';
}

/**
 * A blind comparison: the reviewer sees the two answers as A and B in a random order, scores both in
 * one context and names the better one. A tie keeps the incumbent.
 */
async function compare(
  state: ResearchState,
  model: ResearchModel,
  context: ModelContext,
  incumbent: ResearchCandidate,
  challenger: ResearchCandidate,
  random: () => number,
) {
  const challengerFirst = random() < 0.5;
  const [first, second] = challengerFirst ? [challenger, incumbent] : [incumbent, challenger];
  const { value } = await model.call(
    ModelResearchComparison,
    'LAB2_COMPARE\n比较两份候选答案 A 与 B。它们的来源与先后顺序不说明好坏，不因篇幅或文字流畅而偏向任何一份，不要猜测作者思维过程。分别给出两份的四项评分，再判断哪一份更好地满足用户要求：winner 为 A、B 或 tie（确实难分高下时）。reasons 给出 1–4 条具体依据。issues 列出较好那份（平局时为 A）仍存在的问题，queries 是下一轮应补充检索的关键词，satisfied 表示较好那份是否满足所有要求且没有关键漏洞。' +
      JUDGE_RULES,
    {
      ...context,
      previous: JSON.stringify({ A: first.answer, B: second.answer }),
      latest: context.latest + dropNote(first, '答案 A ') + dropNote(second, '答案 B '),
    },
    { ...CALL, role: 'review', contextLimit: 28000, previousLimit: 14000 },
  );
  const of = (candidate: ResearchCandidate) => (candidate === first ? 'A' : 'B');
  const winner =
    value.winner === 'tie' ? 'tie' : value.winner === of(challenger) ? ('new' as const) : ('incumbent' as const);
  const kept = winner === 'new' ? challenger : incumbent;
  for (const candidate of [incumbent, challenger]) {
    const better = candidate === kept;
    candidate.review = {
      scores: value.scores[of(candidate)],
      issues: better ? value.issues : [],
      queries: better ? value.queries : [],
      rationale: value.reasons.join('\n'),
      satisfied: better && value.satisfied,
    };
    candidate.score = reviewScore(candidate.review, candidate.citations.length);
  }
  challenger.comparison = {
    against: incumbent.index,
    winner,
    order: challengerFirst ? 'new-first' : 'incumbent-first',
    reasons: value.reasons,
  };
  state.best = kept.index;
  kept.accepted = true;
  challenger.reviewNote =
    winner === 'new'
      ? `盲评比较胜过第 ${incumbent.index + 1} 版，改为采用本版。`
      : winner === 'tie'
        ? `与第 ${incumbent.index + 1} 版不分高下，保留第 ${incumbent.index + 1} 版。`
        : `盲评比较不如第 ${incumbent.index + 1} 版，保留第 ${incumbent.index + 1} 版。`;
}

/** One step: a solve (two independent roots in parallel when high effort starts) or a review/comparison. */
export async function advanceResearch(
  state: ResearchState,
  model: ResearchModel,
  context: ModelContext,
  options: AdvanceOptions = {},
): Promise<ResearchState> {
  if (state.version !== 2)
    throw new AppError('这份研究记录来自旧版本，可以查看，但需要重新开始研究。', 409, 'research_version');
  const next = structuredClone(state);
  if (next.phase === 'finished') return next;
  const best = next.best === null ? null : next.candidates[next.best]!;
  if (next.phase === 'solve') {
    const at = next.candidates.length;
    if (parallelStart(next, options.callsLeft ?? Infinity)) {
      const settled = await Promise.allSettled([
        solve(next, model, context, STRATEGIES.direct, null, 0, at),
        solve(next, model, context, STRATEGIES.explore, null, 1, at + 1),
      ]);
      const roots = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
      if (!roots.length) throw (settled[0] as PromiseRejectedResult).reason;
      roots.forEach((root, offset) => next.candidates.push({ ...root, index: at + offset }));
      if (roots.length < 2) next.warnings.push('另一方向的求解没有完成，本轮只比较已有方向。');
    } else next.candidates.push(await solve(next, model, context, strategyFor(next), best, best?.branch ?? 0, at));
    if (next.effort === 'direct') {
      const only = next.candidates.at(-1)!;
      next.best = only.index;
      only.accepted = true;
      next.phase = 'finished';
      next.stopReason = 'direct';
    } else next.phase = 'review';
    return next;
  }
  const waiting = pending(next);
  if (!best && waiting.length >= 2)
    await compare(next, model, context, waiting[0]!, waiting[1]!, options.random ?? Math.random);
  else if (!best) await reviewAlone(next, model, context, waiting[0]!);
  else await compare(next, model, context, best, waiting[0]!, options.random ?? Math.random);
  const retained = next.candidates[next.best!]!;
  const satisfied =
    retained.review?.satisfied &&
    !retained.review.issues.length &&
    Object.values(retained.review.scores).every((score) => score >= 3) &&
    retained.citations.length > 0;
  const lost = next.candidates
    .filter((candidate) => candidate.parent !== null && candidate.comparison)
    .slice(-2)
    .filter((candidate) => candidate.comparison!.winner !== 'new');
  // High effort compares at least two genuinely different answers before allowing early acceptance.
  if (satisfied && (state.effort !== 'high' || next.candidates.length >= 2)) {
    next.phase = 'finished';
    next.stopReason = 'accepted';
  } else if (lost.length === 2) {
    next.phase = 'finished';
    next.stopReason = 'plateau';
  } else if (next.candidates.length - (next.offset ?? 0) >= RESEARCH_BUDGETS[state.effort].candidates) {
    next.phase = 'finished';
    next.stopReason = 'budget';
  } else next.phase = 'solve';
  return next;
}
export function bestCandidate(state: ResearchState): ResearchCandidate | null {
  return state.best === null ? null : state.candidates[state.best] || null;
}
