import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WorkspaceCommitInput, type WorkspaceView } from '../../../packages/contracts/src/workspace';
import { useAction, useApi, useData, useDraft } from './api';
import { ErrorNotice, QueryState } from './ui';
import s from './styles.module.css';

export function WorkspacePanel() {
  const api = useApi(),
    client = useQueryClient(),
    action = useAction(),
    query = useData<WorkspaceView>('/workspace');
  const [message, setMessage, clear] = useDraft('workspace.commit', '');
  const draftRef = useRef(message);
  draftRef.current = message;
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const commit = (event: FormEvent) => {
    event.preventDefault();
    if (!query.data) return;
    const sent = message;
    void action.run(
      () =>
        api.write<{ commitSha: string }>(
          '/workspace/commit',
          WorkspaceCommitInput.parse({ revision: query.data.revision, message: sent }),
        ),
      (result) => {
        if (draftRef.current === sent) clear();
        void client.invalidateQueries();
        action.setMessage('已保存本地版本 ' + result.commitSha.slice(0, 7) + '。');
      },
    );
  };
  return (
    <section className={s.section} aria-labelledby="workspace-heading">
      <h2 id="workspace-heading">规则工作区</h2>
      <p className={s.muted}>确认的规则保存为 Markdown 和本地 Git 版本。手工修改可以先试用，再核对提交。</p>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          <p>
            {query.data.rules} 条文件规则 · {query.data.flows} 个流程 · 版本 {query.data.head.slice(0, 7)}
          </p>
          <div className={s.toolbar}>
            <button
              className={s.textButton}
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () => api.write('/workspace/scan', {}),
                  () => {
                    void client.invalidateQueries();
                    action.setMessage('规则与流程已重新载入。');
                  },
                )
              }
            >
              载入文件修改
            </button>
            <a className={s.textLink} href="#/library?tab=memories">
              编辑记忆与偏好
            </a>
          </div>
          {query.data.locked && <p role="alert">工作区存在 Git 锁。请先在电脑上核实 Git 操作；助手不会删除锁文件。</p>}
          {query.data.changes.length ? (
            <>
              <ul>
                {query.data.changes.map((change) => (
                  <li key={change.path}>
                    <button
                      className={s.textButton}
                      disabled={change.digest === null || action.busy}
                      onClick={() =>
                        void action.run(
                          () => api.get<{ content: string }>('/workspace/file?path=' + encodeURIComponent(change.path)),
                          (value) => setFile({ path: change.path, content: value.content }),
                        )
                      }
                    >
                      {change.path}
                    </button>{' '}
                    <span className={s.muted}>{change.digest === null ? '已删除' : '待提交'}</span>
                  </li>
                ))}
              </ul>
              <form className={s.form} onSubmit={commit}>
                <label>
                  提交说明
                  <input
                    value={message}
                    maxLength={200}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="例如：区分报名截止与活动开始"
                    required
                  />
                </label>
                <button className={s.primary} disabled={action.busy || query.data.locked || !message.trim()}>
                  提交这些修改
                </button>
              </form>
            </>
          ) : (
            <p className={s.muted}>所有修改均已保存到本地 Git。</p>
          )}
          {file && (
            <details className={s.disclosure} open>
              <summary>{file.path}</summary>
              <pre className={s.prewrap}>{file.content}</pre>
            </details>
          )}
        </>
      )}
      <ErrorNotice error={action.error} onReload={() => void query.refetch()} />
      {action.message && (
        <p role="status" className={s.muted}>
          {action.message}
        </p>
      )}
      <details className={s.disclosure}>
        <summary>在电脑上管理文件</summary>
        <p>
          目录为 private/workspace。规则放 rules/，流程放 flows/，本人资料放 profile/，笔记放
          notes/。内容只保存在部署设备；没有自动远程同步。
        </p>
        <p>流程必须使用已登记的步骤；发送、提交的确认和运行预算由程序控制。</p>
      </details>
    </section>
  );
}
