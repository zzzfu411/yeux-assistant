import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, digest, id } from '../common.js';

const exec = promisify(execFile);
export const WORKSPACE_LOCK = 847392030;
export type WorkspaceChange = { path: string; status: string; digest: string | null };
export type WorkspaceStatus = { head: string; revision: string; changes: WorkspaceChange[]; locked: boolean };
const sha = /^[a-f0-9]{40,64}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** No shell, hooks, inherited Git environment or remote commands. Paths never leave this worktree. */
export class WorkspaceRepo {
  readonly root: string;
  constructor(folder: string) {
    this.root = resolve(folder, 'workspace');
  }
  private async git(args: string[]) {
    try {
      const result = await exec(
        'git',
        [
          '-c',
          'safe.directory=' + this.root,
          '-c',
          'user.name=yeux-assistant',
          '-c',
          'user.email=assistant@localhost',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.quotePath=false',
          ...args,
        ],
        {
          cwd: this.root,
          timeout: 10000,
          killSignal: 'SIGKILL',
          maxBuffer: 8 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            LANG: 'C.UTF-8',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
          },
        },
      );
      return result.stdout;
    } catch {
      throw new AppError('工作区 Git 操作失败或超时；文件已保留，请检查 Git 与工作区锁后重试。', 503, 'workspace_git');
    }
  }
  async initialize() {
    const gate = join(this.root, '..', '.workspace-initialize.lock');
    let owned = false;
    for (let n = 0; n < 100; n++) {
      try {
        await writeFile(gate, String(process.pid), { flag: 'wx', mode: 0o600 });
        owned = true;
        break;
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        await sleep(100);
      }
    }
    if (!owned) throw new AppError('工作区初始化锁尚未释放，请检查是否仍有初始化进程。', 503, 'workspace_locked');
    try {
      let exists = true;
      try {
        await lstat(this.root);
      } catch (error) {
        if (!missing(error)) throw error;
        exists = false;
      }
      if (exists) {
        await this.status();
        return;
      }
      await mkdir(this.root, { mode: 0o700 });
      for (const sub of ['rules', 'flows', 'profile', 'records', 'notes'])
        await mkdir(join(this.root, sub), { mode: 0o700 });
      await this.git(['init', '-b', 'main', '--template=']);
      await this.write(
        'README.md',
        '# 个人工作区\n\n规则放 rules/，流程放 flows/，本人信息放 profile/，办事记录放 records/，笔记放 notes/。\n网页保存已确认规则会提交；手工编辑不会自动提交。此仓库只在本机，不自动连接远程。\n',
      );
      await this.write('.gitattributes', '* text=auto eol=lf\n');
      await this.commitFiles(['README.md', '.gitattributes'], 'workspace: initialize');
    } finally {
      await unlink(gate);
    }
  }
  async check() {
    const root = await lstat(this.root),
      git = await lstat(join(this.root, '.git'));
    if (!root.isDirectory() || !git.isDirectory())
      throw new AppError('工作区必须是独立普通目录与 Git 仓库；不接受符号链接或关联工作树。', 409, 'workspace_invalid');
  }
  async path(path: string, allowMissing = false) {
    if (
      !path ||
      path.length > 1000 ||
      /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
      !/^(README\.md|\.gitattributes|(?:rules|flows|profile|records|notes)\/[^\0]+)$/.test(path)
    ) {
      throw new AppError('工作区路径无效。', 400, 'workspace_path');
    }
    await this.check();
    let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new AppError('工作区不接受符号链接。', 400, 'workspace_path');
      } catch (error) {
        if (!(allowMissing && missing(error))) throw error;
      }
    }
    return current;
  }
  async read(path: string) {
    const target = await this.path(path),
      info = await lstat(target);
    if (!info.isFile() || info.size > 100000) throw new AppError('规则或流程文件超过 100 KB，或不是普通文件。');
    return readFile(target, 'utf8');
  }
  async write(path: string, content: string) {
    const target = await this.path(path, true);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await this.path(path, true);
    const temporary = target + '.tmp-' + id();
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async status(): Promise<WorkspaceStatus> {
    await this.check();
    const head = (await this.git(['rev-parse', '--verify', 'HEAD'])).trim();
    const raw = (await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
      .split('\0')
      .filter(Boolean);
    const changes: WorkspaceChange[] = [];
    for (const line of raw) {
      const path = line.slice(3),
        target = await this.path(path, true);
      let hash: string | null = null;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.size > 2_000_000) throw new AppError('工作区文件无法提交：' + path);
        hash = digest(await readFile(target, 'utf8'));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      changes.push({ path, status: line.slice(0, 2), digest: hash });
    }
    let locked = false;
    try {
      await lstat(join(this.root, '.git', 'index.lock'));
      locked = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return { head, changes, revision: digest({ head, changes }), locked };
  }
  async commitFiles(paths: string[], message: string, trailers: Record<string, string> = {}, includeStaged = false) {
    if (!paths.length || paths.length > 1000 || message.length > 300 || /[\x00-\x1f\x7f]/.test(message))
      throw new AppError('提交说明或文件数量无效。');
    for (const path of paths) await this.path(path, true);
    // Do not consume pre-existing staged changes, even if they concern the same file.
    if (!includeStaged && (await this.git(['diff', '--cached', '--name-only', '-z'])).length)
      throw new AppError('工作区已有暂存修改，请先手工处理再保存。', 409, 'workspace_staged');
    const args = ['commit', '--allow-empty', '--no-verify', '-m', message];
    for (const [key, value] of Object.entries(trailers)) {
      if (!/^Yeux-[A-Za-z]+$/.test(key) || /[\r\n\0]/.test(value) || value.length > 1000)
        throw new AppError('工作区提交回执无效。');
      args.push('--trailer', key + ': ' + value);
    }
    await this.git(['add', '--', ...paths]);
    // Never retry this command automatically: a timeout may still have created the commit.
    await this.git(args);
    return (await this.git(['rev-parse', '--verify', 'HEAD'])).trim();
  }
  async log(path: string, limit = 20) {
    await this.path(path, true);
    return (await this.git(['log', '--format=%H', '-n', String(Math.max(1, Math.min(limit, 100))), '--', path]))
      .trim()
      .split('\n')
      .filter(Boolean);
  }
  async show(commit: string, path: string) {
    if (!sha.test(commit)) throw new AppError('提交号无效。');
    await this.path(path, true);
    return this.git(['show', commit + ':' + path]);
  }
  async findCommitByTrailer(command: string) {
    if (!/^[a-f0-9]{64}$/.test(command)) throw new AppError('请求摘要无效。');
    const raw = await this.git([
      'log',
      '--fixed-strings',
      '--grep=Yeux-Command: ' + command,
      '--format=%H%x00%B%x00',
      '-n',
      '1',
    ]);
    if (!raw.trim()) return null;
    const [hash, message] = raw.split('\0');
    const fields = Object.fromEntries(
      [...message!.matchAll(/^(Yeux-[A-Za-z]+): ([^\n]+)$/gm)].map((match) => [match[1]!, match[2]!]),
    );
    if (fields['Yeux-Command'] !== command) return null;
    return { hash: hash!.trim(), fields };
  }
}
