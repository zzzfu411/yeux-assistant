import { useEffect, useState } from 'react';
import type { Device, DeviceCommand } from '../../../packages/contracts/src/devices';
import { EhallPrepare, EhallSubmit, EhallState, ehallProfile } from '../../../packages/contracts/src/ehall';
import { useApi, useDraft } from './api';
import s from './styles.module.css';

export function EhallForm({
  device,
  disabled,
  preview,
}: {
  device: Device;
  disabled: boolean;
  preview: (capability: string, args: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useDraft('ehall-form.' + device.id, { applicant: '', purpose: '' });
  return (
    <form
      className={s.form}
      onSubmit={(event) => {
        event.preventDefault();
        preview('ehall.form.prepare', {
          profile: ehallProfile.id,
          profileVersion: '1',
          fields: draft,
          sources: { applicant: '本人填写', purpose: '本人填写' },
        });
      }}
    >
      <h3>模拟在读证明</h3>
      <p className={s.muted}>填写合成示例，体验准备、预览和确认提交。此入口不连接学校账号。</p>
      <label>
        申请人
        <input
          required
          maxLength={80}
          value={draft.applicant}
          onChange={(e) => setDraft({ ...draft, applicant: e.target.value })}
          placeholder="示例同学"
        />
      </label>
      <label>
        申请用途
        <textarea
          required
          maxLength={300}
          rows={3}
          value={draft.purpose}
          onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
          placeholder="课程实验演示"
        />
      </label>
      <button className={s.secondary} disabled={disabled || !draft.applicant.trim() || !draft.purpose.trim()}>
        准备表单
      </button>
    </form>
  );
}
function Evidence({ commandId, digest }: { commandId: string; digest: string }) {
  const api = useApi(),
    [url, setUrl] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true,
      objectUrl = '';
    const controller = new AbortController();
    void api
      .request<Blob>('/device-commands/' + encodeURIComponent(commandId) + '/evidence/' + digest, {
        blob: true,
        signal: controller.signal,
      })
      .then((blob) => {
        if (live) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, commandId, digest]);
  return url ? (
    <img className={s.ehallEvidence} src={url} alt="模拟 ehall 页面核验截图" />
  ) : (
    <p role="status">{failed ? '截图暂时无法载入，可刷新页面重试。' : '正在载入核验截图…'}</p>
  );
}
export function EhallPreview({
  command,
  onSubmit,
  disabled,
}: {
  command: DeviceCommand;
  onSubmit?: (args: Record<string, unknown>) => void;
  disabled: boolean;
}) {
  const [reviewed, setReviewed] = useState(false);
  const prepared = EhallPrepare.safeParse(command.arguments),
    submission = EhallSubmit.safeParse(command.arguments);
  const data = prepared.success ? prepared.data : submission.success ? submission.data : null;
  const state = EhallState.safeParse(command.receipt?.after);
  const digest = state.success
    ? state.data.screenshotDigest
    : submission.success
      ? submission.data.screenshotDigest
      : undefined;
  const evidenceCommand =
    state.success && state.data.screenshotDigest
      ? command.id
      : submission.success
        ? submission.data.preparedCommandId
        : command.id;
  return (
    <section className={s.form} aria-label="ehall 表单预览">
      {data && (
        <>
          <dl className={s.ehallFields}>
            <dt>事务</dt>
            <dd>模拟在读证明 · 配置 v1</dd>
            <dt>申请人</dt>
            <dd>
              {data.fields.applicant}
              <small>本人填写</small>
            </dd>
            <dt>用途</dt>
            <dd>
              {data.fields.purpose}
              <small>本人填写</small>
            </dd>
            <dt>附件</dt>
            <dd>无（本轮模拟不上传附件）</dd>
          </dl>
          <p className={s.notice}>{ehallProfile.consequences}</p>
        </>
      )}
      {state.success && state.data.rows && (
        <ul>
          {state.data.rows.map((row, i) => (
            <li key={i}>
              {row.course} · {row.time}
            </li>
          ))}
        </ul>
      )}
      {state.success && state.data.application && <p role="status">申请状态：{state.data.application.state}</p>}
      {digest && (
        <details>
          <summary>查看页面截图</summary>
          <Evidence commandId={evidenceCommand} digest={digest} />
        </details>
      )}
      {onSubmit && data && state.success && state.data.formDigest && state.data.screenshotDigest && (
        <>
          <label className={s.ehallConfirm}>
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
            已核对字段与后果，准备提交模拟申请
          </label>
          <button
            className={s.primary}
            disabled={disabled || !reviewed}
            onClick={() =>
              onSubmit({
                ...data,
                preparedCommandId: command.id,
                formDigest: state.data.formDigest,
                screenshotDigest: state.data.screenshotDigest,
              })
            }
          >
            生成提交确认
          </button>
        </>
      )}
    </section>
  );
}
