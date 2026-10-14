import { EffortPicker, ResearchBanner, ResearchProgress } from './research';
import type { Effort } from '../../../packages/contracts/src/research';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CreateGoal,
  CreateSession,
  Feedback,
  UpdateGoal,
  DraftInput,
  type Attempt,
  type Goal,
  type GoalDetail,
  type LearningSession,
  type SessionDetail,
  type SourceSummary,
  type Today,
} from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import type { GoalOverview, TodayOverview, SessionSummary } from '../../../packages/contracts/src/pagination';
import { CreateErrandInput } from '../../../packages/contracts/src/errands';
import {
  date,
  ErrorNotice,
  Heading,
  navigate,
  QueryState,
  Result,
  SessionRows,
  SourcePicker,
  Sources,
  Status,
  useCursorList,
  CursorControls,
} from './ui';
import { MemoryEditor } from './memory-editor';
import { ErrandPanel, FlowList } from './errand';
import s from './styles.module.css';
import { Icon, type IconName } from './icons';

const attemptSource: Record<Attempt['source'], string> = {
  user_report: '含本人反馈',
  model_estimate: '模型估计',
  ungraded: '未评阅',
};

function LegacyRecord({ record, sessionId }: { record: Record<string, unknown>; sessionId: string }) {
  let decoded: unknown = record.sources,
    invalid = false;
  if (typeof decoded === 'string') {
    if (decoded.trim()) {
      try {
        decoded = JSON.parse(decoded);
      } catch {
        invalid = true;
        decoded = [];
      }
    } else decoded = [];
  }
  if (decoded == null) decoded = [];
  if (!Array.isArray(decoded)) {
    invalid = true;
    decoded = [];
  }
  const entries: Array<{ path: string; text: string }> = [];
  for (const entry of decoded as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid = true;
      continue;
    }
    const item = entry as Record<string, unknown>,
      path = typeof item.path === 'string' ? item.path : '',
      text = typeof item.text === 'string' ? item.text : '';
    if (!path && !text) {
      invalid = true;
      continue;
    }
    if (
      (item.path !== undefined && typeof item.path !== 'string') ||
      (item.text !== undefined && typeof item.text !== 'string')
    )
      invalid = true;
    entries.push({ path, text });
  }
  const packet =
    typeof record.packet === 'string'
      ? record.packet
      : record.packet == null
        ? ''
        : JSON.stringify(record.packet, null, 2);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(record, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ('迁移前记录-' + sessionId).replace(/[\\/:*?"<>|]/g, '_') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <details className={s.disclosure}>
      <summary>迁移前记录</summary>
      <p className={s.muted}>以下为迁移前保存的内容。历史引用未全部核验，不作为本轮的新证据。</p>
      {packet && (
        <section className={s.section}>
          <h2>旧整理内容</h2>
          <Result>{packet}</Result>
        </section>
      )}
      <section className={s.section}>
        <h2>历史引用</h2>
        {entries.map((entry, index) => (
          <div className={s.citation} key={index}>
            <p className={s.prewrap}>{entry.path || '未记录路径'}</p>
            <blockquote>{entry.text || '未记录摘录'}</blockquote>
          </div>
        ))}
        {invalid ? (
          <p className={s.muted}>部分历史引用格式无法展开，可下载完整记录核对。</p>
        ) : (
          !entries.length && <p className={s.muted}>没有保存历史引用。</p>
        )}
      </section>
      <div className={s.toolbar}>
        <button type="button" className={s.secondary} onClick={download}>
          下载完整旧记录（JSON）
        </button>
      </div>
    </details>
  );
}

const taskModes = {
  research: {
    label: '深入研究',
    summary: '比较方案、查证资料、改进答案',
    icon: 'research',
    field: '研究问题',
    help: '填写问题与验收要求，助手会检索资料、比较候选并保留较好版本。',
    example: '比较关系型数据库与文档数据库，结合课程资料给出选型依据、反例和适用边界。',
    action: '开始研究',
    footer: '研究记录、引用与消耗会保存',
  },
  goal: {
    label: '学习计划',
    summary: '拆解目标，持续练习',
    icon: 'goals',
    field: '学习目标',
    help: '填写目标，助手会准备学习步骤和练习。',
    example: '理解数据库事务，能解释四种隔离级别。',
    action: '创建学习计划',
    footer: '每次准备一个学习步骤',
  },
  study: {
    label: '学习答疑',
    summary: '概念讲解与练习',
    icon: 'study',
    field: '学习问题',
    help: '输入概念或练习题，获取讲解和巩固练习。',
    example: '用一个例子解释数据库的左连接，再出一道练习题。',
    action: '开始答疑',
    footer: '结果会保存在历史记录',
  },
  errand: {
    label: '办理通知',
    summary: '抽取要素、查材料、拟邮件',
    icon: 'checklist',
    field: '通知原文',
    help: '粘贴通知或邮件正文。助手抽取截止与活动时间（附原文依据），对照你的资料列出材料，缺信息时先问你，再准备邮件草稿和日历。',
    example:
      '关于举办 2026 年秋季学期“生成式软件工程”课程展示的通知\n各位同学：课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行。请于 11 月 10 日 23:59 前将报名表和项目简介（不超过 500 字）发送至 gse-ta@nju.edu.cn，邮件主题注明“展示报名+姓名”。',
    action: '开始办理',
    footer: '要素逐条核对原文；邮件需你确认才发送',
  },
  work: {
    label: '整理材料',
    summary: '提炼要点、生成草稿',
    icon: 'work',
    field: '材料与整理要求',
    help: '粘贴材料，注明需要摘要、要点或回复草稿。',
    example: '把下面的通知整理为办理事项、截止时间和材料清单：\n（在此粘贴通知）',
    action: '整理材料',
    footer: '结果会保存在历史记录',
  },
  manage: {
    label: '安排复盘',
    summary: '生成待办与复盘清单',
    icon: 'clock',
    field: '安排或复盘内容',
    help: '填写待办或学习记录，生成安排与复盘清单。',
    example: '明天有 1 小时，安排数据库事务复习、软件工程阅读，并列出复盘要点。',
    action: '生成清单',
    footer: '定时执行请使用「定时计划」',
  },
} satisfies Record<
  string,
  {
    label: string;
    summary: string;
    icon: IconName;
    field: string;
    help: string;
    example: string;
    action: string;
    footer: string;
  }
>;
type TaskMode = keyof typeof taskModes;
type TaskFields = { title: string; outcome: string; sourceIds: string[]; effort?: Effort; flowId?: string };
type TaskDraft = TaskFields & { mode: TaskMode; saved?: Partial<Record<TaskMode, TaskFields>> };
function switchTask(draft: TaskDraft, mode: TaskMode): TaskDraft {
  if (draft.mode === mode) return draft;
  const saved = {
    ...draft.saved,
    [draft.mode]: {
      title: draft.title,
      outcome: draft.outcome,
      sourceIds: draft.sourceIds,
      effort: draft.effort,
      flowId: draft.flowId,
    },
  };
  return { ...(saved[mode] || { title: '', outcome: '', sourceIds: [] }), mode, saved };
}

function GoalSourcePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
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

function TodayStats({ data }: { data: TodayOverview }) {
  // Red is kept for what is waiting on the owner; other non-zero counts use the ink colour.
  const items: Array<[string, number, string, IconName, 'annot' | 'ink' | 'none']> = [
    ['待你处理', data.pendingTotal, '#/history?state=pending', 'today', data.pendingTotal > 0 ? 'annot' : 'none'],
    [
      '待确认邮件',
      data.mailWaiting ?? 0,
      '#/mail?filter=drafting',
      'mail',
      (data.mailWaiting ?? 0) > 0 ? 'annot' : 'none',
    ],
    ['新邮件', data.mailNew ?? 0, '#/mail?filter=new', 'bell', (data.mailNew ?? 0) > 0 ? 'ink' : 'none'],
    ['进行中的目标', data.activeGoalTotal, '#/goals', 'goals', 'none'],
  ];
  return (
    <nav className={s.statStrip} aria-label="今日概况">
      {items.map(([label, value, href, icon, highlight]) => (
        <a key={label} href={href} data-highlight={highlight}>
          <Icon name={icon} />
          <span>
            <strong>{value}</strong>
            {label}
          </span>
        </a>
      ))}
    </nav>
  );
}
export function TodayPage({ initialMode, greeting }: { initialMode?: string | null; greeting?: string }) {
  const query = useData<TodayOverview>('/today/overview', { refetchInterval: 20_000 }),
    api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [draft, setDraft] = useDraft<TaskDraft>('new-goal', { title: '', outcome: '', sourceIds: [], mode: 'goal' });
  const [optionsOpen, setOptionsOpen] = useState(false);
  const task = taskModes[draft.mode] || taskModes.goal;
  // Research needs a model to solve and review; fail here instead of in the background run.
  const researchBlocked = draft.mode === 'research' && query.data?.modelConfigured === false;
  useEffect(() => {
    if (initialMode && Object.hasOwn(taskModes, initialMode)) {
      const flowId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('flow') || undefined;
      setDraft((current) => {
        const next = switchTask(current, initialMode as TaskMode);
        return flowId ? { ...next, flowId } : next;
      });
    }
  }, [initialMode, setDraft]);
  const flows = useData<Array<{ id: string; enabled: boolean; definition: { title: string } }>>('/flows');
  const selectMode = (mode: TaskMode) => {
    if (action.busy) return;
    setDraft((current) => switchTask(current, mode));
    setOptionsOpen(false);
    action.setError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(
      async () => {
        if (draft.mode === 'goal')
          return api.write<{ sessionId: string; goalId: string }>(
            '/goals',
            CreateGoal.parse({ title: draft.title.trim(), outcome: draft.outcome, sourceIds: draft.sourceIds }),
          );
        if (draft.mode === 'errand')
          return api.write<{ sessionId: string }>(
            '/errands',
            CreateErrandInput.parse({ text: draft.title, ...(draft.flowId ? { flowId: draft.flowId } : {}) }),
          );
        return api.write<{ sessionId: string }>(
          '/sessions',
          CreateSession.parse({
            prompt: draft.title,
            kind: draft.mode === 'research' ? 'work' : draft.mode,
            ...(draft.mode === 'research'
              ? { research: { effort: draft.effort || 'low', sourceIds: draft.sourceIds } }
              : {}),
          }),
        );
      },
      (result) => {
        setDraft((current) =>
          JSON.stringify(current) === JSON.stringify(draft) ? { ...current, title: '', outcome: '' } : current,
        );
        void client.invalidateQueries();
        navigate('/session/' + result.sessionId);
      },
    );
  };
  return (
    <>
      <Heading title="学习工作台" eyebrow={greeting}>
        选择功能，填写内容，开始处理。关闭页面后任务仍在后台继续。
      </Heading>
      {query.data && <TodayStats data={query.data} />}
      <div className={s.featureGrid} role="group" aria-label="选择功能">
        {(Object.keys(taskModes) as TaskMode[]).map((mode) => {
          const item = taskModes[mode];
          return (
            <button
              key={mode}
              type="button"
              className={s.featureButton}
              aria-pressed={draft.mode === mode}
              aria-controls="task-composer"
              aria-labelledby={'feature-' + mode}
              aria-describedby={'feature-help-' + mode}
              disabled={action.busy}
              onClick={() => selectMode(mode)}
            >
              <span className={s.featureTitle}>
                <Icon name={item.icon} />
                <strong id={'feature-' + mode}>{item.label}</strong>
              </span>
              <span className={s.featureDescription} id={'feature-help-' + mode}>
                {item.summary}
              </span>
            </button>
          );
        })}
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (!query.data.modelConfigured || !query.data.workerOnline) && (
        <div className={s.notice}>
          {!query.data.modelConfigured && (
            <p>
              未连接模型，当前只提供资料摘录与自评练习。<a href="#/settings">设置模型</a>
            </p>
          )}
          {!query.data.workerOnline && <p>后台尚未运行，任务暂时不会开始。启动助手后台后，已保存的任务会继续。</p>}
        </div>
      )}
      {Boolean(query.data?.workerOnline && query.data.backgroundIssues) && (
        <p className={s.notice}>
          后台有 {query.data!.backgroundIssues} 项检查需要处理。<a href="#/settings?view=runtime">查看运行状态</a>
        </p>
      )}
      <div className={s.todayGrid}>
        <div>
          <form id="task-composer" aria-label={task.label + '填写区'} onSubmit={submit} className={s.composer}>
            <div className={s.composerHeading}>
              <h2 id="composer-title">
                <label htmlFor="new-goal">{task.field}</label>
              </h2>
              <button
                type="button"
                className={s.exampleButton}
                disabled={action.busy || Boolean(draft.title.trim())}
                onClick={() =>
                  setDraft((current) => (current.title.trim() ? current : { ...current, title: task.example }))
                }
              >
                填入示例
              </button>
            </div>
            <p id="task-help" className={s.composerHelp}>
              {task.help}
            </p>
            <textarea
              id="new-goal"
              aria-describedby="task-help"
              maxLength={draft.mode === 'goal' ? 200 : 30000}
              rows={3}
              placeholder={task.example}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            {draft.mode === 'errand' && (
              <div className={s.composerControls}>
                <div className={s.inlineSelect}>
                  <label htmlFor="errand-flow">按流程办理</label>
                  <select
                    id="errand-flow"
                    value={draft.flowId || ''}
                    onChange={(e) => setDraft({ ...draft, flowId: e.target.value || undefined })}
                  >
                    <option value="">不使用流程（默认步骤）</option>
                    {(flows.data || [])
                      .filter((flow) => flow.enabled)
                      .map((flow) => (
                        <option key={flow.id} value={flow.id}>
                          {flow.definition.title}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            )}
            {draft.mode === 'research' && (
              <>
                <EffortPicker
                  value={draft.effort || 'low'}
                  disabled={action.busy}
                  onChange={(effort) => setDraft({ ...draft, effort })}
                />
                <details className={s.composerOptions} onToggle={(e) => setOptionsOpen(e.currentTarget.open)}>
                  <summary>
                    研究资料 · {draft.sourceIds.length ? `已选 ${draft.sourceIds.length} 份` : '自动检索'}
                  </summary>
                  {optionsOpen && (
                    <GoalSourcePicker
                      value={draft.sourceIds}
                      onChange={(sourceIds) => setDraft({ ...draft, sourceIds })}
                    />
                  )}
                  <p className={s.muted}>不选时检索可用资料库；选择后仅使用所选资料。每次研究固定原文版本。</p>
                </details>
              </>
            )}
            {draft.mode === 'goal' && (
              <>
                <div className={s.composerControls}>
                  <button
                    type="button"
                    className={s.toolButton}
                    aria-label={
                      draft.sourceIds.length ? `已关联 ${draft.sourceIds.length} 份资料` : '选择资料（当前未关联）'
                    }
                    onClick={() => setOptionsOpen(true)}
                  >
                    <Icon name="library" />
                    {draft.sourceIds.length ? `${draft.sourceIds.length} 份资料` : '选择资料'}
                  </button>
                  <button
                    type="button"
                    className={s.toolButton}
                    aria-expanded={optionsOpen}
                    aria-controls="goal-options"
                    onClick={() => setOptionsOpen(!optionsOpen)}
                  >
                    <Icon name="settings" />
                    学习设置
                  </button>
                </div>
                <div id="goal-options" hidden={!optionsOpen} className={s.composerOptions}>
                  <div className={s.optionField}>
                    <label htmlFor="goal-outcome">预期成果</label>
                    <textarea
                      id="goal-outcome"
                      rows={2}
                      maxLength={4000}
                      value={draft.outcome}
                      onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
                      placeholder="例如：能独立完成第一讲的练习，每天 20 分钟"
                    />
                  </div>
                  {optionsOpen && (
                    <GoalSourcePicker
                      value={draft.sourceIds}
                      onChange={(sourceIds) => setDraft({ ...draft, sourceIds })}
                    />
                  )}
                  <p className={s.muted}>不选资料时，按目标本身准备。</p>
                </div>
              </>
            )}
            {researchBlocked && (
              <p className={s.composerBlocked} role="note">
                深入研究需要先连接模型，并开启资料片段引用。<a href="#/settings">去设置</a>
              </p>
            )}
            <div className={s.composerFooter}>
              <span className={s.muted}>{task.footer}</span>
              <button
                className={s.primary}
                disabled={
                  action.busy ||
                  researchBlocked ||
                  !draft.title.trim() ||
                  (draft.mode === 'goal' && draft.sourceIds.length > 100)
                }
              >
                {action.busy ? '正在提交…' : task.action}
                <Icon name="arrow" />
              </button>
            </div>
          </form>
          <ErrorNotice error={action.error} />
          <p className={s.composerHint}>输入自动暂存，切换功能或刷新后可继续填写。</p>
        </div>
        <aside className={s.todayAside}>
          {query.data && (
            <section className={s.resumePanel} aria-labelledby="resume-heading">
              <div className={s.sectionHeading}>
                <h2 id="resume-heading">待办任务</h2>
                {query.data.sessions.length > 0 && <span className={s.muted}>{query.data.pendingTotal} 项</span>}
              </div>
              <SessionRows sessions={query.data.sessions} showAction empty="暂无待办。选择功能，创建第一个任务。" />
              {query.data.pendingTotal > 3 && (
                <a className={s.textLink} href="#/history?state=pending">
                  查看全部待办
                  <Icon name="arrow" />
                </a>
              )}
              {Boolean(query.data.goalTotal) && (
                <a className={s.textLink} href="#/goals">
                  查看全部目标（{query.data.goalTotal}）<Icon name="arrow" />
                </a>
              )}
            </section>
          )}
          <FlowList compact />
          <nav className={s.quickLinks} aria-label="常用入口">
            {(
              [
                ['#/mail', 'mail', '邮件', '往来线程、回复草稿与通知'],
                ['#/devices', 'device', '设备控制', '确认设备操作与 ehall 模拟事务'],
                ['#/settings?view=workspace', 'branch', '规则与流程', '已确认的纠正，用 Git 保存'],
                ['#/schedules', 'clock', '定时计划', '按时准备学习任务'],
                ['#/history', 'history', '历史记录', '查看之前的任务与结果'],
              ] as const
            ).map(([href, icon, title, description]) => (
              <a href={href} key={href}>
                <Icon name={icon} />
                <span>
                  {title}
                  <small>{description}</small>
                </span>
                <Icon name="arrow" />
              </a>
            ))}
          </nav>
        </aside>
      </div>
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
    void client.invalidateQueries();
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
export function SessionPage({ id }: { id: string }) {
  const query = useData<SessionDetail>('/sessions/' + encodeURIComponent(id), { refetchInterval: 5000 });
  return (
    <>
      <a className={s.back} href={query.data?.session.goalId ? '#/goal/' + query.data.session.goalId : '#/today'}>
        ‹ {query.data?.session.goalId ? '返回目标' : '今天'}
      </a>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <SessionContent
          detail={query.data}
          reload={async () => {
            const result = await query.refetch();
            return result.data;
          }}
        />
      )}
    </>
  );
}
function SessionContent({
  detail,
  reload,
}: {
  detail: SessionDetail;
  reload: () => Promise<SessionDetail | undefined>;
}) {
  const { session, attempts, artifacts, approvals } = detail,
    api = useApi(),
    client = useQueryClient(),
    action = useAction();
  const [answer, setAnswer] = useDraft('answer.' + session.id, {
    text: '',
    revision: session.revision,
    selfReport: '',
  });
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useDraft('session.' + session.id, {
      content: session.content,
      recipient: (session as LearningSession & { recipient?: string }).recipient || '',
      revision: session.revision,
    });
  const [remember, setRemember] = useState(false);
  const [archive, setArchive] = useState(false),
    [resolution, setResolution] = useState(''),
    [ownVersion, setOwnVersion] = useState(session.revision);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!answer.text && answer.revision !== session.revision)
      setAnswer((current) => ({ ...current, revision: session.revision }));
  }, [session.revision, answer.text]);
  useEffect(() => {
    if (!editing && draft.content === session.content && draft.revision !== session.revision)
      setDraft((current) => ({ ...current, revision: session.revision }));
  }, [session.revision, editing, session.content]);
  const refresh = () => {
    void client.invalidateQueries();
  };
  const active = ['queued', 'running'].includes(session.state),
    canAnswer =
      session.kind === 'study'
        ? session.state === 'waiting_feedback'
        : ['waiting_feedback', 'ready', 'completed'].includes(session.state);
  const sending = approvals.some((approval) => ['approved', 'executing', 'uncertain'].includes(approval.state));
  const isErrand = session.flow === 'errand',
    isMail = session.flow === 'mail-reply' || Boolean(session.parentSessionId && session.recipient);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sent = answer;
    void action.run(
      () =>
        api.write<{ revision: number }>(
          '/sessions/' + session.id + '/feedback',
          Feedback.parse({
            revision: answer.revision,
            answer: answer.text,
            ...(answer.selfReport ? { selfReport: answer.selfReport } : {}),
          }),
        ),
      (result) => {
        setAnswer((current) => ({
          ...current,
          text: current.text === sent.text ? '' : current.text,
          selfReport: current.text === sent.text ? '' : current.selfReport,
          revision: result.revision,
        }));
        setOwnVersion(result.revision);
        refresh();
      },
    );
  };
  const loadVersion = () =>
    void action.run(reload, (result) => {
      if (result) {
        setAnswer((current) => ({ ...current, revision: result.session.revision }));
        setDraft((current) => ({ ...current, revision: result.session.revision }));
        setOwnVersion(result.session.revision);
        action.setMessage('最新版本已载入，输入已保留。请核对后重新保存。');
      }
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const sent = draft;
    void action.run(
      () => api.write<{ revision: number }>('/sessions/' + session.id + '/draft', DraftInput.parse(draft), 'PATCH'),
      (result) => {
        setDraft((current) => ({ ...current, revision: result.revision }));
        setOwnVersion(result.revision);
        if (draftRef.current.content === sent.content && draftRef.current.recipient === sent.recipient)
          setEditing(false);
        action.setMessage('已保存。');
        refresh();
      },
    );
  };
  const download = () =>
    void action.run(
      () => api.request<string>('/sessions/' + session.id + '/export', { raw: true }),
      (content) => {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' })),
          anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = (session.title || '学习记录').replace(/[\\/:*?"<>|]/g, '_') + '.md';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
  const edit = () => {
    if (draft.content !== session.content && draft.revision < session.revision && draft.revision === ownVersion)
      setDraft({
        content: session.content,
        recipient: (session as LearningSession & { recipient?: string }).recipient || '',
        revision: session.revision,
      });
    setEditing(true);
  };
  const kindLabel =
    session.research || detail.research
      ? '深入研究'
      : session.flow === 'errand'
        ? '办理通知'
        : session.flow === 'mail-reply'
          ? '邮件回复'
          : session.parentSessionId
            ? '邮件草稿'
            : session.kind === 'study'
              ? session.goalId
                ? '学习计划'
                : '学习答疑'
              : session.kind === 'work'
                ? '整理材料'
                : '安排复盘';
  return (
    <>
      <Heading title={session.title} eyebrow={kindLabel + ' · ' + date(session.createdAt)}>
        <Status state={session.state} />
      </Heading>
      <details className={s.disclosure}>
        <summary>最初的要求</summary>
        <p className={s.prewrap}>{session.prompt}</p>
      </details>
      {session.error && (
        <div className={s.error} role="alert">
          {session.error}
        </div>
      )}
      {active && (
        <div className={s.runningNotice} role="status">
          <span className={s.pulse} aria-hidden="true" />
          <p>
            {session.state === 'queued' ? '已排队，等待后台开始。' : '正在准备。'}
            你可以离开页面，稍后回来继续。
          </p>
          <button
            className={s.secondary}
            disabled={action.busy || !session.currentRunId}
            onClick={() => void action.run(() => api.write('/runs/' + session.currentRunId + '/cancel'), refresh)}
          >
            停止
          </button>
        </div>
      )}
      {detail.research && (
        <ResearchBanner detail={detail.research} active={active && detail.research.runId === session.currentRunId} />
      )}
      {Boolean(detail.related?.length) && (
        <nav className={s.relatedLinks} aria-label="相关任务">
          {detail.related!.map((item) => (
            <a key={item.id} href={'#/session/' + encodeURIComponent(item.id)}>
              <Icon name={item.flow === 'errand' ? 'checklist' : 'mail'} />
              {item.relation === 'parent' ? '来自办事：' : item.flow === 'errand' ? '办事：' : '邮件草稿：'}
              {item.title}
              <Status state={item.state} />
            </a>
          ))}
        </nav>
      )}
      {isErrand && detail.errand ? (
        <>
          {detail.errand.state.plan?.summary && (
            <article className={s.answer}>
              <Result>{detail.errand.state.plan.summary}</Result>
              <Sources citations={session.citations} />
            </article>
          )}
          <ErrandPanel errand={detail.errand} session={session} />
        </>
      ) : isMail && session.content ? (
        <MailDraft
          session={session}
          busy={action.busy || active}
          sending={sending}
          edited={artifacts.some((artifact) => artifact.provenance === 'user_revision' && artifact.kind === 'draft')}
          onEdit={edit}
          onRequest={() =>
            void action.run(
              () => api.write('/sessions/' + session.id + '/approval', { revision: session.revision }),
              refresh,
            )
          }
          onPropose={() =>
            void action.run(
              () =>
                api.write<{ key?: string; content?: string; pending?: boolean }>(
                  '/sessions/' + session.id + '/rule-proposal',
                  { revision: session.revision },
                ),
              (result) =>
                action.setMessage(
                  result.pending
                    ? '正在从你的修改中总结规则，通常需要半分钟。完成后会通知你，提议在“资料 → 记忆与偏好”确认后才会生效。'
                    : '已生成规则提议' +
                        (result.content ? '：“' + result.content + '”' : '') +
                        '。到“资料 → 记忆与偏好”确认后才会生效。',
                ),
            )
          }
        />
      ) : (
        session.content && (
          <article className={s.answer}>
            <Result>{session.content}</Result>
            <Sources citations={session.citations} />
          </article>
        )
      )}
      {detail.research && (
        <ResearchProgress
          detail={detail.research}
          sessionId={session.id}
          active={active && detail.research.runId === session.currentRunId}
        />
      )}
      {Boolean(detail.ruleUsage?.length) && (
        <details className={s.disclosure}>
          <summary>本次遵循的规则</summary>
          {detail.ruleUsage!.map((rule) => (
            <div key={rule.runId + ':' + rule.key} className={s.evidence}>
              <p>
                {rule.key} · 第 {rule.version} 版 · {rule.commitSha?.slice(0, 7) || '未提交的文件版本'}
              </p>
              <p className={s.prewrap}>{rule.content}</p>
            </div>
          ))}
        </details>
      )}
      {attempts.map((attempt) => (
        <section className={s.conversation} key={attempt.id}>
          <div className={s.userAnswer}>
            <span className={s.muted}>你的回答</span>
            <p className={s.prewrap}>{attempt.answer}</p>
          </div>
          {attempt.feedback && <Result>{attempt.feedback}</Result>}
          <p className={s.muted}>
            {attempt.source === 'ungraded'
              ? '未评阅'
              : `${attempt.verdict === 'pass' ? (attempt.source === 'user_report' ? '本人标记已理解' : '本次练习已通过') : attempt.verdict === 'retry' ? (attempt.source === 'user_report' ? '本人标记需要练习' : '再练一次') : attempt.verdict === 'pending' ? '等待评阅' : '还需要一点信息'} · ${attemptSource[attempt.source]}`}
          </p>
          {attempt.feedback && attempt.evidence && (
            <details className={s.disclosure}>
              <summary>评估依据</summary>
              <p className={s.prewrap}>{attempt.evidence}</p>
            </details>
          )}
        </section>
      ))}
      {session.kind === 'study' && session.state === 'completed' && (
        <div className={s.notice}>
          <p>
            {session.goalId
              ? '本轮练习已完成。下一次复习会按目标安排准备。'
              : '本轮练习已完成。新的问题可从学习答疑开始。'}
          </p>
          <a className={s.textLink} href={session.goalId ? '#/goal/' + encodeURIComponent(session.goalId) : '#/today'}>
            {session.goalId ? '查看目标与复习安排' : '返回学习工作台'}
          </a>
        </div>
      )}
      {canAnswer && session.research && (
        <p className={s.muted}>提交修改意见会按本任务的研究投入开启新一轮，单独计算预算。</p>
      )}
      {canAnswer && (
        <form className={s.composer} onSubmit={submit}>
          <label htmlFor="answer" className={s.composerLabel}>
            {session.kind === 'study' ? '练习回答' : isErrand ? '补充信息' : isMail ? '补充信息或修改要求' : '修改意见'}
          </label>
          <textarea
            id="answer"
            rows={4}
            maxLength={30000}
            value={answer.text}
            onChange={(e) => setAnswer({ ...answer, text: e.target.value })}
            placeholder={
              session.kind === 'study' ? '填写练习答案，或补充需要讲解的内容。' : '填写需要补充或调整的内容。'
            }
          />
          {session.kind === 'study' && (
            <details className={s.composerOptions}>
              <summary>补充自评</summary>
              <label>
                我对这一步的理解
                <select
                  value={answer.selfReport || ''}
                  onChange={(e) => setAnswer({ ...answer, selfReport: e.target.value })}
                >
                  <option value="">请助手评阅</option>
                  <option value="understood">我已理解</option>
                  <option value="need_practice">还需要练习</option>
                </select>
              </label>
              <p className={s.muted}>自评会作为本人的学习证据保留。</p>
            </details>
          )}
          <div className={s.composerFooter}>
            <span className={s.muted}>输入会暂存于这个浏览器会话。</span>
            <button className={s.primary} disabled={action.busy || !answer.text.trim()}>
              {action.busy ? '正在提交…' : session.kind === 'study' ? '提交回答' : '提交反馈'}
            </button>
          </div>
        </form>
      )}
      <ErrorNotice error={action.error} onReload={loadVersion} />
      {action.message && (
        <p role="status" className={s.muted}>
          {action.message}
        </p>
      )}
      {['failed', 'cancelled'].includes(session.state) && (
        <button
          className={s.primary}
          disabled={action.busy}
          onClick={() =>
            void action.run(
              () => api.write('/sessions/' + session.id + '/retry', { revision: session.revision }),
              refresh,
            )
          }
        >
          重新准备
        </button>
      )}
      {editing && (
        <form className={s.form} onSubmit={save}>
          <label>
            修改内容
            <textarea
              rows={12}
              maxLength={100000}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <label>
            收件人（需要邮件时填写）
            <input
              type="email"
              maxLength={320}
              value={draft.recipient}
              onChange={(e) => setDraft({ ...draft, recipient: e.target.value })}
            />
          </label>
          <div className={s.toolbar}>
            <button className={s.primary} disabled={action.busy}>
              保存内容
            </button>
            <button type="button" className={s.textButton} onClick={() => setEditing(false)}>
              稍后再改
            </button>
          </div>
        </form>
      )}
      {remember && (
        <section className={s.section}>
          <h2>记住一条纠正</h2>
          <p className={s.muted}>
            写下希望以后遵守的规则，确认保存后用于后续任务。可在「资料 → 记忆与偏好」修改或停用。
          </p>
          <MemoryEditor
            memory={null}
            draftKey={'correction.' + session.id}
            initialScope="correction"
            done={(saved) => {
              setRemember(false);
              if (saved) action.setMessage('已记住，下次准备内容时会使用。');
            }}
          />
        </section>
      )}
      {!active && (
        <details className={s.disclosure}>
          <summary>更多操作</summary>
          <div className={s.toolbar}>
            <button className={s.secondary} onClick={() => setRemember(true)}>
              记住一条纠正
            </button>
            {session.state !== 'archived' && (
              <button className={s.secondary} disabled={sending} onClick={edit}>
                修改内容
              </button>
            )}
            <button className={s.secondary} disabled={action.busy} onClick={download}>
              导出
            </button>
            {session.state !== 'archived' && (
              <>
                <button
                  className={s.secondary}
                  disabled={action.busy || sending}
                  onClick={() =>
                    void action.run(
                      () => api.write('/sessions/' + session.id + '/approval', { revision: session.revision }),
                      refresh,
                    )
                  }
                >
                  核对邮件
                </button>
                <button className={s.textButton} onClick={() => setArchive(!archive)}>
                  归档
                </button>
              </>
            )}
          </div>
          {archive && (
            <div className={s.notice}>
              <p>归档后仍可在历史中查看，当前学习步骤将结束。</p>
              <button
                className={s.secondary}
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => api.write('/sessions/' + session.id + '/archive', { revision: session.revision }),
                    () => {
                      setArchive(false);
                      refresh();
                    },
                  )
                }
              >
                确认归档
              </button>
            </div>
          )}
          {Boolean(artifacts.length) && (
            <details className={s.disclosure}>
              <summary>内容版本（{artifacts.length}）</summary>
              {artifacts.map((artifact) => (
                <details key={artifact.id} className={s.disclosure}>
                  <summary>
                    {artifact.kind === 'assessment_audit'
                      ? '评阅核对记录'
                      : artifact.provenance === 'user_revision'
                        ? '本人修订'
                        : '生成内容'}{' '}
                    · {date(artifact.createdAt)}
                  </summary>
                  {artifact.kind === 'assessment_audit' ? (
                    <pre className={s.prewrap}>{artifact.content}</pre>
                  ) : (
                    <Result>{artifact.content}</Result>
                  )}
                </details>
              ))}
            </details>
          )}
          {detail.legacy !== null && <LegacyRecord record={detail.legacy} sessionId={session.id} />}
        </details>
      )}
      {Boolean(approvals.length) && (
        <section className={s.section}>
          <h2>邮件记录</h2>
          {approvals.map((approval) => (
            <div className={s.approval} key={approval.id}>
              <p>
                {(
                  {
                    pending: '等待确认',
                    approved: '等待发送',
                    executing: '正在发送',
                    sent: '已发送',
                    rejected: '已取消',
                    invalidated: '内容已变更',
                    uncertain: '发送结果待核实',
                    failed: '发送失败',
                  } as Record<string, string>
                )[approval.state] || approval.state}
              </p>
              <dl className={s.metadata}>
                {(['recipient', 'sender', 'subject', 'draft', 'revision'] as const).map((key) => (
                  <div key={key}>
                    <dt>
                      {
                        {
                          recipient: '收件人',
                          sender: '发送账号',
                          subject: '主题',
                          draft: '正文',
                          revision: '内容版本',
                        }[key]
                      }
                    </dt>
                    <dd className={s.prewrap}>{String(approval.payload[key] ?? '')}</dd>
                  </div>
                ))}
              </dl>
              {approval.error && <p className={s.dangerText}>{approval.error}</p>}
              {approval.state === 'pending' && (
                <div className={s.toolbar}>
                  <button
                    className={s.primary}
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          api.write('/approvals/' + approval.id + '/decision', {
                            digest: approval.digest,
                            approve: true,
                          }),
                        refresh,
                      )
                    }
                  >
                    确认发送这封邮件
                  </button>
                  <button
                    className={s.secondary}
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          api.write('/approvals/' + approval.id + '/decision', {
                            digest: approval.digest,
                            approve: false,
                          }),
                        refresh,
                      )
                    }
                  >
                    取消发送
                  </button>
                </div>
              )}
              {approval.state === 'uncertain' && (
                <div className={s.form}>
                  <p>请先在邮箱核对，这里不会自动重发。</p>
                  <label>
                    核实记录
                    <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} />
                  </label>
                  <div className={s.toolbar}>
                    <button
                      className={s.secondary}
                      disabled={action.busy || !resolution.trim()}
                      onClick={() =>
                        void action.run(
                          () => api.write('/approvals/' + approval.id + '/resolve', { sent: true, note: resolution }),
                          refresh,
                        )
                      }
                    >
                      确认已发送
                    </button>
                    <button
                      className={s.secondary}
                      disabled={action.busy || !resolution.trim()}
                      onClick={() =>
                        void action.run(
                          () => api.write('/approvals/' + approval.id + '/resolve', { sent: false, note: resolution }),
                          refresh,
                        )
                      }
                    >
                      确认未发送
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** A reply draft shown as the letter that would be sent; sending always goes through the exact approval. */
function MailDraft({
  session,
  busy,
  sending,
  edited,
  onEdit,
  onRequest,
  onPropose,
}: {
  session: LearningSession;
  busy: boolean;
  sending: boolean;
  edited: boolean;
  onEdit: () => void;
  onRequest: () => void;
  onPropose: () => void;
}) {
  const questions = session.mail?.questions || [];
  return (
    <section className={s.letterDraft} aria-label="邮件草稿">
      <dl className={s.letterHead}>
        <div>
          <dt>收件人</dt>
          <dd>{session.recipient || '（未填写）'}</dd>
        </div>
        {Boolean(session.mail?.cc?.length) && (
          <div>
            <dt>抄送</dt>
            <dd>{session.mail!.cc!.join('、')}</dd>
          </div>
        )}
        <div>
          <dt>主题</dt>
          <dd>{session.title}</dd>
        </div>
        {session.mail?.threadId && (
          <div>
            <dt>线程</dt>
            <dd>
              <a href={'#/mail/' + encodeURIComponent(session.mail.threadId)}>查看往来信件</a>
              {session.mail.inReplyTo ? ' · 作为回复发送（保留会话关联）' : ''}
            </dd>
          </div>
        )}
      </dl>
      <div className={s.letterBody}>{session.content}</div>
      <Sources citations={session.citations} />
      {questions.length > 0 && session.state === 'waiting_feedback' && (
        <div className={s.questions} role="note">
          <h2>回复前需要你补充</h2>
          <ol>
            {questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ol>
        </div>
      )}
      <div className={s.toolbar}>
        <button
          type="button"
          className={s.primary}
          disabled={busy || sending || session.state !== 'ready'}
          onClick={onRequest}
        >
          <Icon name="mail" />
          核对并发送
        </button>
        <button type="button" className={s.secondary} disabled={busy || sending} onClick={onEdit}>
          修改草稿
        </button>
        {edited && (
          <button type="button" className={s.textButton} disabled={busy} onClick={onPropose}>
            <Icon name="branch" />
            从我的修改总结规则
          </button>
        )}
      </div>
      <p className={s.marginNote}>
        “核对并发送”会先生成一份不可更改的发送确认：收件人、主题、正文和版本都固定下来，你确认后才会发出。
      </p>
    </section>
  );
}
