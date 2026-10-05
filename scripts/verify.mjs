import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const name = 'gse-verify-' + randomBytes(5).toString('hex');
const password = randomBytes(24).toString('hex');
let started = false,
  pool;
function run(binary, args, env = process.env, capture = false) {
  const result = spawnSync(binary, args, {
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(binary + ' 验证失败。');
  return result.stdout?.trim();
}
try {
  run('docker', ['info', '--format', '{{.ServerVersion}}'], process.env, true);
  run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      'gse.assistant.test=true',
      '-e',
      'POSTGRES_PASSWORD=' + password,
      '-p',
      '127.0.0.1::5432',
      'postgres:18-bookworm',
    ],
    process.env,
    true,
  );
  started = true;
  const endpoint = run('docker', ['port', name, '5432/tcp'], process.env, true),
    port = endpoint.split(':').at(-1);
  const base = 'postgres://postgres:' + password + '@127.0.0.1:' + port + '/';
  pool = new pg.Pool({ connectionString: base + 'postgres', connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let n = 0; n < 40; n++) {
    try {
      await pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ready) throw new Error('测试数据库未就绪。');
  for (const database of ['assistant_api_test', 'assistant_runtime_test', 'assistant_migration_test'])
    await pool.query('CREATE DATABASE ' + database);
  await pool.end();
  pool = undefined;
  const env = {
    ...process.env,
    API_TEST_DATABASE_URL: base + 'assistant_api_test',
    RUNTIME_TEST_DATABASE_URL: base + 'assistant_runtime_test',
    MIGRATION_TEST_DATABASE_URL: base + 'assistant_migration_test',
  };
  run('pnpm', ['format:check'], env);
  run('pnpm', ['check:architecture'], env);
  run('pnpm', ['typecheck'], env);
  run('pnpm', ['build'], env);
  run('pnpm', ['exec', 'vitest', 'run'], env);
  console.log('类型、构建与 PostgreSQL 回归通过，正在清理测试容器。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
  } catch {
    process.exitCode = 1;
    console.error('测试数据库连接未能正常关闭。');
  }
  if (started) {
    const removed = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0) {
      process.exitCode = 1;
      console.error('测试容器清理失败，请核对 ' + name + '。');
    }
  }
  if (!process.exitCode) console.log('全部检查通过，测试容器已移除；真实数据库未被使用。');
}
