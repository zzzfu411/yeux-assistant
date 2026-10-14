import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MailSettingsView, PushDeviceView } from '../../../packages/contracts/src/mail';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, QueryState } from './ui';
import { Icon } from './icons';
import s from './styles.module.css';

const modes = [
  ['off', '关闭', '不读取也不发送邮件'],
  ['simulation', '模拟邮箱', '本机文件邮箱，可完整演示收信、起草、确认发送'],
  ['imap', '真实邮箱（smail）', '用客户端专用密码连接 IMAP / SMTP'],
] as const;

export function MailSettingsPanel() {
  const query = useData<MailSettingsView>('/settings/mail');
  return (
    <section className={`${s.section} ${s.settingsCard}`} aria-labelledby="mail-settings-heading" id="mail">
      <div className={s.sectionHeading}>
        <h2 id="mail-settings-heading">邮箱</h2>
        {query.data && (
          <span className={s.status} data-tone={query.data.mode === 'off' ? 'neutral' : 'success'}>
            <i aria-hidden="true" />
            {modes.find(([mode]) => mode === query.data!.mode)?.[1]}
          </span>
        )}
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && <MailSettingsForm settings={query.data} reload={async () => (await query.refetch()).data} />}
    </section>
  );
}

function MailSettingsForm({
  settings,
  reload,
}: {
  settings: MailSettingsView;
  reload: () => Promise<MailSettingsView | undefined>;
}) {
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [draft, setDraft] = useDraft('mail-settings', {
    mode: settings.mode,
    address: settings.address,
    imap_host: settings.imap_host,
    imap_port: settings.imap_port,
    smtp_host: settings.smtp_host,
    smtp_port: settings.smtp_port,
    poll: settings.poll,
    auto_draft: settings.auto_draft,
    daily_limit: settings.daily_limit,
    revision: settings.revision,
  });
  // The password is never kept in a browser draft.
  const [password, setPassword] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    const sent = password;
    void action.run(
      () => api.write<MailSettingsView>('/settings/mail', { ...draft, password }, 'PATCH'),
      (result) => {
        setDraft((current) => ({ ...current, revision: result.revision }));
        setPassword((current) => (current === sent ? '' : current));
        action.setMessage('邮箱设置已保存。可以测试连接。');
        void client.invalidateQueries();
      },
    );
  };
  return (
    <form className={s.form} onSubmit={save}>
      <fieldset className={s.choiceCards}>
        <legend>邮箱模式</legend>
        {modes.map(([mode, label, help]) => (
          <label key={mode} data-checked={draft.mode === mode}>
            <input
              type="radio"
              name="mail-mode"
              checked={draft.mode === mode}
              onChange={() => setDraft({ ...draft, mode })}
            />
            <strong>{label}</strong>
            <small>{help}</small>
          </label>
        ))}
      </fieldset>
      {draft.mode !== 'off' && (
        <>
          <div className={s.formGrid}>
            <label>
              邮箱地址
              <input
                type="email"
                required
                maxLength={320}
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                placeholder="学号@smail.nju.edu.cn"
              />
            </label>
            {draft.mode === 'imap' && (
              <label>
                客户端专用密码 / 授权码
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={1000}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={settings.has_password ? '已保存；留空保留' : '在邮箱设置中生成'}
                />
              </label>
            )}
          </div>
          {draft.mode === 'imap' && (
            <details className={s.disclosure}>
              <summary>服务器（留空使用默认 imap / smtp.exmail.qq.com）</summary>
              <div className={s.formGrid}>
                <label>
                  IMAP 服务器
                  <input
                    value={draft.imap_host}
                    maxLength={255}
                    onChange={(e) => setDraft({ ...draft, imap_host: e.target.value })}
                    placeholder="imap.exmail.qq.com"
                  />
                </label>
                <label>
                  IMAP 端口
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.imap_port}
                    onChange={(e) => setDraft({ ...draft, imap_port: Number(e.target.value) })}
                  />
                </label>
                <label>
                  SMTP 服务器
                  <input
                    value={draft.smtp_host}
                    maxLength={255}
                    onChange={(e) => setDraft({ ...draft, smtp_host: e.target.value })}
                    placeholder="smtp.exmail.qq.com"
                  />
                </label>
                <label>
                  SMTP 端口
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.smtp_port}
                    onChange={(e) => setDraft({ ...draft, smtp_port: Number(e.target.value) })}
                  />
                </label>
              </div>
            </details>
          )}
          <div className={s.formGrid}>
            <label>
              自动起草回复
              <select
                value={draft.auto_draft}
                onChange={(e) => setDraft({ ...draft, auto_draft: e.target.value as typeof draft.auto_draft })}
              >
                <option value="direct">只为直接发给我的来信起草（推荐）</option>
                <option value="all">所有来信都起草（含群发）</option>
                <option value="none">不自动起草，在邮件页手动起草</option>
              </select>
            </label>
            <label>
              每日自动起草上限
              <input
                type="number"
                min={0}
                max={100}
                value={draft.daily_limit}
                onChange={(e) => setDraft({ ...draft, daily_limit: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={draft.poll}
              onChange={(e) => setDraft({ ...draft, poll: e.target.checked })}
            />
            <span>后台每分钟收取新邮件（关闭时只在点击“收取新邮件”时读取）</span>
          </label>
          <p className={s.muted}>
            只读方式打开邮箱，不标记已读、不移动邮件。草稿只有在你核对收件人、主题和正文并确认后才会发送；结果不明时不会自动重发。
          </p>
        </>
      )}
      <ErrorNotice
        error={action.error}
        onReload={() =>
          void action.run(reload, (result) => {
            if (result) setDraft((current) => ({ ...current, revision: result.revision }));
          })
        }
      />
      {action.message && (
        <p className={s.notice} role="status">
          {action.message}
        </p>
      )}
      <div className={s.toolbar}>
        <button className={s.primary} disabled={action.busy}>
          保存邮箱设置
        </button>
        <button
          type="button"
          className={s.secondary}
          disabled={action.busy || settings.mode === 'off'}
          onClick={() =>
            void action.run(
              () => api.write<{ message: string }>('/settings/mail/test', {}),
              (result) => action.setMessage(result.message),
            )
          }
        >
          测试已保存的邮箱
        </button>
      </div>
    </form>
  );
}

