import type { PgBoss } from 'pg-boss';
import type { Store, Tx, Row } from '../../../storage/src/index.js';
import {
  MailSimulateInput,
  MailThreadAction,
  MailTriageInput,
  type MailMessageView,
  type MailThreadDetail,
  type MailThreadSummary,
} from '../../../contracts/src/mail.js';
import { AppError, checkVersion, event, id, iso, once, requireRow } from '../common.js';
import { config, mailMode } from '../config.js';
import { createErrand } from '../errands/service.js';
import { compose, SimulatedMailbox } from './mailbox.js';
import { createReplySession } from './ingest.js';
import { withoutQuotedHistory } from './thread.js';

const FILTERS: Record<string, string> = {
  all: "t.triage<>'ignored'",
  new: "t.triage='new'",
  drafting: "t.triage='drafting'",
  replied: "t.triage='replied'",
  errand: "t.triage='errand'",
  bulk: "t.triage='bulk'",
  ignored: "t.triage='ignored'",
};

function summary(row: Row): MailThreadSummary {
  return {
    id: row.id,
    subject: row.subject,
    participants: row.participants,
    lastMessageAt: iso(row.last_message_at),
    triage: row.triage,
    messageCount: Number(row.message_count || 0),
    latestFrom: row.latest_from || '',
    preview: withoutQuotedHistory(row.latest_body || '')
      .replace(/\s+/g, ' ')
      .slice(0, 160),
    sessionId: row.session_id,
    sessionState: row.session_state || null,
    revision: row.revision,
  };
}
const threadColumns = `t.*,
  (SELECT count(*) FROM app.mail_messages m WHERE m.thread_id=t.id) AS message_count,
  (SELECT m.from_addr FROM app.mail_messages m WHERE m.thread_id=t.id ORDER BY coalesce(m.sent_at,m.created_at) DESC,m.id DESC LIMIT 1) AS latest_from,
  (SELECT m.body_text FROM app.mail_messages m WHERE m.thread_id=t.id ORDER BY coalesce(m.sent_at,m.created_at) DESC,m.id DESC LIMIT 1) AS latest_body,
  (SELECT s.state FROM app.sessions s WHERE s.id=t.session_id) AS session_state`;

