import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ErrandDetail } from '../../../packages/contracts/src/errands';
import type { LearningSession } from '../../../packages/contracts/src/index';
import { useAction, useApi, useData } from './api';
import { ErrorNotice, Status } from './ui';
import { Icon } from './icons';
import s from './styles.module.css';
import { refresh } from './live';

const labels = {
  organizer: '主办方',
  eventStart: '活动开始',
  eventEnd: '活动结束',
  registrationDeadline: '报名截止',
  submissionDeadline: '提交截止',
  location: '地点',
  contact: '联系方式',
} as const;
const stepNames: Record<string, string> = {
  extract_notice: '抽取要素',
  retrieve: '查个人资料',
  ask_user: '向我追问',
  draft_mail: '准备邮件',
  ehall_prepare: 'ehall（暂缓）',
  calendar: '日历提醒',
  archive: '归档记录',
};
const statusMark = { ready: ['已有', 'success'], missing: ['缺少', 'danger'], check: ['待确认', 'accent'] } as const;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A seal stamped on the sheet for where the errand stands; finished facts only, never a guess. */
function Seal({ errand, session }: { errand: ErrandDetail; session: LearningSession }) {
  const [text, tone] = errand.archivedPath
    ? ['已归档', 'success']
    : ['queued', 'running'].includes(session.state)
      ? ['办理中', 'info']
      : session.state === 'failed'
        ? ['需处理', 'danger']
        : errand.state.questions.length
          ? ['待补充', 'annot']
          : ['ready', 'completed'].includes(session.state)
            ? ['已备妥', 'success']
            : ['', ''];
  return text ? (
    <span className={s.seal} data-tone={tone} role="status">
      {text}
    </span>
  ) : null;
}

