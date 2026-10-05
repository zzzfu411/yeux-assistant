import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { IssuedDeviceBridge } from '../../../packages/contracts/src/device-bridge';
import { useAction, useApi } from './api';
import { date, ErrorNotice } from './ui';
import s from './styles.module.css';

export function DeviceConnection() {
  const api = useApi(), action = useAction(), client = useQueryClient();
  const [editing, setEditing] = useState(false), [name, setName] = useState('我的 Mac 音量');
  const [issued, setIssued] = useState<IssuedDeviceBridge | null>(null), [copied, setCopied] = useState(false);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void action.run(() => api.write<IssuedDeviceBridge>('/devices/bridges', { name, adapter: 'macos.audio', expiresInDays: 30 }), value => {
      setIssued(value); setEditing(false); setCopied(false); void client.invalidateQueries();
    });
  };
  const config = issued?.token ? JSON.stringify({ server: window.location.origin, deviceId: issued.deviceId, adapter: issued.adapter, token: issued.token }, null, 2) : '';
  return <section className={s.section} aria-label="设备连接">
    <div className={s.sectionHeading}><h2>连接真实设备</h2><button className={s.secondary} disabled={action.busy || Boolean(issued)} onClick={() => setEditing(!editing)}>{editing ? '收起连接表单' : '连接 Mac'}</button></div>
    <p className={s.muted}>当前支持 Mac 默认输出音量。电脑运行执行器后，选择操作并确认执行。</p>
    {editing && <form className={s.form} onSubmit={connect}>
      <label>连接名称<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="off"/></label>
      <p className={s.muted}>音量范围 0–50%，保持静音设置。连接有效期 30 天，可随时撤销。</p>
      <button className={s.primary} disabled={action.busy || !name.trim()}>{action.busy ? '正在创建连接…' : '生成连接配置'}</button>
    </form>}
    {issued && <div className={s.form} aria-label="设备连接配置">
      {issued.token ? <>
        <p>连接已创建，有效至 {date(issued.expiresAt)}。将配置保存到运行执行器的 Mac，保持这个文件私密。</p>
        <label htmlFor="device-bridge-config">连接配置</label><textarea id="device-bridge-config" className={s.agentToken} rows={8} value={config} readOnly autoFocus spellCheck={false} autoComplete="off"/>
        <div className={s.toolbar}><button className={s.secondary} onClick={() => void action.run(() => navigator.clipboard.writeText(config), () => setCopied(true))}>{copied ? '已复制配置' : '复制配置'}</button><button className={s.textButton} onClick={() => setIssued(null)}>关闭配置显示</button></div>
        <p className={s.muted}>配置仅显示一次。关闭后无法恢复，可撤销此连接再创建。</p>
      </> : <><p role="status">连接已创建，但上次响应未收到。配置无法再次读取，请撤销此连接再创建。</p><button className={s.secondary} disabled={action.busy} onClick={() => void action.run(() => api.write('/devices/' + issued.deviceId + '/revoke-bridge'), () => { setIssued(null); void client.invalidateQueries(); })}>撤销此设备连接</button></>}
    </div>}
    <details><summary>执行器启动说明</summary><div className={s.form}>
      <p>在 Mac 上打开本项目，先安装项目依赖，将连接配置保存为 <code>private/device.json</code>。</p>
      <p><code>pnpm install --frozen-lockfile</code></p><p><code>pnpm device:run --config private/device.json</code></p>
      <p className={s.muted}>保持终端运行；按 Ctrl+C 停止。助手在 VPS 时，配置中的服务地址使用其 HTTPS 地址。设备在线只表示连接正常，操作结果以读回记录为准。</p>
    </div></details>
    <ErrorNotice error={action.error}/>
  </section>;
}
