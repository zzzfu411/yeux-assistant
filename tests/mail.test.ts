import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PgBoss } from 'pg-boss';
import { Store } from '../packages/storage/src/index.js';
import { MailActions, type ReadonlyInbox } from '../packages/core/src/mail.js';

const url = process.env.MIGRATION_TEST_DATABASE_URL;
describe.skipIf(!url)('durable, exact mail approvals (synthetic accounts only)', () => {
  let store: Store, folder: string, mail: MailActions;
  const boss = { send: vi.fn(async () => 'mock-job') } as unknown as PgBoss;
  const send = vi.fn(async () => true);
  const settings = { mail_user: 'sender@example.invalid', mail_password: 'synthetic-only' };
  async function approval() {
    return mail.request('request', 'session-1', { revision: 3 });
  }
  async function approved() {
    const row = await approval();
    await mail.decide('approve', row.id, { digest: row.digest, approve: true });
    return row;
  }
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Only a disposable *_test database is allowed');
    store = new Store(url);
  });
  afterAll(async () => {
    await store?.close();
  });
  beforeEach(async () => {
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'gse-mail-'));
    await writeFile(join(folder, 'config.json'), JSON.stringify(settings));
    await store.exec(
      "INSERT INTO app.sessions(id,title,kind,prompt,state,revision,content,recipient) VALUES('session-1','Exact subject','work','Original request','ready',3,'Exact draft','receiver@example.invalid')",
    );
    send.mockReset();
    send.mockResolvedValue(true);
    mail = new MailActions(store, boss, folder, { send });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });
  it('binds subject, recipient, body, sender, action and revision; same request is idempotent', async () => {
    const row = await approved();
    expect(row.payload).toEqual({
      action: 'mail.send',
      sessionId: 'session-1',
      revision: 3,
      subject: 'Exact subject',
      recipient: 'receiver@example.invalid',
      sender: 'sender@example.invalid',
      draft: 'Exact draft',
    });
    expect((await mail.request('request', 'session-1', { revision: 3 })).id).toBe(row.id);
    expect(await mail.sendOne()).toBe(true);
    expect(await mail.sendOne()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual(row.payload);
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('sent');
    expect((await store.one("SELECT content FROM app.artifacts WHERE kind='sent'"))?.content).toContain('Exact draft');
    expect((await store.one("SELECT content FROM app.artifacts WHERE kind='sent'"))?.content).toContain(row.message_id);
  });
  it('rejects a changed sender or modified snapshot without sending', async () => {
    const row = await approval();
    await writeFile(join(folder, 'config.json'), JSON.stringify({ ...settings, mail_user: 'changed@example.invalid' }));
    await expect(mail.decide('approve', row.id, { digest: row.digest, approve: true })).rejects.toThrow('发件账号');
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('invalidated');
    expect(await mail.sendOne()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('never executes unknown actions or tampered approved bodies', async () => {
    await approved();
    await store.exec("UPDATE app.approvals SET action='calendar.create'");
    await mail.sendOne();
    expect(send).not.toHaveBeenCalled();
    expect((await store.one('SELECT error FROM app.approvals'))?.error).toContain('尚未接入');
    const next = await mail.request('new', 'session-1', { revision: 3 });
    await mail.decide('new-approve', next.id, { digest: next.digest, approve: true });
    await store.exec("UPDATE app.approvals SET payload=jsonb_set(payload,'{draft}','\"unapproved\"') WHERE id=$1", [
      next.id,
    ]);
    await mail.sendOne();
    expect(send).not.toHaveBeenCalled();
    expect((await store.one('SELECT state FROM app.approvals WHERE id=$1', [next.id]))?.state).toBe('invalidated');
  });
  it('commits executing before SMTP and never retries an uncertain outcome', async () => {
    const row = await approved();
    send.mockImplementationOnce(async () => {
      expect((await store.one('SELECT state FROM app.approvals WHERE id=$1', [row.id]))?.state).toBe('executing');
      throw new Error('connection lost after DATA');
    });
    await mail.sendOne();
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('uncertain');
    await mail.sendOne();
    await mail.recover();
    await mail.recover();
    expect(send).toHaveBeenCalledTimes(1);
    await expect(mail.request('another', 'session-1', { revision: 3 })).rejects.toThrow('已有的发送记录');
    await mail.resolve('resolve', row.id, { sent: false, note: '已核实发件箱没有这封邮件。' });
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('resolved_not_sent');
    expect(await mail.sendOne()).toBe(false);
  });
  it('settles a durable SMTP receipt after database failure and restart without resending', async () => {
    const row = await approved();
    send.mockImplementationOnce(async () => {
      vi.spyOn(store, 'transaction').mockRejectedValueOnce(new Error('temporary commit outage'));
      return true;
    });
    await expect(mail.sendOne()).rejects.toThrow('temporary commit outage');
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('executing');
    expect(await readdir(join(folder, 'receipts'))).toHaveLength(1);
    const restarted = new MailActions(store, boss, folder, { send });
    await restarted.recover();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('sent');
    expect(await readdir(join(folder, 'receipts'))).toHaveLength(0);
    expect(await restarted.sendOne()).toBe(false);
    expect((await store.one("SELECT count(*) n FROM app.artifacts WHERE kind='sent'"))?.n).toBe('1');
  });
  it('keeps an in-memory receipt when disk persistence fails; the next tick only settles', async () => {
    await approved();
    await writeFile(join(folder, 'receipts'), 'simulate unavailable directory');
    await expect(mail.sendOne()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    await rm(join(folder, 'receipts'));
    await mail.sendOne();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('sent');
  });
  it('recovers interrupted execution once and records unknown legacy bodies honestly', async () => {
    const row = await approved();
    await store.exec("UPDATE app.approvals SET state='executing',payload='{}'");
    await mail.recover();
    await mail.recover();
    expect(
      (await store.one("SELECT count(*) n FROM app.notifications WHERE dedupe_key LIKE 'mail-interrupted:%'"))?.n,
    ).toBe('1');
    await mail.resolve('resolve', row.id, { sent: true, note: '本人已核实发送，但旧版没有保存正文。' });
    const content = (await store.one("SELECT content FROM app.artifacts WHERE kind='sent'"))?.content;
    expect(content).toContain('实际发送正文未知');
    expect(content).not.toContain('Exact draft');
    expect(send).not.toHaveBeenCalled();
  });
  it('allows rejection without credentials and invalidates an expired approved action', async () => {
    const row = await approval();
    await writeFile(join(folder, 'config.json'), '{broken');
    await mail.decide('reject', row.id, { digest: row.digest, approve: false });
    expect((await store.one('SELECT state FROM app.approvals'))?.state).toBe('rejected');
    await writeFile(join(folder, 'config.json'), JSON.stringify(settings));
    const next = await mail.request('request-2', 'session-1', { revision: 3 });
    await mail.decide('approve-2', next.id, { digest: next.digest, approve: true });
    await store.exec("UPDATE app.approvals SET decided_at=now()-interval '2 days' WHERE id=$1", [next.id]);
    await mail.sendOne();
    expect(send).not.toHaveBeenCalled();
  });
  it('two concurrent senders claim a particular approval only once', async () => {
    const row = await approved();
    const second = new MailActions(store, boss, folder, { send });
    await Promise.all([mail.sendOne(row.id), second.sendOne(row.id)]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  const raw = (messageId: string, subject: string, body: string) =>
    Buffer.from(
      `From: campus@example.invalid\r\nReply-To: campus@example.invalid\r\nTo: sender@example.invalid\r\nMessage-ID: <${messageId}@example.invalid>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
      'utf8',
    );
  function inbox(messages: Map<number, Buffer>): ReadonlyInbox {
    return {
      uidValidity: '100',
      list: async () => [...messages.keys()],
      read: async (uid) => messages.get(uid)!,
      close: vi.fn(async () => {}),
    };
  }
  it('deduplicates original notices after user edits, quarantines conflicts and continues later UIDs', async () => {
    const first = raw('reuse', 'Original', 'Complete source content'),
      conflict = raw('reuse', 'Changed', 'Different important source content'),
      later = raw('later', 'Later', 'A separate message');
    let messages = new Map([[1, first]]);
    mail = new MailActions(store, boss, folder, { send, inbox: async () => inbox(messages) });
    expect(await mail.poll()).toEqual({ imported: 1, quarantined: 0 });
    await store.exec(
      "UPDATE app.sessions SET title='User edited title',content='User edited reply' WHERE id<>'session-1'",
    );
    messages = new Map([
      [1, first],
      [2, first],
      [3, conflict],
      [4, later],
    ]);
    expect(await mail.poll()).toEqual({ imported: 1, quarantined: 1 });
    expect((await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"))?.value).toBe(
      '4',
    );
    const files = await readdir(join(folder, 'mail-quarantine'));
    expect(files).toHaveLength(1);
    expect(await readFile(join(folder, 'mail-quarantine', files[0]!))).toEqual(conflict);
    expect((await store.one('SELECT count(*) n FROM app.sources'))?.n).toBe('2');
    expect((await store.one("SELECT count(*) n FROM app.sessions WHERE title='User edited title'"))?.n).toBe('1');
  });
  it('preserves oversized body suffix in raw quarantine instead of truncating', async () => {
    const oversized = raw('long', 'Long', 'A'.repeat(100000) + 'FINAL IMPORTANT INSTRUCTION');
    const supported = raw('supported', 'Supported', '学'.repeat(100000));
    const messages = new Map([
      [1, oversized],
      [2, supported],
    ]);
    mail = new MailActions(store, boss, folder, { inbox: async () => inbox(messages), send });
    expect(await mail.poll()).toEqual({ imported: 1, quarantined: 1 });
    const files = await readdir(join(folder, 'mail-quarantine'));
    expect(await readFile(join(folder, 'mail-quarantine', files[0]!))).toEqual(oversized);
    expect((await store.one("SELECT prompt FROM app.sessions WHERE title='Supported'"))?.prompt).toBe(
      '学'.repeat(100000),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('does not advance IMAP watermark when fetch fails', async () => {
    mail = new MailActions(store, boss, folder, {
      inbox: async () => ({
        uidValidity: '100',
        list: async () => [1],
        read: async () => {
          throw new Error('socket timeout');
        },
        close: async () => {},
      }),
      send,
    });
    await expect(mail.poll()).rejects.toThrow('socket timeout');
    expect(
      await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"),
    ).toBeUndefined();
  });
  it('cancels a blocked read, closes the mailbox and can poll again without losing the UID', async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const abort = vi.fn(),
      close = vi.fn(async () => {});
    let current: ReadonlyInbox = {
      uidValidity: '100',
      list: async () => [1],
      read: () => {
        reading();
        return new Promise<Buffer>(() => {});
      },
      abort,
      close,
    };
    mail = new MailActions(store, boss, folder, { inbox: async () => current, send });
    const request = mail.poll(controller.signal),
      rejected = expect(request).rejects.toMatchObject({ code: 'mail_poll_timeout' });
    await started;
    controller.abort();
    await rejected;
    expect(abort).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"),
    ).toBeUndefined();
    expect((await store.one('SELECT count(*) n FROM app.sources'))?.n).toBe('0');
    current = inbox(new Map([[1, raw('after-cancel', 'Recovered notice', 'Original message is still available')]]));
    expect(await mail.poll()).toEqual({ imported: 1, quarantined: 0 });
    expect((await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"))?.value).toBe(
      '1',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('bounds cancellation cleanup to one second even when close never settles', async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const abort = vi.fn(),
      close = vi.fn(() => new Promise<void>(() => {}));
    let current: ReadonlyInbox = {
      uidValidity: '100',
      list: async () => [1],
      read: () => {
        reading();
        return new Promise<Buffer>(() => {});
      },
      abort,
      close,
    };
    mail = new MailActions(store, boss, folder, { inbox: async () => current, send });
    let settled = false;
    const request = mail.poll(controller.signal);
    void request.catch(() => {
      settled = true;
    });
    const rejected = expect(request).rejects.toMatchObject({ code: 'mail_poll_timeout' });
    await started;
    vi.useFakeTimers();
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(abort).toHaveBeenCalled();
    expect(
      await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"),
    ).toBeUndefined();
    current = inbox(new Map());
    expect(await mail.poll()).toEqual({ imported: 0, quarantined: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it('quarantines a complete HTML-only notice rather than storing placeholder facts', async () => {
    const message = Buffer.from(
      'From: campus@example.invalid\r\nMessage-ID: <html@example.invalid>\r\nSubject: HTML notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Important original HTML content</p>',
    );
    mail = new MailActions(store, boss, folder, { inbox: async () => inbox(new Map([[1, message]])), send });
    expect(await mail.poll()).toEqual({ imported: 0, quarantined: 1 });
    const files = await readdir(join(folder, 'mail-quarantine'));
    expect(await readFile(join(folder, 'mail-quarantine', files[0]!))).toEqual(message);
    expect((await store.one('SELECT count(*) n FROM app.sources'))?.n).toBe('0');
  });
});
