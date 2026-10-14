import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/index.js';
import { initializeData } from '../packages/core/src/config.js';
import { Rules } from '../packages/core/src/workspace/rules.js';
import { Workspace } from '../packages/core/src/workspace/service.js';
import { formatFile } from '../packages/core/src/workspace/files.js';

const url = process.env.API_TEST_DATABASE_URL;
describe('versioned rule files with PostgreSQL', () => {
  let store: Store, folder: string, rules: Rules;
  beforeEach(async () => {
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Rules tests require an isolated *_test database');
    store = new Store(url);
    await store.pool.query('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'yeux-rules-'));
    await initializeData(folder);
    rules = new Rules(store, folder);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store?.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const input = {
    key: 'notice.deadline',
    scope: 'correction',
    content: '截止时间与活动开始时间分开记录。',
    confirmed: true,
    enabled: true,
    revision: 0,
  };
  it('saves confirmed rules to Git once and leaves proposals out of the worktree', async () => {
    const first = await rules.save('rule-one', input);
    const head = (await rules.repo.status()).head;
    expect(first.commitSha).toBe(head);
    expect(await rules.save('rule-one', input)).toEqual(first);
    expect((await rules.repo.status()).head).toBe(head);
    await expect(rules.save('rule-one', { ...input, content: 'different' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await rules.save('proposal', { ...input, key: 'proposal', confirmed: false });
    expect((await rules.repo.status()).head).toBe(head);
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', ['proposal']))!.path).toBeNull();
  });
  it('recovers a Git commit after the DB transaction fails without creating a second commit', async () => {
    const original = rules.persist.bind(rules);
    vi.spyOn(rules, 'persist').mockRejectedValueOnce(new Error('synthetic post-commit outage'));
    await expect(rules.save('recover', input)).rejects.toThrow('post-commit');
    expect(await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key])).toBeUndefined();
    const head = (await rules.repo.status()).head;
    vi.mocked(rules.persist).mockImplementation(original);
    await rules.scan();
    const scanned = (await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!;
    expect(scanned.version).toBe(1);
    expect((await rules.save('recover', input)).version).toBe(1);
    expect((await rules.repo.status()).head).toBe(head);
    expect((await store.one('SELECT count(*) n FROM app.memory_versions'))!.n).toBe('1');
  });
  it('loads manual edits without committing, keeps invalid last-good content, disables deletions and restores files', async () => {
    await rules.save('first', input);
    const old = (await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!,
      head = (await rules.repo.status()).head;
    const changed = formatFile(
      { key: input.key, scope: 'mail', enabled: true, created: '2026-10-05' },
      '回复前核对截止时间。',
    );
    await rules.repo.write(old.path, changed);
    await rules.scan();
    let row = (await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!;
    expect(row.version).toBe(2);
    expect(row.commit_sha).toBeNull();
    expect(row.origin).toBe('file_edit');
    expect((await rules.repo.status()).head).toBe(head);
    await rules.repo.write(old.path, 'invalid');
    await rules.scan();
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.content).toBe(row.content);
    await rm(join(rules.repo.root, old.path));
    await rules.scan();
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.enabled).toBe(false);
    await rules.repo.write(old.path, changed);
    await rules.scan();
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.enabled).toBe(true);
  });
  it('disables conflicting keys and reactivates only after conflict resolution', async () => {
    await rules.save('first', input);
    const row = (await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!;
    await rules.repo.write('rules/all/duplicate.md', await rules.repo.read(row.path));
    await rules.scan();
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.enabled).toBe(false);
    await rm(join(rules.repo.root, 'rules/all/duplicate.md'));
    await rules.scan();
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.enabled).toBe(true);
  });
  it('protects hand edits against web overwrite and binds manual commits to the reviewed status', async () => {
    await rules.save('first', input);
    const row = (await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!;
    await rules.repo.write(row.path, 'manual');
    await expect(rules.save('second', { ...input, revision: 1 })).rejects.toMatchObject({ code: 'workspace_changed' });
    expect(await rules.repo.read(row.path)).toBe('manual');
    await rules.repo.write(
      row.path,
      formatFile({ key: input.key, scope: 'correction', enabled: true, created: '2026-10-05' }, '人工确认后的规则。'),
    );
    const workspace = new Workspace(store, folder),
      status = await workspace.status();
    await rules.repo.write('notes/new.md', 'new');
    await expect(
      workspace.commit('manual-stale', { revision: status.revision, message: 'manual' }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const latest = await workspace.status();
    const commit = await workspace.commit('manual', { revision: latest.revision, message: '人工整理规则' });
    expect((await workspace.status()).changes).toEqual([]);
    expect((await store.one('SELECT * FROM app.memories WHERE key=$1', [input.key]))!.commit_sha).toBe(
      commit.commitSha,
    );
  });
  it('imports legacy confirmed rules while preserving their versions and historical snapshots', async () => {
    await store.exec(
      "INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES('legacy','work','保留已有规则',3,true,true)",
    );
    const preview = await rules.importExisting();
    expect(preview.applied).toBe(false);
    expect(preview.files).toHaveLength(1);
    const imported = await rules.importExisting(true);
    expect(imported.applied).toBe(true);
    const row = (await store.one("SELECT * FROM app.memories WHERE key='legacy'"))!;
    expect(row.version).toBe(3);
    expect(row.origin).toBe('import');
    expect(row.path).toBeTruthy();
    expect((await rules.importExisting(true)).files).toHaveLength(0);
  });
  it('recovers a committed legacy import after database rollback without making another commit', async () => {
    await store.exec(
      "INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES('recover-import','work','保留导入版本',2,true,true)",
    );
    const commit = rules.repo.commitFiles.bind(rules.repo);
    rules.repo.commitFiles = async (...args) => {
      await commit(...args);
      throw new Error('simulated failure after git commit');
    };
    await expect(rules.importExisting(true)).rejects.toThrow('simulated failure');
    const head = (await rules.repo.status()).head;
    rules.repo.commitFiles = commit;
    expect((await rules.importExisting(true)).commitSha).toBe(head);
    expect((await rules.repo.status()).head).toBe(head);
    expect(await store.one("SELECT version,origin FROM app.memories WHERE key='recover-import'")).toMatchObject({
      version: 2,
      origin: 'import',
    });
  });
  it('saves declarative flows once and requires a new version for changed instructions', async () => {
    const workspace = new Workspace(store, folder),
      definition = {
        id: 'notice',
        title: '通知办事',
        version: 1,
        trigger: { manual: true },
        steps: ['extract_notice', 'retrieve', 'archive'],
      };
    const saved = await workspace.flows.save('flow-one', { definition, instructions: '先核对原文', revision: 0 });
    expect(await workspace.flows.save('flow-one', { definition, instructions: '先核对原文', revision: 0 })).toEqual(
      saved,
    );
    await workspace.flows.repo.write(
      'flows/notice.md',
      formatFile({ ...definition, steps: ['extract_notice', 'shell', 'archive'] }, 'changed'),
    );
    await workspace.flows.scan();
    expect((await workspace.flows.list())[0]!.enabled).toBe(false);
  });
});
