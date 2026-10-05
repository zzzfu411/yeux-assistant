import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/src/index.js';
import { SourceArchiveInput, SourceInput, SourceUpdateInput } from '../packages/contracts/src/source-inputs.js';
import { Sources } from '../packages/core/src/sources.js';
import { Knowledge, putSource, retrieve } from '../packages/core/src/knowledge.js';
import { initializeData } from '../packages/core/src/config.js';
import { digest, once } from '../packages/core/src/common.js';

describe('source lifecycle input contracts', () => {
  it('requires a revision and an actual edit while keeping duplicate copies explicit', () => {
    expect(SourceInput.parse({ title: ' 笔记 ', content: '原文' })).toEqual({ title: '笔记', content: '原文' });
    expect(SourceInput.safeParse({ title: '笔记', content: '原文', allowDuplicate: 'true' }).success).toBe(false);
    expect(SourceUpdateInput.safeParse({ revision: 1 }).success).toBe(false);
    expect(SourceUpdateInput.safeParse({ revision: 0, title: '笔记' }).success).toBe(false);
    expect(SourceUpdateInput.safeParse({ revision: 1, title: ' ' }).success).toBe(false);
    expect(SourceArchiveInput.safeParse({ revision: 1, archived: true }).success).toBe(true);
    expect(SourceArchiveInput.safeParse({ revision: 1, archived: true, delete: true }).success).toBe(false);
  });
});

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('source maintenance with real PostgreSQL', () => {
  let store: Store, folder: string, knowledge: Knowledge, sources: Sources;
  beforeAll(() => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Only an isolated *_test database is allowed');
    store = new Store(url);
  });
  beforeEach(async () => {
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE'); await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'yeux-source-lifecycle-')); await initializeData(folder);
    knowledge = new Knowledge(store, folder); sources = new Sources(store, knowledge);
  });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });
  afterAll(async () => { await store?.close(); });

  const upload = (key: string, content = 'sharedneedle 合成原文', allowDuplicate?: boolean) => {
    const input = { title: '原始笔记', content, ...(allowDuplicate === undefined ? {} : { allowDuplicate }) };
    return store.transaction(tx => once(tx, key, 'source.import', input, () => sources.import(tx, key, input)));
  };
  const update = (sourceId: string, input: unknown) => store.transaction(tx => sources.update(tx, sourceId, input));
  const archive = (sourceId: string, input: unknown) => store.transaction(tx => sources.archive(tx, sourceId, input));

  it('deduplicates simultaneous equal uploads across different request keys and replays each receipt', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => upload('parallel-' + index)));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(5);
    expect(await store.one('SELECT count(*) n FROM app.sources')).toMatchObject({ n: '1' });
    expect(await store.one('SELECT count(*) n FROM app.source_versions')).toMatchObject({ n: '1' });
    for (let index = 0; index < results.length; index++) expect(await upload('parallel-' + index)).toEqual(results[index]);
  });

  it('leaves a duplicate archived and creates a separate copy only when explicitly requested', async () => {
    const first = await upload('first'); const archived = await archive(first.id, { revision: first.revision, archived: true });
    const duplicate = await upload('duplicate');
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true, revision: archived.revision, archivedAt: archived.archivedAt });
    expect(await sources.list()).toHaveLength(0); expect(await sources.list(true)).toHaveLength(1);
    const copy = await upload('copy', undefined, true); expect(copy.id).not.toBe(first.id); expect(copy.duplicate).toBe(false);
    const next = await upload('prefer-active'); expect(next.id).toBe(copy.id);
    expect((await sources.detail(first.id)).archivedAt).toBe(archived.archivedAt);
  });

  it('versions title-only changes and preserves the exact old citation after editing and archiving', async () => {
    const initial = await upload('versioned'); const citation = (await retrieve(store, 'sharedneedle'))[0]!;
    expect(citation.title).toBe('原始笔记');
    const renamed = await update(initial.id, { revision: initial.revision, title: '新的笔记标题' });
    expect(renamed).toMatchObject({ version: 2, revision: 2 });
    const edited = await update(initial.id, { revision: 2, content: 'differentneedle 新正文' });
    expect(edited).toMatchObject({ version: 3, revision: 3 });
    await archive(initial.id, { revision: 3, archived: true });
    const historic = await sources.detail(citation.sourceId, citation.version);
    expect(historic).toMatchObject({ title: citation.title, digest: citation.digest, content: 'sharedneedle 合成原文', version: 1, current_version: 3, revision: 4 });
    expect(String(historic.content).slice(citation.start, citation.end)).toBe(citation.quote);
    expect((await sources.detail(initial.id, 2))).toMatchObject({ title: '新的笔记标题', digest: citation.digest, content: 'sharedneedle 合成原文' });
    expect(historic.versions.map(item => [item.version, item.title])).toEqual([[3, '新的笔记标题'], [2, '新的笔记标题'], [1, '原始笔记']]);
    expect(await retrieve(store, 'differentneedle', [initial.id])).toEqual([]);
  });

  it('does not rewrite the imported original or let a restarted scanner replace the edited text', async () => {
    const initial = await upload('managed-file');
    const path = (await store.one('SELECT path FROM app.sources WHERE id=$1', [initial.id]))!.path;
    expect(await readFile(join(folder, 'documents', path), 'utf8')).toBe('sharedneedle 合成原文');
    await update(initial.id, { revision: 1, content: '新版正文 retainedneedle' });
    await new Knowledge(store, folder).scan();
    expect((await sources.detail(initial.id))).toMatchObject({ version: 2, managed: true, editableText: true, content: '新版正文 retainedneedle' });
    expect(await readFile(join(folder, 'documents', path), 'utf8')).toBe('sharedneedle 合成原文');
    expect(await store.one('SELECT count(*) n FROM app.source_versions WHERE source_id=$1', [initial.id])).toMatchObject({ n: '2' });
  });

  it('accepts one concurrent edit and rejects the stale revision without losing either historic version', async () => {
    const initial = await upload('concurrent-edit');
    const edits = await Promise.allSettled([
      update(initial.id, { revision: 1, title: '并发 A', content: 'A 的正文' }),
      update(initial.id, { revision: 1, title: '并发 B', content: 'B 的正文' })
    ]);
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(edits.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'version_conflict' } });
    expect((await sources.detail(initial.id)).versions).toHaveLength(2);
    expect((await sources.detail(initial.id, 1)).content).toBe('sharedneedle 合成原文');
  });

  it('serializes archive against an edit and does not silently revive the source', async () => {
    const initial = await upload('concurrent-archive');
    const changes = await Promise.allSettled([
      archive(initial.id, { revision: 1, archived: true }),
      update(initial.id, { revision: 1, content: 'changedneedle' })
    ]);
    expect(changes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(changes.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'version_conflict' } });
    const result = await sources.detail(initial.id); expect(result.revision).toBe(2);
    if (result.archivedAt) { expect(result.version).toBe(1); expect(await sources.list()).toHaveLength(0); }
    else { expect(result.version).toBe(2); expect(result.content).toBe('changedneedle'); }
  });

  it('archives without deleting versions, rejects edits while archived, and restores retrieval explicitly', async () => {
    const initial = await upload('lifecycle');
    await archive(initial.id, { revision: 1, archived: true });
    await expect(update(initial.id, { revision: 2, title: '不能直接编辑' })).rejects.toMatchObject({ code: 'source_archived' });
    expect(await retrieve(store, 'sharedneedle')).toEqual([]);
    expect((await sources.detail(initial.id, 1)).content).toBe('sharedneedle 合成原文');
    expect(await archive(initial.id, { revision: 2, archived: false })).toMatchObject({ revision: 3, archivedAt: null });
    expect((await retrieve(store, 'sharedneedle'))[0]).toMatchObject({ sourceId: initial.id, version: 1 });
    expect((await sources.detail(initial.id)).versions).toHaveLength(1);
    await expect(archive(initial.id, { revision: 2, archived: true })).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('keeps externally sourced text read-only while permitting versioned title changes', async () => {
    const content = '原文件 extractedneedle', metadata = { course: 'gse', courseName: 'GSE', originPath: 'gse/lecture.pdf', originHash: digest('original'), format: 'pdf', extraction: 'synthetic', pages: [{ number: 1, start: 0, end: content.length }], warnings: [] };
    await store.transaction(tx => putSource(tx, { id: 'external', title: '原课件', content, metadata }));
    await expect(update('external', { revision: 1, content: '自行修改' })).rejects.toMatchObject({ code: 'source_read_only' });
    await update('external', { revision: 1, title: '准确的课件标题' });
    const detail = await sources.detail('external'); expect(detail).toMatchObject({ title: '准确的课件标题', version: 2, editableText: false, metadata });
    expect((await sources.detail('external', 1))).toMatchObject({ title: '原课件', metadata });
    const summary = (await sources.list())[0]!;
    expect(summary.metadata).toEqual({ course: 'gse', courseName: 'GSE', format: 'pdf' });
    expect(summary).not.toHaveProperty('content'); expect(summary.metadata).not.toHaveProperty('pages');
  });

  it('does not recreate archived scanned sources and indexes changed files after explicit restore', async () => {
    const file = join(folder, 'documents', 'scanner.md'); await writeFile(file, '扫描第一版 scanfirst');
    await knowledge.scan(); const source = (await sources.list())[0]!;
    await archive(source.id, { revision: source.revision, archived: true });
    await writeFile(file, '扫描第二版 scansecond'); await knowledge.scan(); await new Knowledge(store, folder).scan();
    expect((await sources.detail(source.id))).toMatchObject({ version: 1, revision: 2 });
    expect(await sources.list()).toHaveLength(0);
    await archive(source.id, { revision: 2, archived: false }); await knowledge.scan();
    expect((await sources.detail(source.id))).toMatchObject({ version: 2, revision: 4, content: '扫描第二版 scansecond' });
    expect((await sources.detail(source.id, 1)).content).toBe('扫描第一版 scanfirst');
  });

  it('rechecks lifecycle after a scanner waits behind an in-flight archive lock', async () => {
    const file = join(folder, 'documents', 'concurrent-scan.md'); await writeFile(file, '归档前的原文');
    await knowledge.scan(); const source = (await sources.list())[0]!;
    await writeFile(file, '归档期间不应索引的新原文');
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const archiving = store.transaction(async tx => {
      await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + source.id]);
      ready(Number((await tx.one('SELECT pg_backend_pid() pid'))!.pid));
      await gate;
      return sources.archive(tx, source.id, { revision: 1, archived: true });
    });
    const blocker = await locked;
    const scanning = knowledge.scan();
    try {
      const deadline = Date.now() + 5000; let waiting = false;
      while (Date.now() < deadline) {
        waiting = Boolean(await store.one('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blocker]));
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      release(); await archiving; await scanning;
      const detail = await sources.detail(source.id);
      expect(detail).toMatchObject({ version: 1, revision: 2, content: '归档前的原文' });
      expect(detail.archivedAt).not.toBeNull(); expect(detail.versions).toHaveLength(1);
      await archive(source.id, { revision: 2, archived: false }); await knowledge.scan();
      expect((await sources.detail(source.id))).toMatchObject({ version: 2, revision: 4, content: '归档期间不应索引的新原文' });
    } finally {
      release(); await Promise.allSettled([archiving, scanning]);
    }
  });

  it('rejects invalid UTF-8 and oversized bytes atomically and treats unchanged edits as no-ops', async () => {
    const initial = await upload('validation');
    await expect(update(initial.id, { revision: 1, content: '\ud800' })).rejects.toThrow('UTF-8');
    await expect(update(initial.id, { revision: 1, content: '汉'.repeat(700000) })).rejects.toThrow('2 MB');
    expect(await update(initial.id, { revision: 1, title: '原始笔记', content: 'sharedneedle 合成原文' })).toMatchObject({ version: 1, revision: 1 });
    expect((await sources.detail(initial.id)).versions).toHaveLength(1);
  });
});