/** Facts with their original sentences, the checklist, produced actions and archiving. */
export function ErrandPanel({ errand, session }: { errand: ErrandDetail; session: LearningSession }) {
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [flowDraft, setFlowDraft] = useState<FlowDraft | null>(null);
  const { state, notice } = errand;
  const facts = state.facts;
  const busy = ['queued', 'running'].includes(session.state);
  const done = state.steps.filter((step) =>
    step === 'extract_notice'
      ? Boolean(facts)
      : step === 'retrieve'
        ? Boolean(state.plan)
        : step === 'ask_user'
          ? state.answers.length > 0 || (Boolean(state.plan) && !state.questions.length)
          : step === 'draft_mail'
            ? Boolean(errand.mailSession) || (Boolean(state.plan) && !state.plan?.mail.needed)
            : step === 'calendar'
              ? Boolean(facts)
              : step === 'archive'
                ? Boolean(errand.archivedPath)
                : false,
  );
  return (
    <section className={s.errand} aria-label="通知办理">
      <ol className={s.stepTrack} aria-label="办理步骤">
        {state.steps.map((step, index) => {
          const status = done.includes(step)
            ? 'done'
            : busy && index === done.length
              ? 'current'
              : step === 'ask_user' && state.questions.length
                ? 'current'
                : 'idle';
          return (
            <li key={step} data-status={status}>
              <i aria-hidden="true">{status === 'done' ? <Icon name="check" /> : index + 1}</i>
              {stepNames[step] || step}
            </li>
          );
        })}
      </ol>
      {notice.flow && (
        <p className={s.marginNote}>
          按流程「{notice.flow.title}」v{notice.flow.version} 办理
        </p>
      )}
      {facts && (
        <div className={s.factSheet}>
          <p className={s.sheetSerial} aria-hidden="true">
            办 事 单 · No. {session.id.slice(0, 6).toUpperCase()}
          </p>
          <Seal errand={errand} session={session} />
          <h2>通知要素</h2>
          <p className={s.muted}>每一项都核对过通知原文：日期必须出现在引文中，截止时间不会被当作活动时间。</p>
          <dl>
            {(Object.keys(labels) as Array<keyof typeof labels>).map((key) =>
              facts[key].value ? (
                <div key={key}>
                  <dt>{labels[key]}</dt>
                  <dd>
                    <strong>{facts[key].value}</strong>
                    {facts[key].note && <em>{facts[key].note}</em>}
                    <q>{facts[key].quote}</q>
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
          {facts.unknowns.length > 0 && (
            <div className={s.annotation}>
              <strong>未能确认</strong>
              <ul>
                {facts.unknowns.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {notice.sourceId && (
            <a className={s.textLink} href={'#/source/' + encodeURIComponent(notice.sourceId)}>
              查看通知原文（已存入资料库）
            </a>
          )}
        </div>
      )}
      {state.plan && state.plan.checklist.length > 0 && (
        <div className={s.checklist}>
          <h2>材料与条件</h2>
          <ul>
            {state.plan.checklist.map((item, index) => (
              <li key={index} data-status={item.status}>
                <span className={s.status} data-tone={statusMark[item.status][1]}>
                  <i aria-hidden="true" />
                  {statusMark[item.status][0]}
                </span>
                <span>
                  <strong>{item.item}</strong>
                  {item.note && <small>{item.note}</small>}
                  {item.sourceIds.map((id) => (
                    <a key={id} href={'#/source/' + encodeURIComponent(id)}>
                      依据
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.questions.length > 0 && (
        <div className={s.questions} role="note">
          <h2>需要你补充</h2>
          <ol>
            {state.questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ol>
          <p className={s.muted}>在下方“补充信息”里回答，助手会据此更新清单和邮件草稿。</p>
        </div>
      )}
      {state.warnings.length > 0 && (
        <div className={s.notice}>
          {state.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
      {(errand.mailSession || state.calendar.length > 0) && (
        <div className={s.outputs}>
          <h2>产出</h2>
          <div className={s.outputGrid}>
            {errand.mailSession && (
              <a className={s.outputCard} href={'#/session/' + encodeURIComponent(errand.mailSession.id)}>
                <Icon name="mail" />
                <span className={s.outputText}>
                  <strong>邮件草稿</strong>
                  <small>发给 {errand.mailSession.recipient} · 需要你核对后发送</small>
                </span>
                <Status state={errand.mailSession.state} />
              </a>
            )}
            {state.calendar.length > 0 && (
              <button
                type="button"
                className={s.outputCard}
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => api.downloadBlob('/sessions/' + encodeURIComponent(session.id) + '/errand/calendar'),
                    (blob) => download(blob, (notice.title || '办事').slice(0, 40) + '.ics'),
                  )
                }
              >
                <Icon name="today" />
                <span className={s.outputText}>
                  <strong>日历文件（.ics）</strong>
                  <small>
                    {state.calendar.map((event) => event.title + ' ' + event.at.replace('T', ' ')).join('；')}
                  </small>
                </span>
                <Icon name="download" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className={s.toolbar}>
        {errand.archivedPath ? (
          <p className={s.stamp} data-tone="success">
            已归档 · {errand.archivedPath}
            {errand.archivedCommit ? ' · ' + errand.archivedCommit.slice(0, 7) : ''}
          </p>
        ) : (
          <button
            className={s.primary}
            disabled={action.busy || busy || session.state === 'waiting_feedback' || !state.plan}
            onClick={() =>
              void action.run(
                () =>
                  api.write('/sessions/' + encodeURIComponent(session.id) + '/errand/archive', {
                    revision: session.revision,
                  }),
                () => void refresh(client, '/sessions', '/today', '/sources', '/mail'),
              )
            }
          >
            <Icon name="check" />
            完成并归档
          </button>
        )}
        <button
          className={s.secondary}
          disabled={action.busy || !facts}
          onClick={() =>
            void action.run(
              () => api.get<FlowDraft>('/sessions/' + encodeURIComponent(session.id) + '/errand/flow-draft'),
              setFlowDraft,
            )
          }
        >
          <Icon name="branch" />
          保存为流程
        </button>
      </div>
      {!errand.archivedPath && (
        <p className={s.muted}>
          归档会把要素、你的补充、清单和邮件结果写成 Markdown，提交到私密 Git，并加入资料库供以后检索。
        </p>
      )}
      <ErrorNotice error={action.error} />
      {flowDraft && <FlowEditor draft={flowDraft} done={() => setFlowDraft(null)} />}
    </section>
  );
}

type FlowDraft = {
  revision: number;
  definition: {
    id: string;
    title: string;
    version: number;
    enabled: boolean;
    trigger: { manual: boolean; mail?: { subject_any: string[] } };
    steps: string[];
  };
  instructions: string;
};
const editableSteps = ['retrieve', 'ask_user', 'draft_mail', 'calendar'];

export function FlowEditor({ draft, done }: { draft: FlowDraft; done: () => void }) {
  const api = useApi(),
    action = useAction(),
    client = useQueryClient();
  const [value, setValue] = useState({
    id: draft.definition.id,
    title: draft.definition.title,
    keywords: draft.definition.trigger.mail?.subject_any.join('，') || '',
    steps: draft.definition.steps.filter((step) => editableSteps.includes(step)),
    instructions: draft.instructions,
    enabled: draft.definition.enabled,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const keywords = value.keywords
      .split(/[,，、\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    void action.run(
      () =>
        api.write('/flows', {
          revision: draft.revision,
          instructions: value.instructions,
          definition: {
            id: value.id,
            title: value.title,
            version: draft.definition.version,
            enabled: value.enabled,
            trigger: { manual: true, ...(keywords.length ? { mail: { subject_any: keywords } } : {}) },
            steps: ['extract_notice', ...editableSteps.filter((step) => value.steps.includes(step)), 'archive'],
          },
        }),
      () => {
        void refresh(client, '/flows', '/workspace', '/today');
        action.setMessage('流程已保存并提交到私密 Git。首页“常用流程”可以直接使用它。');
      },
    );
  };
  return (
    <form className={`${s.form} ${s.flowEditor}`} onSubmit={submit} aria-label="保存为流程">
      <h3>保存为流程 · 第 {draft.definition.version} 版</h3>
      <div className={s.formGrid}>
        <label>
          流程标识
          <input
            required
            pattern="[a-z0-9][a-z0-9._-]{0,99}"
            value={value.id}
            onChange={(e) => setValue({ ...value, id: e.target.value })}
            disabled={draft.revision > 0}
          />
        </label>
        <label>
          名称
          <input
            required
            maxLength={100}
            value={value.title}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
        </label>
      </div>
      <fieldset className={s.fieldset}>
        <legend>步骤（抽取要素与归档固定保留；确认发送不能关闭）</legend>
        <div className={s.checkRow}>
          {editableSteps.map((step) => (
            <label className={s.check} key={step}>
              <input
                type="checkbox"
                checked={value.steps.includes(step)}
                onChange={(e) =>
                  setValue({
                    ...value,
                    steps: e.target.checked ? [...value.steps, step] : value.steps.filter((item) => item !== step),
                  })
                }
              />
              <span>{stepNames[step]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        邮件主题关键词（命中后自动按此流程办理，留空则只手动使用）
        <input
          value={value.keywords}
          maxLength={400}
          onChange={(e) => setValue({ ...value, keywords: e.target.value })}
          placeholder="例如：报名，申请，材料提交"
        />
      </label>
      <label>
        流程说明（作为这个流程的规则交给助手）
        <textarea
          rows={4}
          maxLength={12000}
          value={value.instructions}
          onChange={(e) => setValue({ ...value, instructions: e.target.value })}
        />
      </label>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
        />
        <span>启用</span>
      </label>
      <ErrorNotice error={action.error} />
      {action.message && (
        <p className={s.notice} role="status">
          {action.message}
        </p>
      )}
      <div className={s.toolbar}>
        <button className={s.primary} disabled={action.busy || Boolean(action.message)}>
          保存并提交到 Git
        </button>
        <button type="button" className={s.textButton} onClick={done}>
          关闭
        </button>
      </div>
    </form>
  );
}

type FlowRow = {
  id: string;
  version: number;
  enabled: boolean;
  commit_sha: string | null;
  definition: FlowDraft['definition'] & { instructions?: string };
};
export function FlowList({ compact = false }: { compact?: boolean }) {
  const query = useData<FlowRow[]>('/flows');
  const flows = (query.data || []).filter((flow) => flow.enabled);
  if (compact && !flows.length) return null;
  return (
    <section className={compact ? s.flowPanel : s.section} aria-label="常用流程">
      <div className={s.sectionHeading}>
        <h2>常用流程</h2>
        <a className={s.textLink} href="#/settings?view=workspace">
          管理
        </a>
      </div>
      {flows.length ? (
        <ul className={s.flowList}>
          {flows.map((flow) => (
            <li key={flow.id}>
              <a href={'#/today?mode=errand&flow=' + encodeURIComponent(flow.id)}>
                <Icon name="branch" />
                <span>
                  <strong>{flow.definition.title}</strong>
                  <small>
                    {flow.definition.steps.map((step) => stepNames[step] || step).join(' → ')}
                    {flow.definition.trigger.mail
                      ? ' · 邮件主题含“' + flow.definition.trigger.mail.subject_any.join('/') + '”时自动'
                      : ''}
                  </small>
                </span>
                <Icon name="arrow" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.empty}>还没有流程。办完一次通知后点“保存为流程”，以后同类通知就能直接套用。</p>
      )}
    </section>
  );
}
