import type { PgBoss } from 'pg-boss';
import type { Tx, Row } from '../../../storage/src/index.js';
import { digest, event, id, notify } from '../common.js';
import { createRun } from '../sessions.js';
import { createErrand } from '../errands/service.js';
import { putSource } from '../knowledge.js';
import { matchesBySubject, normalizeAddress, replyContext, subjectKey } from './thread.js';

export type ParsedMail = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  sentAt: Date | null;
  body: string;
  origin: 'plain' | 'html' | 'composed';
  bulk: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  rawDigest: string;
};
export type IngestOptions = {
  account: string;
  folder: string;
  uidValidity: string;
  uid: number;
  role: 'inbox' | 'sent' | 'local';
  /** Whether a new incoming message may create a draft or flow session. */
  draft: boolean;
  autoDraft: 'none' | 'direct' | 'all';
  dailyLimit: number;
  /** Stable identity used for the personal-database source id (kept compatible with earlier imports). */
  sourceIdentity: string;
};

async function findThread(tx: Tx, account: string, mail: ParsedMail, participants: string[]) {
  const parents = [mail.inReplyTo, ...mail.references].filter((value): value is string => Boolean(value));
  if (parents.length) {
    const parent = await tx.one(
      `SELECT thread_id FROM app.mail_messages WHERE account=$1 AND message_id=ANY($2::text[])
       ORDER BY coalesce(sent_at,created_at) DESC, id DESC LIMIT 1`,
      [account, parents],
    );
    if (parent) return parent.thread_id as string;
  }
  const key = subjectKey(mail.subject);
  if (!key) return null;
  const candidates = await tx.rows(
    'SELECT * FROM app.mail_threads WHERE account=$1 AND subject_key=$2 ORDER BY last_message_at DESC, id LIMIT 20',
    [account, key],
  );
  const match = candidates.find((thread) =>
    matchesBySubject(
      { id: thread.id, participants: thread.participants, lastMessageAt: new Date(thread.last_message_at) },
      participants,
      mail.sentAt,
    ),
  );
  return match?.id ?? null;
}

/** A parent that arrives after its replies (history backfill) joins their threads into its own. */
async function mergeOrphans(tx: Tx, account: string, threadId: string, messageId: string | null) {
  if (!messageId) return;
  const orphans = await tx.rows(
    `SELECT DISTINCT thread_id FROM app.mail_messages WHERE account=$1 AND thread_id<>$2
     AND (in_reply_to=$3 OR $3=ANY(references_ids))`,
    [account, threadId, messageId],
  );
  for (const orphan of orphans) {
    await tx.exec('UPDATE app.mail_messages SET thread_id=$2 WHERE thread_id=$1', [orphan.thread_id, threadId]);
    const old = await tx.one('SELECT * FROM app.mail_threads WHERE id=$1', [orphan.thread_id]);
    await tx.exec(
      `UPDATE app.sessions SET mail=jsonb_set(mail,'{threadId}',to_jsonb($2::text)) WHERE mail->>'threadId'=$1`,
      [orphan.thread_id, threadId],
    );
    await tx.exec(
      `UPDATE app.mail_threads SET participants=ARRAY(SELECT DISTINCT unnest(participants || $2::text[])),
       last_message_at=greatest(last_message_at,$3), session_id=coalesce(session_id,$4), revision=revision+1, updated_at=now()
       WHERE id=$1`,
      [threadId, old?.participants || [], old?.last_message_at || new Date(0), old?.session_id || null],
    );
    await tx.exec('DELETE FROM app.mail_threads WHERE id=$1', [orphan.thread_id]);
    await event(tx, 'mail.thread_merged', threadId, { merged: orphan.thread_id });
  }
}

/** Flows whose mail trigger matches the subject create a notice-handling session instead of a reply. */
async function matchingFlow(tx: Tx, subject: string) {
  const flows = await tx.rows("SELECT * FROM app.flows WHERE enabled AND definition->'trigger' ? 'mail' ORDER BY id");
  const folded = subject.normalize('NFKC').toLowerCase();
  return flows.find((flow) =>
    ((flow.definition?.trigger?.mail?.subject_any as string[]) || []).some((word) =>
      folded.includes(word.normalize('NFKC').toLowerCase()),
    ),
  );
}

