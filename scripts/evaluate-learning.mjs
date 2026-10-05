import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  ['--import', 'tsx', resolve(root, 'scripts/evaluate-learning.ts'), ...process.argv.slice(2)],
  { cwd: root, env: process.env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => {
  console.error('无法启动质量检查，请先安装项目依赖。');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
