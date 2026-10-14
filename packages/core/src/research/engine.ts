import {
  ResearchAnswer,
  ResearchReview,
  RUBRIC,
  RESEARCH_BUDGETS,
  type Effort,
  type ResearchState,
  type ResearchCandidate,
} from '../../../contracts/src/research.js';
import type { Citation } from '../../../contracts/src/index.js';
import type { ModelContext } from '../model.js';
import { z } from 'zod';

export const initialResearch = (effort: Effort): ResearchState => ({
  version: 1,
  effort,
  candidates: [],
  best: null,
  phase: 'solve',
  stopReason: null,
  warnings: [],
});
export function strategyFor(state: ResearchState) {
  const n = state.candidates.length;
  if (!n) return '直接依据资料回答，明确证据不足之处。';
  if (state.effort === 'high' && n === 1)
    return '探索另一方向：先提出一个与现有答案不同的解释或方案，检查支持相反结论的资料，独立求解；资料未提及不构成反证，不必强行得出相反结论。';
  if (state.effort === 'high' && n === 3) return '构造最简单的反例或边界情况，验证当前较好答案的关键假设，再据此修订。';
  return '根据评阅指出的漏洞和补充资料，逐项修改当前较好答案；保留已经正确的部分。';
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
export const ModelResearchAnswer = z.preprocess(normalizeAnswer, ResearchAnswer);
export const ModelResearchReview = z.preprocess(normalizeReview, ResearchReview);
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
export interface ResearchModel {
  providedCitations: Citation[];
  json<T>(
    schema: import('zod').z.ZodType<T>,
    instruction: string,
    context: ModelContext,
    options?: {
      assessment?: boolean;
      requireCompletePrevious?: boolean;
      timeoutMs?: number;
      reserveMs?: number;
      role?: 'solve' | 'review';
    },
  ): Promise<T>;
}
export async function advanceResearch(
  state: ResearchState,
  model: ResearchModel,
  context: ModelContext,
): Promise<ResearchState> {
  const next = structuredClone(state);
  if (next.phase === 'finished') return next;
  const best = next.best === null ? null : next.candidates[next.best]!;
  if (next.phase === 'solve') {
    const strategy = strategyFor(next);
    const answer = await model.json(
      ModelResearchAnswer,
      'LAB2_SOLVE\n' +
        strategy +
        '\n验收维度：' +
        JSON.stringify(RUBRIC) +
        '\n简洁回答用户要求，避免反复列举无关缺口；允许标明前提、推理步骤与局限的推断。citations 只能逐字摘录本次给定资料（sourceId、version、quote）。没有证据就说明局限，不编造链接或引文。limitations 列出未解决问题。',
      {
        ...context,
        previous: best?.answer.content || context.previous,
        latest: context.latest + (best?.review ? '\n已有候选的评阅（待核实）：' + JSON.stringify(best.review) : ''),
      },
      { assessment: true, requireCompletePrevious: true, timeoutMs: 180000, reserveMs: 5000 },
    );
    const { citations, verified, dropped } = verifyResearchCitations(answer, model.providedCitations);
    const index = next.candidates.length;
    next.candidates.push({
      index,
      strategy,
      parent: best?.index ?? null,
      // Reviewers only see quotations that passed the program check.
      answer: { ...answer, citations: verified },
      citations,
      ...(dropped.length ? { droppedCitations: dropped } : {}),
      review: null,
      score: null,
      accepted: false,
      reviewNote: '',
    });
    if (next.effort === 'direct') {
      next.best = index;
      next.candidates[index]!.accepted = true;
      next.phase = 'finished';
      next.stopReason = 'direct';
    } else next.phase = 'review';
    return next;
  }
  const candidate = next.candidates.at(-1)!;
  const review = await model.json(
    ModelResearchReview,
    'LAB2_REVIEW\n独立检查这份候选答案，不因文字流畅或投入较多而提高评分。不要猜测作者思维过程。每项 0–4 分：0 缺失、1 严重问题、2 部分满足、3 基本满足、4 充分满足。\n' +
      JSON.stringify(RUBRIC) +
      '\n允许根据资料中的定义进行有明确前提和推理步骤的推断；缺少逐字结论不等于推断错误。若不同意，应指出缺失前提、推理错误或真正冲突的证据，不把资料未提及当成反证。给出具体问题和依据，queries 是下一轮应补充检索的关键词。只有所有要求都满足且没有关键漏洞才 satisfied=true。',
    {
      ...context,
      previous: JSON.stringify(candidate.answer),
      latest:
        context.latest +
        (candidate.droppedCitations?.length
          ? `\n程序核对：候选中有 ${candidate.droppedCitations.length} 条引文无法在给定资料中找到，已移除；请按剩余证据评分。`
          : ''),
    },
    { assessment: true, requireCompletePrevious: true, timeoutMs: 180000, reserveMs: 5000, role: 'review' },
  );
  candidate.review = review;
  candidate.score = reviewScore(review, candidate.citations.length);
  if (!best || best.score === null || candidate.score > best.score) {
    next.best = candidate.index;
    candidate.accepted = true;
    candidate.reviewNote = best ? '模型按固定维度评为更好，保留为当前版本。' : '首个已评阅版本。';
  } else candidate.reviewNote = '评分未提高，保留之前的较好版本。';
  const retained = next.candidates[next.best!]!;
  const satisfied =
    retained.review?.satisfied &&
    !retained.review.issues.length &&
    Object.values(retained.review.scores).every((score) => score >= 3) &&
    retained.citations.length > 0;
  // high makes at least one genuinely different attempt before allowing early acceptance.
  if (satisfied && (state.effort !== 'high' || next.candidates.length >= 2)) {
    next.phase = 'finished';
    next.stopReason = 'accepted';
  } else if (next.candidates.length >= RESEARCH_BUDGETS[state.effort].candidates) {
    next.phase = 'finished';
    next.stopReason = 'budget';
  } else next.phase = 'solve';
  return next;
}
export function bestCandidate(state: ResearchState): ResearchCandidate | null {
  return state.best === null ? null : state.candidates[state.best] || null;
}
