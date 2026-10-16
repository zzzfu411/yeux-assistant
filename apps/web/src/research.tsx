import {
  RESEARCH_BUDGETS,
  type Effort,
  type ResearchCandidate,
  type ResearchDetail,
} from '../../../packages/contracts/src/research';
import { useState } from 'react';
import { useApi, useAction } from './api';
import { ErrorNotice, Result, Sources } from './ui';
import { Icon } from './icons';
import s from './styles.module.css';

const efforts: Array<{ value: Effort; flow: string }> = [
  { value: 'direct', flow: '单次回答，作为基线' },
  { value: 'low', flow: '求解、评阅、修改' },
  { value: 'high', flow: '多方向比较，反例查证' },
];
const minutes = (seconds: number) =>
  seconds % 60
    ? (seconds / 60).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' 分钟'
    : seconds / 60 + ' 分钟';
const dimensions = [
  ['coverage', '需求覆盖'],
  ['evidence', '证据支持'],
  ['challenges', '反例与局限'],
  ['usability', '可用性'],
] as const;

export function EffortPicker({
  value,
  onChange,
  disabled,
}: {
  value: Effort;
  onChange: (value: Effort) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className={s.effortPicker} disabled={disabled}>
      <legend>研究投入</legend>
      <div className={s.effortOptions}>
        {efforts.map(({ value: option, flow }) => {
          const budget = RESEARCH_BUDGETS[option];
          return (
            <label className={s.effortOption} key={option} data-checked={value === option}>
              <input
                type="radio"
                name="research-effort"
                value={option}
                checked={value === option}
                onChange={() => onChange(option)}
                aria-describedby={'effort-' + option}
              />
              <span className={s.effortName}>{budget.label}</span>
              <span className={s.effortPips} aria-hidden="true">
                {Array.from({ length: budget.calls }, (_, index) => (
                  <i key={index} />
                ))}
              </span>
              <span className={s.effortFlow} id={'effort-' + option}>
                {flow}
                <small>
                  ≤ {budget.calls} 次调用 · {minutes(budget.seconds)}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <p className={s.effortNote}>
        上限不是必然用满：达到评阅标准会提前结束。投入越高，可能消耗更多 API 额度；结论仍需核对。
      </p>
    </fieldset>
  );
}

function reasonFor(detail: ResearchDetail, active: boolean) {
  const { state } = detail;
  if (state.stopReason === 'direct') return { text: '单次回答，未经独立评阅', tone: 'neutral' };
  if (state.stopReason === 'accepted') return { text: '已满足模型评阅标准，仍需本人核查', tone: 'success' };
  if (state.stopReason === 'error') return { text: '后续查证未完成，保留此前版本', tone: 'danger' };
  if (state.stopReason === 'budget') return { text: '本轮预算已结束', tone: 'accent' };
  if (active) return { text: state.phase === 'review' ? '正在检查候选答案' : '正在检索与求解', tone: 'info' };
  return { text: '已停止，进度已保留', tone: 'neutral' };
}

/** Compact status shown above the delivered answer. */
export function ResearchBanner({ detail, active }: { detail: ResearchDetail; active: boolean }) {
  const { state } = detail,
    reason = reasonFor(detail, active);
  return (
    <div className={s.researchBanner} data-tone={reason.tone}>
      <span className={s.researchBadge}>
        <Icon name="research" />
        {RESEARCH_BUDGETS[state.effort].label}投入
      </span>
      <p>
        <strong>{reason.text}</strong>
        {state.best !== null && (
          <span>
            {' '}
            · 采用第 {state.best + 1} 版{state.effort === 'direct' ? '' : '（模型比较）'}
          </span>
        )}
      </p>
      {state.warnings.length > 0 && (
        <ul>
          {state.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function solveLabel(effort: Effort, index: number) {
  if (!index) return '求解';
  if (effort === 'high' && index === 1) return '另一方向';
  if (effort === 'high' && index === 3) return '反例检查';
  return '修改';
}
type Step = { label: string; status: 'done' | 'current' | 'idle' | 'missed' | 'skipped' };
/** The steps that actually ran, then the remaining plan while the run is active. */
function researchSteps(detail: ResearchDetail, active: boolean): Step[] {
  const { state } = detail,
    reviewed = state.effort !== 'direct',
    steps: Step[] = [];
  state.candidates.forEach((candidate, index) => {
    steps.push({ label: solveLabel(state.effort, index), status: 'done' });
    if (!reviewed) return;
    const last = index === state.candidates.length - 1;
    if (candidate.review) steps.push({ label: '评阅', status: 'done' });
    else if (last && active) steps.push({ label: '评阅', status: 'current' });
    else steps.push({ label: '评阅', status: 'missed' });
  });
  const planned = RESEARCH_BUDGETS[state.effort].candidates;
  if (active) {
    if (state.phase === 'solve' && state.candidates.length < planned)
      steps.push({ label: solveLabel(state.effort, state.candidates.length), status: 'current' });
    // Actual steps follow the planned solve/review order, so the remainder is a suffix of the plan.
    const plan = Array.from({ length: planned }, (_, index) =>
      reviewed ? [solveLabel(state.effort, index), '评阅'] : [solveLabel(state.effort, index)],
    ).flat();
    for (const label of plan.slice(steps.length)) steps.push({ label, status: 'idle' });
  } else if (state.stopReason === 'accepted' && state.candidates.length < planned)
    steps.push({ label: '提前结束：已满足标准', status: 'skipped' });
  return steps;
}
function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <span className={s.meter} role="img" aria-label={label}>
      <i style={{ width: ratio * 100 + '%' }} />
    </span>
  );
}
function shortStrategy(strategy: string) {
  const head = strategy.split(/[：:，,。]/)[0] || strategy;
  return head.length > 18 ? head.slice(0, 18) + '…' : head;
}
function Candidate({ candidate, best }: { candidate: ResearchCandidate; best: number | null }) {
  const adopted = candidate.index === best,
    status = adopted ? '当前采用' : candidate.score === null ? '待评阅' : '未采用';
  return (
    <article className={s.candidate} data-adopted={adopted}>
      <header className={s.candidateHead}>
        <span className={s.candidateStrategy}>
          {shortStrategy(candidate.strategy)}
          {candidate.parent !== null && <small>基于第 {candidate.parent + 1} 版</small>}
        </span>
        <span className={s.candidateScore}>
          {candidate.score === null ? (
            <small>未评分</small>
          ) : (
            <>
              <Meter value={candidate.score} max={16} label={`模型评分 ${candidate.score} / 16`} />
              <small>{candidate.score} / 16</small>
            </>
          )}
        </span>
        <span className={s.candidateStatus} data-adopted={adopted}>
          {status}
        </span>
      </header>
      <div className={s.candidateBody}>
        <p className={s.muted}>引导策略：{candidate.strategy}</p>
        {candidate.review && (
          <dl className={s.rubric}>
            {dimensions.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  <Meter
                    value={candidate.review!.scores[key]}
                    max={4}
                    label={`${label} ${candidate.review!.scores[key]} / 4`}
                  />
                  <span>{candidate.review!.scores[key]} / 4</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Result>{candidate.answer.content}</Result>
        <Sources citations={candidate.citations} />
        {Boolean(candidate.droppedCitations?.length) && (
          <>
            <h3>未通过原文核对的引文（已移除）</h3>
            <ul className={s.droppedQuotes}>
              {candidate.droppedCitations!.map((quote, i) => (
                <li key={i}>{quote}</li>
              ))}
            </ul>
          </>
        )}
        {candidate.answer.limitations.length > 0 && (
          <>
            <h3>尚待核实</h3>
            <ul>
              {candidate.answer.limitations.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </>
        )}
        {candidate.review && (
          <>
            <h3>评阅依据</h3>
            <p>{candidate.review.rationale}</p>
            {candidate.review.issues.length > 0 && (
              <ul>
                {candidate.review.issues.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {candidate.reviewNote && <p className={s.candidateNote}>{candidate.reviewNote}</p>}
      </div>
    </article>
  );
}

/** Versions as page tabs of a lab notebook; the adopted one opens first. Arrow keys move between tabs. */
function Versions({ state }: { state: ResearchDetail['state'] }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const shown = chosen ?? state.best ?? state.candidates.length - 1,
    candidate = state.candidates[shown] ?? state.candidates.at(-1)!;
  const move = (step: number) => {
    const next = (candidate.index + step + state.candidates.length) % state.candidates.length;
    setChosen(next);
    document.getElementById('version-tab-' + next)?.focus();
  };
  return (
    <>
      <div
        className={s.versionTabs}
        role="tablist"
        aria-label="候选版本"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') move(1);
          else if (event.key === 'ArrowLeft') move(-1);
        }}
      >
        {state.candidates.map((item) => {
          const selected = item.index === candidate.index;
          return (
            <button
              key={item.index}
              id={'version-tab-' + item.index}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="version-panel"
              tabIndex={selected ? 0 : -1}
              data-adopted={item.index === state.best}
              onClick={() => setChosen(item.index)}
            >
              <span>第 {item.index + 1} 版</span>
              <small>{item.index === state.best ? '采用' : item.score === null ? '待评阅' : item.score + ' 分'}</small>
            </button>
          );
        })}
      </div>
      <div
        id="version-panel"
        role="tabpanel"
        aria-labelledby={'version-tab-' + candidate.index}
        className={s.versionPanel}
      >
        <Candidate candidate={candidate} best={state.best} key={candidate.index} />
      </div>
    </>
  );
}

export function ResearchProgress({
  detail,
  sessionId,
  active,
}: {
  detail: ResearchDetail;
  sessionId: string;
  active: boolean;
}) {
  const api = useApi(),
    action = useAction(),
    { state, usage } = detail;
  const limitSeconds = detail.maxSeconds ?? RESEARCH_BUDGETS[state.effort].seconds,
    seconds = Math.round(detail.elapsedMs / 1000);
  const steps = researchSteps(detail, active);
  const download = () =>
    void action.run(
      () => api.request<string>('/sessions/' + encodeURIComponent(sessionId) + '/research/export', { raw: true }),
      (content) => {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'research-' + sessionId + '.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
  return (
    <section className={s.researchRecord} aria-label="研究记录">
      <div className={s.sectionHeading}>
        <h2>研究记录</h2>
        <button type="button" className={s.textButton} disabled={action.busy} onClick={download}>
          <Icon name="download" />
          导出研究记录
        </button>
      </div>
      <p className={s.researchSummary}>
        {RESEARCH_BUDGETS[state.effort].label}投入 · 求解 {detail.model}
        {state.effort === 'direct' ? '' : detail.reviewModel ? ` · 独立评阅 ${detail.reviewModel}` : ' · 同一模型评阅'}
        {state.best !== null ? ` · 当前采用第 ${state.best + 1} 版` : ' · 尚无已采用版本'}
      </p>
      <div className={s.statGrid}>
        <div className={s.stat}>
          <span>模型调用</span>
          <strong>
            {detail.calls}
            <small> / {detail.maxCalls} 次</small>
          </strong>
          <Meter
            value={detail.calls}
            max={detail.maxCalls}
            label={`已用 ${detail.calls} / ${detail.maxCalls} 次调用`}
          />
        </div>
        <div className={s.stat}>
          <span>用时</span>
          <strong>
            {seconds}
            <small> / {limitSeconds} 秒</small>
          </strong>
          <Meter value={seconds} max={limitSeconds} label={`已用 ${seconds} / ${limitSeconds} 秒`} />
        </div>
        <div className={s.stat}>
          <span>Token</span>
          <strong>
            {usage.reportedCalls ? usage.totalTokens.toLocaleString() : '—'}
            {usage.reportedCalls > 0 && !usage.complete && <small> 不完整</small>}
          </strong>
          <small className={s.statNote}>
            {usage.complete
              ? `${usage.totalTokens.toLocaleString()} token · 输入 ${usage.promptTokens.toLocaleString()} / 输出 ${usage.completionTokens.toLocaleString()}`
              : usage.reportedCalls
                ? `已报告 ${usage.totalTokens.toLocaleString()} token（不完整）`
                : 'token 用量未报告'}
          </small>
        </div>
      </div>
      <ol className={s.stepTrack} aria-label="研究步骤">
        {steps.map((step, index) => (
          <li key={index} data-status={step.status}>
            {step.status !== 'skipped' && (
              <i aria-hidden="true">
                {step.status === 'done' ? (
                  <Icon name="check" />
                ) : step.status === 'missed' ? (
                  <Icon name="close" />
                ) : (
                  index + 1
                )}
              </i>
            )}
            {step.label}
            {step.status === 'missed' && <span className={s.srOnly}>（未完成）</span>}
          </li>
        ))}
      </ol>
      {state.candidates.length > 0 && (
        <>
          <h3 className={s.timelineTitle}>候选版本与查证（{state.candidates.length}）</h3>
          <p className={s.muted}>评分来自模型，只用于挑选版本；引文仅确认与原文一致，不代表结论必然正确。</p>
          <Versions state={state} />
        </>
      )}
      {detail.sourceVersions.length > 0 && (
        <details className={s.disclosure}>
          <summary>固定的资料版本（{detail.sourceVersions.length}）</summary>
          <ul className={s.plainList}>
            {detail.sourceVersions.map((source) => (
              <li key={source.id + '@' + source.version}>
                <a href={'#/source/' + encodeURIComponent(source.id) + '?version=' + source.version}>{source.title}</a>
                <span className={s.muted}> · 第 {source.version} 版</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorNotice error={action.error} />
    </section>
  );
}
