import type { ModelAssessment } from '../../contracts/src/assessment.js';
import type { Citation } from '../../contracts/src/index.js';

export const ASSESSMENT_INSTRUCTION =
  '评阅最新用户回答相对于上一份已交付练习的表现。先核对题目要求、回答已经正确说明的要素、遗漏要素以及明确错误，再作判定。按表达的含义判断，接受同义表述和操作中已经建立的场景条件；不要求把已经表达的含义按固定小标题重复，不额外添加题目与资料未要求的条件。pass：回答具体且有资料支持，覆盖题目关键要求，没有关键错误；仅说已理解、保证会做好、复述任务要求或泛泛表态不能判为 pass。retry：回答包含可指出并由资料核实的明确错误、矛盾或错误做法；不能仅因回答不完整就判为 retry。unclear：已答部分正确但遗漏必要要素、没有实际作答、套话、题意或证据不足、缺少可靠资料。部分正确且不完整而无明确错误时必须用 unclear，反馈保留正确部分并指出需要补充的要素；若同时存在明确错误，则用 retry 并具体说明错误。pass 和 retry 都须提供可核对的证据，无法提供时用 unclear。answerQuotes 逐字摘录用户回答，不能编造或用自己生成的答案替代。citationRefs 必须逐字引用实际提供资料，携带 sourceId、version 和 UTF-16 字符 start/end；可取提供片段内的连续子串。evidence 解释回答与引用如何支持判定，不把摘录存在当作理解正确。反馈是模型估计，不能宣称课程完成。';

export type AssessmentReason =
  | 'missing_exercise'
  | 'missing_sources'
  | 'missing_answer_quote'
  | 'invalid_answer_quote'
  | 'missing_citation'
  | 'invalid_citation'
  | 'missing_explanation';

/** This verifies traceable evidence, not semantic correctness or understanding. */
export function guardAssessment(
  proposed: ModelAssessment,
  input: { answer: string; exerciseComplete: boolean; providedCitations: Citation[] },
) {
  const reasons: AssessmentReason[] = [];
  if (!input.exerciseComplete) reasons.push('missing_exercise');
  if (!input.providedCitations.length) reasons.push('missing_sources');
  if (!proposed.answerQuotes.length) reasons.push('missing_answer_quote');
  const validAnswers = proposed.answerQuotes.filter((quote) => Boolean(quote.trim()) && input.answer.includes(quote));
  if (validAnswers.length !== proposed.answerQuotes.length) reasons.push('invalid_answer_quote');
  if (!proposed.citationRefs.length) reasons.push('missing_citation');
  const validCitations = proposed.citationRefs.filter(
    (ref) =>
      Boolean(ref.quote.trim()) &&
      input.providedCitations.some(
        (citation) =>
          citation.sourceId === ref.sourceId &&
          citation.version === ref.version &&
          ref.start >= citation.start &&
          ref.end <= citation.end &&
          ref.end > ref.start &&
          citation.quote.slice(ref.start - citation.start, ref.end - citation.start) === ref.quote,
      ),
  );
  if (validCitations.length !== proposed.citationRefs.length) reasons.push('invalid_citation');
  if (!proposed.evidence.trim()) reasons.push('missing_explanation');
  const downgraded = proposed.verdict !== 'unclear' && reasons.length > 0;
  const assessment: ModelAssessment = downgraded
    ? {
        ...proposed,
        verdict: 'unclear',
        feedback:
          reasons.includes('missing_exercise') || reasons.includes('missing_sources')
            ? '这次评阅缺少完整题目或参考依据，暂无法判断。回答已保存，可以补充资料或用自评记录当前理解。'
            : '这次评阅没有提供完整、可核对的回答证据，暂无法判断。回答已保存，本次暂不判为已理解或需要重练，也可以用自评记录当前理解。',
        evidence: validAnswers.join('\n'),
        answerQuotes: validAnswers,
        citationRefs: validCitations,
      }
    : proposed;
  return { assessment, reasons, downgraded };
}
