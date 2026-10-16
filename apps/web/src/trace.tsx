import { useState } from 'react';
import type { SessionTrace, TraceCall, TraceRun } from '../../../packages/contracts/src/index';
import { useData } from './api';
import { date, QueryState } from './ui';
import s from './styles.module.css';

const outcomes: Record<TraceCall['outcome'], string> = {
  pending: '进行中',
  ok: '完成',
  invalid: '结构不合格',
  http_error: '服务出错',
  unavailable: '连接中断或超时',
  budget: '时间预算用尽',
};
const runStates: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};
/** Step names are code identifiers; the trace shows what each one did. */
export function stepLabel(name: string) {
  const research = /^(solve|review):(\d+)$/.exec(name);
  if (research) return (research[1] === 'solve' ? '求解第 ' : '评阅第 ') + (Number(research[2]) + 1) + ' 版';
  return (
    {
      extract: '抽取通知要素',
      plan: '制定计划',
      mail: '撰写邮件',
      draft: '起草回复',
      prepare: '准备练习',
      assess: '评阅回答',
    }[name] ??
    (name || '未归入步骤')
  );
}
const seconds = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' 秒');
const tokens = (call: TraceCall) =>
  call.promptTokens === null && call.completionTokens === null
    ? '未报告'
    : `${call.promptTokens ?? '?'} / ${call.completionTokens ?? '?'}` +
      (call.reasoningTokens ? `（推理 ${call.reasoningTokens}）` : '');

function RunTable({ run, index }: { run: TraceRun; index: number }) {
  const names = [...new Set([...run.steps.map((item) => item.name), ...run.calls.map((call) => call.step)])];
  const elapsed =
    run.startedAt && run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null;
  return (
    <section className={s.traceRun} aria-label={'第 ' + index + ' 次运行'}>
      <p className={s.traceHead}>
        <strong>{index === 1 ? '最近一次运行' : '更早的运行'}</strong>
        <span>{runStates[run.state] ?? run.state}</span>
        <span>
          调用 {run.modelCalls} / {run.maxModelCalls}
        </span>
        <span>{elapsed === null ? date(run.createdAt) : '用时 ' + seconds(elapsed)}</span>
        {run.attempts > 1 && <span>后台重试 {run.attempts - 1} 次</span>}
        {run.resumeFrom && <span>接续上一轮</span>}
      </p>
      {run.error && <p className={s.muted}>{run.error}</p>}
      {names.length ? (
        <div className={s.traceScroll}>
          <table className={s.traceTable}>
            <thead>
              <tr>
                <th scope="col">步骤</th>
                <th scope="col">结果</th>
                <th scope="col">首字节</th>
                <th scope="col">用时</th>
                <th scope="col">输入 / 输出 token</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const calls = run.calls.filter((call) => call.step === name),
                  saved = run.steps.find((item) => item.name === name);
                if (!calls.length)
                  return (
                    <tr key={name}>
                      <th scope="row">{stepLabel(name)}</th>
                      <td colSpan={4}>{saved?.reusedFrom ? '沿用上一轮的结果，未调用模型' : '已完成，未调用模型'}</td>
                    </tr>
                  );
                return calls.map((call, position) => (
                  <tr key={name + position} data-outcome={call.outcome}>
                    <th scope="row">
                      {stepLabel(name)}
                      {calls.length > 1 && <small> 第 {position + 1} 次</small>}
                    </th>
                    <td>{outcomes[call.outcome]}</td>
                    <td>{seconds(call.firstByteMs)}</td>
                    <td>{seconds(call.latencyMs)}</td>
                    <td>{tokens(call)}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={s.muted}>这次运行没有调用模型。</p>
      )}
    </section>
  );
}
function TraceBody({ sessionId }: { sessionId: string }) {
  const query = useData<SessionTrace>('/sessions/' + encodeURIComponent(sessionId) + '/trace');
  if (!query.data)
    return <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />;
  if (!query.data.runs.length) return <p className={s.muted}>还没有运行记录。</p>;
  return (
    <>
      {query.data.runs.map((run, index) => (
        <RunTable run={run} index={index + 1} key={run.id} />
      ))}
      <p className={s.muted}>时间与 token 由本机计时和模型服务报告；结构不合格或服务出错的调用同样计入预算。</p>
    </>
  );
}
/** Steps, model calls and their timing for every run of this task; loaded only when opened. */
export function RunTrace({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={s.disclosure} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>运行记录</summary>
      {open && <TraceBody sessionId={sessionId} />}
    </details>
  );
}
