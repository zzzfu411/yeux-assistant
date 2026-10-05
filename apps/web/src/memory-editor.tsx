import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MemoryInput } from '../../../packages/contracts/src/index';
import { useAction, useApi, useDraft } from './api';
import { date, ErrorNotice } from './ui';
import s from './styles.module.css';

export type Memory = {
  key: string;
  scope: string;
  content: string;
  version: number;
  confirmed: boolean;
  enabled: boolean;
  updated_at: string;
};
export const scopeNames: Record<string, string> = {
  preference: '偏好',
  fact: '本人信息',
  correction: '纠正',
  all: '全部任务',
  study: '学习',
  work: '工作',
  manage: '管理',
};
export function MemoryEditor({
  memory,
  done,
  draftKey = 'new',
  initialScope = 'preference',
}: {
  memory: Memory | null;
  done: (saved?: boolean) => void;
  draftKey?: string;
  initialScope?: string;
}) {
  const api = useApi(),
    client = useQueryClient(),
    action = useAction(),
    [history, setHistory] = useState<Array<{
      version: number;
      snapshot: Record<string, unknown>;
      created_at: string;
    }> | null>(null);
  const [draft, setDraft, clear] = useDraft('memory.' + (memory?.key || draftKey), {
    key: memory?.key || 'preference-' + crypto.randomUUID(),
    content: memory?.content || '',
    scope: memory?.scope || initialScope,
    confirmed: memory?.confirmed ?? true,
    enabled: memory?.enabled ?? true,
    revision: memory?.version || 0,
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const sent = draft;
    void action.run(
      () => api.write<{ version: number }>('/memories', MemoryInput.parse(sent)),
      (result) => {
        void client.invalidateQueries();
        if (JSON.stringify(draftRef.current) === JSON.stringify(sent)) {
          clear();
          done(true);
        } else {
          setDraft((current) => ({ ...current, revision: result.version }));
          action.setMessage('已保存上次提交，继续编辑的内容仍在。');
        }
      },
    );
  };
  const reload = () =>
    void action.run(
      () => api.get<Memory[]>('/memories'),
      (rows) => {
        const updated = rows.find((row) => row.key === draft.key);
        if (updated) setDraft((current) => ({ ...current, revision: updated.version }));
        action.setMessage('已载入最新版本，输入已保留。');
      },
    );
  return (
    <form className={s.form} onSubmit={save}>
      <label>
        内容
        <textarea
          rows={4}
          maxLength={30000}
          required
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      </label>
      <label>
        用途
        <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
          {Object.entries(scopeNames).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={draft.confirmed}
          onChange={(e) => setDraft({ ...draft, confirmed: e.target.checked })}
        />
        这是我确认的信息
      </label>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        在后续学习中使用
      </label>
      <ErrorNotice error={action.error} onReload={reload} />
      {action.message && (
        <p className={s.muted} role="status">
          {action.message}
        </p>
      )}
      <div className={s.toolbar}>
        <button className={s.primary} disabled={action.busy || !draft.content.trim()}>
          保存偏好
        </button>
        <button type="button" className={s.textButton} onClick={() => done()}>
          关闭
        </button>
        {memory && (
          <button
            type="button"
            className={s.textButton}
            onClick={() =>
              void action.run(
                () =>
                  api.get<Array<{ version: number; snapshot: Record<string, unknown>; created_at: string }>>(
                    '/memories/' + encodeURIComponent(memory.key) + '/history',
                  ),
                setHistory,
              )
            }
          >
            查看历史
          </button>
        )}
      </div>
      {history && (
        <div>
          {history.map((item) => (
            <div className={s.evidence} key={item.version}>
              <p>
                第 {item.version} 版 · {date(item.created_at)}
              </p>
              <p className={s.prewrap}>{String(item.snapshot.content || '')}</p>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
