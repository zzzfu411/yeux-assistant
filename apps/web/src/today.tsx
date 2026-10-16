import { EffortPicker } from './research';
import type { Effort } from '../../../packages/contracts/src/research';
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreateGoal, CreateSession } from '../../../packages/contracts/src/index';
import { storage, useAction, useApi, useData, useDraft } from './api';
import type { SessionSummary, TodayOverview } from '../../../packages/contracts/src/pagination';
import { CreateErrandInput } from '../../../packages/contracts/src/errands';
import { ErrorNotice, navigate, QueryState } from './ui';
import { FlowList } from './errand';
import { GoalSourcePicker } from './goals';
import { detectIntent, type TaskMode } from './intent';
import s from './styles.module.css';
import { Icon, type IconName } from './icons';

const taskModes = {
  research: {
    label: '深入研究',
    tab: '研究',
    icon: 'research',
    help: '检索资料、比较候选并保留较好版本。',
    example: '比较关系型数据库与文档数据库，结合课程资料给出选型依据、反例和适用边界。',
    action: '开始研究',
    footer: '研究记录、引用与消耗会保存',
  },
  goal: {
    label: '学习计划',
    tab: '计划',
    icon: 'goals',
    help: '拆成学习步骤，每次准备一步练习，按回答安排复习。',
    example: '理解数据库事务，能解释四种隔离级别。',
    action: '创建学习计划',
    footer: '每次准备一个学习步骤',
  },
  study: {
    label: '学习答疑',
    tab: '答疑',
    icon: 'study',
    help: '讲解概念，再出一道巩固练习。',
    example: '用一个例子解释数据库的左连接，再出一道练习题。',
    action: '开始答疑',
    footer: '结果会保存在历史记录',
  },
  errand: {
    label: '办理通知',
    tab: '办事',
    icon: 'checklist',
    help: '抽取截止与活动时间（附原文依据），对照你的资料列材料，缺信息先问你，再拟邮件和日历。',
    example:
      '关于举办 2026 年秋季学期“生成式软件工程”课程展示的通知\n各位同学：课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行。请于 11 月 10 日 23:59 前将报名表和项目简介（不超过 500 字）发送至 gse-ta@nju.edu.cn，邮件主题注明“展示报名+姓名”。',
    action: '开始办理',
    footer: '要素逐条核对原文；邮件需你确认才发送',
  },
  work: {
    label: '整理材料',
    tab: '整理',
    icon: 'work',
    help: '提炼要点、摘要或回复草稿。',
    example: '把下面的会议记录整理成三条要点和一份待办：\n（在此粘贴材料）',
    action: '整理材料',
    footer: '结果会保存在历史记录',
  },
  manage: {
    label: '安排复盘',
    tab: '复盘',
    icon: 'clock',
    help: '生成时间安排或复盘清单。定时执行请用「定时计划」。',
    example: '明天有 1 小时，安排数据库事务复习、软件工程阅读，并列出复盘要点。',
    action: '生成清单',
    footer: '定时执行请使用「定时计划」',
  },
} satisfies Record<
  TaskMode,
  { label: string; tab: string; icon: IconName; help: string; example: string; action: string; footer: string }
>;
const modeOrder = Object.keys(taskModes) as TaskMode[];
type ComposeDraft = {
  text: string;
  mode: TaskMode;
  /** The owner picked the tab; typing no longer changes it. */
  locked: boolean;
  outcome: string;
  sourceIds: string[];
  effort?: Effort;
  flowId?: string;
};
const emptyDraft: ComposeDraft = { text: '', mode: 'study', locked: false, outcome: '', sourceIds: [] };
/** An unsent entry from the earlier per-mode composer is carried over once, so an upgrade loses nothing. */
function legacyDraft(): ComposeDraft | null {
  try {
    const old = JSON.parse(storage.get('draft.new-goal') || 'null');
    // The old composer kept one text per mode; the one on screen wins, then any other unsent text.
    const found = [[old?.mode, old], ...Object.entries(old?.saved || {})].find(
      ([, entry]: any) => typeof entry?.title === 'string' && entry.title.trim(),
    ) as [unknown, any] | undefined;
    if (!found) return null;
    const [mode, kept] = found;
    return {
      ...emptyDraft,
      text: kept.title,
      mode: typeof mode === 'string' && Object.hasOwn(taskModes, mode) ? (mode as TaskMode) : 'goal',
      locked: true,
      outcome: typeof kept.outcome === 'string' ? kept.outcome : '',
      sourceIds: Array.isArray(kept.sourceIds) ? kept.sourceIds.filter((id: unknown) => typeof id === 'string') : [],
      ...(kept.effort ? { effort: kept.effort } : {}),
      ...(kept.flowId ? { flowId: kept.flowId } : {}),
    };
  } catch {
    return null;
  }
}

