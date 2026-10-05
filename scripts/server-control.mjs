import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  createWriteStream,
  readdirSync,
  chownSync,
  chmodSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createBackup } from './backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'status';
const folder = resolve(process.env.ASSISTANT_SERVER_DATA_DIR || join(root, 'private/server'));
const envFile = join(folder, 'runtime.env');
const project = process.env.ASSISTANT_SERVER_PROJECT || 'yeux-assitant-server';
const file = join(root, 'deploy/compose.server.yaml');
const compose = ['compose', '--env-file', envFile, '--project-directory', root, '-f', file, '-p', project];
let environment;
function run(args, capture = false) {
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error || result.status !== 0) throw new Error('服务器命令失败，请保留输出中的状态并检查 Docker。');
  return result.stdout?.trim() || '';
}
try {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('服务器项目名格式无效。');
  if (!['init', 'start', 'stop', 'status', 'check', 'admin', 'backup'].includes(command))
    throw new Error('用法：pnpm server init|start|stop|status|check|admin|backup');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('服务器运维脚本需要 Node.js 24 或更新版本。');
  if (command === 'init') {
    if (existsSync(envFile)) {
      console.log('服务器配置已存在，保留原值。');
      process.exit(0);
    }
    if (existsSync(folder) && readdirSync(folder).length)
      throw new Error('数据目录非空，请先制定导入方案；不会覆盖旧数据。');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const uid = process.getuid?.() || 1000,
      gid = process.getgid?.() || 1000;
    writeFileSync(
      envFile,
      'POSTGRES_PASSWORD=' +
        randomBytes(32).toString('hex') +
        '\nASSISTANT_DATABASE=assistant\nASSISTANT_PORT=8765\nASSISTANT_PUBLIC_ORIGIN=http://127.0.0.1:8765\nASSISTANT_UID=' +
        uid +
        '\nASSISTANT_GID=' +
        gid +
        '\n',
      { mode: 0o600, flag: 'wx', flush: true },
    );
    if (process.getuid?.() === 0) {
      chownSync(folder, uid, gid);
      chownSync(envFile, uid, gid);
    }
    console.log('已创建独立服务器配置。尚未启动服务、创建管理员或导入个人资料。');
    process.exit(0);
  }
  if (!existsSync(envFile)) throw new Error('请先运行 pnpm server init。');
  const saved = parseEnv(readFileSync(envFile, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(saved.POSTGRES_PASSWORD || ''))
    throw new Error('服务器数据库密码配置无效；不会覆盖已有配置。');
  if (
    !/^\d{1,5}$/.test(saved.ASSISTANT_PORT || '') ||
    Number(saved.ASSISTANT_PORT) < 1024 ||
    Number(saved.ASSISTANT_PORT) > 65535
  )
    throw new Error('服务器端口需在 1024–65535 范围。');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(saved.ASSISTANT_DATABASE || 'assistant'))
    throw new Error('服务器数据库名称格式无效。');
  const url = new URL(saved.ASSISTANT_PUBLIC_ORIGIN);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('远程来源必须使用 HTTPS；HTTP 仅用于回环地址。');
  if (!/^[1-9]\d*$/.test(saved.ASSISTANT_UID || '') || !/^\d+$/.test(saved.ASSISTANT_GID || ''))
    throw new Error('服务器需使用有效的非 root 用户 ID。');
  if (url.protocol === 'http:' && Number(url.port || 80) !== Number(saved.ASSISTANT_PORT))
    throw new Error('回环入口端口与 ASSISTANT_PORT 不一致。');
  environment = { ...process.env, ...saved, ASSISTANT_DATA_DIR: folder, ASSISTANT_SOURCE_DIR: root };
  const inventory = spawnSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project], {
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (inventory.status !== 0) throw new Error('Docker 引擎不可用，请先运行 pnpm server:probe。');
  for (const container of inventory.stdout.trim().split(/\s+/).filter(Boolean)) {
    const result = spawnSync(
      'docker',
      ['inspect', '--format', '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}', container],
      { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let instance;
    try {
      instance = JSON.parse(result.stdout);
    } catch {
      throw new Error('无法核对现有服务器实例。');
    }
    if (
      instance.labels['com.docker.compose.project.working_dir'] !== root ||
      instance.labels['com.docker.compose.project.config_files'] !== file
    )
      throw new Error('同名服务器属于另一目录；请使用独立项目名，不会替换或停止它。');
    const data = instance.mounts.find((mount) => mount.Destination === '/app/private');
    if (data && data.Source !== folder) throw new Error('现有服务器的数据目录不同；需要先制定迁移方案，不会重新挂载。');
  }
  run(['config', '--quiet']);
  if (command === 'check') {
    console.log('服务器配置可解析；此次检查未启动或停止服务。');
  } else if (command === 'start') {
    run(['build', 'api']);
    run([
      'run',
      '--rm',
      '--no-deps',
      'api',
      'node',
      '-e',
      "const fs=require('node:fs');try{fs.accessSync('/app/private',fs.constants.W_OK);fs.accessSync('/app/private/runtime.env',fs.constants.R_OK)}catch{console.error('服务器数据目录未正确挂载或当前 UID 无法写入；请核对目录共享和 ASSISTANT_UID/GID，不要改成全员可写。');process.exit(1)}",
    ]);
    run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
    console.log('服务器已启动。浏览器入口：' + url.origin + '；首次使用运行 pnpm server admin。');
  } else if (command === 'stop') run(['stop', '--timeout', '120']);
  else if (command === 'status') run(['ps']);
  else if (command === 'admin') run(['exec', 'api', 'node', 'dist/scripts/setup-admin.js']);
  else if (command === 'backup') {
    const running = run(['ps', '--status', 'running', '--services'], true)
      .split(/\s+/)
      .filter((service) => ['api', 'worker'].includes(service));
    try {
      if (running.length) run(['stop', '--timeout', '120', ...running]);
      const output = await createBackup(folder, async (path) => {
        const child = spawn(
          'docker',
          [
            ...compose,
            'exec',
            '-T',
            'db',
            'pg_dump',
            '-U',
            'assistant',
            '-d',
            saved.ASSISTANT_DATABASE || 'assistant',
            '-Fc',
          ],
          { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'inherit'] },
        );
        const ended = new Promise((done, reject) => {
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? done() : reject(new Error('服务器数据库备份失败。'))));
        });
        try {
          await Promise.all([ended, pipeline(child.stdout, createWriteStream(path, { mode: 0o600, flags: 'wx' }))]);
        } catch (error) {
          child.kill();
          await ended.catch(() => {});
          throw error;
        }
      });
      console.log('完整服务器备份已保存：' + output);
    } finally {
      if (running.length) run(['start', ...running]);
    }
  }
} catch (error) {
  console.error(error instanceof TypeError ? '服务器配置格式无效。' : error.message);
  process.exitCode = 1;
}
