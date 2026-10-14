import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { Tx, type Store, type Row } from '../../storage/src/index.js';
import { ApprovalDecision, ApprovalResolution } from '../../contracts/src/index.js';
import { AppError, checkVersion, digest, event, id, notify, once, requireRow } from './common.js';
import { config, mailMode } from './config.js';
import { lockSession } from './sessions.js';
import { SessionMail } from '../../contracts/src/mail.js';
import { compose, openImapFolder, SimulatedMailbox, type FolderRole, type ReadonlyInbox } from './mail/mailbox.js';
import { parseMail } from './mail/parse.js';
import { ingestMessage } from './mail/ingest.js';
export type { ReadonlyInbox } from './mail/mailbox.js';

const address = z.string().regex(/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/);
const snapshotSchema = z
  .object({
    action: z.literal('mail.send'),
    sessionId: z.string(),
    revision: z.number().int().nonnegative(),
    subject: z.string(),
    recipient: address,
    sender: address,
    draft: z.string(),
    // Reply headers and copies are part of what the owner confirms; older approvals omit them.
    inReplyTo: z.string().nullable().optional(),
    references: z.array(z.string()).max(20).optional(),
    cc: z.array(address).max(10).optional(),
  })
  .strict();
type MailSnapshot = z.infer<typeof snapshotSchema>;
type Receipt = { approvalId: string; digest: string; sent: boolean; at: string };
export type MailAdapters = {
  send?: (settings: Row, payload: MailSnapshot, messageId: string) => Promise<boolean>;
  inbox?: (settings: Row, signal?: AbortSignal) => Promise<ReadonlyInbox>;
  /** The Sent folder is read only when a test supplies it or a real / simulated mailbox is used. */
  sent?: (settings: Row, signal?: AbortSignal) => Promise<ReadonlyInbox | null>;
};

function pollStopped() {
  return new AppError('本轮邮箱读取已停止或超过 60 秒；下次从已保存的位置继续。', 503, 'mail_poll_timeout');
}
function guardPoll(signal?: AbortSignal) {
  if (signal?.aborted) throw pollStopped();
}
function pollTransaction(tx: Tx, signal?: AbortSignal): Tx {
  if (!signal) return tx;
  return new Tx({
    execute: async (query) => {
      guardPoll(signal);
      const result = await tx.executor.execute(query);
      guardPoll(signal);
      return result;
    },
  });
}
/** Cleanup still runs after cancellation; a broken adapter cannot hold the poll slot forever. */
async function closeInbox(inbox: ReadonlyInbox, signal: AbortSignal) {
  const abort = () => {
    try {
      inbox.abort?.();
    } catch {
      /* Preserve the original poll result. */
    }
  };
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(() => {
      abort();
      finish();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve()
      .then(() => inbox.close())
      .then(finish, () => {
        abort();
        finish();
      });
  });
}