async function underDailyLimit(tx: Tx, limit: number) {
  const key = 'mail-drafts:' + new Date().toISOString().slice(0, 10);
  await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  const used = Number((await tx.one('SELECT value FROM app.settings WHERE key=$1', [key]))?.value || 0);
  if (used >= limit) return false;
  await tx.exec(
    'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, JSON.stringify(used + 1)],
  );
  return true;
}

/**
 * Stores one message, keeps its thread current and indexes it in the personal database.
 * Returns whether this was a new incoming message. Callers hold the per-message advisory lock.
 */
export async function ingestMessage(tx: Tx, boss: PgBoss, mail: ParsedMail, options: IngestOptions) {
  const account = normalizeAddress(options.account);
  const direction: 'in' | 'out' =
    options.role === 'sent' || options.role === 'local' || normalizeAddress(mail.from) === account ? 'out' : 'in';
  if (mail.messageId) {
    const existing = await tx.one('SELECT id FROM app.mail_messages WHERE account=$1 AND message_id=$2', [
      account,
      mail.messageId,
    ]);
    if (existing)
      return { created: false, messageRowId: existing.id as string | null, threadId: null as string | null };
  }
  const participants = [
    ...new Set([mail.from, ...mail.to, ...mail.cc].map(normalizeAddress).filter((p) => p && p !== account)),
  ];
  const at = mail.sentAt || new Date();
  let threadId = await findThread(tx, account, mail, participants);
  if (!threadId) {
    threadId = id();
    await tx.exec(
      `INSERT INTO app.mail_threads(id,account,subject,subject_key,participants,last_message_at,triage)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        threadId,
        account,
        mail.subject,
        subjectKey(mail.subject),
        participants,
        at,
        mail.bulk && direction === 'in' ? 'bulk' : direction === 'out' ? 'replied' : 'new',
      ],
    );
  } else {
    await tx.exec(
      `UPDATE app.mail_threads SET participants=ARRAY(SELECT DISTINCT unnest(participants || $2::text[])),
       last_message_at=greatest(last_message_at,$3),
       triage=CASE WHEN $4 AND triage IN ('drafting','new') THEN 'replied'
                   WHEN NOT $4 AND NOT $5 AND triage IN ('replied','ignored','bulk') THEN 'new' ELSE triage END,
       revision=revision+1, updated_at=now() WHERE id=$1`,
      [threadId, participants, at, direction === 'out', mail.bulk],
    );
  }
  const rowId = id();
  const sourceId = 'mail-source-' + digest(options.sourceIdentity).slice(0, 24);
  await putSource(tx, {
    id: sourceId,
    title: (direction === 'out' ? '已发邮件 · ' : '邮件 · ') + mail.subject,
    content: [
      `发件人：${mail.from}`,
      `收件人：${mail.to.join(', ')}`,
      mail.sentAt ? `时间：${mail.sentAt.toISOString()}` : '',
      `主题：${mail.subject}`,
      '',
      mail.body,
    ]
      .filter((line, index) => line || index > 3)
      .join('\n'),
  });
  const inserted = await tx.exec(
    `INSERT INTO app.mail_messages(id,account,folder,uidvalidity,uid,message_id,in_reply_to,references_ids,thread_id,direction,
      from_addr,to_addrs,cc_addrs,reply_to,subject,sent_at,body_text,body_origin,raw_digest,bulk,attachments,source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT DO NOTHING`,
    [
      rowId,
      account,
      options.folder,
      options.uidValidity,
      options.uid,
      mail.messageId,
      mail.inReplyTo,
      mail.references,
      threadId,
      direction,
      normalizeAddress(mail.from),
      mail.to.map(normalizeAddress),
      mail.cc.map(normalizeAddress),
      mail.replyTo ? normalizeAddress(mail.replyTo) : null,
      mail.subject,
      mail.sentAt,
      mail.body,
      mail.origin,
      mail.rawDigest,
      mail.bulk,
      JSON.stringify(mail.attachments),
      sourceId,
    ],
  );
  // The same UID read again after an interrupted poll: already stored, nothing new to do.
  if (!inserted.rowCount) return { created: false, messageRowId: null as string | null, threadId };
  await mergeOrphans(tx, account, threadId, mail.messageId);
  await event(tx, 'mail.received', threadId, { direction });
  if (direction === 'out' || !options.draft) return { created: direction === 'in', messageRowId: rowId, threadId };

  const thread = await tx.one('SELECT * FROM app.mail_threads WHERE id=$1 FOR UPDATE', [threadId]);
  const flow = await matchingFlow(tx, mail.subject);
  if (flow) {
    const created = await createErrand(tx, boss, {
      title: mail.subject,
      text: mail.body,
      origin: { kind: 'mail', messageId: rowId, threadId, from: mail.from },
      flow: { id: flow.id, version: flow.version },
    });
    await tx.exec("UPDATE app.mail_threads SET triage='errand',session_id=$2,updated_at=now() WHERE id=$1", [
      threadId,
      created.sessionId,
    ]);
    await notify(
      tx,
      'mail-errand:' + rowId,
      created.sessionId,
      '通知已交给流程处理',
      `「${flow.definition.title}」：${mail.subject}`,
    );
    return { created: true, messageRowId: rowId, threadId };
  }
  const allowed = options.autoDraft === 'all' || (options.autoDraft === 'direct' && !mail.bulk);
  if (!allowed) return { created: true, messageRowId: rowId, threadId };
  const open = thread?.session_id
    ? await tx.one(
        `SELECT * FROM app.sessions s WHERE s.id=$1 AND s.flow='mail-reply' AND s.state IN ('queued','running','waiting_feedback','ready')
         AND NOT EXISTS (SELECT 1 FROM app.approvals a WHERE a.session_id=s.id AND a.state IN ('sent','resolved_sent'))`,
        [thread.session_id],
      )
    : null;
  if (open) {
    // A newer message in the thread: redraft unless a draft is being generated or sent right now.
    const busy =
      ['queued', 'running'].includes(open.state) ||
      (await tx.one(
        "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('pending','approved','executing','uncertain')",
        [open.id],
      ));
    if (!busy) {
      await tx.exec('UPDATE app.sessions SET mail=$2,recipient=$3,revision=revision+1,updated_at=now() WHERE id=$1', [
        open.id,
        JSON.stringify({ ...open.mail, ...replyContext(threadId, mail, mail.messageId), cc: open.mail?.cc || [] }),
        mail.replyTo || mail.from,
      ]);
      await createRun(tx, boss, open.id, { type: 'mail', messageId: rowId });
    }
    return { created: true, messageRowId: rowId, threadId };
  }
  if (!(await underDailyLimit(tx, options.dailyLimit))) {
    await notify(
      tx,
      'mail-limit:' + new Date().toISOString().slice(0, 10),
      null,
      '今日自动起草已达上限',
      '新邮件已收取，可在邮件页手动起草回复。',
    );
    return { created: true, messageRowId: rowId, threadId };
  }
  const created = await createReplySession(tx, boss, thread!, mail, rowId);
  await notify(
    tx,
    'mail-new:' + rowId,
    created.sessionId,
    '新邮件：' + mail.subject.slice(0, 60),
    '已开始准备回复草稿。',
  );
  return { created: true, messageRowId: rowId, threadId };
}

export async function createReplySession(tx: Tx, boss: PgBoss, thread: Row, mail: ParsedMail, messageRowId: string) {
  const sessionId = id();
  await tx.exec(
    `INSERT INTO app.sessions(id,title,kind,prompt,recipient,flow,mail) VALUES($1,$2,'work',$3,$4,'mail-reply',$5)`,
    [
      sessionId,
      mail.subject,
      mail.body,
      normalizeAddress(mail.replyTo || mail.from),
      JSON.stringify(replyContext(thread.id, mail, mail.messageId)),
    ],
  );
  const runId = await createRun(tx, boss, sessionId, { type: 'mail', messageId: messageRowId });
  await tx.exec(
    "UPDATE app.mail_threads SET triage='drafting',session_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",
    [thread.id, sessionId],
  );
  return { sessionId, runId };
}
