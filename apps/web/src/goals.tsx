import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UpdateGoal, type Attempt, type Goal, type SourceSummary } from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import type { GoalOverview, SessionSummary } from '../../../packages/contracts/src/pagination';
import {
  date,
  ErrorNotice,
  Heading,
  QueryState,
  SessionRows,
  SourcePicker,
  Status,
  useCursorList,
  CursorControls,
} from './ui';
import { attemptSource } from './session';
import s from './styles.module.css';
import { Icon } from './icons';
import { refresh as refreshReads } from './live';

export function GoalSourcePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const query = useData<SourceSummary[]>('/sources');
  return (
    <>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <SourcePicker
          sources={query.data}
          selectionReady={query.isSuccess && !query.isError && !query.isFetching}
          value={value}
          onChange={onChange}
          onRefresh={() => void query.refetch()}
          refreshing={query.isFetching}
        />
      )}
    </>
  );
}
export function GoalsPage() {
  const [search, setSearch] = useState(''),
    [q, setQ] = useState(''),
    [status, setStatus] = useState('all');
  const list = useCursorList<Goal>('/goals/list?status=' + status + '&q=' + encodeURIComponent(q)),
    query = list.query;
  return (
    <>
      <Heading
        title="目标"
        action={
          <a className={s.primary} href="#/today?mode=goal">
            添加目标
          </a>
        }
      >
        管理学习计划，查看每一步的练习记录。
      </Heading>
      <div className={s.libraryTools + ' ' + s.goalTools}>
        <label>
          目标状态
          <select aria-label="目标状态" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">进行中</option>
            <option value="paused">已暂停</option>
            <option value="completed">已完成</option>
          </select>
        </label>
        <form
          className={s.search}
          onSubmit={(event) => {
            event.preventDefault();
            if (q === search.trim()) list.refresh();
            else setQ(search.trim());
          }}
        >
          <label className={s.srOnly} htmlFor="goal-search">
            查找目标
          </label>
          <input
            id="goal-search"
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按目标标题查找"
          />
          <button className={s.secondary}>查找</button>
        </form>
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          {query.data.items.length ? (
            <div className={s.rows}>
              {query.data.items.map((goal) => (
                <a className={s.row} key={goal.id} href={'#/goal/' + encodeURIComponent(goal.id)}>
                  <div>
                    <strong>{goal.title}</strong>
                    <p>
                      {goal.outcome || '每次准备一个学习步骤'}
                      {goal.nextReview && goal.status === 'active' && <> · 下次复习 {date(goal.nextReview)}</>}
                    </p>
                  </div>
                  <Status state={goal.status === 'completed' ? 'goal_completed' : goal.status} />
                </a>
              ))}
            </div>
          ) : (
            <p className={s.empty}>
              {q || status !== 'all' ? '没有符合条件的目标。' : '还没有目标。从一个想弄懂的问题开始。'}
            </p>
          )}
        </>
      )}
      <CursorControls list={list} />
    </>
  );
}
export function GoalPage({ id }: { id: string }) {
  const query = useData<GoalOverview>('/goals/' + encodeURIComponent(id) + '/overview');
  return (
    <>
      <a className={s.back} href="#/goals">
        ‹ 全部目标
      </a>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <GoalContent
          detail={query.data}
          reload={async () => {
            const result = await query.refetch();
            return result.data?.goal;
          }}
        />
      )}
    </>
  );
}
function GoalContent({ detail, reload }: { detail: GoalOverview; reload: () => Promise<Goal | undefined> }) {
  const { goal, plan } = detail,
    api = useApi(),
    client = useQueryClient(),
    action = useAction();
  const [edit, setEdit] = useState(false),
    [draft, setDraft] = useDraft('goal.' + goal.id, {
      title: goal.title,
      outcome: goal.outcome,
      sourceIds: goal.sourceIds,
      days: goal.intervals.map((n) => n / 86400).join(', '),
      revision: goal.revision,
    });
  const [markComplete, setMarkComplete] = useState(false);
  const next = useData<{ items: SessionSummary[] }>(
    '/sessions/list?goalId=' + encodeURIComponent(goal.id) + '&state=pending&limit=1',
  ).data?.items[0];
  const steps = plan?.steps || [],
    practiced = steps.filter((step) => ['practiced', 'completed'].includes(step.state)).length;
  const refresh = () => {
    void refreshReads(client, '/goals', '/sessions', '/today');
  };
  const changeStatus = (status: Goal['status']) =>
    void action.run(
      () => api.write('/goals/' + goal.id, UpdateGoal.parse({ revision: goal.revision, status }), 'PATCH'),
      () => {
        setMarkComplete(false);
        refresh();
      },
    );
  const save = (e: FormEvent) => {
    e.preventDefault();
    void action.run(
      () => {
        const intervals = draft.days
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map((day) => Number(day) * 86400);
        return api.write<{ revision: number }>(
          '/goals/' + goal.id,
          UpdateGoal.parse({
            revision: draft.revision,
            title: draft.title,
            outcome: draft.outcome,
            sourceIds: draft.sourceIds,
            intervals,
          }),
          'PATCH',
        );
      },
      (result) => {
        setDraft((current) => ({ ...current, revision: result.revision }));
        setEdit(false);
        refresh();
      },
    );
  };
  const loadVersion = () =>
    void action.run(reload, (current) => {
      if (current) {
        setDraft((d) => ({ ...d, revision: current.revision }));
        action.setMessage('已载入最新版本，保留了你的输入。');
      }
    });
  return (
    <>
      <Heading title={goal.title}>
        <Status state={goal.status === 'completed' ? 'goal_completed' : goal.status} />
        {goal.nextReview && goal.status === 'active' && <> · 下次复习 {date(goal.nextReview)}</>}
      </Heading>
      {goal.outcome && <p className={s.description}>{goal.outcome}</p>}
      {(next || steps.length > 0) && (
        <div className={s.goalSummary}>
          {steps.length > 0 && (
            <div className={s.goalProgress}>
              <span>
                学习路径 <strong>{practiced}</strong> / {steps.length} 步已练习
              </span>
              <span className={s.meter} role="img" aria-label={`已练习 ${practiced} / ${steps.length} 步`}>
                <i style={{ width: (practiced / steps.length) * 100 + '%' }} />
              </span>
            </div>
          )}
          {next && (
            <a className={s.primary} href={'#/session/' + encodeURIComponent(next.id)}>
              {next.state === 'waiting_feedback'
                ? '继续练习'
                : next.state === 'failed'
                  ? '处理当前步骤'
                  : '查看准备进度'}
              <Icon name="arrow" />
            </a>
          )}
        </div>
      )}
      <div className={s.toolbar}>
        <button
          className={s.secondary}
          disabled={action.busy}
          onClick={() => changeStatus(goal.status === 'active' ? 'paused' : 'active')}
        >
          {goal.status === 'active' ? '暂停' : '继续学习'}
        </button>
        <button className={s.textButton} onClick={() => setEdit(!edit)}>
          调整目标
        </button>
        {goal.status !== 'completed' && (
          <button className={s.textButton} onClick={() => setMarkComplete(!markComplete)}>
            标记完成
          </button>
        )}
      </div>
      {markComplete && (
        <div className={s.notice}>
          <p>完成目标由你确认。已准备材料和模型评估不会自动算作学完。</p>
          <button className={s.primary} disabled={action.busy} onClick={() => changeStatus('completed')}>
            我已完成这个目标
          </button>
          <button className={s.textButton} onClick={() => setMarkComplete(false)}>
            返回
          </button>
        </div>
      )}
      {edit && (
        <form className={s.form} onSubmit={save}>
          <label>
            目标
            <input
              maxLength={200}
              required
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            预期成果
            <textarea
              value={draft.outcome}
              maxLength={4000}
              onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
            />
          </label>
          <label>
            复习间隔（天，用逗号分隔）
            <input value={draft.days} onChange={(e) => setDraft({ ...draft, days: e.target.value })} />
          </label>
          <GoalSourcePicker value={draft.sourceIds} onChange={(sourceIds) => setDraft({ ...draft, sourceIds })} />
          <button className={s.primary} disabled={action.busy || draft.sourceIds.length > 100}>
            保存调整
          </button>
        </form>
      )}
      <ErrorNotice error={action.error} onReload={loadVersion} />
      {action.message && (
        <p role="status" className={s.muted}>
          {action.message}
        </p>
      )}
      {plan && (
        <section className={s.section}>
          <h2>学习路径</h2>
          <ol className={s.steps}>
            {plan.steps.map((step) => (
              <li key={step.id} data-state={step.state}>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.objective}</p>
                </div>
                <Status state={step.state} />
              </li>
            ))}
          </ol>
          {plan.rationale && (
            <details className={s.disclosure}>
              <summary>计划依据</summary>
              <p>{plan.rationale}</p>
              <p className={s.muted}>第 {plan.version} 版计划</p>
            </details>
          )}
        </section>
      )}
      <GoalRecords goalId={goal.id} attemptTotal={detail.attemptTotal} />
    </>
  );
}
function GoalRecords({ goalId, attemptTotal }: { goalId: string; attemptTotal: number }) {
  const list = useCursorList<SessionSummary>('/sessions/list?goalId=' + encodeURIComponent(goalId)),
    [expanded, setExpanded] = useState(false),
    query = list.query;
  return (
    <>
      <section className={s.section} aria-label="目标学习记录">
        <h2>学习记录</h2>
        <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
        {query.data && <SessionRows sessions={query.data.items} />}
        <CursorControls list={list} />
      </section>
      {attemptTotal > 0 && (
        <details className={s.disclosure} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>练习与反馈（{attemptTotal}）</summary>
          {expanded && <GoalAttempts goalId={goalId} />}
        </details>
      )}
    </>
  );
}
function GoalAttempts({ goalId }: { goalId: string }) {
  const list = useCursorList<Attempt>('/goals/' + encodeURIComponent(goalId) + '/attempts/list'),
    query = list.query;
  return (
    <div aria-label="目标练习记录">
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data?.items.map((attempt) => (
        <div className={s.evidence} key={attempt.id}>
          <p>{attempt.answer}</p>
          <p>{attempt.feedback || (attempt.source === 'ungraded' ? '未评阅' : '等待评估')}</p>
          <span className={s.muted}>
            {attemptSource[attempt.source]} · {date(attempt.createdAt)}
          </span>
          {attempt.evidence && <blockquote>{attempt.evidence}</blockquote>}
          <a className={s.textLink} href={'#/session/' + encodeURIComponent(attempt.sessionId)}>
            查看学习记录
          </a>
        </div>
      ))}
      <CursorControls list={list} />
    </div>
  );
}
