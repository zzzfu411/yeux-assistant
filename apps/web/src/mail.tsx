import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MailThreadDetail, MailThreadSummary } from '../../../packages/contracts/src/mail';
import type { TodayOverview } from '../../../packages/contracts/src/pagination';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, navigate, Pages, QueryState, Status } from './ui';
import { Icon } from './icons';
import s from './styles.module.css';

const filters = [
  ['all', '全部'],
  ['new', '待处理'],
  ['drafting', '草稿中'],
  ['replied', '已回复'],
  ['errand', '办事'],
  ['bulk', '群发'],
  ['ignored', '已忽略'],
] as const;
export const triageNames: Record<string, string> = {
  new: '待处理',
  drafting: '草稿中',
  replied: '已回复',
  errand: '办事中',
  bulk: '群发',
  ignored: '已忽略',
};
const triageTone: Record<string, string> = {
  new: 'accent',
  drafting: 'info',
  replied: 'success',
  errand: 'info',
  bulk: 'neutral',
  ignored: 'neutral',
};
export function Triage({ value }: { value: string }) {
  return (
    <span className={s.status} data-tone={triageTone[value] || 'neutral'}>
      <i aria-hidden="true" />
      {triageNames[value] || value}
    </span>
  );
}

export function MailPage() {
  const [filter, setFilter] = useState<string>(
    new URLSearchParams(window.location.hash.split('?')[1] || '').get('filter') || 'all',
  );
  const [page, setPage] = useState(0);
  const query = useData<{ items: MailThreadSummary[]; total: number; counts: Record<string, number> }>(
    '/mail/threads?filter=' + filter + '&page=' + page,
    { refetchInterval: 20_000 },
  );
  const today = useData<TodayOverview>('/today/overview');
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const mode = today.data?.mailMode;
  return (
    <>
      <Heading
        title="邮件"
        eyebrow="往来信件 · 回复草稿 · 通知办理"
        action={
          <button
            type="button"
            className={s.secondary}
            disabled={action.busy || mode === 'off'}
            onClick={() =>
              void action.run(
                () => api.write('/mail/poll', {}),
                () => {
                  action.setMessage('已请求收取，新邮件会在几秒内出现。');
                  setTimeout(() => void client.invalidateQueries(), 3000);
                },
              )
            }
          >
            <Icon name="mail" />
            收取新邮件
          </button>
        }
      >
        每封来信按往来线程整理，并存入个人资料库。回复草稿需要你核对收件人和正文后才会发送；同一封邮件不会被重复处理。
      </Heading>
      {mode === 'off' && (
        <div className={s.notice}>
          <p>
            邮箱尚未启用。<a href="#/settings#mail">在设置中启用模拟邮箱或连接 smail</a>
          </p>
        </div>
      )}
      {mode === 'simulation' && <SimulatedLetter />}
      <ErrorNotice error={action.error} />
      {action.message && (
        <p className={s.muted} role="status">
          {action.message}
        </p>
      )}
      <div className={s.filterTabs} role="tablist" aria-label="邮件分类">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? s.selectedTab : s.tab}
            onClick={() => {
              setFilter(value);
              setPage(0);
            }}
          >
            {label}
            {value !== 'all' && query.data?.counts[value] ? <small>{query.data.counts[value]}</small> : null}
          </button>
        ))}
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data &&
        (query.data.items.length ? (
          <div className={s.letterList}>
            {query.data.items.map((thread) => (
              <a className={s.letterRow} key={thread.id} href={'#/mail/' + encodeURIComponent(thread.id)}>
                <span className={s.letterMark} data-triage={thread.triage} aria-hidden="true">
                  <Icon name="mail" />
                </span>
                <span className={s.letterMain}>
                  <strong>{thread.subject}</strong>
                  <small>
                    {thread.latestFrom} · {thread.messageCount} 封 · {date(thread.lastMessageAt)}
                  </small>
                  <span>{thread.preview}</span>
                </span>
                <Triage value={thread.triage} />
              </a>
            ))}
          </div>
        ) : (
          <p className={s.empty}>
            {filter === 'all' ? '还没有邮件。启用邮箱后，新来信会出现在这里。' : '这个分类下没有邮件。'}
          </p>
        ))}
      {query.data && <Pages page={page} total={query.data.total} onChange={setPage} />}
    </>
  );
}