function credentials(settings: Row) {
  const mode = mailMode(settings);
  if (
    mode === 'off' ||
    !address.safeParse(settings.mail_user).success ||
    (mode === 'imap' && (typeof settings.mail_password !== 'string' || !settings.mail_password))
  )
    throw new AppError('邮箱尚未配置，请在“设置 → 邮箱”填写账号或启用模拟邮箱。');
}
function replyFields(session: Row) {
  const parsed = SessionMail.safeParse(session.mail);
  if (!parsed.success) return { inReplyTo: null, references: [] as string[], cc: [] as string[] };
  return { inReplyTo: parsed.data.inReplyTo, references: parsed.data.references, cc: parsed.data.cc };
}
function matching(approval: Row, session: Row, sender: string) {
  const result = snapshotSchema.safeParse(approval.payload);
  if (!result.success) return false;
  const p = result.data;
  return (
    approval.action === 'mail.send' &&
    p.sessionId === session.id &&
    p.revision === session.revision &&
    p.sender === sender &&
    p.subject === session.title &&
    p.recipient === session.recipient &&
    p.draft === session.content &&
    (p.inReplyTo ?? null) === replyFields(session).inReplyTo &&
    JSON.stringify(p.references ?? []) === JSON.stringify(replyFields(session).references) &&
    JSON.stringify(p.cc ?? []) === JSON.stringify(replyFields(session).cc) &&
    digest(p) === approval.digest
  );
}
function validSession(session: Row) {
  return ['ready', 'completed'].includes(session.state);
}
async function invalidate(tx: Tx, approval: Row, reason: string) {
  await tx.exec("UPDATE app.approvals SET state='invalidated',error=$2,finished_at=now() WHERE id=$1", [
    approval.id,
    reason,
  ]);
  await event(tx, 'mail.invalidated', approval.session_id, { approvalId: approval.id });
  await notify(tx, 'mail-invalid:' + approval.id, approval.session_id, '需要重新核对发送', reason);
}
async function simulatedSend(folder: string, payload: MailSnapshot, messageId: string) {
  const raw = await compose({
    from: payload.sender,
    to: payload.recipient,
    cc: payload.cc,
    subject: payload.subject,
    text: payload.draft,
    messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
  });
  await new SimulatedMailbox(folder).append('sent', raw);
  return true;
}
async function defaultSend(settings: Row, payload: MailSnapshot, messageId: string): Promise<boolean> {
  const transport = nodemailer.createTransport({
    host: settings.smtp_host || 'smtp.exmail.qq.com',
    port: Number(settings.smtp_port || 465),
    secure: true,
    auth: { user: settings.mail_user, pass: settings.mail_password },
    connectionTimeout: 10000,
    greetingTimeout: 15000,
    socketTimeout: 25000,
    logger: false,
    debug: false,
    tls: { rejectUnauthorized: true },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      transport.sendMail({
        from: payload.sender,
        to: payload.recipient,
        cc: payload.cc?.length ? payload.cc : undefined,
        subject: payload.subject,
        text: payload.draft,
        messageId,
        inReplyTo: payload.inReplyTo || undefined,
        references: payload.references?.length ? payload.references : undefined,
        envelope: { from: payload.sender, to: [payload.recipient, ...(payload.cc || [])] },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          transport.close();
          reject(new Error('SMTP deadline'));
        }, 65000);
      }),
    ]);
    return (
      result.accepted?.some((value) =>
        typeof value === 'string' ? value === payload.recipient : value.address === payload.recipient,
      ) === true
    );
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}
/** All external sends pass through an exact, version-bound approval snapshot. */
export class MailActions {
  readonly pending = new Map<string, Receipt>();
  private sending = false;
  private polling = false;
  constructor(
    readonly store: Store,
    readonly boss: PgBoss,
    readonly folder: string,
    readonly adapters: MailAdapters = {},
  ) {}
  command<T>(key: string, operation: string, input: unknown, work: (tx: Tx) => Promise<T>) {
    return this.store.transaction((tx) => once(tx, key, operation, input, () => work(tx)));
  }
  async request(key: string, sessionId: string, input: { revision: number }) {
    const data = z.object({ revision: z.number().int().nonnegative() }).strict().parse(input);
    const settings = await config(this.folder);
    credentials(settings);
    return this.command(key, 'mail.request:' + sessionId, data, async (tx) => {
      const session = await lockSession(tx, sessionId);
      checkVersion(session, data.revision);
      if (!validSession(session)) throw new AppError('当前任务还不能申请发送，请先完成草稿。', 409);
      if (!address.safeParse(session.recipient).success) throw new AppError('请填写一个有效的收件邮箱。');
      if (!session.content.trim() || /\[(?:请补充|待填写)/.test(session.content)) throw new AppError('请先补全草稿。');
      if (/[\r\n\x00]/.test(session.title)) throw new AppError('邮件主题必须为单行。');
      if (
        await tx.one(
          "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",
          [sessionId],
        )
      )
        throw new AppError('请先处理已有的发送记录。', 409);
      const old = await tx.rows("SELECT * FROM app.approvals WHERE session_id=$1 AND state='pending' FOR UPDATE", [
        sessionId,
      ]);
      for (const approval of old) {
        if (
          matching(approval, session, settings.mail_user) &&
          Date.now() - new Date(approval.created_at).getTime() <= 86400000
        )
          return approval;
        await invalidate(tx, approval, '草稿、账号或确认期限已改变，请重新核对。');
      }
      const reply = replyFields(session);
      const payload: MailSnapshot = {
        action: 'mail.send',
        sessionId,
        revision: session.revision,
        subject: session.title,
        recipient: session.recipient,
        sender: settings.mail_user,
        draft: session.content,
        ...(session.mail ? { inReplyTo: reply.inReplyTo, references: reply.references, cc: reply.cc } : {}),
      };
      const approvalId = id(),
        messageId = `<gse-${approvalId}@${settings.mail_user.split('@')[1]}>`;
      const approval = await tx.one(
        "INSERT INTO app.approvals(id,session_id,action,digest,payload,state,message_id) VALUES($1,$2,'mail.send',$3,$4,'pending',$5) RETURNING *",
        [approvalId, sessionId, digest(payload), JSON.stringify(payload), messageId],
      );
      await event(tx, 'mail.requested', sessionId, { approvalId });
      return approval!;
    });
  }
  async decide(key: string, approvalId: string, input: unknown) {
    const data = ApprovalDecision.parse(input);
    let sender = '',
      configurationError = '';
    if (data.approve)
      try {
        const settings = await config(this.folder);
        credentials(settings);
        sender = settings.mail_user;
      } catch {
        configurationError = '发件配置缺失或无法读取，请修复后重新确认。';
      }
    const result = await this.command(key, 'mail.decide:' + approvalId, data, async (tx) => {
      const before = await requireRow(tx, 'SELECT session_id FROM app.approvals WHERE id=$1', [approvalId]);
      const session = await lockSession(tx, before.session_id);
      const approval = await requireRow(tx, 'SELECT * FROM app.approvals WHERE id=$1 FOR UPDATE', [approvalId]);
      if (approval.digest !== data.digest) throw new AppError('确认内容不匹配，请重新核对。', 409);
      if (approval.state !== 'pending') throw new AppError('这项确认已处理或失效。', 409);
      const reason =
        approval.action !== 'mail.send'
          ? '此动作尚未接入执行适配器。'
          : !validSession(session)
            ? '任务状态已经改变，请重新核对。'
            : data.approve && (configurationError || !matching(approval, session, sender))
              ? configurationError || '草稿或发件账号已改变，请重新确认。'
              : data.approve && Date.now() - new Date(approval.created_at).getTime() > 86400000
                ? '确认超过一天，请重新核对。'
                : '';
      if (reason) {
        await invalidate(tx, approval, reason);
        return { approvalId, state: 'invalidated', error: reason };
      }
      const state = data.approve ? 'approved' : 'rejected';
      await tx.exec('UPDATE app.approvals SET state=$2,decided_at=now() WHERE id=$1', [approvalId, state]);
      if (data.approve) await this.boss.send('mail-send', { approvalId }, { db: tx.bossDb, singletonKey: approvalId });
      await event(tx, 'mail.decided', session.id, { approvalId, state });
      return { approvalId, state, error: '' };
    });
    if (result.error) throw new AppError(result.error, 409, 'approval_invalidated');
    return result;
  }
  async resolve(key: string, approvalId: string, input: unknown) {
    const data = ApprovalResolution.parse(input);
    return this.command(key, 'mail.resolve:' + approvalId, data, async (tx) => {
      const before = await requireRow(tx, 'SELECT session_id FROM app.approvals WHERE id=$1', [approvalId]);
      await lockSession(tx, before.session_id);
      const approval = await requireRow(tx, 'SELECT * FROM app.approvals WHERE id=$1 FOR UPDATE', [approvalId]);
      if (approval.state !== 'uncertain') throw new AppError('没有待核实的发送记录。', 409);
      if (approval.action !== 'mail.send') throw new AppError('此动作尚未接入执行适配器。');
      const state = data.sent ? 'resolved_sent' : 'resolved_not_sent';
      await tx.exec('UPDATE app.approvals SET state=$2,error=$3,finished_at=now() WHERE id=$1', [
        approvalId,
        state,
        data.note,
      ]);
      if (data.sent) await this.sentArtifact(tx, approval, true, data.note);
      await event(tx, 'mail.resolved', approval.session_id, { approvalId, sent: data.sent, note: data.note });
      await notify(
        tx,
        'mail-resolved:' + approvalId,
        approval.session_id,
        '发送结果已记录',
        data.sent ? '本人已核实发送。' : '本人已核实未发送；再次发送需要新的确认。',
      );
      return { approvalId, state };
    });
  }
  private async sentArtifact(tx: Tx, approval: Row, manual = false, note = '') {
    const payload = approval.payload as Row;
    const complete =
      payload && ['subject', 'sender', 'recipient', 'draft'].every((k) => typeof payload[k] === 'string');
    const content = complete
      ? `# ${payload.subject}\n\n${manual ? '本人核实已发送' : 'SMTP 已接受'}\n发件人：${payload.sender}\n收件人：${payload.recipient}\nMessage-ID：${approval.message_id}\n审批记录：${approval.id}\n确认版本：${payload.revision ?? '旧版未记录'}\n\n${payload.draft}${note ? '\n\n核实说明：' + note : ''}`
      : `# 旧版发送人工核实\n\n${note}\n\n原记录缺少完整快照；实际发送正文未知，当前草稿不能作为已发送正文。`;
    if (!complete && !manual) throw new AppError('发送快照缺少必要字段。');
    await tx.exec(
      "INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,'sent',$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING",
      [id(), approval.session_id, content, manual ? 'user_confirmation' : 'smtp_receipt', 'mail-sent:' + approval.id],
    );
  }
  /** A confirmed reply joins its thread at once; the Sent-folder copy later deduplicates by Message-ID. */
  private async recordOutgoing(tx: Tx, approval: Row) {
    const payload = snapshotSchema.safeParse(approval.payload);
    if (!payload.success) return;
    const session = await tx.one('SELECT mail FROM app.sessions WHERE id=$1', [approval.session_id]);
    const mail = SessionMail.safeParse(session?.mail);
    if (!mail.success) return;
    const thread = await tx.one('SELECT id FROM app.mail_threads WHERE id=$1', [mail.data.threadId]);
    if (!thread) return;
    await ingestMessage(
      tx,
      this.boss,
      {
        messageId: approval.message_id,
        inReplyTo: payload.data.inReplyTo ?? null,
        references: payload.data.references ?? [],
        from: payload.data.sender,
        to: [payload.data.recipient],
        cc: payload.data.cc ?? [],
        replyTo: null,
        subject: payload.data.subject,
        sentAt: new Date(),
        body: payload.data.draft,
        origin: 'composed',
        bulk: false,
        attachments: [],
        rawDigest: digest(payload.data),
      },
      {
        account: payload.data.sender,
        folder: 'yeux-sent',
        uidValidity: approval.id,
        uid: 0,
        role: 'local',
        draft: false,
        autoDraft: 'none',
        dailyLimit: 0,
        sourceIdentity: 'email:' + payload.data.sender + ':' + approval.message_id,
      },
    );
    await tx.exec("UPDATE app.mail_threads SET triage='replied',revision=revision+1,updated_at=now() WHERE id=$1", [
      thread.id,
    ]);
  }
  private receiptPath(approvalId: string) {
    return join(this.folder, 'receipts', 'mail-' + digest(approvalId) + '.json');
  }
  private async saveReceipt(receipt: Receipt) {
    await mkdir(join(this.folder, 'receipts'), { recursive: true, mode: 0o700 });
    const path = this.receiptPath(receipt.approvalId),
      temporary = path + '.' + id();
    try {
      await writeFile(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  private async settle(receipt: Receipt) {
    await this.store.transaction(async (tx) => {
      const before = await requireRow(tx, 'SELECT session_id FROM app.approvals WHERE id=$1', [receipt.approvalId]);
      await lockSession(tx, before.session_id);
      const approval = await requireRow(tx, 'SELECT * FROM app.approvals WHERE id=$1 FOR UPDATE', [receipt.approvalId]);
      if (approval.digest !== receipt.digest) throw new AppError('本地回执与发送记录不匹配，需人工核对。');
      if (!['executing', 'uncertain'].includes(approval.state)) return;
      if (approval.state === 'uncertain' && !receipt.sent && approval.finished_at) return;
      const state = receipt.sent ? 'sent' : 'uncertain',
        error = receipt.sent ? '' : '发送结果不确定，请核对已发送邮件；不会自动重发。';
      await tx.exec('UPDATE app.approvals SET state=$2,error=$3,finished_at=$4 WHERE id=$1', [
        approval.id,
        state,
        error,
        receipt.at,
      ]);
      if (receipt.sent) {
        await this.sentArtifact(tx, approval);
        await this.recordOutgoing(tx, approval);
      }
      await event(tx, 'mail.result', approval.session_id, { approvalId: approval.id, state });
      await notify(
        tx,
        'mail-result:' + approval.id,
        approval.session_id,
        receipt.sent ? '邮件已发送' : '发送结果需核实',
        error,
      );
    });
    await unlink(this.receiptPath(receipt.approvalId)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.pending.delete(receipt.approvalId);
  }
  /** Called by the single, lock-owning worker on startup, before accepting sends. */
  async recover() {
    await mkdir(join(this.folder, 'receipts'), { recursive: true, mode: 0o700 });
    for (const name of await readdir(join(this.folder, 'receipts'))) {
      if (!/^mail-[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = z
        .object({ approvalId: z.string(), digest: z.string().length(64), sent: z.boolean(), at: z.iso.datetime() })
        .strict()
        .parse(JSON.parse(await readFile(join(this.folder, 'receipts', name), 'utf8')));
      if (this.receiptPath(value.approvalId) !== join(this.folder, 'receipts', name))
        throw new AppError('本地回执文件名不一致，需人工核对。');
      this.pending.set(value.approvalId, value);
    }
    for (const receipt of this.pending.values()) await this.settle(receipt);
    await this.store.transaction(async (tx) => {
      const interrupted = await tx.rows(
        "UPDATE app.approvals SET state='uncertain',error='发送进程曾中断，结果待核实；不会自动重发。',finished_at=now() WHERE state='executing' RETURNING *",
      );
      for (const approval of interrupted) {
        await event(tx, 'mail.interrupted', approval.session_id, { approvalId: approval.id });
        await notify(
          tx,
          'mail-interrupted:' + approval.id,
          approval.session_id,
          '发送结果需核实',
          '发送过程曾中断，请核对已发送邮件。',
        );
      }
    });
  }
  async sendOne(approvalId?: string): Promise<boolean> {
    if (this.sending) return false;
    this.sending = true;
    try {
      const receipt = this.pending.values().next().value as Receipt | undefined;
      if (receipt) {
        await this.saveReceipt(receipt);
        await this.settle(receipt);
        return true;
      }
      const candidate = await this.store.one(
        "SELECT * FROM app.approvals WHERE state='approved' AND ($1::text IS NULL OR id=$1) ORDER BY created_at,id LIMIT 1",
        [approvalId || null],
      );
      if (!candidate) return false;
      let settings: Row = {},
        configurationError = '';
      try {
        settings = await config(this.folder);
        credentials(settings);
      } catch {
        configurationError = '发件配置缺失或无法读取，请修复后重新确认。';
      }
      const claimed = await this.store.transaction(async (tx) => {
        const session = await lockSession(tx, candidate.session_id);
        const approval = await requireRow(tx, 'SELECT * FROM app.approvals WHERE id=$1 FOR UPDATE', [candidate.id]);
        if (approval.state !== 'approved') return null;
        const reason =
          approval.action !== 'mail.send'
            ? '此动作尚未接入执行适配器。'
            : configurationError || !validSession(session) || !matching(approval, session, settings.mail_user)
              ? configurationError || '确认内容、状态或账号已改变，请重新核对。'
              : !approval.decided_at || Date.now() - new Date(approval.decided_at).getTime() > 86400000
                ? '确认超过一天，请重新核对。'
                : '';
        if (reason) {
          await invalidate(tx, approval, reason);
          return null;
        }
        await tx.exec("UPDATE app.approvals SET state='executing' WHERE id=$1", [approval.id]);
        await event(tx, 'mail.started', session.id, { approvalId: approval.id });
        return approval;
      });
      if (!claimed) return true;
      let sent = false;
      try {
        const payload = snapshotSchema.parse(claimed.payload);
        sent = this.adapters.send
          ? await this.adapters.send(settings, payload, claimed.message_id)
          : mailMode(settings) === 'simulation'
            ? await simulatedSend(this.folder, payload, claimed.message_id)
            : await defaultSend(settings, payload, claimed.message_id);
      } catch {
        sent = false;
      }
      // Retain the result in memory before any filesystem/DB await. A failed
      // settlement retries this receipt; it never invokes SMTP a second time.
      const result: Receipt = { approvalId: claimed.id, digest: claimed.digest, sent, at: new Date().toISOString() };
      this.pending.set(claimed.id, result);
      await this.saveReceipt(result);
      await this.settle(result);
      return true;
    } finally {
      this.sending = false;
    }
  }
  async tick() {
    return this.sendOne();
  }
  private async quarantine(
    identity: string,
    raw: Buffer,
    reason: string,
    watermarkKey: string,
    uid: number,
    signal?: AbortSignal,
  ) {
    guardPoll(signal);
    await mkdir(join(this.folder, 'mail-quarantine'), { recursive: true, mode: 0o700 });
    const filename = digest(identity) + '.eml',
      path = join(this.folder, 'mail-quarantine', filename);
    try {
      await writeFile(path, raw, { mode: 0o600, flag: 'wx', flush: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (!raw.equals(await readFile(path))) throw new AppError('隔离邮件内容冲突，未推进读取水位。');
    }
    await this.store.transaction(async (original) => {
      const tx = pollTransaction(original, signal);
      await tx.exec(
        'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [
          'mail-quarantine:' + identity,
          JSON.stringify({
            identity,
            rawPath: 'mail-quarantine/' + filename,
            error: reason,
            createdAt: new Date().toISOString(),
          }),
        ],
      );
      await notify(
        tx,
        'quarantine:' + identity,
        null,
        '有一封邮件需要手动查看',
        '原邮件已保存在本地隔离区，其他邮件继续导入。',
      );
      await tx.exec(
        'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [watermarkKey, JSON.stringify(String(uid))],
      );
    });
  }
  private async openFolder(settings: Row, role: FolderRole, signal: AbortSignal): Promise<ReadonlyInbox | null> {
    if (role === 'inbox' && this.adapters.inbox) return this.adapters.inbox(settings, signal);
    if (role === 'sent' && this.adapters.sent) return this.adapters.sent(settings, signal);
    if (this.adapters.inbox) return null; // A test inbox without a Sent adapter reads INBOX only.
    if (mailMode(settings) === 'simulation') return new SimulatedMailbox(this.folder).open(role);
    return openImapFolder(settings, role, signal);
  }
  /** Reads BODY.PEEK through mailboxes opened read-only; never flags or moves mail. */
  async poll(externalSignal?: AbortSignal): Promise<{ imported: number; quarantined: number }> {
    if (this.polling) return { imported: 0, quarantined: 0 };
    this.polling = true;
    let inbox: ReadonlyInbox | null | undefined;
    const deadline = AbortSignal.timeout(60000),
      signal = externalSignal ? AbortSignal.any([deadline, externalSignal]) : deadline;
    const waitFor = <T>(operation: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(pollStopped());
          return;
        }
        const abort = () => {
          inbox?.abort?.();
          reject(pollStopped());
        };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(operation)
          .then(
            (value) => {
              signal.removeEventListener('abort', abort);
              if (signal.aborted) reject(pollStopped());
              else resolve(value);
            },
            (error) => {
              signal.removeEventListener('abort', abort);
              reject(signal.aborted ? pollStopped() : error);
            },
          );
      });
    let imported = 0,
      quarantined = 0;
    try {
      const settings = await waitFor(() => config(this.folder));
      credentials(settings);
      const autoDraft = ['none', 'direct', 'all'].includes(settings.mail_auto_draft)
        ? settings.mail_auto_draft
        : 'direct';
      const dailyLimit = Number.isInteger(settings.mail_daily_limit) ? settings.mail_daily_limit : 10;
      for (const role of ['inbox', 'sent'] as const) {
        inbox = await waitFor(() => this.openFolder(settings, role, signal));
        if (!inbox) continue;
        try {
          // INBOX keeps the original watermark key so upgrades continue where they stopped.
          const key = 'mail:' + settings.mail_user + (role === 'sent' ? ':sent:' : ':') + inbox.uidValidity;
          const watermark = Number(
            (await this.store.one('SELECT value FROM app.settings WHERE key=$1', [key]))?.value || 0,
          );
          if (!Number.isSafeInteger(watermark) || watermark < 0) throw new AppError('邮箱读取水位无效，未执行读取。');
          const available = [...new Set(await waitFor(() => inbox!.list(watermark)))]
            .filter((n) => Number.isSafeInteger(n) && n > watermark)
            .sort((a, b) => a - b);
          const uids = watermark ? available.slice(0, 50) : available.slice(role === 'inbox' ? -20 : -50);
          for (const uid of uids) {
            guardPoll(signal);
            const raw = await waitFor(() => inbox!.read(uid)),
              identity = key + ':' + uid;
            let parsed: Awaited<ReturnType<typeof parseMail>>;
            try {
              parsed = await waitFor(() => parseMail(raw, settings.mail_user));
            } catch (error) {
              guardPoll(signal);
              await this.quarantine(
                identity,
                raw,
                error instanceof AppError ? error.message : '邮件解析失败，原文已保留。',
                key,
                uid,
                signal,
              );
              quarantined++;
              continue;
            }
            const sender = (parsed.replyTo || parsed.from).trim(),
              sourceIdentity = 'email:' + settings.mail_user + ':' + (parsed.messageId || parsed.rawDigest);
            // The first sync records history; only recent mail may start a draft.
            const recent = !parsed.sentAt || Date.now() - parsed.sentAt.getTime() < 3 * 86400000;
            try {
              const count = await this.store.transaction(async (original) => {
                const tx = pollTransaction(original, signal);
                const sourceKey = 'mail-source:' + digest(sourceIdentity);
                await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sourceKey]);
                const requestDigest = digest([parsed.subject, parsed.body, sender, 'work', 1, null]);
                const saved = (await tx.one('SELECT value FROM app.settings WHERE key=$1', [sourceKey]))?.value;
                const legacy = (
                  await tx.one(
                    "SELECT payload FROM app.legacy_rows WHERE table_name='tasks' AND payload->>'source_key'=$1",
                    [sourceIdentity],
                  )
                )?.payload;
                const prior =
                  saved ||
                  (legacy
                    ? {
                        sessionId: legacy.id,
                        digest:
                          legacy.request_digest ||
                          digest([
                            legacy.subject,
                            legacy.notice,
                            legacy.recipient,
                            legacy.kind,
                            legacy.priority,
                            legacy.due_at,
                          ]),
                      }
                    : null);
                if (prior && prior.digest !== requestDigest)
                  throw new AppError('相同 Message-ID 对应不同原文，已隔离保留。', 409, 'mail_source_conflict');
                let count = 0;
                if (!prior) {
                  const result = await ingestMessage(tx, this.boss, parsed, {
                    account: settings.mail_user,
                    folder: role === 'inbox' ? 'INBOX' : 'Sent',
                    uidValidity: inbox!.uidValidity,
                    uid,
                    role,
                    draft: role === 'inbox' && (watermark > 0 || recent),
                    autoDraft,
                    dailyLimit,
                    sourceIdentity,
                  });
                  await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [
                    sourceKey,
                    JSON.stringify({
                      identity: sourceIdentity,
                      digest: requestDigest,
                      threadId: result.threadId,
                      sourceId: 'mail-source-' + digest(sourceIdentity).slice(0, 24),
                    }),
                  ]);
                  count = result.created && role === 'inbox' ? 1 : 0;
                }
                await tx.exec(
                  'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                  [key, JSON.stringify(String(uid))],
                );
                return count;
              });
              imported += count;
            } catch (error) {
              guardPoll(signal);
              if (!(error instanceof AppError) || error.code !== 'mail_source_conflict') throw error;
              await this.quarantine(identity, raw, error.message, key, uid, signal);
              quarantined++;
            }
          }
        } finally {
          const current = inbox;
          inbox = undefined;
          await closeInbox(current, signal);
        }
      }
      return { imported, quarantined };
    } finally {
      this.polling = false;
    }
  }
}
