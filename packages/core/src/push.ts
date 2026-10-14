import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import type { Store, Row } from '../../storage/src/index.js';
import { PushRemoveInput, PushSubscriptionInput, type PushDeviceView } from '../../contracts/src/mail.js';
import { iso, once } from './common.js';

type Keys = { publicKey: string; privateKey: string; subject: string };

/** VAPID keys are created once in the private folder; the private key never leaves the computer. */
export async function vapidKeys(folder: string): Promise<Keys> {
  const path = join(folder, 'web-push.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const keys = webpush.generateVAPIDKeys();
  try {
    await writeFile(path, JSON.stringify({ ...keys, subject: 'mailto:assistant@localhost' }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

const linkFor = (row: Row) =>
  row.session_id ? '/#/session/' + encodeURIComponent(row.session_id) : '/#/notifications';

/** Phone notifications for the installed web app. Delivery is at most once per notification. */
export class Push {
  constructor(
    readonly store: Store,
    readonly folder: string,
  ) {}
  async publicKey() {
    return { publicKey: (await vapidKeys(this.folder)).publicKey };
  }
  async devices(): Promise<PushDeviceView[]> {
    return (await this.store.rows('SELECT * FROM app.push_subscriptions ORDER BY created_at DESC')).map((row) => ({
      endpointHost: new URL(row.endpoint).host,
      label: row.label,
      createdAt: iso(row.created_at),
      lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
    }));
  }
  async subscribe(key: string, input: unknown) {
    const data = PushSubscriptionInput.parse(input);
    return this.store.transaction((tx) =>
      once(tx, key, 'push.subscribe', data, async () => {
        await tx.exec(
          `INSERT INTO app.push_subscriptions(endpoint,keys,label) VALUES($1,$2,$3)
           ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys,label=excluded.label,failures=0`,
          [data.endpoint, JSON.stringify(data.keys), data.label],
        );
        return { subscribed: true };
      }),
    );
  }
  async unsubscribe(key: string, input: unknown) {
    const data = PushRemoveInput.parse(input);
    return this.store.transaction((tx) =>
      once(tx, key, 'push.unsubscribe', data, async () => {
        await tx.exec('DELETE FROM app.push_subscriptions WHERE endpoint=$1', [data.endpoint]);
        return { removed: true };
      }),
    );
  }
  private async send(payload: { title: string; body: string; url: string; tag: string }) {
    const keys = await vapidKeys(this.folder);
    const subscriptions = await this.store.rows('SELECT * FROM app.push_subscriptions');
    let sent = 0,
      failed = 0;
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify(payload),
          { vapidDetails: keys, TTL: 3600, timeout: 10000, urgency: 'normal' },
        );
        sent++;
        await this.store.exec('UPDATE app.push_subscriptions SET failures=0,last_success_at=now() WHERE endpoint=$1', [
          subscription.endpoint,
        ]);
      } catch (error: any) {
        failed++;
        // 404 / 410: the browser dropped this subscription; others are retried later up to a limit.
        if ([404, 410].includes(error?.statusCode) || subscription.failures >= 9)
          await this.store.exec('DELETE FROM app.push_subscriptions WHERE endpoint=$1', [subscription.endpoint]);
        else
          await this.store.exec('UPDATE app.push_subscriptions SET failures=failures+1 WHERE endpoint=$1', [
            subscription.endpoint,
          ]);
      }
    }
    return { sent, failed, devices: subscriptions.length };
  }
  async test() {
    return this.send({
      title: 'yeux 通知已开启',
      body: '之后有新邮件、待确认或需要补充时会提醒你。',
      url: '/#/today',
      tag: 'test',
    });
  }
  /** Called by the worker: claim recent unpushed notifications first, then send. */
  async deliver() {
    const rows = await this.store.transaction((tx) =>
      tx.rows(
        `UPDATE app.notifications SET pushed_at=now() WHERE id IN (
           SELECT id FROM app.notifications WHERE pushed_at IS NULL AND created_at > now()-interval '2 hours'
           ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`,
      ),
    );
    if (!rows.length) return { sent: 0 };
    if (!(await this.store.one('SELECT endpoint FROM app.push_subscriptions LIMIT 1'))) return { sent: 0 };
    if (rows.length > 3)
      return this.send({
        title: `有 ${rows.length} 条新消息`,
        body: rows
          .map((r) => r.title)
          .slice(0, 3)
          .join('；'),
        url: '/#/notifications',
        tag: 'batch',
      });
    let sent = 0;
    for (const row of rows)
      sent += (
        await this.send({
          title: row.title,
          body: String(row.body || '').slice(0, 140),
          url: linkFor(row),
          tag: row.id,
        })
      ).sent;
    return { sent };
  }
}
