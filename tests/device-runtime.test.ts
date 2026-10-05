import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { Store } from '../packages/storage/src/index.js';
import { createBoss } from '../packages/core/src/queue.js';
import { initializeData } from '../packages/core/src/config.js';
import { DeviceActions, DEVICE_QUEUE } from '../packages/core/src/devices/service.js';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitUntil(predicate: () => Promise<boolean> | boolean, message: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(30);
  }
  throw new Error(message);
}
async function stopChild(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  child.kill(signal);
  try {
    await waitUntil(exited, 'Worker did not stop', signal === 'SIGKILL' ? 3000 : 5000);
  } catch {
    child.kill('SIGKILL');
    await waitUntil(exited, 'Worker did not exit after SIGKILL', 3000);
  }
}

// Uses the production Worker entry point and its registered simulator. Fault injection is
// confined to PostgreSQL row locks and a write-audit trigger in this disposable database.
describe.runIf(Boolean(url))('device recovery through a real Worker process', () => {
  let store: Store, boss: Awaited<ReturnType<typeof createBoss>>, devices: DeviceActions, folder: string;
  let blocker: PoolClient | undefined;
  let worker: ChildProcess | undefined;
  let output = '';
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test'))
      throw new Error('An isolated *_runtime_test database is required');
    store = new Store(url!);
    await store.exec('DROP SCHEMA IF EXISTS device_runtime_test CASCADE');
    await store.exec('DROP SCHEMA IF EXISTS checkpoints CASCADE');
    await store.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    boss = await createBoss(url!, false);
    folder = await mkdtemp(join(tmpdir(), 'yeux-device-worker-'));
    await initializeData(folder);
    devices = new DeviceActions(store, boss);
    await store.exec('CREATE SCHEMA device_runtime_test');
    await store.exec('CREATE TABLE device_runtime_test.writes(device_id text NOT NULL, power boolean NOT NULL)');
    await store.exec(`CREATE FUNCTION device_runtime_test.record_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO device_runtime_test.writes VALUES(NEW.device_id,NEW.power); RETURN NEW; END $$`);
    await store.exec(
      'CREATE TRIGGER device_runtime_test_write AFTER UPDATE OF power ON app.device_simulation_state FOR EACH ROW EXECUTE FUNCTION device_runtime_test.record_write()',
    );
  });
  afterEach(async () => {
    // Terminate the child before releasing the lock, even when an assertion fails.
    if (worker) await stopChild(worker, 'SIGKILL');
    worker = undefined;
    if (blocker) {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      blocker = undefined;
    }
    await boss?.stop();
    if (store) {
      await store.exec('DROP SCHEMA IF EXISTS device_runtime_test CASCADE');
      await store.exec('DROP SCHEMA IF EXISTS checkpoints CASCADE');
      await store.exec('DROP SCHEMA IF EXISTS queue CASCADE');
      await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
      await store.close();
    }
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  function launchWorker(applicationName: string) {
    const connection = new URL(url!);
    connection.searchParams.set('application_name', applicationName);
    output = '';
    worker = spawn(process.execPath, ['--import', 'tsx', resolve('apps/worker/src/main.ts')], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connection.href, ASSISTANT_DATA: folder },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    };
    worker.stdout?.on('data', capture);
    worker.stderr?.on('data', capture);
    worker.once('error', (error) => {
      output += error.message;
    });
  }
  const command = (id: string) => store.one('SELECT * FROM app.device_commands WHERE id=$1', [id]);
  const state = (deviceId: string) =>
    store.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [deviceId]);
  const writes = async (deviceId: string) =>
    Number((await store.one('SELECT count(*) n FROM device_runtime_test.writes WHERE device_id=$1', [deviceId]))!.n);
  async function approve(deviceId: string, power: boolean) {
    const pending = await devices.request(randomUUID(), deviceId, {
      revision: 1,
      capability: 'power.set',
      arguments: { power },
    });
    return devices.decide(randomUUID(), pending.id, {
      revision: pending.revision,
      digest: pending.digest,
      approve: true,
    });
  }
  it('leaves a killed claimed command uncertain, never replays it, and accepts a new action after verification', async () => {
    const { deviceId } = await devices.addSimulation(randomUUID(), { name: '进程恢复演示灯' });
    const original = await approve(deviceId, true);
    blocker = await store.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT device_id FROM app.device_simulation_state WHERE device_id=$1 FOR UPDATE', [deviceId]);
    const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    const firstApplication = 'device-recovery-' + randomUUID();
    launchWorker(firstApplication);
    await waitUntil(async () => {
      if (worker!.exitCode !== null || worker!.signalCode !== null)
        throw new Error('Worker exited before dispatch: ' + output);
      if ((await command(original.id))?.state !== 'executing') return false;
      return Boolean(
        await store.one(
          `SELECT pid FROM pg_stat_activity
        WHERE application_name=$1 AND $2::integer=ANY(pg_blocking_pids(pid))
          AND query LIKE '%device_simulation_state%'`,
          [firstApplication, blockerPid],
        ),
      );
    }, 'Worker did not persist its claim and wait on the simulated device row');
    const claimed = (await command(original.id))!;
    expect(claimed.execution_token).toBeTruthy();
    expect(await writes(deviceId)).toBe(0);

    await stopChild(worker!, 'SIGKILL');
    worker = undefined;
    await blocker.query('ROLLBACK');
    blocker.release();
    blocker = undefined;
    // A query already sent to PostgreSQL may finish as the connection dies. Wait for
    // every first-Worker session to disappear before recording its final side effects.
    await waitUntil(
      async () => !(await store.one('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [firstApplication])),
      'Killed Worker left database connections alive',
    );
    const beforeRestart = (await state(deviceId))!.power as boolean;
    const initialWrites = await writes(deviceId);
    expect(initialWrites).toBeLessThanOrEqual(1);
    expect((await command(original.id))!.state).toBe('executing');
    await store.exec("DELETE FROM app.health WHERE name='worker'");

    launchWorker('device-recovered-' + randomUUID());
    await waitUntil(async () => {
      if (worker!.exitCode !== null || worker!.signalCode !== null)
        throw new Error('Restarted Worker exited: ' + output);
      return (
        (await command(original.id))?.state === 'uncertain' &&
        Boolean(await store.one("SELECT name FROM app.health WHERE name='worker'"))
      );
    }, 'Restarted Worker did not recover the interrupted command');
    const recovered = (await command(original.id))!;
    expect(recovered.receipt).toBeNull();
    expect(recovered.execution_token).toBe(claimed.execution_token);
    const duplicateId = await boss.send(DEVICE_QUEUE, { commandId: original.id });
    expect(duplicateId).toBeTruthy();
    await waitUntil(
      async () => (await store.one('SELECT state FROM queue.job WHERE id=$1', [duplicateId]))?.state === 'completed',
      'Duplicate delivery was not consumed',
    );
    expect((await command(original.id))!.state).toBe('uncertain');
    expect((await state(deviceId))!.power).toBe(beforeRestart);
    expect(await writes(deviceId)).toBe(initialWrites);

    await expect(
      devices.request(randomUUID(), deviceId, { revision: 1, capability: 'power.set', arguments: { power: false } }),
    ).rejects.toMatchObject({ code: 'device_busy' });
    await devices.resolve(randomUUID(), original.id, {
      revision: recovered.revision,
      outcome: beforeRestart ? 'executed' : 'not_executed',
      note: '测试进程在重启前独立读取模拟设备状态并核实。',
    });
    const next = await approve(deviceId, !beforeRestart);
    await waitUntil(
      async () => (await command(next.id))?.state === 'succeeded',
      'Worker did not execute a newly confirmed action after verification',
    );
    expect((await command(original.id))!.state).toBe('resolved');
    expect((await command(next.id))!.receipt).toMatchObject({
      source: 'simulation',
      before: { power: beforeRestart },
      after: { power: !beforeRestart },
      outcome: 'verified',
    });
    expect(await writes(deviceId)).toBe(initialWrites + 1);
    await stopChild(worker!);
    worker = undefined;
  });
});
