import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Row } from '../../../storage/src/index.js';
import { AppError } from '../common.js';

/** One read-only mailbox folder. UIDs only grow within one uidValidity. */
export interface ReadonlyInbox {
  uidValidity: string;
  list(watermark: number): Promise<number[]>;
  read(uid: number): Promise<Buffer>;
  close(): Promise<void>;
  abort?(): void;
}
export type FolderRole = 'inbox' | 'sent';
export { mailMode } from '../config.js';

export async function openImapFolder(settings: Row, role: FolderRole, signal?: AbortSignal) {
  const client = new ImapFlow({
    host: settings.imap_host || 'imap.exmail.qq.com',
    port: Number(settings.imap_port || 993),
    secure: true,
    auth: { user: settings.mail_user, pass: settings.mail_password },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 15000,
    socketTimeout: 25000,
    tls: { rejectUnauthorized: true },
  });
  client.on('error', () => {});
  const abort = () => client.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new AppError('本轮邮箱读取已停止。', 503, 'mail_poll_timeout');
    await client.connect();
    let path = 'INBOX';
    if (role === 'sent') {
      const sent = (await client.list()).find((box) => box.specialUse === '\\Sent');
      if (!sent) {
        signal?.removeEventListener('abort', abort);
        await client.logout().catch(() => {});
        client.close();
        return null;
      }
      path = sent.path;
    }
    const lock = await client.getMailboxLock(path, { readOnly: true });
    if (!client.mailbox || !client.mailbox.uidValidity) throw new AppError('邮箱未返回 UIDVALIDITY，未推进同步水位。');
    const reader: ReadonlyInbox = {
      uidValidity: client.mailbox.uidValidity.toString(),
      list: async (watermark) =>
        (await client.search(watermark ? { uid: `${watermark + 1}:*` } : { all: true }, { uid: true })) || [],
      read: async (uid) => {
        const result = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!result || !result.source) throw new AppError('邮箱未返回正文，下次继续读取。');
        return result.source;
      },
      abort,
      close: async () => {
        signal?.removeEventListener('abort', abort);
        lock.release();
        if (signal?.aborted) {
          client.close();
          return;
        }
        try {
          await client.logout();
        } finally {
          client.close();
        }
      },
    };
    return reader;
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    client.close();
    throw error;
  }
}

/**
 * A file mailbox for development and demonstration: private/mail-sim/{INBOX,Sent}/<uid>.eml.
 * Nothing leaves the computer; "sending" appends the exact composed message to Sent.
 */
export class SimulatedMailbox {
  static readonly UID_VALIDITY = 'sim-1';
  readonly root: string;
  constructor(folder: string) {
    this.root = join(folder, 'mail-sim');
  }
  private directory(role: FolderRole) {
    return join(this.root, role === 'inbox' ? 'INBOX' : 'Sent');
  }
  private async uids(role: FolderRole) {
    try {
      return (await readdir(this.directory(role)))
        .map((name) => /^(\d{1,12})\.eml$/.exec(name)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(Number)
        .sort((a, b) => a - b);
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  open(role: FolderRole): ReadonlyInbox {
    return {
      uidValidity: SimulatedMailbox.UID_VALIDITY,
      list: async (watermark) => (await this.uids(role)).filter((uid) => uid > watermark),
      read: async (uid) => readFile(join(this.directory(role), String(uid).padStart(6, '0') + '.eml')),
      close: async () => {},
    };
  }
  /** Append a raw message with the next UID; concurrent writers retry on collision. */
  async append(role: FolderRole, raw: Buffer) {
    await mkdir(this.directory(role), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 20; attempt++) {
      const uid = ((await this.uids(role)).at(-1) || 0) + 1;
      try {
        await writeFile(join(this.directory(role), String(uid).padStart(6, '0') + '.eml'), raw, {
          flag: 'wx',
          mode: 0o600,
        });
        return uid;
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new AppError('模拟邮箱写入冲突，请稍后重试。', 503, 'mail_simulation_busy');
  }
}

export type ComposedMail = {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
};
export function compose(mail: ComposedMail): Promise<Buffer> {
  return new MailComposer({
    from: mail.from,
    to: mail.to,
    cc: mail.cc?.length ? mail.cc : undefined,
    subject: mail.subject,
    text: mail.text,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references?.length ? mail.references : undefined,
    date: mail.date || new Date(),
  })
    .compile()
    .build();
}
