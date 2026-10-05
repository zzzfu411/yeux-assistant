import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = 'postgres:18-bookworm';
const unverified = (message) => ({ status: 'unverified', message });

// Never capture SQL, archive contents or Docker stderr. Docker's selected local
// context is respected; this command does not start an engine or pull an image.
export function runDocker(args, { timeout = 5000, stdin = 'ignore', signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ interrupted: true, status: null });
      return;
    }
    const child = spawn('docker', args, { stdio: [stdin, 'ignore', 'ignore'], windowsHide: true });
    let timedOut = false,
      interrupted = false,
      failure;
    const abort = () => {
      interrupted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', (error) => {
      failure = { code: error.code };
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ status, ...(failure ? { error: failure } : {}), timedOut, interrupted });
    });
  });
}

export async function inspectDockerDump(path, { run = runDocker, signal, decodeTimeout = 30000 } = {}) {
  const available = await run(['image', 'inspect', image], { signal });
  if (available.interrupted) return unverified('备份解码已中断；文件完整性已核对，dump 尚未完整解码。');
  if (available.error || available.timedOut || available.status !== 0) {
    return unverified(
      'Docker 未就绪或本地缺少 postgres:18-bookworm；请手动准备后重试 --docker，检查不会启动引擎或拉取镜像。',
    );
  }
  const name = 'yeux-backup-check-' + randomUUID();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let created, decoded, cleanup;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('backup file is not regular');
    created = await run(
      [
        'create',
        '--pull=never',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=postgres',
        '--log-driver=none',
        '--interactive',
        '--entrypoint',
        'pg_restore',
        image,
        '--no-owner',
        '--no-privileges',
        '--file=-',
      ],
      { signal },
    );
    if (!created.error && !created.timedOut && !created.interrupted && created.status === 0) {
      decoded = await run(['start', '--attach', '--interactive', name], {
        stdin: handle.fd,
        timeout: decodeTimeout,
        signal,
      });
    }
  } finally {
    // Killing a Docker client does not necessarily stop its container. Always
    // remove this unique container and image-declared anonymous volumes; never
    // target a database container, project, named volume or the source files.
    try {
      await handle.close();
    } finally {
      cleanup = await run(['rm', '--force', '--volumes', name], { timeout: 5000 });
    }
  }
  if (cleanup.error || cleanup.timedOut || cleanup.status !== 0) {
    return unverified(`Docker 检查未确认临时资源清理完成；请检查并移除 ${name}，然后重试。`);
  }
  if (created?.interrupted || decoded?.interrupted || signal?.aborted)
    return unverified('备份解码已中断；临时容器已移除，dump 尚未完整解码。');
  if (!decoded) return unverified('Docker 无法建立解码容器；未连接数据库，dump 尚未完整解码。');
  if (decoded.timedOut)
    return unverified(
      'Docker dump 解码超过 30 秒，临时容器已移除；请使用 PostgreSQL 18 的 pg_restore 在独立环境中继续检查。',
    );
  if (decoded.error || decoded.status === 125)
    return unverified('Docker 解码进程无法运行；临时容器已移除，dump 尚未完整解码。');
  if (decoded.status !== 0)
    throw Object.assign(new Error('pg_restore 无法读取完整 dump，或解码进程异常退出；归档未通过验证。'), {
      code: 'dump_invalid',
    });
  return {
    status: 'decoded',
    message: 'Docker 中的 PostgreSQL 18 已解码完整归档；未连接或恢复数据库，临时容器已移除。',
  };
}