/** Simulation only: deliver a synthetic letter to exercise sync, threading, drafting and sending. */
function SimulatedLetter({ threadId }: { threadId?: string }) {
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft, clear] = useDraft('mail-simulate.' + (threadId || 'new'), {
    from: 'teacher@nju.edu.cn',
    name: '课程助教',
    subject: '',
    body: '',
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(
      () =>
        api.write('/mail/simulate', {
          ...draft,
          ...(threadId ? { replyToThread: threadId, subject: draft.subject || '回复' } : {}),
        }),
      () => {
        clear();
        setDraft({ from: draft.from, name: draft.name, subject: '', body: '' });
        action.setMessage('来信已放入模拟收件箱，正在收取。');
        setTimeout(() => void client.invalidateQueries(), 2500);
      },
    );
  };
  return (
    <details className={s.simulator} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="plus" />
        {threadId ? '模拟对方在这个线程里回信' : '模拟一封来信'}
        <span className={s.muted}> · 只写入本机模拟邮箱，不会发出</span>
      </summary>
      <form className={s.form} onSubmit={submit}>
        <div className={s.formGrid}>
          <label>
            发件人邮箱
            <input
              type="email"
              required
              value={draft.from}
              maxLength={320}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label>
            发件人名称
            <input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
        </div>
        {!threadId && (
          <label>
            主题
            <input
              required
              value={draft.subject}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="例如：关于周五组会报告的安排"
            />
          </label>
        )}
        <label>
          正文
          <textarea
            required
            rows={5}
            value={draft.body}
            maxLength={20000}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder="写下对方的来信内容；可以包含问题、截止时间或需要提交的材料。"
          />
        </label>
        <ErrorNotice error={action.error} />
        {action.message && (
          <p className={s.muted} role="status">
            {action.message}
          </p>
        )}
        <button
          className={s.primary}
          disabled={action.busy || !draft.body.trim() || (!threadId && !draft.subject.trim())}
        >
          放入模拟收件箱
        </button>
      </form>
    </details>
  );
}

export function MailThreadPage({ id }: { id: string }) {
  const query = useData<MailThreadDetail>('/mail/threads/' + encodeURIComponent(id), { refetchInterval: 15_000 });
  const today = useData<TodayOverview>('/today/overview');
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const thread = query.data?.thread;
  const act = (path: string, body: Record<string, unknown>, done?: (result: any) => void) =>
    void action.run(
      () => api.write<any>('/mail/threads/' + encodeURIComponent(id) + path, body),
      (result) => {
        void client.invalidateQueries();
        done?.(result);
      },
    );
  return (
    <>
      <a className={s.back} href="#/mail">
        ‹ 全部邮件
      </a>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && thread && (
        <>
          <Heading title={thread.subject} eyebrow={'往来线程 · ' + thread.messageCount + ' 封'}>
            <Triage value={thread.triage} />
            <span className={s.headingMeta}>{thread.participants.join('、')}</span>
          </Heading>
          <div className={s.toolbar}>
            <button
              className={s.primary}
              disabled={action.busy}
              onClick={() =>
                act('/draft', { revision: thread.revision }, (result) => navigate('/session/' + result.sessionId))
              }
            >
              <Icon name="mail" />
              {thread.sessionId && thread.triage === 'drafting' ? '打开回复草稿' : '起草回复'}
            </button>
            <button
              className={s.secondary}
              disabled={action.busy}
              onClick={() =>
                act('/errand', { revision: thread.revision }, (result) => navigate('/session/' + result.sessionId))
              }
            >
              <Icon name="checklist" />
              作为通知办理
            </button>
            <button
              className={s.textButton}
              disabled={action.busy}
              onClick={() =>
                act('/triage', { revision: thread.revision, triage: thread.triage === 'ignored' ? 'new' : 'ignored' })
              }
            >
              {thread.triage === 'ignored' ? '恢复为待处理' : '无需处理'}
            </button>
          </div>
          <ErrorNotice error={action.error} />
          <ol className={s.letters}>
            {query.data.messages.map((message) => (
              <li key={message.id} className={s.letter} data-direction={message.direction}>
                <header>
                  <strong>{message.direction === 'out' ? '我' : message.from}</strong>
                  <span>
                    {message.direction === 'out' ? '发给 ' + message.to.join('、') : '收件 ' + message.to.join('、')}
                    {message.cc.length ? ' · 抄送 ' + message.cc.join('、') : ''}
                  </span>
                  <time>{message.sentAt ? date(message.sentAt) : '时间未知'}</time>
                </header>
                <p className={s.prewrap}>{message.body}</p>
                <footer>
                  {message.bodyOrigin === 'html' && <span>由 HTML 邮件转换为文本</span>}
                  {message.bulk && <span>群发邮件</span>}
                  {message.attachments.map((file) => (
                    <span key={file.filename}>
                      附件：{file.filename}（{Math.ceil(file.size / 1024)} KB）
                    </span>
                  ))}
                  {message.sourceId && <a href={'#/source/' + encodeURIComponent(message.sourceId)}>已存入资料库</a>}
                </footer>
              </li>
            ))}
          </ol>
          {query.data.sessions.length > 0 && (
            <section className={s.section}>
              <h2>相关任务</h2>
              <div className={s.rows}>
                {query.data.sessions.map((session) => (
                  <a className={s.row} key={session.id} href={'#/session/' + encodeURIComponent(session.id)}>
                    <div>
                      <strong>{session.title}</strong>
                      <p>
                        {session.flow === 'errand' ? '通知办理' : '回复草稿'} · {date(session.createdAt)}
                      </p>
                    </div>
                    <Status state={session.state} />
                  </a>
                ))}
              </div>
            </section>
          )}
          {today.data?.mailMode === 'simulation' && <SimulatedLetter threadId={id} />}
        </>
      )}
    </>
  );
}
