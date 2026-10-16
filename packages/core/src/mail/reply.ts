import type { Store } from '../../../storage/src/index.js';
import { ModelMailDraft, SessionMail } from '../../../contracts/src/mail.js';
import { AppError, event, id, notify } from '../common.js';
import { retrieve } from '../knowledge.js';
import { ModelGateway } from '../model.js';
import { fence, step, type RunIdentity } from '../runtime-state.js';
import { FLOW_CALL_TIMEOUT_MS } from '../sessions.js';
import { replySubject, subjectKey, withoutQuotedHistory } from './thread.js';

const INSTRUCTION =
  'MAIL_REPLY\n为本人起草这封邮件的回复。按往来记录理解上下文，只回答对方实际提出的问题；用给定的个人资料核对事实，资料里没有的信息不要编造。' +
  '如果缺少回复所必需的信息（例如时间、名单、本人意愿），在 questions 中向本人提问，正文可以用“【请补充：…】”标出待填处。' +
  '语气与对方来信一致，落款使用资料中的本人姓名；sourceIds 只列出实际用到的资料。不要声称已经发送、已经提交或替本人做了决定。';
const RULE_SCOPES = ['all', 'preference', 'fact', 'correction', 'work', 'mail'];

export async function executeMailReplyRun(store: Store, folder: string, identity: RunIdentity) {
  const model = new ModelGateway(store, folder, identity);
  const ctx = await store.transaction(async (tx) => {
    const { session, run } = await fence(tx, identity);
    const mail = SessionMail.safeParse(session.mail);
    if (!mail.success) throw new AppError('回复任务缺少邮件线程信息。', 409, 'mail_context_missing');
    const thread = await tx.one('SELECT * FROM app.mail_threads WHERE id=$1', [mail.data.threadId]);
    if (!thread) throw new AppError('邮件线程已不存在。', 409, 'mail_thread_missing');
    const messages = (
      await tx.rows(
        'SELECT * FROM app.mail_messages WHERE thread_id=$1 ORDER BY coalesce(sent_at,created_at) DESC, id DESC LIMIT 6',
        [thread.id],
      )
    ).reverse();
    const attempt = run.input.attemptId
      ? await tx.one('SELECT * FROM app.attempts WHERE id=$1 AND session_id=$2', [run.input.attemptId, session.id])
      : null;
    const latest = [...messages].reverse().find((m) => m.direction === 'in');
    const ownSources = new Set(messages.map((m) => m.source_id).filter(Boolean));
    const citations = (
      await retrieve(
        tx,
        [thread.subject, latest ? withoutQuotedHistory(latest.body_text).slice(0, 600) : ''].join(' '),
        [],
        8,
        undefined,
        'mail',
      )
    ).filter((c) => !ownSources.has(c.sourceId));
    const memories = await tx.rows(
      'SELECT * FROM app.memories WHERE enabled AND scope = ANY($1::text[]) ORDER BY key',
      [RULE_SCOPES],
    );
    return { session, run, mail: mail.data, thread, messages, attempt, citations, memories };
  });
  // Quoted history is removed and each message bounded, so a long thread cannot crowd out the rules.
  const history = ctx.messages
    .map((m) =>
      [
        `[${m.direction === 'in' ? '来信' : '本人已发'} · ${m.sent_at ? new Date(m.sent_at).toISOString().slice(0, 16).replace('T', ' ') : '时间未知'} · ${m.from_addr} → ${m.to_addrs.join(', ')}]`,
        `主题：${m.subject}`,
        withoutQuotedHistory(m.body_text).slice(0, 1800),
      ].join('\n'),
    )
    .join('\n\n')
    .slice(-9000);
  const confirmed = ctx.memories.filter((m) => m.confirmed);
  let draft: ModelMailDraft;
  const generated = await model.configured();
  let provided = new Set<string>(),
    providedCitations = ctx.citations;
  if (generated) {
    const context = {
      task: '回复邮件：' + ctx.thread.subject + '（收件人由本人确认：' + ctx.session.recipient + '）',
      latest:
        '往来记录（旧→新）：\n' + history + (ctx.attempt ? '\n\n本人补充或修改要求：\n' + ctx.attempt.answer : ''),
      previous: ctx.session.content,
      rules: confirmed.map((m) => m.key + ': ' + m.content),
      ruleRecords: confirmed.map((m) => ({
        key: m.key,
        version: m.version,
        commitSha: m.commit_sha ?? null,
        content: m.content,
      })),
      notes: ctx.memories.filter((m) => !m.confirmed).map((m) => m.key + ': ' + m.content),
      sources: ctx.citations,
    };
    const written = await step(
      store,
      identity,
      'draft',
      {
        input: [
          INSTRUCTION,
          context.task,
          context.latest,
          context.previous,
          context.rules,
          context.notes,
          ctx.citations.map((c) => [c.sourceId, c.version, c.start, c.end]),
        ],
      },
      async () => {
        const call = await model.call(ModelMailDraft, INSTRUCTION, context, {
          timeoutMs: FLOW_CALL_TIMEOUT_MS,
          reserveMs: 5000,
          profile: 'draft',
        });
        return { draft: call.value, provided: call.providedCitations };
      },
    );
    draft = written.draft;
    provided = new Set(written.provided.map((c) => c.sourceId));
    providedCitations = written.provided;
  } else {
    draft = {
      subject: ctx.thread.subject,
      body:
        '（尚未连接模型，请在此填写回复。）\n\n' +
        ctx.citations
          .slice(0, 2)
          .map((c) => `参考：${c.title}\n${c.quote.slice(0, 300)}`)
          .join('\n\n'),
      sourceIds: [],
      questions: [],
    };
  }
  // The thread subject is kept; a model cannot silently start a different conversation.
  const subject = replySubject(
    subjectKey(draft.subject) === subjectKey(ctx.thread.subject) ? draft.subject : ctx.thread.subject,
  );
  const citations = providedCitations.filter((c) => draft.sourceIds.includes(c.sourceId) && provided.has(c.sourceId));
  await store.transaction(async (tx) => {
    const { session, run } = await fence(tx, identity);
    const mail = { ...ctx.mail, questions: draft.questions };
    await tx.exec(
      "INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,citations,dedupe_key) VALUES($1,$2,$3,'mail_draft',$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING",
      [
        id(),
        session.id,
        run.id,
        draft.body,
        generated ? 'model_generated' : 'local_guidance',
        JSON.stringify(citations),
        'mail-draft:' + run.id,
      ],
    );
    await tx.exec(
      "UPDATE app.sessions SET title=$2,content=$3,citations=$4,mail=$5,state=$6,error='',revision=revision+1,updated_at=now() WHERE id=$1",
      [
        session.id,
        subject,
        draft.body,
        JSON.stringify(citations),
        JSON.stringify(mail),
        draft.questions.length ? 'waiting_feedback' : 'ready',
      ],
    );
    await tx.exec(
      "UPDATE app.approvals SET state='invalidated',error='草稿已重新生成，请重新核对。',finished_at=now() WHERE session_id=$1 AND state='pending'",
      [session.id],
    );
    if (run.input.attemptId)
      await tx.exec(
        "UPDATE app.attempts SET verdict='unclear',feedback='已作为邮件修改要求处理，不是学习评估。',source='ungraded' WHERE id=$1 AND session_id=$2",
        [run.input.attemptId, session.id],
      );
    await tx.exec(
      "UPDATE app.mail_threads SET triage='drafting',session_id=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND triage<>'replied'",
      [ctx.thread.id, session.id],
    );
    await tx.exec("UPDATE app.runs SET state='succeeded',finished_at=now(),error='' WHERE id=$1", [run.id]);
    await notify(
      tx,
      'mail-draft:' + run.id,
      session.id,
      draft.questions.length ? '回复前需要你补充信息' : '回复草稿已准备好',
      draft.questions.length ? draft.questions[0]!.slice(0, 120) : subject,
    );
    await event(tx, 'run.finished', session.id, { runId: run.id });
  });
}