function keyBytes(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
const pushSupported = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Phone notifications for the installed web app; works over HTTPS (the remote entrance). */
export function PushPanel() {
  const devices = useData<PushDeviceView[]>('/push/devices');
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const supported = pushSupported();
  const standalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone);
  const enable = () =>
    void action.run(
      async () => {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('没有获得通知权限；可在系统设置中为这个应用开启。');
        const { publicKey } = await api.get<{ publicKey: string }>('/push/key');
        const subscription =
          (await registration.pushManager.getSubscription()) ||
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(publicKey),
          }));
        const json = subscription.toJSON();
        await api.write('/push/subscriptions', {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          label: /iPhone|iPad/.test(navigator.userAgent)
            ? 'iPhone / iPad'
            : /Android/.test(navigator.userAgent)
              ? 'Android'
              : '电脑浏览器',
        });
      },
      () => {
        action.setMessage('已在这台设备开启通知。');
        void client.invalidateQueries();
      },
    );
  const disable = () =>
    void action.run(
      async () => {
        const registration = await navigator.serviceWorker.getRegistration('/sw.js');
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await api.write('/push/subscriptions/remove', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
      },
      () => {
        action.setMessage('这台设备不再接收通知。');
        void client.invalidateQueries();
      },
    );
  return (
    <section className={`${s.section} ${s.settingsCard}`} aria-labelledby="push-heading">
      <div className={s.sectionHeading}>
        <h2 id="push-heading">手机通知</h2>
        <span className={s.status} data-tone={devices.data?.length ? 'success' : 'neutral'}>
          <i aria-hidden="true" />
          {devices.data?.length ? devices.data.length + ' 台设备' : '未开启'}
        </span>
      </div>
      <p className={s.muted}>
        新邮件、待确认的发送、需要你补充的信息和完成的任务会推送到手机。iPhone 需先用 Safari 打开 https
        地址并“添加到主屏幕”，再从主屏幕打开后开启。
      </p>
      {!supported && <p className={s.notice}>这个浏览器或地址不支持网页推送（需要 HTTPS 与安装后的网页应用）。</p>}
      {supported && !standalone && /iPhone|iPad/.test(navigator.userAgent) && (
        <p className={s.notice}>请先点 Safari 的“分享 → 添加到主屏幕”，再从主屏幕图标打开本页开启通知。</p>
      )}
      <div className={s.toolbar}>
        <button type="button" className={s.primary} disabled={!supported || action.busy} onClick={enable}>
          <Icon name="bell" />
          在这台设备开启通知
        </button>
        <button
          type="button"
          className={s.secondary}
          disabled={action.busy || !devices.data?.length}
          onClick={() =>
            void action.run(
              () => api.write<{ sent: number; failed: number }>('/push/test', {}),
              (result) => action.setMessage(`测试通知：成功 ${result.sent}，失败 ${result.failed}。`),
            )
          }
        >
          发送测试通知
        </button>
        {supported && (
          <button type="button" className={s.textButton} disabled={action.busy} onClick={disable}>
            关闭这台设备
          </button>
        )}
      </div>
      <ErrorNotice error={action.error} />
      {action.message && (
        <p className={s.notice} role="status">
          {action.message}
        </p>
      )}
      {Boolean(devices.data?.length) && (
        <ul className={s.plainList}>
          {devices.data!.map((device) => (
            <li key={device.endpointHost + device.createdAt}>
              {device.label || '设备'} · {device.endpointHost} · 开启于 {date(device.createdAt)}
              {device.lastSuccessAt ? ' · 最近送达 ' + date(device.lastSuccessAt) : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
