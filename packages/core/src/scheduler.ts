import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PgBoss } from 'pg-boss';
import type { Store } from '../../storage/src/index.js';
import { createSession } from './sessions.js';
import { AppError, event, notify } from './common.js';

export function nextScheduledTime(due: Date, intervalSeconds: number, now = new Date()) {
  if (!intervalSeconds) return due;
  const interval = intervalSeconds * 1000;
  return new Date(due.getTime() + (Math.max(0, Math.floor((now.getTime() - due.getTime()) / interval)) + 1) * interval);
}

export class Scheduler {
  constructor(
    readonly store: Store,
    readonly boss: PgBoss,
  ) {}
  async tick() {
    const due = await this.store
      .rows(`SELECT p.id FROM app.schedules p LEFT JOIN app.sessions s ON s.id=p.active_session
      WHERE p.enabled AND p.next_run<=now() AND NOT (coalesce(s.state IN ('queued','running','waiting_feedback'),false)
        AND (p.prompt<>s.prompt OR p.kind<>s.kind OR p.title<>s.title)) ORDER BY p.next_run,p.id LIMIT 50`);
    for (const item of due) {
      try {
        await this.store.transaction(async (tx) => {
          const schedule = await tx.one(
            'SELECT * FROM app.schedules WHERE id=$1 AND enabled AND next_run<=now() FOR UPDATE SKIP LOCKED',
            [item.id],
          );
          if (!schedule) return;
          if (!['study', 'work', 'manage'].includes(schedule.kind))
            throw new AppError('计划类型无法识别，请编辑这个计划。');
          const active = schedule.active_session
            ? await tx.one('SELECT * FROM app.sessions WHERE id=$1', [schedule.active_session])
            : undefined;
          const open = active && ['queued', 'running', 'waiting_feedback'].includes(active.state);
          if (
            open &&
            (active.prompt !== schedule.prompt || active.kind !== schedule.kind || active.title !== schedule.title)
          )
            return;
          let sessionId = active?.id || null;
          if (!open)
            sessionId = (
              await createSession(tx, this.boss, {
                title: schedule.title,
                prompt: schedule.prompt,
                kind: schedule.kind,
              })
            ).sessionId;
          const next = nextScheduledTime(new Date(schedule.next_run), schedule.interval_seconds);
          await tx.exec('UPDATE app.schedules SET active_session=$2,next_run=$3,enabled=$4 WHERE id=$1', [
            schedule.id,
            sessionId,
            next,
            Boolean(schedule.interval_seconds),
          ]);
          await event(tx, 'schedule.triggered', schedule.id, {
            sessionId,
            coalesced: Boolean(open),
            version: schedule.version,
          });
        });
      } catch (error) {
        await this.store.transaction((tx) =>
          notify(
            tx,
            `schedule-error:${item.id}`,
            null,
            '有一个计划需要处理',
            error instanceof AppError ? error.message : '计划暂未执行，请检查设置。',
          ),
        );
      }
    }
    const goals = await this.store.rows(`SELECT g.id FROM app.goals g WHERE g.status='active' AND g.next_review<=now()
      AND NOT EXISTS(SELECT 1 FROM app.sessions s WHERE s.goal_id=g.id AND s.state IN ('queued','running','waiting_feedback'))
      ORDER BY g.next_review,g.id LIMIT 20`);
    for (const item of goals) {
      try {
        await this.store.transaction(async (tx) => {
          const goal = await tx.one(
            "SELECT * FROM app.goals WHERE id=$1 AND status='active' AND next_review<=now() FOR UPDATE SKIP LOCKED",
            [item.id],
          );
          if (
            !goal ||
            (await tx.one(
              "SELECT id FROM app.sessions WHERE goal_id=$1 AND state IN ('queued','running','waiting_feedback')",
              [item.id],
            ))
          )
            return;
          const session = await createSession(tx, this.boss, {
            title: goal.title,
            prompt: goal.outcome || goal.title,
            kind: 'study',
            goalId: goal.id,
          });
          await tx.exec('UPDATE app.goals SET next_review=NULL,updated_at=now() WHERE id=$1', [goal.id]);
          await event(tx, 'review.queued', goal.id, { sessionId: session.sessionId });
        });
      } catch {
        await this.store.transaction((tx) =>
          notify(tx, `review-error:${item.id}`, null, '一项复习暂未准备', '进度已保留，稍后会重试。'),
        );
      }
    }
  }
}

export class ArtifactExporter {
  readonly exported = new Set<string>();
  constructor(
    readonly store: Store,
    readonly folder: string,
  ) {}
  async tick() {
    const directory = join(this.folder, 'artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifacts = await this.store.rows('SELECT id,content FROM app.artifacts ORDER BY created_at,id');
    for (const artifact of artifacts) {
      if (this.exported.has(artifact.id)) continue;
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(artifact.id)) continue;
      const target = join(directory, 'v2-' + artifact.id + '.md');
      try {
        await writeFile(target, artifact.content, { flag: 'wx', mode: 0o600 });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if ((await readFile(target, 'utf8')) !== artifact.content)
          throw new AppError('导出文件存在本地修改，已保留原文件。');
      }
      this.exported.add(artifact.id);
    }
  }
}
