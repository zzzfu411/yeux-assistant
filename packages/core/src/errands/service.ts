import type { PgBoss } from 'pg-boss';
import type { Store, Tx, Row } from '../../../storage/src/index.js';
import type { Citation } from '../../../contracts/src/index.js';
import {
  ModelErrandMail,
  ModelErrandPlan,
  ModelNoticeFacts,
  type ErrandDetail,
  type ErrandNotice,
  type ErrandState,
} from '../../../contracts/src/errands.js';
import { AppError, checkVersion, digest, event, id, notify, once } from '../common.js';
import { createRun, FLOW_CALL_TIMEOUT_MS, lockSession } from '../sessions.js';
import { putSource, retrieve } from '../knowledge.js';
import { ModelGateway, type ModelContext } from '../model.js';
import { fence, step, type RunIdentity } from '../runtime-state.js';
import { WorkspaceRepo, WORKSPACE_LOCK } from '../workspace/repo.js';
import { replyContext, replySubject } from '../mail/thread.js';
import { factLabels, replyTarget, verifyFacts } from './facts.js';
import { calendarEvents, toICS } from './calendar.js';
import { flowSlug, recordName, subjectKeywords } from './naming.js';

export const DEFAULT_STEPS = ['extract_notice', 'retrieve', 'ask_user', 'draft_mail', 'calendar', 'archive'];
const RULE_SCOPES = ['all', 'preference', 'fact', 'correction', 'work', 'errand', 'mail'];
const emptyState = (steps: string[]): ErrandState => ({
  version: 1,
  facts: null,
  warnings: [],
  plan: null,
  questions: [],
  answers: [],
  calendar: [],
  mailSessionId: null,
  steps,
});
const bounded = (text: string, size: number) =>
  text.length <= size ? text : text.slice(0, size) + '\n…（后文已截断）';

export async function createErrand(
  tx: Tx,
  boss: PgBoss,
  input: {
    title: string;
    text: string;
    origin: ErrandNotice['origin'];
    flow?: { id: string; version?: number } | null;
  },
) {
  const flowRow = input.flow ? await tx.one('SELECT * FROM app.flows WHERE id=$1 AND enabled', [input.flow.id]) : null;
  if (input.flow && !flowRow) throw new AppError('流程不存在或已停用，请在“规则与流程”检查。', 409, 'flow_unavailable');
  const flow = flowRow
    ? {
        id: flowRow.id as string,
        version: flowRow.version as number,
        title: flowRow.definition.title as string,
        steps: flowRow.definition.steps as string[],
        instructions: String(flowRow.definition.instructions || ''),
      }
    : null;
  const title = (input.title.trim() || input.text.trim().split(/\r?\n/)[0] || '办理通知').slice(0, 120);
  let sourceId: string | null = null,
    sourceVersion: number | null = null;
  if (input.origin.kind === 'paste') {
    // The notice itself is personal data: keep the original text searchable and citable.
    const saved = await putSource(tx, {
      id: 'notice-' + digest(input.text).slice(0, 24),
      title: '通知 · ' + title,
      content: input.text,
    });
    sourceId = saved.id;
    sourceVersion = saved.version;
  } else if (input.origin.kind === 'mail' && input.origin.messageId) {
    const message = await tx.one(
      'SELECT m.source_id,s.version FROM app.mail_messages m LEFT JOIN app.sources s ON s.id=m.source_id WHERE m.id=$1',
      [input.origin.messageId],
    );
    sourceId = message?.source_id || null;
    sourceVersion = message?.version || null;
  }
  const notice: ErrandNotice = { title, text: input.text, sourceId, sourceVersion, origin: input.origin, flow };
  const sessionId = id();
  await tx.exec(
    `INSERT INTO app.sessions(id,title,kind,prompt,flow,flow_id,flow_version) VALUES($1,$2,'work',$3,'errand',$4,$5)`,
    [sessionId, title, input.text, flow?.id || null, flow?.version || null],
  );
  await tx.exec('INSERT INTO app.errands(session_id,notice,state) VALUES($1,$2,$3)', [
    sessionId,
    JSON.stringify(notice),
    JSON.stringify(emptyState(flow?.steps || DEFAULT_STEPS)),
  ]);
  const runId = await createRun(tx, boss, sessionId, { type: 'initial' });
  await event(tx, 'errand.created', sessionId, { flow: flow?.id || null });
  return { sessionId, runId };
}

