import { researchDetail } from './research/service.js';
import { archiveErrand, createErrand, errandCalendar, errandDetail, flowSuggestion } from './errands/service.js';
import { CreateErrandInput, ErrandActionInput } from '../../contracts/src/errands.js';
import { proposeRule } from './proposals.js';
import { MailInbox } from './mail/inbox.js';
import { openImapFolder, SimulatedMailbox } from './mail/mailbox.js';
import { Push } from './push.js';
import nodemailer from 'nodemailer';
import { Workspace } from './workspace/service.js';
import type { PgBoss } from 'pg-boss';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import {
  CreateGoal,
  UpdateGoal,
  Feedback,
  CreateSession,
  SourceInput,
  SourceUpdateInput,
  SourceArchiveInput,
  MemoryInput,
  ScheduleInput,
  DraftInput,
} from '../../contracts/src/index.js';
import {
  AppError,
  id,
  event,
  once,
  notify,
  requireRow,
  checkVersion,
  goalDTO,
  sessionDTO,
  attemptDTO,
  planDTO,
  iso,
  canonical,
} from './common.js';
import { createRun, createSession, lockSession } from './sessions.js';
export { createRun, createSession, lockSession } from './sessions.js';
import { Knowledge, retrieve } from './knowledge.js';
import { Sources } from './sources.js';
import { config, mailMode, Settings } from './config.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  GoalListQuery,
  SessionListQuery,
  AttemptListQuery,
  type GoalOverview,
  type TodayOverview,
} from '../../contracts/src/pagination.js';
import { digest, sessionSummaryDTO, type CommandBoundary } from './common.js';
import { readRuntimeStatus } from './health.js';
import type { GoalDetail, Today } from '../../contracts/src/index.js';

// Preserve PostgreSQL microseconds; Date.toISOString() would drop cursor precision.
const cursorTime = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const summaryColumns =
  's.id,s.goal_id,s.title,s.kind,s.state,left(s.prompt,160) AS prompt_preview,left(s.error,240) AS error_preview,s.flow,(s.research IS NOT NULL) AS is_research,s.created_at,s.updated_at';
const cursorDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const CursorPayload = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    asOf: cursorDate,
    before: z
      .object({ at: cursorDate, id: z.string().min(1).max(160) })
      .strict()
      .nullable(),
  })
  .strict();
type CursorPayload = z.infer<typeof CursorPayload>;
function encodePage(value: CursorPayload, secret: string) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + createHmac('sha256', secret).update(body).digest('hex');
}
async function pagePosition(
  tx: Tx,
  cursor: string | undefined,
  scope: unknown,
  secret: string,
): Promise<CursorPayload> {
  const scopeHash = digest(scope);
  if (cursor) {
    try {
      const [body, signature] = cursor.split('.');
      if (!body || !signature || signature.length !== 64) throw new Error();
      const expected = createHmac('sha256', secret).update(body).digest('hex');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
      const value = CursorPayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      if (value.scope !== scopeHash) throw new Error();
      return value;
    } catch {
      throw new AppError('分页位置已失效或筛选条件已改变，请刷新列表。', 400, 'invalid_cursor');
    }
  }
  const clock = await tx.one(`SELECT ${cursorTime('clock_timestamp()')} AS at`);
  return { version: 1, scope: scopeHash, asOf: clock!.at, before: null };
}
function pageResult<T>(
  rows: Row[],
  limit: number,
  total: number,
  position: CursorPayload,
  secret: string,
  map: (row: Row) => T,
) {
  const visible = rows.slice(0, limit),
    last = visible.at(-1);
  return {
    items: visible.map(map),
    total,
    pageCursor: encodePage(position, secret),
    nextCursor:
      rows.length > limit && last
        ? encodePage({ ...position, before: { at: last.cursor_at, id: last.id } }, secret)
        : null,
  };
}
const like = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