export function TodayPage({ initialMode, greeting }: { initialMode?: string | null; greeting?: string }) {
  const query = useData<TodayOverview>('/today/overview', { refetchInterval: 20_000 });
  return (
    <>
      <DayHeader greeting={greeting} data={query.data} />
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      <div className={s.spread}>
        <WaitingPage data={query.data} />
        <Composer data={query.data} initialMode={initialMode} />
      </div>
      <FlowList compact />
    </>
  );
}

/** A planner page header: the day in large numerals, the greeting in the margin hand. */
function DayHeader({ greeting, data }: { greeting?: string; data?: TodayOverview }) {
  const now = new Date(),
    weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
  const facts: Array<[string, number, string]> = data
    ? [
        ['进行中的目标', data.activeGoalTotal, '#/goals'],
        ['新邮件', data.mailNew ?? 0, '#/mail?filter=new'],
        ['未读消息', data.unread, '#/notifications'],
      ]
    : [];
  return (
    <header className={s.dayHeader}>
      <time className={s.dayNumber} dateTime={now.toISOString().slice(0, 10)} aria-hidden="true">
        {now.getDate()}
      </time>
      <div>
        <p className={s.eyebrow}>{greeting}</p>
        <h1>
          今天 <span className={s.dayMeta}>{`${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${weekday}`}</span>
        </h1>
        {facts.length > 0 && (
          <nav className={s.dayFacts} aria-label="今日概况">
            {facts.map(([label, value, href]) => (
              <a key={label} href={href} data-zero={value === 0}>
                {label} <strong>{value}</strong>
              </a>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

type Waiting = { key: string; kind: string; icon: IconName; title: string; note: string; href: string; action: string };
function waitingFrom(session: SessionSummary): Waiting {
  const kind =
    session.flow === 'errand'
      ? '办事'
      : session.flow === 'mail-reply'
        ? '信件'
        : session.isResearch
          ? '研究'
          : session.kind === 'study'
            ? session.goalId
              ? '练习'
              : '答疑'
            : session.kind === 'work'
              ? '整理'
              : '复盘';
  const icon: IconName =
    session.flow === 'errand'
      ? 'checklist'
      : session.flow === 'mail-reply'
        ? 'mail'
        : session.isResearch
          ? 'research'
          : session.kind === 'study'
            ? 'goals'
            : 'work';
  const action =
    session.state === 'waiting_feedback'
      ? session.kind === 'study'
        ? '继续练习'
        : session.flow === 'errand'
          ? '补充信息'
          : '查看并反馈'
      : session.state === 'failed'
        ? '处理任务'
        : '查看进度';
  return {
    key: session.id,
    kind,
    icon,
    title: session.title,
    note: session.errorPreview || session.promptPreview,
    href: '#/session/' + encodeURIComponent(session.id),
    action,
  };
}

/** Left page: at most three things that are waiting on the owner, most urgent first. */
function WaitingPage({ data }: { data?: TodayOverview }) {
  const items: Array<Waiting & { state: string }> = [];
  if (data?.mailWaiting)
    items.push({
      key: 'mail',
      kind: '信件',
      icon: 'mail',
      title: data.mailWaiting + ' 封回信待你核对',
      note: '草稿已备好，确认收件人和正文后才会发出。',
      href: '#/mail?filter=drafting',
      action: '核对邮件',
      state: 'waiting_feedback',
    });
  for (const session of data?.sessions || []) items.push({ ...waitingFrom(session), state: session.state });
  const shown = items.slice(0, 3),
    more = (data?.pendingTotal || 0) + (data?.mailWaiting ? 1 : 0) - shown.length;
  return (
    <section className={s.leftPage} aria-labelledby="waiting-heading">
      <div className={s.pageHead}>
        <h2 id="waiting-heading">等你的事</h2>
        {data && shown.length > 0 && <span className={s.pageCount}>共 {shown.length + more} 项</span>}
      </div>
      {data && !shown.length && (
        <p className={s.pageEmpty}>
          今天没有等你的事。
          <br />
          在右页写下一件想做的。
        </p>
      )}
      <ol className={s.waitingCards}>
        {shown.map((item) => (
          <li key={item.key} data-state={item.state}>
            <a href={item.href}>
              <span className={s.cardTab}>
                <Icon name={item.icon} />
                {item.kind}
              </span>
              <strong>{item.title}</strong>
              {item.note && <small>{item.note}</small>}
              <span className={s.cardAction}>
                {item.action}
                <Icon name="arrow" />
              </span>
            </a>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <a className={s.textLink} href="#/history?state=pending">
          另有 {more} 项 <Icon name="arrow" />
        </a>
      )}
      {Boolean(data?.goalTotal) && (
        <a className={s.textLink} href="#/goals">
          查看全部目标（{data!.goalTotal}）<Icon name="arrow" />
        </a>
      )}
    </section>
  );
}

/** Right page: one place to write. The tab is guessed from the text and can be changed on the page edge. */
function Composer({ data, initialMode }: { data?: TodayOverview; initialMode?: string | null }) {
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [legacy] = useState(legacyDraft);
  const [draft, setDraft] = useDraft<ComposeDraft>('compose', legacy ?? emptyDraft);
  useEffect(() => {
    // An empty composer takes over the old unsent draft even if the new key was already created.
    if (legacy) setDraft((current) => (current.text.trim() ? current : legacy));
    storage.remove('draft.new-goal');
  }, [legacy, setDraft]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const intent = detectIntent(draft.text);
  // Nothing typed and no tab chosen: no mode yet, so no tab looks selected.
  const mode: TaskMode | null = draft.locked ? draft.mode : (intent?.mode ?? null);
  const task = taskModes[mode ?? 'study'];
  const flows = useData<Array<{ id: string; enabled: boolean; definition: { title: string } }>>('/flows');
  useEffect(() => {
    // Links such as "套用流程" open the page with a tab already chosen.
    if (initialMode && Object.hasOwn(taskModes, initialMode)) {
      const flowId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('flow') || undefined;
      setDraft((current) => {
        // Unsent writing wins: a link never turns notes meant for another tab into, say, a new goal.
        const showing = current.locked ? current.mode : detectIntent(current.text)?.mode;
        if (current.text.trim() && showing !== initialMode) return current;
        return { ...current, mode: initialMode as TaskMode, locked: true, ...(flowId ? { flowId } : {}) };
      });
    }
  }, [initialMode, setDraft]);
  const choose = (next: TaskMode) => {
    if (action.busy) return;
    setDraft((current) => ({ ...current, mode: next, locked: true }));
    setOptionsOpen(false);
    action.setError(null);
  };
  // Research needs a model to solve and review; fail here instead of in the background run.
  const researchBlocked = mode === 'research' && data?.modelConfigured === false;
  const goalTooLong = mode === 'goal' && draft.text.trim().length > 200;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sent = draft;
    void action.run(
      async () => {
        if (mode === 'goal')
          return api.write<{ sessionId: string; goalId: string }>(
            '/goals',
            CreateGoal.parse({ title: draft.text.trim(), outcome: draft.outcome, sourceIds: draft.sourceIds }),
          );
        if (mode === 'errand')
          return api.write<{ sessionId: string }>(
            '/errands',
            CreateErrandInput.parse({ text: draft.text, ...(draft.flowId ? { flowId: draft.flowId } : {}) }),
          );
        return api.write<{ sessionId: string }>(
          '/sessions',
          CreateSession.parse({
            prompt: draft.text,
            kind: mode === 'research' ? 'work' : mode,
            ...(mode === 'research' ? { research: { effort: draft.effort || 'low', sourceIds: draft.sourceIds } } : {}),
          }),
        );
      },
      (result) => {
        setDraft((current) =>
          current.text === sent.text
            ? { ...current, text: '', outcome: '', locked: false, flowId: undefined }
            : current,
        );
        void client.invalidateQueries();
        navigate('/session/' + result.sessionId);
      },
    );
  };
  return (
    <section className={s.rightPage} aria-label="新任务" data-mode={mode ?? undefined}>
      {data && (!data.modelConfigured || !data.workerOnline || data.backgroundIssues > 0) && (
        <div className={s.annotation} role="note">
          <strong>批注</strong>
          <ul>
            {!data.modelConfigured && (
              <li>
                未连接模型，当前只提供资料摘录与自评练习。<a href="#/settings">设置模型</a>
              </li>
            )}
            {!data.workerOnline && <li>后台尚未运行，任务暂时不会开始；启动后台后，已保存的任务会继续。</li>}
            {data.workerOnline && data.backgroundIssues > 0 && (
              <li>
                后台有 {data.backgroundIssues} 项检查需要处理。<a href="#/settings?view=runtime">查看运行状态</a>
              </li>
            )}
          </ul>
        </div>
      )}
      <div className={s.modeTabs} role="group" aria-label="选择功能">
        {modeOrder.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={mode === item}
            aria-label={taskModes[item].label}
            title={taskModes[item].help}
            disabled={action.busy}
            data-mode={item}
            onClick={() => choose(item)}
          >
            <Icon name={taskModes[item].icon} />
            <span aria-hidden="true">{taskModes[item].tab}</span>
          </button>
        ))}
      </div>
      <form id="task-composer" aria-label={task.label + '填写区'} onSubmit={submit} className={s.writeForm}>
        <div className={s.pageHead}>
          <h2 id="compose-heading">
            <label htmlFor="compose-text">写下来</label>
          </h2>
          <button
            type="button"
            className={s.exampleButton}
            disabled={action.busy || Boolean(draft.text.trim())}
            onClick={() => setDraft((current) => (current.text.trim() ? current : { ...current, text: task.example }))}
          >
            填入示例
          </button>
        </div>
        <textarea
          id="compose-text"
          aria-describedby="compose-intent"
          maxLength={30000}
          rows={5}
          placeholder={
            draft.locked
              ? task.example
              : '写一个想弄懂的问题、一个学习目标，或直接粘贴一份通知。\n助手会判断要做什么，你也可以在页边改。'
          }
          value={draft.text}
          onChange={(e) => {
            const text = e.target.value;
            setDraft((current) => ({ ...current, text, locked: text.trim() ? current.locked : false }));
          }}
        />
        <p id="compose-intent" className={s.intentLine} aria-live="polite">
          {!draft.text.trim() && !draft.locked ? (
            <>按内容自动选择：研究、计划、答疑、办事、整理或复盘。</>
          ) : draft.locked ? (
            <>
              <span className={s.intentStamp} data-mode={mode ?? undefined}>
                {task.label}
              </span>
              你选的 · {task.help}
              {intent && intent.mode !== mode && (
                <button
                  type="button"
                  className={s.exampleButton}
                  onClick={() => setDraft((current) => ({ ...current, locked: false }))}
                >
                  改回识别：{taskModes[intent.mode].label}
                </button>
              )}
            </>
          ) : (
            <>
              <span className={s.intentStamp} data-mode={mode ?? undefined} data-unsure={!intent?.confident}>
                {task.label}
              </span>
              {intent?.reason}
              {intent?.confident ? '' : '；不对就在页边换一个'}
            </>
          )}
        </p>
        {mode === 'errand' && (
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
        {mode === 'research' && (
          <>
            <EffortPicker
              value={draft.effort || 'low'}
              disabled={action.busy}
              onChange={(effort) => setDraft({ ...draft, effort })}
            />
            <details className={s.composerOptions} onToggle={(e) => setOptionsOpen(e.currentTarget.open)}>
              <summary>研究资料 · {draft.sourceIds.length ? `已选 ${draft.sourceIds.length} 份` : '自动检索'}</summary>
              {optionsOpen && (
                <GoalSourcePicker value={draft.sourceIds} onChange={(sourceIds) => setDraft({ ...draft, sourceIds })} />
              )}
              <p className={s.muted}>不选时检索可用资料库；选择后仅使用所选资料。每次研究固定原文版本。</p>
            </details>
          </>
        )}
        {mode === 'goal' && (
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
                <GoalSourcePicker value={draft.sourceIds} onChange={(sourceIds) => setDraft({ ...draft, sourceIds })} />
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
        {goalTooLong && (
          <p className={s.composerBlocked} role="note">
            学习目标最多 200 字。长段材料请在页边改用「整理材料」。
          </p>
        )}
        <div className={s.composerFooter}>
          <span className={s.muted}>{mode ? task.footer : '写好后按内容选择处理方式'}</span>
          <button
            className={s.primary}
            disabled={
              action.busy ||
              researchBlocked ||
              goalTooLong ||
              !draft.text.trim() ||
              (mode === 'goal' && draft.sourceIds.length > 100)
            }
          >
            {action.busy ? '正在提交…' : mode ? task.action : '开始'}
            <Icon name="arrow" />
          </button>
        </div>
      </form>
      <ErrorNotice error={action.error} />
      <p className={s.composerHint}>输入自动暂存，刷新后可以接着写。关闭页面后任务仍在后台继续。</p>
    </section>
  );
}
