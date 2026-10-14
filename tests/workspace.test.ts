import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceRepo } from '../packages/core/src/workspace/repo.js';
import { digest } from '../packages/core/src/common.js';
import { parseFile, formatFile, rulePath } from '../packages/core/src/workspace/files.js';
import { RuleHeader, FlowDefinition } from '../packages/contracts/src/workspace.js';

describe('private workspace repository', () => {
  let folder: string, repo: WorkspaceRepo;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'yeux-workspace-'));
    repo = new WorkspaceRepo(folder);
  });
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  it('initializes once even with two concurrent initializers and preserves dirty files', async () => {
    await Promise.all([repo.initialize(), new WorkspaceRepo(folder).initialize()]);
    const before = await repo.status();
    await repo.write('notes/合成笔记.md', '学习记录');
    await repo.initialize();
    expect((await repo.status()).head).toBe(before.head);
    expect((await repo.status()).changes).toHaveLength(1);
    expect(execFileSync('git', ['remote'], { cwd: repo.root, encoding: 'utf8' })).toBe('');
  });
  it('refuses existing nonrepositories and symlinks without altering them', async () => {
    await mkdir(repo.root);
    await writeFile(join(repo.root, 'keep.txt'), 'keep');
    await expect(repo.initialize()).rejects.toThrow();
    expect(await readFile(join(repo.root, 'keep.txt'), 'utf8')).toBe('keep');
    await rm(repo.root, { recursive: true });
    const other = join(folder, 'other');
    await mkdir(other);
    await symlink(other, repo.root);
    await expect(repo.initialize()).rejects.toThrow();
  });
  it('commits exact paths and trailers, and does not include unrelated manual edits', async () => {
    await repo.initialize();
    await repo.write('notes/personal.md', 'uncommitted');
    await repo.write('rules/all/one.md', 'rule');
    const command = digest('request'),
      hash = await repo.commitFiles(['rules/all/one.md'], 'rule: one', { 'Yeux-Command': command });
    expect((await repo.findCommitByTrailer(command))?.hash).toBe(hash);
    expect(await repo.show(hash, 'rules/all/one.md')).toBe('rule');
    expect((await repo.status()).changes.map((item) => item.path)).toEqual(['notes/personal.md']);
  });
  it('rejects path traversal, symlink parents, staged user changes and leaves Git locks intact', async () => {
    await repo.initialize();
    await expect(repo.write('../escape', 'bad')).rejects.toThrow();
    await symlink(tmpdir(), join(repo.root, 'rules', 'escape'));
    await expect(repo.write('rules/escape/out.md', 'bad')).rejects.toThrow();
    await rm(join(repo.root, 'rules', 'escape'));
    await repo.write('notes/staged.md', 'manual');
    execFileSync('git', ['add', 'notes/staged.md'], { cwd: repo.root });
    await repo.write('rules/all/app.md', 'app');
    await expect(repo.commitFiles(['rules/all/app.md'], 'app')).rejects.toMatchObject({ code: 'workspace_staged' });
    await writeFile(join(repo.root, '.git/index.lock'), 'keep');
    expect((await repo.status()).locked).toBe(true);
    expect(await readFile(join(repo.root, '.git/index.lock'), 'utf8')).toBe('keep');
  });
  it('does not execute repository hooks', async () => {
    await repo.initialize();
    await mkdir(join(repo.root, '.git/hooks'));
    await writeFile(join(repo.root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 47\n', { mode: 0o700 });
    await repo.write('notes/test.md', 'test');
    await expect(repo.commitFiles(['notes/test.md'], 'test')).resolves.toMatch(/^[a-f0-9]{40}$/);
  });
});

describe('readable rules and declarative flows', () => {
  it('roundtrips Chinese content and refuses unknown YAML fields, duplicates and aliases', () => {
    const header = { key: 'notice.deadline', scope: 'correction', enabled: true, created: '2026-10-05' };
    expect(parseFile(formatFile(header, '截止不等于开始。'), RuleHeader)).toEqual({
      header,
      content: '截止不等于开始。',
    });
    expect(() => parseFile(formatFile({ ...header, execute: 'rm' }, 'x'), RuleHeader)).toThrow();
    expect(() => parseFile('---\nkey: one\nkey: two\n---\nx', RuleHeader)).toThrow();
    expect(() => parseFile('---\nkey: &key one\nscope: *key\n---\nx', RuleHeader)).toThrow();
    expect(rulePath('work', '中文/规则')).toMatch(/^rules\/work\/[a-z0-9._-]+\.md$/);
  });
  const flow = {
    id: 'notice-to-errand',
    title: '通知办事',
    version: 1,
    trigger: { manual: true },
    steps: ['extract_notice', 'retrieve', 'ask_user', 'draft_mail', 'archive'],
  };
  it('validates registered steps with immutable safety policy', () => {
    expect(FlowDefinition.safeParse(flow).success).toBe(true);
    expect(FlowDefinition.safeParse({ ...flow, steps: ['shell', 'archive'] }).success).toBe(false);
    expect(FlowDefinition.safeParse({ ...flow, confirm: false }).success).toBe(false);
    expect(FlowDefinition.safeParse({ ...flow, budget: 50 }).success).toBe(false);
    expect(FlowDefinition.safeParse({ ...flow, steps: ['extract_notice', 'ehall_prepare', 'archive'] }).success).toBe(
      false,
    );
  });
});