const EXTRACT =
  'ERRAND_EXTRACT\n从通知原文抽取要素。每个值都要给出 quote：从原文逐字摘录的一句话，不得改写。' +
  '日期写成 YYYY-MM-DD 或 YYYY-MM-DD HH:MM；原文没有的信息填 null 并写进 unknowns，不要猜测。' +
  '报名截止、材料提交截止、活动开始、活动结束必须分开：截止时间不是活动开始时间。materials 是需要本人准备的材料；actions 是需要本人做的事及途径。';
const PLAN =
  'ERRAND_PLAN\n根据已核验的通知要素、本人补充和给定的个人资料，准备办理清单。' +
  'summary 用一两句话（不超过 150 字）说明要做什么、最晚何时；每条 note 不超过 60 字。' +
  'checklist 逐项说明材料或条件：资料中能找到的标 ready 并给 sourceIds；找不到的标 missing；需要本人确认的标 check。' +
  'questions 只问办理所必需、资料中确实没有的信息，最多 4 个；已在“本人补充”里回答过的不要再问。' +
  '如果通知要求用邮件报名、回复或提交，mail.needed=true 并给出主题（按通知对主题的要求）；正文之后单独撰写，这里不要写。否则 needed=false。' +
  '不得声称已经提交、发送或办理完成。';
const DRAFT =
  'ERRAND_MAIL\n按通知要求写这封邮件。主题沿用给定主题，除非通知对主题格式另有要求；落款用资料中的本人姓名。' +
  '资料和本人补充里没有的个人信息不要编造，用【待填：…】标出。收件人由程序确定，正文不要写邮箱。' +
  '不得声称附上了资料中没有的附件，也不得声称已经提交或办理完成。';

function render(notice: ErrandNotice, state: ErrandState) {
  const facts = state.facts;
  const lines: string[] = [];
  if (state.plan) lines.push(state.plan.summary, '');
  if (facts) {
    lines.push('## 通知要素（均附原文依据）', '', '| 项目 | 内容 | 原文 |', '| --- | --- | --- |');
    for (const key of Object.keys(factLabels) as Array<keyof typeof factLabels>) {
      const field = facts[key];
      if (field.value)
        lines.push(
          `| ${factLabels[key]} | ${field.value}${field.note ? `（${field.note}）` : ''} | “${field.quote.replace(/\|/g, '｜').replace(/\n/g, ' ')}” |`,
        );
    }
    if (facts.unknowns.length) lines.push('', '**待确认**：' + facts.unknowns.join('；'));
  }
  if (state.plan?.checklist.length) {
    lines.push('', '## 材料与条件', '');
    const mark = { ready: '✅ 已有', missing: '⬜ 缺少', check: '❓ 待确认' } as const;
    for (const item of state.plan.checklist)
      lines.push(`- ${mark[item.status]} **${item.item}**${item.note ? '：' + item.note : ''}`);
  }
  if (state.plan?.todos.length) {
    lines.push('', '## 待办', '');
    for (const todo of state.plan.todos) lines.push(`- [ ] ${todo.title}${todo.due ? `（${todo.due}）` : ''}`);
  }
  if (state.questions.length) {
    lines.push('', '## 需要你补充', '');
    state.questions.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
  }
  if (state.warnings.length) lines.push('', '> ' + state.warnings.join('\n> '));
  lines.push(
    '',
    `<sub>通知原文已保存${notice.sourceId ? '到个人资料库' : ''}；清单与草稿由助手生成，提交和发送前请本人核对。</sub>`,
  );
  return lines.join('\n').trim();
}

async function rulesFor(tx: Tx, notice: ErrandNotice) {
  const memories = await tx.rows(
    'SELECT * FROM app.memories WHERE enabled AND confirmed AND scope = ANY($1::text[]) ORDER BY key',
    [RULE_SCOPES],
  );
  const rules = memories.map((m) => m.key + ': ' + m.content);
  const ruleRecords = memories.map((m) => ({
    key: m.key,
    version: m.version,
    commitSha: m.commit_sha ?? null,
    content: m.content,
  }));
  if (notice.flow?.instructions)
    rules.push(`流程「${notice.flow.title}」v${notice.flow.version}：${notice.flow.instructions.slice(0, 3000)}`);
  return { rules, ruleRecords };
}