async function ensureNoPendingSend(tx: Tx, sessionId: string) {
  if (
    await tx.one("SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')", [
      sessionId,
    ])
  )
    throw new AppError('请先处理发送记录，再修改这项任务。', 409, 'action_in_progress');
}
export class Application {
  readonly workspace: Workspace;
  readonly knowledge: Knowledge;
  readonly settings: Settings;
  readonly sourceLibrary: Sources;
  readonly mail: MailInbox;
  readonly push: Push;
  constructor(
    readonly store: Store,
    readonly boss: PgBoss,
    readonly folder: string,
    token: string,
    readonly commandBoundary?: CommandBoundary,
  ) {
    this.workspace = new Workspace(store, folder);
    this.mail = new MailInbox(store, boss, folder);
    this.push = new Push(store, folder);
    this.knowledge = new Knowledge(store, folder);
    this.settings = new Settings(folder, token);
    this.sourceLibrary = new Sources(store, this.knowledge);
  }
  command<T>(key: string, operation: string, input: unknown, work: (tx: Tx) => Promise<T>) {
    return this.store.transaction((tx) =>
      this.commandBoundary
        ? this.commandBoundary(tx, key, operation, input, () => work(tx))
        : once(tx, key, operation, input, () => work(tx)),
    );
  }
  async today(
    summary?: false,
  ): Promise<
    Today &
      Pick<
        TodayOverview,
        'goalTotal' | 'activeGoalTotal' | 'pendingTotal' | 'backgroundIssues' | 'mailWaiting' | 'mailNew' | 'mailMode'
      >
  >;
  async today(summary: true): Promise<TodayOverview>;
  async today(summary = false) {
    const settings = await config(this.folder),
      llm = settings.llm,
      configured = Boolean(llm?.base_url && llm?.model);
    return this.store.snapshot(async (tx) => ({
      ...(summary
        ? {}
        : {
            goals: (
              await tx.rows("SELECT * FROM app.goals WHERE status='active' ORDER BY updated_at DESC,id LIMIT 100")
            ).map(goalDTO),
          }),
      goalTotal: Number((await tx.one('SELECT count(*) n FROM app.goals'))!.n),
      activeGoalTotal: Number((await tx.one("SELECT count(*) n FROM app.goals WHERE status='active'"))!.n),
      backgroundIssues: (await readRuntimeStatus(tx)).issueCount,
      pendingTotal: Number(
        (await tx.one(
          "SELECT count(*) n FROM app.sessions WHERE state IN ('queued','running','waiting_feedback','failed')",
        ))!.n,
      ),
      sessions: (
        await tx.rows(
          `SELECT ${summary ? summaryColumns : 's.*'} FROM app.sessions s WHERE state IN ('queued','running','waiting_feedback','failed') ORDER BY CASE state WHEN 'waiting_feedback' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,updated_at DESC,id LIMIT 3`,
        )
      ).map((row) => (summary ? sessionSummaryDTO(row) : sessionDTO(row))),
      unread: Number((await tx.one('SELECT count(*) AS n FROM app.notifications WHERE read_at IS NULL'))?.n || 0),
      mailWaiting: Number(
        (await tx.one(
          `SELECT count(*) n FROM app.sessions s WHERE s.state='ready' AND s.content<>'' AND (s.flow='mail-reply' OR s.parent_session_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM app.approvals a WHERE a.session_id=s.id AND a.state IN ('approved','executing','sent','resolved_sent'))`,
        ))!.n,
      ),
      mailNew: Number((await tx.one("SELECT count(*) n FROM app.mail_threads WHERE triage='new'"))!.n),
      mailMode: mailMode(settings),
      modelConfigured: configured,
      workerOnline: Boolean(
        await tx.one("SELECT name FROM app.health WHERE name='worker' AND heartbeat>now()-interval '20 seconds'"),
      ),
    }));
  }
  async goals() {
    return (await this.store.rows('SELECT * FROM app.goals ORDER BY created_at DESC,id LIMIT 200')).map(goalDTO);
  }
  async goal(goalId: string, summary?: false): Promise<GoalDetail & { sessionTotal: number; attemptTotal: number }>;
  async goal(goalId: string, summary: true): Promise<GoalOverview>;
  async goal(goalId: string, summary = false) {
    return this.store.snapshot(async (tx) => {
      const goal = await requireRow(tx, 'SELECT * FROM app.goals WHERE id=$1', [goalId]);
      return {
        goal: goalDTO(goal),
        plan: planDTO(await tx.one('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version DESC LIMIT 1', [goalId])),
        sessionTotal: Number((await tx.one('SELECT count(*) n FROM app.sessions WHERE goal_id=$1', [goalId]))!.n),
        attemptTotal: Number(
          (await tx.one(
            'SELECT count(*) n FROM app.attempts a JOIN app.sessions s ON a.session_id=s.id WHERE s.goal_id=$1',
            [goalId],
          ))!.n,
        ),
        ...(summary
          ? {}
          : {
              sessions: (
                await tx.rows('SELECT * FROM app.sessions WHERE goal_id=$1 ORDER BY created_at DESC,id LIMIT 50', [
                  goalId,
                ])
              ).map(sessionDTO),
              attempts: (
                await tx.rows(
                  'SELECT a.* FROM app.attempts a JOIN app.sessions s ON a.session_id=s.id WHERE s.goal_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 100',
                  [goalId],
                )
              ).map(attemptDTO),
            }),
      };
    });
  }
  async goalList(input: unknown = {}) {
    const { cursor, ...filter } = GoalListQuery.parse(input);
    return this.store.snapshot(async (tx) => {
      const position = await pagePosition(tx, cursor, { resource: 'goals', ...filter }, this.settings.token);
      const values = [
        position.asOf,
        filter.status,
        like(filter.q),
        position.before?.at ?? null,
        position.before?.id ?? null,
        filter.limit + 1,
      ];
      const where = "g.created_at<=$1::timestamptz AND ($2='all' OR g.status=$2) AND g.title ILIKE $3";
      const total = Number((await tx.one(`SELECT count(*) n FROM app.goals g WHERE ${where}`, values))!.n);
      const rows = await tx.rows(
        `SELECT g.*,${cursorTime('g.created_at')} AS cursor_at FROM app.goals g WHERE ${where} AND ($4::timestamptz IS NULL OR (g.created_at,g.id)<($4::timestamptz,$5::text)) ORDER BY g.created_at DESC,g.id DESC LIMIT $6`,
        values,
      );
      return pageResult(rows, filter.limit, total, position, this.settings.token, goalDTO);
    });
  }
  async sessionList(input: unknown = {}) {
    const { cursor, ...filter } = SessionListQuery.parse(input);
    return this.store.snapshot(async (tx) => {
      if (filter.goalId) await requireRow(tx, 'SELECT id FROM app.goals WHERE id=$1', [filter.goalId]);
      const position = await pagePosition(tx, cursor, { resource: 'sessions', ...filter }, this.settings.token);
      const values = [
        position.asOf,
        filter.goalId ?? null,
        filter.kind,
        filter.state,
        like(filter.q),
        position.before?.at ?? null,
        position.before?.id ?? null,
        filter.limit + 1,
      ];
      const where =
        "s.created_at<=$1::timestamptz AND ($2::text IS NULL OR s.goal_id=$2) AND ($3='all' OR s.kind=$3) AND ($4='all' OR s.state=$4 OR ($4='pending' AND s.state IN ('queued','running','waiting_feedback','failed'))) AND s.title ILIKE $5";
      const total = Number((await tx.one(`SELECT count(*) n FROM app.sessions s WHERE ${where}`, values))!.n);
      const rows = await tx.rows(
        `SELECT ${summaryColumns},${cursorTime('s.created_at')} AS cursor_at FROM app.sessions s WHERE ${where} AND ($6::timestamptz IS NULL OR (s.created_at,s.id)<($6::timestamptz,$7::text)) ORDER BY s.created_at DESC,s.id DESC LIMIT $8`,
        values,
      );
      return pageResult(rows, filter.limit, total, position, this.settings.token, sessionSummaryDTO);
    });
  }
  async goalAttempts(goalId: string, input: unknown = {}) {
    const { cursor, ...filter } = AttemptListQuery.parse(input);
    return this.store.snapshot(async (tx) => {
      await requireRow(tx, 'SELECT id FROM app.goals WHERE id=$1', [goalId]);
      const position = await pagePosition(
        tx,
        cursor,
        { resource: 'goal-attempts', goalId, ...filter },
        this.settings.token,
      );
      const values = [
        position.asOf,
        goalId,
        position.before?.at ?? null,
        position.before?.id ?? null,
        filter.limit + 1,
      ];
      const total = Number(
        (await tx.one(
          'SELECT count(*) n FROM app.attempts a JOIN app.sessions s ON a.session_id=s.id WHERE a.created_at<=$1::timestamptz AND s.goal_id=$2',
          values,
        ))!.n,
      );
      const rows = await tx.rows(
        `SELECT a.*,${cursorTime('a.created_at')} AS cursor_at FROM app.attempts a JOIN app.sessions s ON a.session_id=s.id WHERE a.created_at<=$1::timestamptz AND s.goal_id=$2 AND ($3::timestamptz IS NULL OR (a.created_at,a.id)<($3::timestamptz,$4::text)) ORDER BY a.created_at DESC,a.id DESC LIMIT $5`,
        values,
      );
      return pageResult(rows, filter.limit, total, position, this.settings.token, attemptDTO);
    });
  }
  async sourceSelection(tx: Tx, ids: string[], retained: string[] = []) {
    if (!ids.length) return;
    const unique = [...new Set(ids)],
      rows = await tx.rows(
        'SELECT id,archived_at,missing_at,path FROM app.sources WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',
        [unique],
      );
    if (
      rows.length !== unique.length ||
      rows.some(
        (row) =>
          (row.archived_at || row.missing_at || row.path?.startsWith('workspace/profile/')) &&
          !retained.includes(row.id),
      )
    )
      throw new AppError('有一份所选资料已归档或不存在，请重新选择。');
  }
  async addGoal(key: string, input: unknown) {
    const data = CreateGoal.parse(input);
    return this.command(key, 'goal.create', data, async (tx) => {
      await this.sourceSelection(tx, data.sourceIds);
      const goalId = id();
      await tx.exec('INSERT INTO app.goals(id,title,outcome,source_ids,intervals) VALUES($1,$2,$3,$4,$5)', [
        goalId,
        data.title,
        data.outcome,
        JSON.stringify(data.sourceIds),
        JSON.stringify(data.intervals),
      ]);
      const created = await createSession(tx, this.boss, {
        goalId,
        title: data.title,
        prompt: data.outcome || data.title,
        kind: 'study',
      });
      await event(tx, 'goal.created', goalId);
      return { goalId, ...created };
    });
  }
  async changeGoal(key: string, goalId: string, input: unknown) {
    const data = UpdateGoal.parse(input);
    return this.command(key, 'goal.update:' + goalId, data, async (tx) => {
      const old = await requireRow(tx, 'SELECT * FROM app.goals WHERE id=$1 FOR UPDATE', [goalId]);
      checkVersion(old, data.revision);
      if (
        await tx.one(
          "SELECT a.id FROM app.approvals a JOIN app.sessions s ON a.session_id=s.id WHERE s.goal_id=$1 AND a.state IN ('approved','executing','uncertain')",
          [goalId],
        )
      )
        throw new AppError('请先处理这个目标的发送记录。', 409, 'action_in_progress');
      await this.sourceSelection(tx, data.sourceIds || old.source_ids, old.source_ids);
      const status = data.status || old.status;
      const changed =
        (data.title !== undefined && data.title !== old.title) ||
        (data.outcome !== undefined && data.outcome !== old.outcome) ||
        (data.sourceIds !== undefined && canonical(data.sourceIds) !== canonical(old.source_ids));
      await tx.exec(
        'UPDATE app.goals SET title=$2,outcome=$3,status=$4,source_ids=$5,intervals=$6,revision=revision+1,updated_at=now() WHERE id=$1',
        [
          goalId,
          data.title ?? old.title,
          data.outcome ?? old.outcome,
          status,
          JSON.stringify(data.sourceIds ?? old.source_ids),
          JSON.stringify(data.intervals ?? old.intervals),
        ],
      );
      if (status !== 'active' || changed) {
        const sessions = await tx.rows(
          "SELECT * FROM app.sessions WHERE goal_id=$1 AND state IN ('queued','running','waiting_feedback') FOR UPDATE",
          [goalId],
        );
        for (const session of sessions) {
          await tx.exec(
            "UPDATE app.runs SET state='cancelled',generation=generation+1,finished_at=now() WHERE session_id=$1 AND state IN ('queued','running')",
            [session.id],
          );
          await tx.exec("UPDATE app.sessions SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1", [
            session.id,
          ]);
          await event(tx, 'session.updated', session.id);
        }
      }
      if (status === 'active' && (old.status !== 'active' || changed)) {
        const title = data.title ?? old.title,
          outcome = data.outcome ?? old.outcome;
        await createSession(tx, this.boss, { goalId, title, prompt: outcome || title, kind: 'study' });
      }
      await event(tx, 'goal.updated', goalId);
      return { goalId, revision: old.revision + 1 };
    });
  }
  async addSession(key: string, input: unknown) {
    const data = CreateSession.parse(input);
    return this.command(key, 'session.create', data, (tx) => createSession(tx, this.boss, data));
  }
  async history(page = 0) {
    return this.store.snapshot(async (tx) => ({
      items: (
        await tx.rows('SELECT * FROM app.sessions ORDER BY created_at DESC,id LIMIT 30 OFFSET $1', [page * 30])
      ).map(sessionDTO),
      total: Number((await tx.one('SELECT count(*) n FROM app.sessions'))?.n),
    }));
  }
  async session(sessionId: string) {
    return this.store.snapshot(async (tx) => ({
      session: sessionDTO(await requireRow(tx, 'SELECT * FROM app.sessions WHERE id=$1', [sessionId])),
      research: await researchDetail(tx, sessionId),
      errand: await errandDetail(tx, sessionId),
      related: (
        await tx.rows(
          `SELECT id,title,state,flow,CASE WHEN id=(SELECT parent_session_id FROM app.sessions WHERE id=$1) THEN 'parent' ELSE 'child' END AS relation
           FROM app.sessions WHERE parent_session_id=$1 OR id=(SELECT parent_session_id FROM app.sessions WHERE id=$1) ORDER BY created_at`,
          [sessionId],
        )
      ).map((r) => ({ id: r.id, title: r.title, state: r.state, flow: r.flow, relation: r.relation })),
      attempts: (
        await tx.rows('SELECT * FROM app.attempts WHERE session_id=$1 ORDER BY created_at,id', [sessionId])
      ).map(attemptDTO),
      artifacts: (
        await tx.rows('SELECT * FROM app.artifacts WHERE session_id=$1 ORDER BY created_at,id', [sessionId])
      ).map((r) => ({
        id: r.id,
        content: r.content,
        kind: r.kind,
        provenance: r.provenance,
        createdAt: iso(r.created_at),
      })),
      approvals: await tx.rows(
        'SELECT id,state,digest,payload,error FROM app.approvals WHERE session_id=$1 ORDER BY created_at DESC',
        [sessionId],
      ),
      ruleUsage: await tx.rows(
        'SELECT u.run_id AS "runId",u.key,u.version,u.commit_sha AS "commitSha",u.content FROM app.rule_usage u JOIN app.runs r ON r.id=u.run_id WHERE r.session_id=$1 ORDER BY r.created_at,u.key',
        [sessionId],
      ),
      legacy:
        (
          await tx.one("SELECT payload FROM app.legacy_rows WHERE table_name='tasks' AND payload->>'id'=$1", [
            sessionId,
          ])
        )?.payload || null,
    }));
  }
  async feedback(key: string, sessionId: string, input: unknown) {
    const data = Feedback.parse(input);
    return this.command(key, 'session.feedback:' + sessionId, data, async (tx) => {
      const session = await lockSession(tx, sessionId);
      checkVersion(session, data.revision);
      await ensureNoPendingSend(tx, sessionId);
      if (session.kind === 'study' && session.state !== 'waiting_feedback')
        throw new AppError(
          ['ready', 'completed'].includes(session.state)
            ? '这轮练习已结束，请返回目标页继续学习。'
            : '当前练习尚不能接收回答。',
          409,
          'state_conflict',
        );
      if (!['waiting_feedback', 'ready', 'completed'].includes(session.state))
        throw new AppError('当前任务尚不能接收回答。', 409, 'state_conflict');
      if (
        session.goal_id &&
        (await tx.one('SELECT status FROM app.goals WHERE id=$1', [session.goal_id]))?.status !== 'active'
      )
        throw new AppError('请先恢复这个目标。', 409);
      if (
        session.goal_id &&
        (await tx.one(
          "SELECT id FROM app.sessions WHERE goal_id=$1 AND id<>$2 AND state IN ('queued','running','waiting_feedback')",
          [session.goal_id, sessionId],
        ))
      )
        throw new AppError('这个目标已有新的学习步骤，请在目标页继续。', 409, 'state_conflict');
      const attemptId = id();
      await tx.exec('INSERT INTO app.attempts(id,session_id,answer,self_report,source) VALUES($1,$2,$3,$4,$5)', [
        attemptId,
        sessionId,
        data.answer,
        data.selfReport || null,
        data.selfReport ? 'user_report' : 'ungraded',
      ]);
      await tx.exec('UPDATE app.sessions SET revision=revision+1 WHERE id=$1', [sessionId]);
      const prior = await tx.one('SELECT graph_thread FROM app.runs WHERE id=$1', [session.current_run_id]);
      const resume = session.state === 'waiting_feedback' && prior;
      const runId = await createRun(tx, this.boss, sessionId, {
        type: resume ? 'feedback' : 'followup',
        attemptId,
        answer: data.answer,
        selfReport: data.selfReport || null,
        freshThread: !resume,
      });
      if (resume) await tx.exec('UPDATE app.runs SET graph_thread=$2 WHERE id=$1', [runId, prior.graph_thread]);
      return { sessionId, runId, attemptId, revision: session.revision + 1 };
    });
  }
  async cancel(key: string, runId: string) {
    return this.command(key, 'run.cancel:' + runId, {}, async (tx) => {
      const run = await requireRow(tx, 'SELECT * FROM app.runs WHERE id=$1', [runId]);
      const session = await lockSession(tx, run.session_id);
      await ensureNoPendingSend(tx, session.id);
      if (['queued', 'running'].includes(run.state) && session.current_run_id === runId) {
        await tx.exec("UPDATE app.runs SET state='cancelled',generation=generation+1,finished_at=now() WHERE id=$1", [
          runId,
        ]);
        await tx.exec("UPDATE app.sessions SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1", [
          session.id,
        ]);
        await event(tx, 'run.cancelled', session.id, { runId });
      }
      return { sessionId: session.id };
    });
  }
  async retry(key: string, sessionId: string, revision: number) {
    return this.command(key, 'session.retry:' + sessionId, { revision }, async (tx) => {
      const session = await lockSession(tx, sessionId);
      checkVersion(session, revision);
      await ensureNoPendingSend(tx, sessionId);
      if (!['failed', 'cancelled'].includes(session.state)) throw new AppError('当前状态无需重试。', 409);
      if (session.goal_id) {
        const goal = await requireRow(tx, 'SELECT * FROM app.goals WHERE id=$1', [session.goal_id]);
        if (
          goal.status !== 'active' ||
          (await tx.one(
            "SELECT id FROM app.sessions WHERE goal_id=$1 AND id<>$2 AND state IN ('queued','running','waiting_feedback')",
            [session.goal_id, sessionId],
          ))
        )
          throw new AppError('请先处理目标中当前的学习步骤。', 409);
      }
      const prior = await tx.one('SELECT * FROM app.runs WHERE id=$1', [session.current_run_id]);
      await tx.exec('UPDATE app.sessions SET revision=revision+1 WHERE id=$1', [sessionId]);
      const runId = await createRun(tx, this.boss, sessionId, {
        type: 'followup',
        answer: prior?.input.answer || '',
        attemptId: prior?.input.attemptId || null,
        freshThread: true,
        // Research continues from the candidates the failed run already saved.
        ...(session.research && prior ? { resumeFrom: prior.id } : {}),
      });
      return { sessionId, runId };
    });
  }
  async archive(key: string, sessionId: string, revision: number) {
    return this.command(key, 'session.archive:' + sessionId, { revision }, async (tx) => {
      const s = await lockSession(tx, sessionId);
      checkVersion(s, revision);
      if (['queued', 'running'].includes(s.state)) throw new AppError('请先停止当前执行。', 409);
      if (
        await tx.one(
          "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",
          [sessionId],
        )
      )
        throw new AppError('请先处理发送记录。', 409);
      await tx.exec("UPDATE app.sessions SET state='archived',revision=revision+1,updated_at=now() WHERE id=$1", [
        sessionId,
      ]);
      await tx.exec(
        'INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)',
        [id(), sessionId, 'archive', s.content, 'user_revision', key],
      );
      await event(tx, 'session.updated', sessionId);
      return { sessionId };
    });
  }
  async saveDraft(key: string, sessionId: string, input: unknown) {
    const data = DraftInput.parse(input);
    return this.command(key, 'session.draft:' + sessionId, data, async (tx) => {
      const s = await lockSession(tx, sessionId);
      checkVersion(s, data.revision);
      if (
        ['running', 'queued'].includes(s.state) ||
        (await tx.one(
          "SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",
          [sessionId],
        ))
      )
        throw new AppError('请先结束运行或处理发送记录。', 409);
      await tx.exec(
        'UPDATE app.sessions SET content=$2,recipient=$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [sessionId, data.content, data.recipient],
      );
      await tx.exec(
        "UPDATE app.approvals SET state='invalidated',error='草稿已修改，请重新核对。' WHERE session_id=$1 AND state='pending'",
        [sessionId],
      );
      await tx.exec(
        'INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)',
        [id(), sessionId, 'draft', data.content, 'user_revision', key],
      );
      await event(tx, 'session.updated', sessionId);
      return { sessionId, revision: s.revision + 1 };
    });
  }
  async sources(archived = false) {
    return this.sourceLibrary.list(archived);
  }
  async source(sourceId: string, version?: number) {
    return this.sourceLibrary.detail(sourceId, version);
  }
  async importSource(key: string, input: unknown) {
    const data = SourceInput.parse(input);
    return this.command(key, 'source.import', data, (tx) => this.sourceLibrary.import(tx, key, data));
  }
  async updateSource(key: string, sourceId: string, input: unknown) {
    const data = SourceUpdateInput.parse(input);
    return this.command(key, 'source.update:' + sourceId, data, (tx) => this.sourceLibrary.update(tx, sourceId, data));
  }
  async archiveSource(key: string, sourceId: string, input: unknown) {
    const data = SourceArchiveInput.parse(input);
    return this.command(key, 'source.archive:' + sourceId, data, (tx) =>
      this.sourceLibrary.archive(tx, sourceId, data),
    );
  }
  async search(query: string, course?: string) {
    return retrieve(this.store, query, [], 20, course);
  }
  async memories() {
    return this.store.rows('SELECT * FROM app.memories ORDER BY updated_at DESC,key');
  }
  async saveMemory(key: string, input: unknown) {
    return this.workspace.rules.save(key, input);
  }
  async schedules() {
    return (await this.store.rows('SELECT * FROM app.schedules ORDER BY created_at,id')).map((r) => ({
      ...r,
      next_run: iso(r.next_run),
    }));
  }
  async saveSchedule(key: string, scheduleId: string | undefined, input: unknown) {
    const data = ScheduleInput.parse(input);
    if (data.intervalSeconds > 0 && data.intervalSeconds < 60) throw new AppError('重复间隔至少为 60 秒。');
    return this.command(key, 'schedule.save:' + (scheduleId || 'new'), data, async (tx) => {
      const old = scheduleId
        ? await requireRow(tx, 'SELECT * FROM app.schedules WHERE id=$1 FOR UPDATE', [scheduleId])
        : null;
      if ((old?.version || 0) !== data.revision)
        throw new AppError('计划已修改，请载入最新版本。', 409, 'version_conflict');
      const identity = scheduleId || id();
      await tx.exec(
        'INSERT INTO app.schedules(id,title,kind,prompt,interval_seconds,next_run,enabled,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,prompt=excluded.prompt,interval_seconds=excluded.interval_seconds,next_run=excluded.next_run,enabled=excluded.enabled,version=excluded.version',
        [
          identity,
          data.title,
          data.kind,
          data.prompt,
          data.intervalSeconds,
          data.nextRun,
          data.enabled,
          data.revision + 1,
        ],
      );
      await event(tx, 'schedule.updated', identity);
      return { id: identity, version: data.revision + 1 };
    });
  }
  async notifications(page = 0) {
    return this.store.snapshot(async (tx) => ({
      items: await tx.rows(
        `SELECT n.*,d.id AS "deviceCommandId" FROM app.notifications n LEFT JOIN app.device_commands d ON d.id=split_part(n.dedupe_key,':',2) AND split_part(n.dedupe_key,':',1)='device-command' ORDER BY n.created_at DESC,n.id LIMIT 30 OFFSET $1`,
        [page * 30],
      ),
      total: Number((await tx.one('SELECT count(*) n FROM app.notifications'))?.n),
    }));
  }
  async readNotification(key: string, identity: string) {
    return this.command(key, 'notification.read:' + identity, {}, async (tx) => {
      await tx.exec('UPDATE app.notifications SET read_at=now() WHERE id=$1', [identity]);
      await event(tx, 'notification.read', identity);
      return { id: identity };
    });
  }
  async events(after: string) {
    return this.store.transaction(async (tx) => {
      // Only publishers lock this row. Business transactions remain independent;
      // an event becomes eligible here only after its transaction has committed.
      const stream = await requireRow(tx, 'SELECT cursor FROM app.event_stream WHERE singleton FOR UPDATE');
      const pending = await tx.rows('SELECT id FROM app.events WHERE stream_id IS NULL ORDER BY id LIMIT 1000');
      let cursor = BigInt(stream.cursor);
      if (pending.length) {
        await tx.exec(
          'UPDATE app.events e SET stream_id=$1::bigint+batch.position FROM unnest($2::bigint[]) WITH ORDINALITY AS batch(id,position) WHERE e.id=batch.id',
          [String(cursor), pending.map((row) => row.id)],
        );
        cursor += BigInt(pending.length);
        await tx.exec('UPDATE app.event_stream SET cursor=$1 WHERE singleton', [String(cursor)]);
      }
      // Restoring a backup can put a browser's durable cursor ahead of this DB.
      if (BigInt(after) > cursor)
        return [
          { id: String(cursor), kind: 'stream.reset', entityId: null, data: {}, createdAt: new Date().toISOString() },
        ];
      return (await tx.rows('SELECT * FROM app.events WHERE stream_id>$1 ORDER BY stream_id LIMIT 100', [after])).map(
        (r) => ({
          id: String(r.stream_id),
          kind: r.kind,
          entityId: r.entity_id,
          data: r.data,
          createdAt: iso(r.created_at),
        }),
      );
    });
  }
  async saveSettings(key: string, input: unknown) {
    return this.command(key, 'settings.model', input, async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock(847392003)');
      return this.settings.save(input, key);
    });
  }
  async saveMailSettings(key: string, input: unknown) {
    return this.command(key, 'settings.mail', input, async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock(847392003)');
      return this.settings.saveMail(input, key);
    });
  }
  /** Checks each step separately and never sends mail; errors stay generic so no server text leaks. */
  async testMail() {
    const settings = await config(this.folder);
    const mode = mailMode(settings);
    if (mode === 'off') throw new AppError('邮箱尚未启用。', 409, 'mail_off');
    if (mode === 'simulation') {
      const box = new SimulatedMailbox(this.folder);
      await box.open('inbox').list(0);
      return { ok: true, message: '模拟邮箱可用：来信保存在本机 private/mail-sim，发送只写入模拟“已发送”。' };
    }
    const steps: string[] = [];
    try {
      const inbox = await openImapFolder(settings, 'inbox', AbortSignal.timeout(20000));
      await inbox?.close();
      steps.push('收件箱可读');
      const sent = await openImapFolder(settings, 'sent', AbortSignal.timeout(20000));
      steps.push(sent ? '已发送文件夹可读' : '未找到已发送文件夹（只同步收件箱）');
      await sent?.close();
    } catch {
      throw new AppError('IMAP 登录或读取失败，请检查地址、端口、账号和客户端专用密码。', 502, 'mail_imap');
    }
    try {
      const transport = nodemailer.createTransport({
        host: settings.smtp_host || 'smtp.exmail.qq.com',
        port: Number(settings.smtp_port || 465),
        secure: true,
        auth: { user: settings.mail_user, pass: settings.mail_password },
        connectionTimeout: 10000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
      });
      await transport.verify();
      transport.close();
      steps.push('SMTP 可登录（未发送任何邮件）');
    } catch {
      throw new AppError('SMTP 登录失败，请检查发信服务器、端口和密码。', 502, 'mail_smtp');
    }
    return { ok: true, message: steps.join('；') + '。' };
  }
  async addErrand(key: string, input: unknown) {
    const data = CreateErrandInput.parse(input);
    return this.command(key, 'errand.create', data, (tx) =>
      createErrand(tx, this.boss, {
        title: data.title,
        text: data.text,
        origin: { kind: 'paste' },
        flow: data.flowId ? { id: data.flowId } : null,
      }),
    );
  }
  async archiveErrand(key: string, sessionId: string, input: unknown) {
    return archiveErrand(this.store, this.folder, key, sessionId, ErrandActionInput.parse(input));
  }
  async errandCalendar(sessionId: string) {
    return this.store.snapshot((tx) => errandCalendar(tx, sessionId));
  }
  async errandFlowDraft(sessionId: string) {
    return this.store.snapshot((tx) => flowSuggestion(tx, sessionId));
  }
  async proposeRule(key: string, sessionId: string, input: unknown) {
    const data = ErrandActionInput.parse(input);
    return proposeRule(this.store, this.folder, this.workspace.rules, key, sessionId, data.revision);
  }
}
