import { mkdtemp, mkdir, readdir, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(root, 'private/server-release');
const roots = [
  'apps',
  'packages',
  'scripts',
  'deploy',
  'docs',
  'tests',
  'quality',
  'README.md',
  'SPEC.md',
  'AGENTS.md',
  'Dockerfile',
  'compose.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'playwright.config.ts',
  'config.example.json',
  '.env.example',
  '.npmrc',
  '.dockerignore',
  '.gitignore',
  '.prettierrc',
  '.prettierignore',
  '.git-blame-ignore-revs',
];
const excluded = new Set([
  'private',
  'runtime',
  'secrets',
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  'test-results',
  'playwright-report',
]);
await mkdir(parent, { recursive: true, mode: 0o700 });
const temp = await mkdtemp(join(parent, '.bundle-')),
  target = join(temp, 'yeux-assitant');
const hashes = {};
async function copy(relative) {
  const name = relative.split('/').at(-1);
  if (
    excluded.has(name) ||
    (name.startsWith('.env') && name !== '.env.example') ||
    /\.(?:pem|key|sqlite\d*|db|dump|log)$/.test(name) ||
    ['config.json', 'access-token', 'admin-auth.json', 'runtime.env', 'cookies.json', 'storage-state.json'].includes(
      name,
    )
  )
    return;
  const source = join(root, relative),
    info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('发布目录包含符号链接，请先人工检查：' + relative);
  if (info.isDirectory()) {
    await mkdir(join(target, relative), { recursive: true });
    for (const child of (await readdir(source)).sort()) await copy(relative + '/' + child);
  } else if (info.isFile()) {
    const bytes = await readFile(source);
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
    await mkdir(dirname(join(target, relative)), { recursive: true });
    await writeFile(join(target, relative), bytes);
  } else throw new Error('发布目录包含不支持的文件类型。');
}
try {
  for (const relative of roots) await copy(relative);
  const release = createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 12);
  await writeFile(
    join(target, 'release-manifest.json'),
    JSON.stringify({ format: 1, release, files: hashes }, null, 2) + '\n',
  );
  const output = join(parent, 'yeux-assitant-server-' + release + '.tar.gz');
  const result = spawnSync('tar', ['-czf', output, '-C', temp, 'yeux-assitant'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) throw new Error('发布包生成失败。');
  console.log(
    JSON.stringify(
      {
        archive: output,
        release,
        files: Object.keys(hashes).length,
        sha256: createHash('sha256')
          .update(await readFile(output))
          .digest('hex'),
        personalDataIncluded: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