async function writeState(tx: Tx, sessionId: string, state: ErrandState) {
  await tx.exec('UPDATE app.errands SET state=$2,revision=revision+1,updated_at=now() WHERE session_id=$1', [
    sessionId,
    JSON.stringify(state),
  ]);
  await event(tx, 'errand.progress', sessionId, { facts: Boolean(state.facts) });
}
async function saveState(store: Store, identity: RunIdentity, state: ErrandState) {
  await store.transaction(async (tx) => writeState(tx, (await fence(tx, identity)).session.id, state));
}
/** Facts are always re-verified against the notice, so better checks apply to saved extractions too. */
function withFacts(
  state: ErrandState,
  extracted: ErrandState['extracted'],
  text: string,
  steps: string[],
): ErrandState {
  const facts = verifyFacts(extracted!, text);
  return { ...state, extracted, facts, calendar: steps.includes('calendar') ? calendarEvents(facts) : [] };
}

/** The owner's own edits and anything already confirmed are never overwritten. */
async function letterLocked(tx: Tx, mailSessionId: string, lock = false) {
  const child = await tx.one('SELECT * FROM app.sessions WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [mailSessionId]);
  const edited = await tx.one("SELECT id FROM app.artifacts WHERE session_id=$1 AND provenance='user_revision'", [
    mailSessionId,
  ]);
  const sending = await tx.one(
    "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('pending','approved','executing','uncertain','sent')",
    [mailSessionId],
  );
  return { child, locked: !child || Boolean(edited) || Boolean(sending) || child.state !== 'ready' };
}
/** Asking the model for a letter that would not replace the current one only costs time. */
async function letterTaken(store: Store, mailSessionId: string | null) {
  return mailSessionId ? (await store.transaction((tx) => letterLocked(tx, mailSessionId))).locked : false;
}

/** Create or refresh the confirmable email that the notice asks for. It never sends by itself. */
async function upsertMailDraft(tx: Tx, parent: Row, notice: ErrandNotice, state: ErrandState) {
  const mail = state.plan?.mail;
  if (!mail?.needed || !mail.to || !mail.body.trim()) return state.mailSessionId;
  const reply =
    notice.origin.kind === 'mail' && notice.origin.messageId
      ? await tx.one('SELECT * FROM app.mail_messages WHERE id=$1', [notice.origin.messageId])
      : null;
  const subject = reply ? replySubject(reply.subject) : mail.subject.trim() || '关于“' + notice.title + '”';
  if (state.mailSessionId) {
    const { child, locked } = await letterLocked(tx, state.mailSessionId, true);
    if (child && !locked) {
      await tx.exec(
        'UPDATE app.sessions SET title=$2,content=$3,recipient=$4,revision=revision+1,updated_at=now() WHERE id=$1',
        [child.id, subject, mail.body, mail.to],
      );
      await tx.exec(
        "INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,'mail_draft',$3,'model_generated',$4) ON CONFLICT(dedupe_key) DO NOTHING",
        [id(), child.id, mail.body, 'errand-mail:' + digest([child.id, mail.body])],
      );
    }
    return state.mailSessionId;
  }
  const childId = id();
  await tx.exec(
    `INSERT INTO app.sessions(id,title,kind,prompt,state,content,recipient,flow,mail,parent_session_id)
     VALUES($1,$2,'work',$3,'ready',$4,$5,$6,$7,$8)`,
    [
      childId,
      subject,
      '由办事「' + notice.title + '」生成的邮件草稿',
      mail.body,
      mail.to,
      reply ? 'mail-reply' : null,
      reply
        ? JSON.stringify(replyContext(reply.thread_id, { references: reply.references_ids }, reply.message_id))
        : null,
      parent.id,
    ],
  );
  await tx.exec(
    "INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,'mail_draft',$3,'model_generated',$4)",
    [id(), childId, mail.body, 'errand-mail:' + digest([childId, mail.body])],
  );
  if (reply)
    await tx.exec("UPDATE app.mail_threads SET triage='errand',revision=revision+1,updated_at=now() WHERE id=$1", [
      reply.thread_id,
    ]);
  await event(tx, 'session.updated', childId);
  return childId;
}

export async function executeErrandRun(store: Store, folder: string, identity: RunIdentity) {
  const model = new ModelGateway(store, folder, identity);
  const loaded = await store.transaction(async (tx) => {
    const { session, run } = await fence(tx, identity);
    const errand = await tx.one('SELECT * FROM app.errands WHERE session_id=$1', [session.id]);
    if (!errand) throw new AppError('办事记录缺失，无法继续。', 409, 'errand_missing');
    const attempt = run.input.attemptId
      ? await tx.one('SELECT * FROM app.attempts WHERE id=$1 AND session_id=$2', [run.input.attemptId, session.id])
      : null;
    return { session, run, errand, attempt, ...(await rulesFor(tx, errand.notice as ErrandNotice)) };
  });
  const notice = loaded.errand.notice as ErrandNotice;
  let state = structuredClone(loaded.errand.state as ErrandState);
  const steps = state.steps.length ? state.steps : DEFAULT_STEPS;
  // A retried run reloads saved state; the same answer is recorded once.
  if (loaded.attempt && !state.answers.some((item) => item.attemptId === loaded.attempt!.id))
    state.answers.push({
      answer: loaded.attempt.answer,
      at: new Date(loaded.attempt.created_at).toISOString(),
      attemptId: loaded.attempt.id,
    });
  const base: Omit<ModelContext, 'sources'> = {
    task: '办理通知：' + notice.title,
    latest: '',
    previous: '',
    rules: loaded.rules,
    ruleRecords: loaded.ruleRecords,
    notes: [],
  };
  let citations: Citation[] = [];
  if (await model.configured()) {
    if (!state.facts) {
      const latest = '通知原文：\n' + bounded(notice.text, 12000);
      const raw = await step(
        store,
        identity,
        'extract',
        { input: [EXTRACT, latest, base.rules] },
        () =>
          model.json(
            ModelNoticeFacts,
            EXTRACT,
            { ...base, latest, sources: [] },
            { timeoutMs: FLOW_CALL_TIMEOUT_MS, reserveMs: 5000, profile: 'extract' },
          ),
        // The facts and the receipt commit together, so a replay never extracts twice.
        (tx, value, { session }) => writeState(tx, session.id, withFacts(state, value, notice.text, steps)),
      );
      state = withFacts(state, raw, notice.text, steps);
    } else if (state.extracted) {
      state.facts = verifyFacts(state.extracted, notice.text);
      state.calendar = steps.includes('calendar') ? calendarEvents(state.facts) : [];
    }
    const facts = state.facts!;
    const query = [
      facts.title,
      ...facts.materials.map((m) => m.name),
      ...facts.actions.map((a) => a.action),
      ...state.answers.map((a) => a.answer),
    ].join(' ');
    const retrieved = steps.includes('retrieve')
      ? (
          await store.transaction(async (tx) => {
            await fence(tx, identity);
            return retrieve(tx, query, [], 8, undefined, 'errand');
          })
        ).filter((c) => c.sourceId !== notice.sourceId)
      : [];
    const compactFacts = Object.fromEntries(
      (Object.keys(factLabels) as Array<keyof typeof factLabels>)
        .filter((key) => facts[key].value)
        .map((key) => [factLabels[key], facts[key].value]),
    );
    const known = [
      '已核验的通知要素：' +
        JSON.stringify({
          标题: facts.title,
          ...compactFacts,
          材料: facts.materials.map((m) => m.name),
          待确认: facts.unknowns,
        }),
      state.answers.length ? '本人补充：\n' + state.answers.map((a, i) => `${i + 1}. ${a.answer}`).join('\n') : '',
      '通知原文：\n' + bounded(notice.text, 6000),
    ]
      .filter(Boolean)
      .join('\n\n');
    // The plan depends on the verified facts, answers, retrieved material and rules. A retry of the
    // same run replays its receipt; a restarted run reuses it only while those inputs are unchanged.
    const drafted = await step(
      store,
      identity,
      'plan',
      { input: [PLAN, known, retrieved.map((c) => [c.sourceId, c.version, c.start, c.end]), base.rules, steps] },
      async () => {
        const call = await model.call(
          ModelErrandPlan,
          PLAN,
          { ...base, latest: known, previous: state.plan?.summary || '', sources: retrieved },
          { timeoutMs: FLOW_CALL_TIMEOUT_MS, reserveMs: 5000, profile: 'plan' },
        );
        return { plan: call.value, provided: call.providedCitations };
      },
    );
    const plan = drafted.plan;
    const provided = new Set(drafted.provided.map((c) => c.sourceId));
    // An address the owner typed in an answer also counts; sending still needs exact approval.
    const answered = state.answers
      .flatMap((a) => a.answer.normalize('NFKC').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
      .at(-1)
      ?.toLowerCase();
    const to = replyTarget(facts, notice.text, notice.origin) ?? answered ?? null;
    const wantsMail = plan.mail.needed && steps.includes('draft_mail');
    let questions = steps.includes('ask_user') ? plan.questions : [];
    // The recipient question goes first so the four-question limit never drops it.
    if (wantsMail && !to) questions = ['通知中没有写明可回复的邮箱，邮件应发给谁？', ...questions].slice(0, 4);
    state.warnings =
      steps.includes('ask_user') || !plan.questions.length
        ? []
        : ['流程未包含追问步骤，以下信息需要自行核对：' + plan.questions.join('；')];
    if (notice.flow?.steps.includes('ehall_prepare'))
      state.warnings.push('ehall 步骤本轮暂未接入，未准备任何 ehall 表单。');
    const checklist = plan.checklist.map((item) => ({
      ...item,
      sourceIds: item.sourceIds.filter((sid) => provided.has(sid)),
    }));
    state.plan = {
      ...plan,
      checklist,
      // Keep the previous letter until a new one is written, so nothing blank reaches the draft.
      mail: { ...plan.mail, needed: wantsMail, to, body: state.plan?.mail.body || '' },
    };
    state.questions = questions;
    citations = drafted.provided.filter((c) => checklist.some((item) => item.sourceIds.includes(c.sourceId)));
    // The checklist is useful on its own: show it while the letter is being written.
    if (wantsMail && !questions.length) await saveState(store, identity, state);
    const mail = state.plan!.mail;
    // Write the letter only when nothing is left to ask and the owner has not taken it over.
    if (mail.needed && mail.to && !state.questions.length && !(await letterTaken(store, state.mailSessionId))) {
      const latest = [
        known,
        '邮件主题：' + (mail.subject || notice.title),
        '材料清单：' + state.plan!.checklist.map((item) => `${item.item}（${item.status}）`).join('；'),
      ].join('\n\n');
      const letter = await step(
        store,
        identity,
        'mail',
        { input: [DRAFT, latest, retrieved.map((c) => [c.sourceId, c.version, c.start, c.end]), base.rules] },
        () =>
          model.json(
            ModelErrandMail,
            DRAFT,
            { ...base, latest, previous: '', sources: retrieved },
            { timeoutMs: FLOW_CALL_TIMEOUT_MS, reserveMs: 5000, profile: 'draft' },
          ),
      );
      state.plan!.mail = { ...mail, subject: letter.subject, body: letter.body };
    }
  } else {
    state.warnings = ['尚未连接模型：通知原文已保存，连接模型后点“重新准备”即可抽取要素和清单。'];
  }
  await store.transaction(async (tx) => {
    const { session, run } = await fence(tx, identity);
    if (!state.questions.length) state.mailSessionId = await upsertMailDraft(tx, session, notice, state);
    await tx.exec('UPDATE app.errands SET state=$2,revision=revision+1,updated_at=now() WHERE session_id=$1', [
      session.id,
      JSON.stringify(state),
    ]);
    const content = render(notice, state);
    await tx.exec(
      "INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,citations,dedupe_key) VALUES($1,$2,$3,'response',$4,'model_generated',$5,$6) ON CONFLICT(dedupe_key) DO NOTHING",
      [id(), session.id, run.id, content, JSON.stringify(citations), 'errand:' + run.id],
    );
    await tx.exec(
      "UPDATE app.sessions SET content=$2,citations=$3,state=$4,error='',revision=revision+1,updated_at=now() WHERE id=$1",
      [session.id, content, JSON.stringify(citations), state.questions.length ? 'waiting_feedback' : 'ready'],
    );
    if (run.input.attemptId)
      await tx.exec(
        "UPDATE app.attempts SET verdict='unclear',feedback='已作为办事补充信息处理，不是学习评估。',source='ungraded' WHERE id=$1 AND session_id=$2",
        [run.input.attemptId, session.id],
      );
    await tx.exec("UPDATE app.runs SET state='succeeded',finished_at=now(),error='' WHERE id=$1", [run.id]);
    await notify(
      tx,
      'errand:' + run.id,
      session.id,
      state.questions.length ? '办事需要你补充信息' : '办事清单已准备好',
      state.questions.length ? state.questions[0]!.slice(0, 120) : notice.title,
    );
    await event(tx, 'run.finished', session.id, { runId: run.id });
  });
}

export async function errandDetail(tx: Tx, sessionId: string): Promise<ErrandDetail | null> {
  const row = await tx.one('SELECT * FROM app.errands WHERE session_id=$1', [sessionId]);
  if (!row) return null;
  const state = row.state as ErrandState;
  const mail = state.mailSessionId
    ? await tx.one('SELECT id,title,state,recipient FROM app.sessions WHERE id=$1', [state.mailSessionId])
    : null;
  return {
    notice: row.notice,
    state,
    archivedPath: row.archived_path,
    archivedCommit: row.archived_commit,
    revision: row.revision,
    mailSession: mail ? { id: mail.id, title: mail.title, state: mail.state, recipient: mail.recipient } : null,
  };
}

export async function errandCalendar(tx: Tx, sessionId: string) {
  const row = await tx.one('SELECT * FROM app.errands WHERE session_id=$1', [sessionId]);
  const state = row?.state as ErrandState | undefined;
  if (!state?.calendar.length) throw new AppError('这项办事没有可导出的日期。', 404, 'no_calendar');
  return toICS(sessionId, state.calendar, state.facts?.location.value || null);
}

function recordText(session: Row, notice: ErrandNotice, state: ErrandState, mail: Row | null, sent: Row | null) {
  const facts = state.facts;
  const lines = [
    `# 办事记录：${notice.title}`,
    '',
    `- 记录时间：${new Date().toISOString()}`,
    `- 会话：${session.id}`,
    notice.sourceId ? `- 通知原文：资料 ${notice.sourceId}（第 ${notice.sourceVersion} 版）` : '- 通知原文：见下方摘录',
    notice.flow ? `- 使用流程：${notice.flow.title}（${notice.flow.id} v${notice.flow.version}）` : '',
    '',
    '## 事实：通知要素（原文摘录）',
    '',
  ];
  if (facts)
    for (const key of Object.keys(factLabels) as Array<keyof typeof factLabels>)
      if (facts[key].value) lines.push(`- ${factLabels[key]}：${facts[key].value} ——“${facts[key].quote}”`);
  if (facts?.unknowns.length) lines.push('', '未能确认：' + facts.unknowns.join('；'));
  if (state.answers.length) {
    lines.push('', '## 事实：本人补充', '');
    for (const answer of state.answers) lines.push(`- ${answer.at.slice(0, 16)}：${answer.answer}`);
  }
  lines.push('', '## 生成：材料清单与待办（助手生成，已由本人核对后归档）', '');
  for (const item of state.plan?.checklist || [])
    lines.push(`- [${item.status === 'ready' ? 'x' : ' '}] ${item.item}${item.note ? '：' + item.note : ''}`);
  for (const todo of state.plan?.todos || []) lines.push(`- [ ] ${todo.title}${todo.due ? `（${todo.due}）` : ''}`);
  lines.push('', '## 动作', '');
  if (mail)
    lines.push(
      `- 邮件：${mail.title} → ${mail.recipient}；状态：${sent ? '已发送，Message-ID ' + sent.message_id : mail.state}`,
    );
  if (state.calendar.length)
    lines.push(`- 日历：${state.calendar.map((e) => e.title + ' ' + e.at).join('；')}（.ics 由本人导入）`);
  if (!mail && !state.calendar.length) lines.push('- 无对外动作');
  return lines.filter((line, index, all) => line || all[index - 1] !== '').join('\n') + '\n';
}

/** Write a readable record into the private Git workspace and index it as personal data. */
export async function archiveErrand(
  store: Store,
  folder: string,
  key: string,
  sessionId: string,
  input: { revision: number },
) {
  const repo = new WorkspaceRepo(folder);
  return store.transaction(async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
    return once(tx, key, 'errand.archive:' + sessionId, input, async () => {
      const session = await lockSession(tx, sessionId);
      checkVersion(session, input.revision);
      const row = await tx.one('SELECT * FROM app.errands WHERE session_id=$1 FOR UPDATE', [sessionId]);
      if (!row || session.flow !== 'errand') throw new AppError('这不是办事记录。', 404);
      if (row.archived_path) return { path: row.archived_path, commit: row.archived_commit };
      if (!['ready', 'completed'].includes(session.state))
        throw new AppError('请先回答待补充的问题，或等待准备完成后再归档。', 409, 'state_conflict');
      const notice = row.notice as ErrandNotice,
        state = row.state as ErrandState;
      const mail = state.mailSessionId
        ? (await tx.one('SELECT * FROM app.sessions WHERE id=$1', [state.mailSessionId])) || null
        : null;
      if (
        mail &&
        (await tx.one(
          "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",
          [mail.id],
        ))
      )
        throw new AppError('邮件正在发送或待核实，请处理后再归档。', 409, 'state_conflict');
      const sent = mail
        ? (await tx.one(
            "SELECT message_id FROM app.approvals WHERE session_id=$1 AND state IN ('sent','resolved_sent') ORDER BY finished_at DESC LIMIT 1",
            [mail.id],
          )) || null
        : null;
      const replay = await repo.findCommitByTrailer(digest(key));
      const day = new Date().toISOString().slice(0, 10);
      const path =
        replay?.fields['Yeux-Path'] ||
        `records/${day.slice(0, 4)}/${day.slice(5)}-${recordName(notice.title, 'errand-' + sessionId.slice(0, 8))}.md`;
      const text = recordText(session, notice, state, mail, sent);
      let commit = replay?.hash || '';
      if (!replay) {
        const status = await repo.status();
        if (status.locked) throw new AppError('工作区有残留的 Git 锁，请先处理。', 409, 'workspace_changed');
        await repo.write(path, text);
        commit = await repo.commitFiles([path], 'record: ' + notice.title.slice(0, 80), {
          'Yeux-Command': digest(key),
          'Yeux-Path': path,
        });
      }
      const sourcePath = 'workspace/' + path;
      // Same id the workspace scanner derives, so the later scan does not create a duplicate.
      await putSource(tx, {
        id: 'file-' + digest(sourcePath).slice(0, 24),
        title: '办事记录 · ' + notice.title,
        content: replay ? await repo.read(path) : text,
        path: sourcePath,
      });
      await tx.exec(
        'UPDATE app.errands SET archived_path=$2,archived_commit=$3,revision=revision+1,updated_at=now() WHERE session_id=$1',
        [sessionId, path, commit],
      );
      await tx.exec("UPDATE app.sessions SET state='completed',revision=revision+1,updated_at=now() WHERE id=$1", [
        sessionId,
      ]);
      await notify(tx, 'errand-archived:' + sessionId, sessionId, '办事已归档', path);
      await event(tx, 'session.updated', sessionId);
      return { path, commit };
    });
  });
}

/** A starting point for "save as flow": the steps this errand actually used, ready for the owner to edit. */
export async function flowSuggestion(tx: Tx, sessionId: string) {
  const row = await tx.one('SELECT * FROM app.errands WHERE session_id=$1', [sessionId]);
  if (!row) throw new AppError('这不是办事记录。', 404);
  const notice = row.notice as ErrandNotice,
    state = row.state as ErrandState;
  const flowId = notice.flow?.id || flowSlug(notice.title, 'notice-' + digest(notice.title).slice(0, 8));
  const existing = await tx.one('SELECT version,definition FROM app.flows WHERE id=$1', [flowId]);
  const steps = [
    'extract_notice',
    'retrieve',
    ...(state.answers.length || state.questions.length ? ['ask_user'] : []),
    ...(state.mailSessionId || state.plan?.mail.needed ? ['draft_mail'] : []),
    ...(state.calendar.length ? ['calendar'] : []),
    'archive',
  ];
  // Saving an existing flow again keeps the keywords its owner chose.
  const kept = existing?.definition?.trigger?.mail?.subject_any;
  const keywords: string[] = Array.isArray(kept) ? kept : subjectKeywords(notice.title);
  return {
    revision: existing?.version || 0,
    definition: {
      id: flowId,
      title: (notice.flow?.title || notice.title).slice(0, 100),
      version: (existing?.version || 0) + 1,
      enabled: true,
      trigger: { manual: true, ...(keywords.length ? { mail: { subject_any: keywords } } : {}) },
      steps,
    },
    instructions:
      notice.flow?.instructions ||
      '处理同类通知时：截止时间与活动时间分开记录；材料先从 profile/ 与最近的 records/ 查找；缺少信息先问我，不要猜；邮件落款使用资料中的本人姓名。',
  };
}
