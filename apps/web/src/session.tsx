import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Feedback,
  DraftInput,
  type Attempt,
  type LearningSession,
  type SessionDetail,
} from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, QueryState, Result, Sources, Status } from './ui';
import { MemoryEditor } from './memory-editor';
import { ErrandPanel } from './errand';
import { ResearchBanner, ResearchProgress } from './research';
import s from './styles.module.css';
import { Icon } from './icons';

export const attemptSource: Record<Attempt['source'], string> = {
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
