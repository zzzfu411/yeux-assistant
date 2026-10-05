import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Store } from '../../storage/src/index.js';
import { AppError, event } from './common.js';
import { config } from './config.js';
import { Knowledge } from './knowledge.js';
import { MailActions } from './mail.js';
import { LEARNING_QUEUE } from './queue.js';
import { openCheckpoints } from './learning.js';
import { ArtifactExporter, Scheduler } from './scheduler.js';
import { claimRun, failRun, publicRuntimeError, type RunIdentity } from './runtime-state.js';
import { DeviceActions, DEVICE_QUEUE } from './devices/service.js';
import { lockSession } from './sessions.js';

type ChildResult = { ok: boolean; error?: string; permanent?: boolean };
const SLOT_LOCKS = [847392010, 847392011];
export class RunSupervisor {
  readonly children = new Map<string, ChildProcess>();
  readonly pending = new Set<Promise<void>>();
  stopping = false;
  constructor(
    readonly store: Store,
    readonly script = fileURLToPath(
      new URL(`../../../apps/worker/src/run.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url),
    ),
  ) {}
  kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error: any) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
  async handle(runId: string, signal?: AbortSignal) {
    if (this.stopping) throw new Error('Worker stopping');
    const task = this.execute(runId, signal);
    this.pending.add(task);
    try {
      await task;
    } finally {
      this.pending.delete(task);
    }
  }
  private async execute(runId: string, signal?: AbortSignal) {
    const lock = await this.store.pool.connect();
    let slot: number | undefined,
      target = '';
    const killWhenConnectionLost = () => {
      const child = this.children.get(runId);
      if (child) this.kill(child);
    };
    lock.on('error', killWhenConnectionLost);
    try {
      const before = await this.store.one(
        'SELECT s.id,s.goal_id FROM app.sessions s JOIN app.runs r ON r.session_id=s.id WHERE r.id=$1',
        [runId],
      );
      if (!before) return;
      target = before.goal_id ? 'goal:' + before.goal_id : 'session:' + before.id;
      if (!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [target])).rows[0].locked)
        throw new Error('This goal is already running');
      for (const candidate of SLOT_LOCKS) {
        if ((await lock.query('SELECT pg_try_advisory_lock($1) locked', [candidate])).rows[0].locked) {
          slot = candidate;
          break;
        }
      }
      if (slot === undefined) throw new Error('Both execution slots are busy');
      const run = await claimRun(this.store, runId);
      if (!run) return;
      const identity = { runId, generation: run.generation };
      const result = await this.child(identity, new Date(run.deadline).getTime(), signal);
      if (!result.ok) {
        const retry = await failRun(
          this.store,
          identity,
          result.error || '执行中断，当前进度已保留。',
          Boolean(result.permanent),
        );
        if (retry) throw new Error(result.error || 'Execution will retry');
      }
    } finally {
      lock.off('error', killWhenConnectionLost);
      // Session advisory locks outlive individual transactions and are released only after reaping.
      await lock.query('SELECT pg_advisory_unlock_all()').catch(() => {});
      lock.release();
    }
  }
  private child(identity: RunIdentity, deadline: number, signal?: AbortSignal): Promise<ChildResult> {
    return new Promise((resolve) => {
      const child = fork(this.script, [identity.runId, String(identity.generation)], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: process.env,
        execArgv: this.script.endsWith('.ts') ? ['--import', 'tsx'] : [],
      });
      this.children.set(identity.runId, child);
      let result: ChildResult | undefined,
        polling = false,
        closed = false;
      const abort = () => {
        result = {
          ok: false,
          error: this.stopping ? '服务已停止，稍后继续。' : '执行中断，当前进度已保留。',
          permanent: false,
        };
        this.kill(child);
      };
      const timer = setTimeout(
        () => {
          result = { ok: false, error: '本次运行已达到 180 秒上限，请缩小问题后重试。', permanent: true };
          this.kill(child);
        },
        Math.max(1, deadline - Date.now()),
      );
      const poll = setInterval(async () => {
        if (polling || closed) return;
        polling = true;
        try {
          const current = await this.store.one('SELECT state,generation FROM app.runs WHERE id=$1', [identity.runId]);
          if (
            !current ||
            current.generation !== identity.generation ||
            !['running', 'succeeded'].includes(current.state)
          ) {
            result = { ok: false, error: '执行已取消或被新的操作替代。', permanent: true };
            this.kill(child);
          }
        } catch {
          result = { ok: false, error: '数据库连接中断，当前进度已保留。', permanent: false };
          this.kill(child);
        } finally {
          polling = false;
        }
      }, 500);
      child.on('message', (message) => {
        const value = message as ChildResult;
        if (typeof value?.ok === 'boolean' && (!value.error || typeof value.error === 'string')) result = value;
      });
      child.once('error', () => {
        result = { ok: false, error: '执行进程无法启动，请检查运行环境。', permanent: true };
      });
      child.once('close', (code) => {
        closed = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', abort);
        this.children.delete(identity.runId);
        resolve(
          result || {
            ok: false,
            error: code === 124 ? '本次运行已达到时间上限。' : '执行进程已中断，当前进度已保留。',
            permanent: code === 124,
          },
        );
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (this.stopping || signal?.aborted) abort();
    });
  }
  async stop() {
    this.stopping = true;
    for (const child of this.children.values()) this.kill(child);
    await Promise.allSettled([...this.pending]);
  }
}

async function withLock<T>(store: Store, key: number, work: () => Promise<T>) {
  const connection = await store.pool.connect();
  try {
    if (!(await connection.query('SELECT pg_try_advisory_lock($1) locked', [key])).rows[0].locked) return;
    return await work();
  } finally {
    await connection.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    connection.release();
  }
}

/** Call only while holding the exclusive worker ownership lock. No live executor can own these jobs. */
export async function recoverInterruptedRuns(store: Store, boss: PgBoss) {
  const runs = await store.rows(
    "SELECT id,session_id FROM app.runs WHERE state IN ('queued','running') ORDER BY created_at,id",
  );
  for (const candidate of runs)
    await store.transaction(async (tx) => {
      const session = await lockSession(tx, candidate.session_id);
      const run = await tx.one('SELECT * FROM app.runs WHERE id=$1 FOR UPDATE', [candidate.id]);
      if (!run || !['queued', 'running'].includes(run.state) || session.current_run_id !== run.id) return;
      const jobs = await boss.findJobs<{ runId: string }>(LEARNING_QUEUE, { data: { runId: run.id }, db: tx.bossDb });
      const active = jobs.filter((j) => j.state === 'active');
      if (run.state === 'running' || active.length) {
        const replace = jobs.filter((j) => ['active', 'created', 'retry'].includes(j.state));
        if (replace.length)
          await boss.cancel(
            LEARNING_QUEUE,
            replace.map((j) => j.id),
            { db: tx.bossDb },
          );
        await tx.exec("UPDATE app.runs SET state='queued',error='服务曾中断，正在继续。' WHERE id=$1", [run.id]);
        await tx.exec("UPDATE app.sessions SET state='queued',error='',updated_at=now() WHERE id=$1", [session.id]);
        await boss.send(LEARNING_QUEUE, { runId: run.id }, { singletonKey: run.id, db: tx.bossDb });
        await event(tx, 'run.recovered', session.id, { runId: run.id, modelCalls: run.model_calls });
      } else if (!jobs.some((j) => ['created', 'retry'].includes(j.state))) {
        await boss.send(LEARNING_QUEUE, { runId: run.id }, { singletonKey: run.id, db: tx.bossDb });
      }
    });
}

export async function startWorker(store: Store, boss: PgBoss, folder: string) {
  // A personal deployment has one supervisor. PostgreSQL enforces this across accidental double starts.
  const ownership = await store.pool.connect();
  if (!(await ownership.query('SELECT pg_try_advisory_lock(847392007) locked')).rows[0].locked) {
    ownership.release();
    throw new AppError('已有 Worker 正在运行，请使用现有进程。');
  }
  await withLock(store, 847392004, async () => {
    const saver = await openCheckpoints(process.env.DATABASE_URL!, true);
    await saver.end();
  });
  await recoverInterruptedRuns(store, boss);
  const supervisor = new RunSupervisor(store),
    scheduler = new Scheduler(store, boss),
    knowledge = new Knowledge(store, folder),
    exporter = new ArtifactExporter(store, folder),
    mail = new MailActions(store, boss, folder);
  await withLock(store, 847392005, () => mail.recover());
  const devices = new DeviceActions(store, boss);
  await devices.recover();
  let stopping = false,
    heartbeatBusy = false,
    maintenanceError = '';
  let timer: ReturnType<typeof setInterval> | undefined, stopPromise: Promise<void> | undefined;
  const background = new Set<Promise<unknown>>();
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    const task = work();
    background.add(task);
    try {
      return await task;
    } finally {
      background.delete(task);
    }
  };
  const health = async (name: string, error = '') => {
    await store.exec(
      'INSERT INTO app.health(name,heartbeat,error) VALUES($1,now(),$2) ON CONFLICT(name) DO UPDATE SET heartbeat=now(),error=excluded.error',
      [name, error],
    );
  };
  const operation = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
      await health(name);
    } catch (error) {
      await health(name, publicRuntimeError(error));
    }
  };
  await boss.work<{ runId: string }>(
    LEARNING_QUEUE,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      const job = jobs[0];
      if (job) await supervisor.handle(job.data.runId, job.signal);
    },
  );
  await boss.work<{ commandId: string }>(
    DEVICE_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      const job = jobs[0];
      if (job) await track(() => devices.process(job.data.commandId, job.signal));
    },
  );
  await boss.createQueue('mail-poll', { retryLimit: 1, expireInSeconds: 80, policy: 'exclusive' });
  await boss.work('maintenance', { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 }, async () => {
    await track(() =>
      withLock(store, 847392006, async () => {
        await operation('devices', () => devices.sweep());
        await operation('scheduler', () => scheduler.tick());
        await operation('knowledge', () => knowledge.scan());
        await operation('exports', () => exporter.tick());
        // Recover queued but unconsumed approvals too; sendOne rechecks exact content and state.
        const approved = await store.one(
          "SELECT id FROM app.approvals WHERE state='approved' ORDER BY created_at,id LIMIT 1",
        );
        if (
          (approved || mail.pending.size) &&
          !(await boss.findJobs('mail-send', { key: 'outbox-sweep', queued: true })).length
        ) {
          await boss.send('mail-send', {}, { singletonKey: 'outbox-sweep' });
        }
      }),
    );
  });
  await boss.work<{ approvalId?: string }>(
    'mail-send',
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      await track(() =>
        operation('mail-send', () => withLock(store, 847392005, () => mail.sendOne(jobs[0]?.data.approvalId))),
      );
    },
  );
  await boss.work('mail-poll', { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 }, async () => {
    await track(() =>
      operation('mail-poll', () =>
        withLock(store, 847392008, async () => {
          const settings = await config(folder);
          if (settings.poll_mail && settings.mail_user && settings.mail_password) await mail.poll();
        }),
      ),
    );
  });
  const heartbeat = async () => {
    if (stopping || heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await health('worker', maintenanceError);
      await boss.send('maintenance', {}, { singletonKey: 'periodic', singletonSeconds: 10 });
      await boss.send('mail-poll', {}, { singletonKey: 'periodic', singletonSeconds: 60 });
      maintenanceError = '';
    } catch {
      maintenanceError = '后台暂时无法连接数据库，稍后重试。';
    } finally {
      heartbeatBusy = false;
    }
  };
  const stop = () =>
    (stopPromise ||= (async () => {
      stopping = true;
      clearInterval(timer);
      await supervisor.stop();
      await boss.stop({ graceful: true, timeout: 80000 });
      // Retain the ownership lock until any bounded SMTP/IMAP work and receipt writes settle.
      await Promise.allSettled([...background]);
      await store.exec("DELETE FROM app.health WHERE name='worker'").catch(() => {});
      await ownership.query('SELECT pg_advisory_unlock_all()').catch(() => {});
      ownership.release();
    })());
  ownership.on('error', () => {
    process.exitCode = 1;
    void stop().finally(() => store.close());
  });
  await heartbeat();
  timer = setInterval(() => void heartbeat(), 5000);
  return { supervisor, stop };
}