/** Reading and organising correspondence; sending stays in MailActions behind exact approval. */
export class MailInbox {
  constructor(
    readonly store: Store,
    readonly boss: PgBoss,
    readonly folder: string,
  ) {}
  private command<T>(key: string, operation: string, input: unknown, work: (tx: Tx) => Promise<T>) {
    return this.store.transaction((tx) => once(tx, key, operation, input, () => work(tx)));
  }
  async threads(filter = 'all', page = 0) {
    const where = FILTERS[filter] || FILTERS.all;
    return this.store.snapshot(async (tx) => {
      const rows = await tx.rows(
        `SELECT ${threadColumns} FROM app.mail_threads t WHERE ${where} ORDER BY t.last_message_at DESC,t.id LIMIT 30 OFFSET $1`,
        [Math.max(0, page) * 30],
      );
      const counts = Object.fromEntries(
        (await tx.rows('SELECT triage,count(*) n FROM app.mail_threads GROUP BY triage')).map((row) => [
          row.triage,
          Number(row.n),
        ]),
      );
      const total = Number((await tx.one(`SELECT count(*) n FROM app.mail_threads t WHERE ${where}`))!.n);
      return { items: rows.map(summary), total, counts };
    });
  }
  async thread(threadId: string): Promise<MailThreadDetail> {
    return this.store.snapshot(async (tx) => {
      const row = await requireRow(tx, `SELECT ${threadColumns} FROM app.mail_threads t WHERE t.id=$1`, [threadId]);
      const messages = await tx.rows(
        'SELECT * FROM app.mail_messages WHERE thread_id=$1 ORDER BY coalesce(sent_at,created_at),id',
        [threadId],
      );
      const sessions = await tx.rows(
        `SELECT id,title,state,flow,created_at FROM app.sessions
         WHERE id=$2 OR (mail->>'threadId')=$1 OR id IN (SELECT session_id FROM app.errands WHERE notice->'origin'->>'threadId'=$1)
         ORDER BY created_at DESC LIMIT 20`,
        [threadId, row.session_id],
      );
      return {
        thread: summary(row),
        messages: messages.map((m): MailMessageView => ({
          id: m.id,
          direction: m.direction,
          from: m.from_addr,
          to: m.to_addrs,
          cc: m.cc_addrs,
          subject: m.subject,
          sentAt: m.sent_at ? iso(m.sent_at) : null,
          body: m.body_text,
          bodyOrigin: m.body_origin,
          bulk: m.bulk,
          attachments: m.attachments || [],
          sourceId: m.source_id,
        })),
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          state: s.state,
          flow: s.flow,
          createdAt: iso(s.created_at),
        })),
      };
    });
  }
  private async latestIncoming(tx: Tx, threadId: string) {
    const message = await tx.one(
      "SELECT * FROM app.mail_messages WHERE thread_id=$1 AND direction='in' ORDER BY coalesce(sent_at,created_at) DESC,id DESC LIMIT 1",
      [threadId],
    );
    if (!message) throw new AppError('这个线程里没有收到的邮件可以回复。', 409, 'no_incoming');
    return message;
  }
  async draft(key: string, threadId: string, input: unknown) {
    const data = MailThreadAction.parse(input);
    return this.command(key, 'mail.draft:' + threadId, data, async (tx) => {
      const thread = await requireRow(tx, 'SELECT * FROM app.mail_threads WHERE id=$1 FOR UPDATE', [threadId]);
      checkVersion(thread, data.revision);
      const open = thread.session_id
        ? await tx.one(
            `SELECT id FROM app.sessions s WHERE s.id=$1 AND s.flow='mail-reply' AND s.state IN ('queued','running','waiting_feedback','ready')
             AND NOT EXISTS (SELECT 1 FROM app.approvals a WHERE a.session_id=s.id AND a.state IN ('sent','resolved_sent'))`,
            [thread.session_id],
          )
        : null;
      if (open) return { sessionId: open.id as string };
      const message = await this.latestIncoming(tx, threadId);
      const created = await createReplySession(
        tx,
        this.boss,
        thread,
        {
          messageId: message.message_id,
          inReplyTo: message.in_reply_to,
          references: message.references_ids,
          from: message.from_addr,
          to: message.to_addrs,
          cc: message.cc_addrs,
          replyTo: message.reply_to,
          subject: message.subject,
          sentAt: message.sent_at,
          body: message.body_text,
          origin: message.body_origin,
          bulk: message.bulk,
          attachments: [],
          rawDigest: message.raw_digest,
        },
        message.id,
      );
      return { sessionId: created.sessionId };
    });
  }
  async triage(key: string, threadId: string, input: unknown) {
    const data = MailTriageInput.parse(input);
    return this.command(key, 'mail.triage:' + threadId, data, async (tx) => {
      const thread = await requireRow(tx, 'SELECT * FROM app.mail_threads WHERE id=$1 FOR UPDATE', [threadId]);
      checkVersion(thread, data.revision);
      await tx.exec('UPDATE app.mail_threads SET triage=$2,revision=revision+1,updated_at=now() WHERE id=$1', [
        threadId,
        data.triage,
      ]);
      await event(tx, 'mail.triaged', threadId, { triage: data.triage });
      return { threadId, revision: thread.revision + 1 };
    });
  }
  async errand(key: string, threadId: string, input: unknown) {
    const data = MailThreadAction.parse(input);
    return this.command(key, 'mail.errand:' + threadId, data, async (tx) => {
      const thread = await requireRow(tx, 'SELECT * FROM app.mail_threads WHERE id=$1 FOR UPDATE', [threadId]);
      checkVersion(thread, data.revision);
      const message = await this.latestIncoming(tx, threadId);
      const created = await createErrand(tx, this.boss, {
        title: message.subject,
        text: message.body_text,
        origin: { kind: 'mail', messageId: message.id, threadId, from: message.reply_to || message.from_addr },
      });
      await tx.exec(
        "UPDATE app.mail_threads SET triage='errand',session_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",
        [threadId, created.sessionId],
      );
      return created;
    });
  }
  async pollNow() {
    await this.boss.send('mail-poll', { manual: true }, { singletonKey: 'manual', singletonSeconds: 5 });
    return { queued: true };
  }
  /** Simulation only: deliver a synthetic incoming message so the whole flow can be exercised. */
  async simulate(key: string, input: unknown) {
    const data = MailSimulateInput.parse(input);
    const settings = await config(this.folder);
    if (mailMode(settings) !== 'simulation')
      throw new AppError('只有模拟邮箱可以投递测试来信。', 409, 'not_simulation');
    return this.command(key, 'mail.simulate', data, async (tx) => {
      const parent = data.replyToThread
        ? await tx.one(
            'SELECT message_id,references_ids,subject FROM app.mail_messages WHERE thread_id=$1 AND message_id IS NOT NULL ORDER BY coalesce(sent_at,created_at) DESC,id DESC LIMIT 1',
            [data.replyToThread],
          )
        : null;
      const raw = await compose({
        from: data.name ? `"${data.name.replace(/"/g, '')}" <${data.from}>` : data.from,
        to: settings.mail_user,
        subject: data.subject,
        text: data.body,
        messageId: `<sim-${id()}@${data.from.split('@')[1]}>`,
        inReplyTo: parent?.message_id || null,
        references: parent ? [...parent.references_ids, parent.message_id].slice(-20) : [],
      });
      const uid = await new SimulatedMailbox(this.folder).append('inbox', raw);
      await this.boss.send(
        'mail-poll',
        { manual: true },
        { db: tx.bossDb, singletonKey: 'manual', singletonSeconds: 5 },
      );
      return { uid };
    });
  }
}
