import { WorkspacePanel } from './workspace';
import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ModelSettingsInput, ScheduleInput, type LearningSession } from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, Pages, QueryState, SessionRows, useCursorList, CursorControls } from './ui';
import s from './styles.module.css';
import { RuntimeStatusPanel } from './runtime-status';
import { Icon } from './icons';
import { MailSettingsPanel, PushPanel } from './connections';
import { AgentConnectionsPanel } from './agent-connections';
import type { SessionSummary } from '../../../packages/contracts/src/pagination';

type Schedule = {
  id: string;
  title: string;
  kind: string;
  prompt: string;
  interval_seconds: number;
  next_run: string;
  enabled: boolean;
  version: number;
};
type ModelSettings = {
  base_url: string;
  model: string;
  has_api_key: boolean;
  tools: boolean;
  revision: string;
  mail_configured: boolean;
  review_base_url?: string;
  review_model?: string;
  has_review_api_key?: boolean;
  fast_model?: string;
};
type Notification = {
  id: string;
  session_id: string | null;
  deviceCommandId?: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};
const localDate = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function HistoryPage() {
  const initial = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const [search, setSearch] = useState(''),
    [q, setQ] = useState(''),
    [kind, setKind] = useState('all'),
    [state, setState] = useState(initial.get('state') === 'pending' ? 'pending' : 'all');
  const list = useCursorList<SessionSummary>(
      '/sessions/list?kind=' + kind + '&state=' + state + '&q=' + encodeURIComponent(q),
    ),
    query = list.query;
  return (
    <>
      <Heading title="历史">学习、工作和管理任务都在这里。</Heading>
      <div className={s.libraryTools}>
        <label>
          任务类型
          <select aria-label="任务类型" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">全部类型</option>
            <option value="study">学习</option>
            <option value="work">工作</option>
            <option value="manage">管理</option>
          </select>
        </label>
        <label>
          任务状态
          <select aria-label="任务状态" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="pending">待办任务</option>
            <option value="waiting_feedback">等你练习</option>
            <option value="ready">已准备</option>
            <option value="completed">已练习</option>
            <option value="failed">需要处理</option>
            <option value="cancelled">已停止</option>
            <option value="archived">已归档</option>
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
          <label className={s.srOnly} htmlFor="history-search">
            查找历史
          </label>
          <input
            id="history-search"
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="按任务标题查找"
          />
          <button className={s.secondary}>查找</button>
        </form>
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && <SessionRows sessions={query.data.items} empty="没有符合条件的任务。" />}
      <CursorControls list={list} />
    </>
  );
}
export function NotificationsPage() {
  const [page, setPage] = useState(0),
    query = useData<{ items: Notification[]; total: number }>('/notifications?page=' + page),
    api = useApi(),
    client = useQueryClient(),
    action = useAction();
  return (
    <>
      <Heading title="消息">需要你关注的变化。</Heading>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      <ErrorNotice error={action.error} />
      {query.data && (
        <>
          {query.data.items.length ? (
            <div className={s.rows}>
              {query.data.items.map((item) => (
                <article key={item.id} className={s.notification}>
                  <div className={s.sectionHeading}>
                    <h2>
                      {!item.read_at && <span className={s.unreadDot} aria-label="未读" />}
                      {item.title}
                    </h2>
                    <span className={s.muted}>{date(item.created_at)}</span>
                  </div>
                  {item.body && <p className={s.prewrap}>{item.body}</p>}
                  <div className={s.toolbar}>
                    {item.deviceCommandId && (
                      <a className={s.textLink} href={'#/devices?command=' + encodeURIComponent(item.deviceCommandId)}>
                        查看操作
                      </a>
                    )}
                    {item.session_id && (
                      <a className={s.textLink} href={'#/session/' + encodeURIComponent(item.session_id)}>
                        查看任务
                      </a>
                    )}
                    {!item.read_at && (
                      <button
                        className={s.textButton}
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            () => api.write('/notifications/' + item.id + '/read'),
                            () => void client.invalidateQueries(),
                          )
                        }
                      >
                        标为已读
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className={s.empty}>暂时没有新消息。</p>
          )}
          <Pages page={page} total={query.data.total} onChange={setPage} />
        </>
      )}
    </>
  );
}
export function SchedulesPage() {
  const query = useData<Schedule[]>('/schedules'),
    [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  return (
    <>
      <Heading
        title="定时计划"
        action={
          <button className={s.primary} onClick={() => setEditing(null)}>
            添加计划
          </button>
        }
      >
        后台运行时，按约定准备内容。
      </Heading>
      <p className={s.muted}>学习目标的复习节奏可在目标中调整。这里保存独立的提醒与任务。</p>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {editing !== undefined && (
        <ScheduleEditor key={editing?.id || 'new'} schedule={editing} done={() => setEditing(undefined)} />
      )}
      <div className={s.rows}>
        {query.data?.map((schedule) => (
          <div className={s.row} key={schedule.id}>
            <div>
              <strong>
                {schedule.title}
                {!schedule.enabled ? ' · 已暂停' : ''}
              </strong>
              <p>
                {date(schedule.next_run)} ·{' '}
                {schedule.interval_seconds
                  ? '每 ' + (schedule.interval_seconds / 3600).toLocaleString('zh-CN') + ' 小时'
                  : '单次'}
              </p>
              <p>{schedule.prompt}</p>
            </div>
            <button className={s.textButton} onClick={() => setEditing(schedule)}>
              调整
            </button>
          </div>
        ))}
      </div>
      {query.data?.length === 0 && <p className={s.empty}>还没有定时计划。</p>}
    </>
  );
}
function ScheduleEditor({ schedule, done }: { schedule: Schedule | null; done: () => void }) {
  const api = useApi(),
    client = useQueryClient(),
    action = useAction();
  const [draft, setDraft, clear] = useDraft('schedule.' + (schedule?.id || 'new'), {
    title: schedule?.title || '',
    kind: schedule?.kind || 'study',
    prompt: schedule?.prompt || '',
    hours: schedule ? String(schedule.interval_seconds / 3600) : '24',
    nextRun: localDate(schedule?.next_run || new Date(Date.now() + 3600000).toISOString()),
    enabled: schedule?.enabled ?? true,
    revision: schedule?.version || 0,
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [savedId, setSavedId] = useState(schedule?.id || '');
  const save = (e: FormEvent) => {
    e.preventDefault();
    const sent = draft;
    void action.run(
      () =>
        api.write<{ id: string; version: number }>(
          '/schedules' + (savedId ? '/' + savedId : ''),
          ScheduleInput.parse({
            title: draft.title,
            kind: draft.kind,
            prompt: draft.prompt,
            intervalSeconds: Math.round(Number(draft.hours) * 3600),
            nextRun: new Date(draft.nextRun).toISOString(),
            enabled: draft.enabled,
            revision: draft.revision,
          }),
          savedId ? 'PATCH' : 'POST',
        ),
      (result) => {
        void client.invalidateQueries();
        if (JSON.stringify(draftRef.current) === JSON.stringify(sent)) {
          clear();
          done();
        } else {
          setSavedId(result.id);
          setDraft((current) => ({ ...current, revision: result.version }));
          action.setMessage('已保存上次提交，继续编辑的内容仍在。');
        }
      },
    );
  };
  const reload = () =>
    void action.run(
      () => api.get<Schedule[]>('/schedules'),
      (rows) => {
        const updated = rows.find((row) => row.id === savedId);
        if (updated) setDraft((current) => ({ ...current, revision: updated.version }));
        action.setMessage('已载入最新版本，输入已保留。');
      },
    );
  return (
    <form className={s.form} onSubmit={save}>
      <label>
        计划名称
        <input
          required
          maxLength={200}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        任务内容
        <textarea
          required
          rows={3}
          maxLength={30000}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
      </label>
      <div className={s.formGrid}>
        <label>
          下次执行
          <input
            required
            type="datetime-local"
            value={draft.nextRun}
            onChange={(e) => setDraft({ ...draft, nextRun: e.target.value })}
          />
        </label>
        <label>
          执行间隔（小时，0 表示单次）
          <input
            required
            type="number"
            min="0"
            step="any"
            max="8760"
            value={draft.hours}
            onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
          />
        </label>
      </div>
      <label>
        类型
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
          <option value="study">学习</option>
          <option value="work">工作</option>
          <option value="manage">管理</option>
        </select>
      </label>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        启用计划
      </label>
      <ErrorNotice error={action.error} onReload={reload} />
      {action.message && (
        <p className={s.muted} role="status">
          {action.message}
        </p>
      )}
      <div className={s.toolbar}>
        <button className={s.primary} disabled={action.busy}>
          保存计划
        </button>
        <button type="button" className={s.textButton} onClick={done}>
          关闭
        </button>
      </div>
    </form>
  );
}
export function SettingsPage() {
  const query = useData<ModelSettings>('/settings/model'),
    view = new URLSearchParams(window.location.hash.split('?')[1] || '').get('view');
  if (view === 'agents')
    return (
      <>
        <a className={s.back} href="#/settings">
          返回设置
        </a>
        <Heading title="Agent 连接">管理 Hermes、Muse 等外部助手的访问权限。</Heading>
        <AgentConnectionsPanel />
      </>
    );
  if (view === 'workspace')
    return (
      <>
        <a className={s.back} href="#/settings">
          返回设置
        </a>
        <Heading title="规则与流程">保存可以重复使用的做事方法。</Heading>
        <WorkspacePanel />
      </>
    );
  const statusFirst = view === 'runtime';
  return (
    <>
      <Heading title="设置">连接模型，管理规则和外部连接，查看后台运行状态。</Heading>
      <div className={s.settingsLinks}>
        <a href="#/settings?view=workspace">
          <Icon name="branch" />
          <span>
            规则与流程
            <small>确认后的纠正写入私密 Git，新任务按版本使用</small>
          </span>
          <Icon name="arrow" />
        </a>
        <a href="#/settings?view=agents">
          <Icon name="device" />
          <span>
            外部 Agent
            <small>按连接授权读取资料、准备任务</small>
          </span>
          <Icon name="arrow" />
        </a>
      </div>
      {statusFirst && <RuntimeStatusPanel />}
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <SettingsForm
          settings={query.data}
          reload={async () => {
            const result = await query.refetch();
            return result.data;
          }}
        />
      )}
      {!statusFirst && <RuntimeStatusPanel />}
    </>
  );
}
function SettingsForm({
  settings,
  reload,
}: {
  settings: ModelSettings;
  reload: () => Promise<ModelSettings | undefined>;
}) {
  const api = useApi(),
    client = useQueryClient(),
    action = useAction();
  const [draft, setDraft] = useDraft<{
    base_url: string;
    model: string;
    tools: boolean;
    revision: string;
    review_base_url?: string;
    review_model?: string;
    fast_model?: string;
  }>('model', {
    base_url: settings.base_url,
    model: settings.model,
    tools: settings.tools,
    revision: settings.revision,
    review_base_url: settings.review_base_url || '',
    review_model: settings.review_model || '',
    fast_model: settings.fast_model || '',
  });
  const [apiKey, setApiKey] = useState(''),
    [reviewKey, setReviewKey] = useState('');
  // Drafts saved before the reviewer existed fall back to the stored values.
  const reviewBase = draft.review_base_url ?? settings.review_base_url ?? '',
    reviewModel = draft.review_model ?? settings.review_model ?? '',
    fastModel = draft.fast_model ?? settings.fast_model ?? '';
  const save = (e: FormEvent) => {
    e.preventDefault();
    const submittedKey = apiKey,
      submittedReviewKey = reviewKey;
    void action.run(
      () =>
        api.write<ModelSettings>(
          '/settings/model',
          ModelSettingsInput.parse({
            ...draft,
            api_key: apiKey,
            review_base_url: reviewBase,
            review_model: reviewModel,
            fast_model: fastModel,
            ...(reviewKey ? { review_api_key: reviewKey } : {}),
          }),
          'PATCH',
        ),
      (result) => {
        setDraft((current) => ({ ...current, revision: result.revision }));
        setApiKey((current) => (current === submittedKey ? '' : current));
        setReviewKey((current) => (current === submittedReviewKey ? '' : current));
        action.setMessage('配置已保存。可以测试连接。');
        void client.invalidateQueries();
      },
    );
  };
  const reloadVersion = () =>
    void action.run(reload, (result) => {
      if (result) setDraft((current) => ({ ...current, revision: result.revision }));
      action.setMessage('已载入最新版本，输入已保留。');
    });
  const connected = Boolean(settings.base_url && settings.model);
  return (
    <>
      <form className={`${s.form} ${s.settingsCard}`} onSubmit={save} aria-labelledby="model-settings-title">
        <div className={s.sectionHeading}>
          <h2 id="model-settings-title">模型连接</h2>
          <span className={s.status} data-tone={connected ? 'success' : 'accent'}>
            <i aria-hidden="true" />
            {connected ? (settings.has_api_key ? '已配置' : '已配置 · 无密钥') : '未配置'}
          </span>
        </div>
        <p className={s.muted}>兼容 Chat Completions 接口。保存与测试连接分开进行。</p>
        <label>
          模型服务地址
          <input
            type="url"
            maxLength={2000}
            value={draft.base_url}
            onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
            placeholder="https://example.com/v1"
            autoComplete="off"
          />
        </label>
        <label>
          模型名称
          <input
            value={draft.model}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            autoComplete="off"
          />
        </label>
        <label>
          快速步骤模型（可选）
          <input
            value={fastModel}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, fast_model: e.target.value })}
            placeholder="留空沿用上面的模型"
            autoComplete="off"
          />
        </label>
        <p className={s.muted}>
          用于抽取通知要素和撰写邮件，须与上面的模型在同一服务地址；计划、研究与评阅仍用主模型。
        </p>
        <label>
          API 密钥
          <input
            type="password"
            value={apiKey}
            maxLength={10000}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.has_api_key ? '已保存；留空保留' : '输入密钥'}
            autoComplete="new-password"
          />
        </label>
        <p className={s.muted}>密钥不会显示在页面，也不会保存在浏览器草稿中。</p>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={draft.tools}
            onChange={(e) => setDraft({ ...draft, tools: e.target.checked })}
          />
          允许向模型提供检索到的资料片段
        </label>
        <p className={s.muted}>关闭后，不提供资料片段或历史生成内容；本次输入和已保存偏好仍会发送。</p>
        <details className={s.reviewerSettings} open={Boolean(settings.review_model) || undefined}>
          <summary>
            独立评阅模型（深入研究）
            <span className={s.muted}>
              {settings.review_model ? ' · 当前：' + settings.review_model : ' · 未设置，由主模型自评'}
            </span>
          </summary>
          <p className={s.muted}>
            求解与评阅用不同模型，可减少同一模型重复自己的错误。两项都留空则沿用主模型；与主模型同一服务地址时可不填密钥。
          </p>
          <div className={s.formGrid}>
            <label>
              评阅模型地址
              <input
                type="url"
                maxLength={2000}
                value={reviewBase}
                onChange={(e) => setDraft({ ...draft, review_base_url: e.target.value })}
                placeholder="留空沿用主模型"
                autoComplete="off"
              />
            </label>
            <label>
              评阅模型名称
              <input
                value={reviewModel}
                maxLength={300}
                onChange={(e) => setDraft({ ...draft, review_model: e.target.value })}
                placeholder="例如另一家厂商的模型"
                autoComplete="off"
              />
            </label>
          </div>
          <label>
            评阅密钥
            <input
              type="password"
              value={reviewKey}
              maxLength={10000}
              onChange={(e) => setReviewKey(e.target.value)}
              placeholder={settings.has_review_api_key ? '已保存；留空保留' : '更换地址时需重新填写'}
              autoComplete="new-password"
            />
          </label>
        </details>
        <div className={s.toolbar}>
          <button className={s.primary} disabled={action.busy}>
            保存配置
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => api.write<{ ok: boolean; message: string }>('/settings/model/test'),
                (result) => action.setMessage(result.message || '连接成功。'),
              )
            }
          >
            测试已保存的连接
          </button>
        </div>
        <ErrorNotice error={action.error} onReload={reloadVersion} />
        {action.message && (
          <p className={s.notice} role="status">
            {action.message}
          </p>
        )}
      </form>
      <MailSettingsPanel />
      <PushPanel />
    </>
  );
}
