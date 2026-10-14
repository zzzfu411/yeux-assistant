import { existsSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// Reverse SSH tunnel to the HTTPS entrance on the VPS. Data stays on this computer; the VPS only
// proxies https://<domain> to 127.0.0.1:<tunnel port>, which this tunnel forwards to the local API.
// Started and stopped by hand (no login item); the supervisor reconnects with backoff.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(process.env.ASSISTANT_DATA_DIR || join(root, 'private'));
const envFile = join(folder, 'runtime.env');
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const host = env.ASSISTANT_TUNNEL,
  remotePort = Number(env.ASSISTANT_TUNNEL_PORT || 18766),
  localPort = Number(env.ASSISTANT_PORT || 8765);
const pidFile = join(folder, 'tunnel.pid'),
  logFile = join(folder, 'tunnel.log');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const running = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0);
const command = process.argv[2] || 'status';

if (!host || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(host)) {
  console.error('请在 private/runtime.env 设置 ASSISTANT_TUNNEL=用户@服务器（例如 root@203.0.113.5）。');
  process.exit(1);
}
if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
  console.error('ASSISTANT_TUNNEL_PORT 必须是 1024–65535 的端口。');
  process.exit(1);
}

/** Ends only an sshd process listening on this tunnel's port on the VPS; true when one was ended. */
async function releaseStaleForward() {
  const script =
    `pid=$(ss -ltnpH 'sport = :${remotePort}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); ` +
    `[ -n "$pid" ] && [ "$(ps -o comm= -p "$pid")" = sshd ] && kill "$pid" && echo released`;
  const probe = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  probe.stdout.on('data', (chunk) => (output += chunk));
  await new Promise((done) => probe.on('close', done));
  return output.includes('released');
}

if (command === 'start') {
  const pid = running();
  if (pid && alive(pid)) {
    console.log('隧道已在运行（进程 ' + pid + '）。');
    process.exit(0);
  }
  const out = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  child.unref();
  console.log(`隧道已启动：${host} 的 127.0.0.1:${remotePort} → 本机 127.0.0.1:${localPort}。日志：private/tunnel.log`);
} else if (command === 'stop') {
  const pid = running();
  if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
  rmSync(pidFile, { force: true });
  console.log('隧道已停止。');
} else if (command === 'status') {
  const pid = running();
  console.log(pid && alive(pid) ? '隧道运行中（进程 ' + pid + '）。' : '隧道未运行。');
} else if (command === 'run') {
  let stopping = false,
    ssh;
  const stop = () => {
    stopping = true;
    ssh?.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (let failures = 0; !stopping;) {
    const started = Date.now();
    console.log(new Date().toISOString(), 'connecting');
    ssh = spawn(
      'ssh',
      [
        '-N',
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=20',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StreamLocalBindUnlink=yes',
        '-R',
        `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
        host,
      ],
      { stdio: ['ignore', 'inherit', 'pipe'] },
    );
    let portTaken = false;
    ssh.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      if (/remote port forwarding failed/i.test(String(chunk))) portTaken = true;
    });
    const code = await new Promise((done) => ssh.on('close', done));
    if (stopping) break;
    // After sleep or a network change the VPS may keep the old session, and with it the port, for
    // hours. The port belongs to this tunnel alone, so an sshd still holding it is our stale session.
    if (portTaken && (await releaseStaleForward())) {
      console.log(new Date().toISOString(), 'released stale forward on port', remotePort);
      await sleep(1000);
      continue;
    }
    failures = Date.now() - started > 60_000 ? 0 : failures + 1;
    const wait = Math.min(60, 2 ** failures) * 1000;
    console.log(new Date().toISOString(), 'disconnected', code, 'retry in', wait / 1000, 's');
    await sleep(wait);
  }
  rmSync(pidFile, { force: true });
} else {
  console.error('用法：pnpm tunnel start | stop | status');
  process.exit(1);
}
