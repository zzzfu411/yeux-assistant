import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PgBoss } from 'pg-boss';
import { Store } from '../packages/storage/src/index.js';
import { Citation, SourceMetadata } from '../packages/contracts/src/index.js';
import { Application } from '../packages/core/src/application.js';
import { initializeData } from '../packages/core/src/config.js';
import { digest } from '../packages/core/src/common.js';
import { putSource, retrieve } from '../packages/core/src/knowledge.js';
import { buildServer } from '../apps/api/src/server.js';

const originalHash = digest('synthetic original document bytes');
const metadata = (changes: Partial<SourceMetadata> = {}): SourceMetadata => ({
  course: 'gse',
  courseName: '生成式软件工程',
  originPath: 'gse/official/lecture.pdf',
  originHash: originalHash,
  format: 'pdf',
  extraction: 'synthetic-test-extractor',
  warnings: [],
  pages: [],
  assetKey: originalHash + '.pdf',
  ...changes,
});

describe('source metadata contract', () => {
  it('validates page ranges, repository relative paths and original asset hashes', () => {
    expect(SourceMetadata.parse(metadata()).assetKey).toBe(originalHash + '.pdf');
    expect(SourceMetadata.safeParse(metadata({ originPath: '../outside.pdf' })).success).toBe(false);
    expect(SourceMetadata.safeParse(metadata({ originPath: '/private/course.pdf' })).success).toBe(false);
    expect(SourceMetadata.safeParse(metadata({ pages: [{ number: 1, start: 10, end: 9 }] })).success).toBe(false);
    expect(SourceMetadata.safeParse(metadata({ assetKey: 'a'.repeat(64) + '.pdf' })).success).toBe(false);
    expect(SourceMetadata.safeParse(metadata({ assetKey: originalHash + '.exe' })).success).toBe(false);
  });
});

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('versioned original-source metadata with PostgreSQL', () => {
  let store: Store, folder: string, app: Application;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Only an isolated *_test database is allowed');
    store = new Store(url);
  });
  beforeEach(async () => {
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'gse-sources-'));
    const token = await initializeData(folder);
    app = new Application(store, {} as PgBoss, folder, token);
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });
  afterAll(async () => {
    await store?.close();
  });
  const put = (input: Parameters<typeof putSource>[1]) => store.transaction((tx) => putSource(tx, input));
  it('upgrades a populated version-one database without rewriting source or learning history', async () => {
    await store.exec('DROP SCHEMA app CASCADE');
    await store.pool.query(
      'CREATE SCHEMA app; CREATE TABLE app.migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await store.pool.query(await readFile(resolve('packages/storage/migrations/0001.sql'), 'utf8'));
    await store.exec('INSERT INTO app.migrations(version) VALUES(1)');
    await store.exec("INSERT INTO app.goals(id,title) VALUES('legacy-goal','保留的学习目标')");
    await store.exec(
      "INSERT INTO app.sources(id,title,path,digest) VALUES('legacy-source','原始讲义','legacy.md',$1)",
      [digest('旧原文')],
    );
    await store.exec(
      "INSERT INTO app.source_versions(source_id,version,content,digest) VALUES('legacy-source',1,'旧原文',$1)",
      [digest('旧原文')],
    );
    const before = (await store.one("SELECT * FROM app.source_versions WHERE source_id='legacy-source'"))!;
    const goalBefore = (await store.one("SELECT * FROM app.goals WHERE id='legacy-goal'"))!;
    await store.migrate();
    await store.migrate();
    const after = (await store.one("SELECT * FROM app.source_versions WHERE source_id='legacy-source'"))!;
    expect(after).toEqual({ ...before, metadata: null, title: '原始讲义' });
    expect(await store.one("SELECT * FROM app.goals WHERE id='legacy-goal'")).toEqual(goalBefore);
    expect((await store.rows('SELECT version FROM app.migrations ORDER BY version')).map((row) => row.version)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    );
    expect((await app.source('legacy-source')).metadata).toBeNull();
  });
  it('versions metadata independently and returns the requested historic metadata', async () => {
    const text = '原始资料内容 unchanged',
      first = metadata(),
      second = metadata({
        extraction: 'synthetic-test-extractor-v2',
        warnings: ['页码已人工核对'],
        pages: [{ number: 4, start: 0, end: text.length }],
      });
    expect(await put({ id: 'versioned', title: '课程讲义', content: text, metadata: first })).toEqual({
      id: 'versioned',
      version: 1,
    });
    expect(await put({ id: 'versioned', title: '课程讲义', content: text, metadata: { ...first, pages: [] } })).toEqual(
      { id: 'versioned', version: 1 },
    );
    expect(await put({ id: 'versioned', title: '课程讲义', content: text, metadata: second })).toEqual({
      id: 'versioned',
      version: 2,
    });
    expect((await app.source('versioned', 1)).metadata).toEqual(first);
    expect((await app.source('versioned', 2)).metadata).toEqual(second);
    expect((await app.sources())[0]).toMatchObject({
      id: 'versioned',
      version: 2,
      metadata: { course: second.course, courseName: second.courseName, format: second.format },
    });
    const versions = await store.rows(
      "SELECT version,digest,content,metadata FROM app.source_versions WHERE source_id='versioned' ORDER BY version",
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]!.digest).toBe(versions[1]!.digest);
    expect(versions[0]!.content).toBe(text);
    expect(versions[0]!.metadata).toEqual(first);
  });
  it('keeps extraction metadata on unchanged scanning and clears it when the extracted text is edited', async () => {
    const original = '原始内容 originalscan',
      details = metadata({ pages: [{ number: 1, start: 0, end: original.length }] }),
      file = join(folder, 'documents', 'course.md');
    await writeFile(file, original);
    await put({ id: 'scanned', title: '课程讲义', path: 'course.md', content: original, metadata: details });
    await app.knowledge.scan();
    expect((await app.source('scanned')).metadata).toEqual(details);
    expect((await app.source('scanned')).version).toBe(1);
    await writeFile(file, original + '\n这是之后的手工修改。');
    await app.knowledge.scan();
    expect((await app.source('scanned')).metadata).toBeNull();
    expect((await app.source('scanned')).version).toBe(2);
    expect((await app.source('scanned', 1)).metadata).toEqual(details);
    const result = await retrieve(store, 'originalscan', ['scanned']);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('location');
    expect(result[0]).not.toHaveProperty('course');
  });
  it('permits explicit metadata removal without changing or destroying an old text version', async () => {
    await put({ id: 'cleared', title: '课程讲义', content: 'immutable text', metadata: metadata() });
    expect(await put({ id: 'cleared', title: '课程讲义', content: 'immutable text', metadata: null })).toEqual({
      id: 'cleared',
      version: 2,
    });
    expect((await app.source('cleared', 1)).metadata).toEqual(metadata());
    expect((await app.source('cleared')).metadata).toBeNull();
    expect(await put({ id: 'cleared', title: '课程讲义', content: 'immutable text' })).toEqual({
      id: 'cleared',
      version: 2,
    });
  });
  it('labels cross-page chunks using half-open ranges and uses slide labels for presentations', async () => {
    const text = 'firstanchor'.padEnd(1800, '甲') + 'lastanchor'.padEnd(600, '乙');
    await put({
      id: 'pages',
      title: '分页讲义',
      content: text,
      metadata: metadata({
        pages: [
          { number: 1, start: 0, end: 1000 },
          { number: 2, start: 1000, end: 1800 },
          { number: 3, start: 1800, end: 2400 },
        ],
      }),
    });
    const first = (await retrieve(store, 'firstanchor', ['pages']))[0]!,
      last = (await retrieve(store, 'lastanchor', ['pages']))[0]!;
    expect(first.location).toBe('第 1–2 页');
    expect(last.location).toBe('第 2–3 页');
    expect(first).toMatchObject({
      course: 'gse',
      courseName: '生成式软件工程',
      originPath: 'gse/official/lecture.pdf',
    });
    expect(first.quote).toBe(text.slice(first.start, first.end));
    expect(last.quote).toBe(text.slice(last.start, last.end));
    expect(Citation.safeParse(first).success).toBe(true);
    const slideText = 'slideonlyanchor';
    await put({
      id: 'slides',
      title: '幻灯片',
      content: slideText,
      metadata: metadata({
        format: 'pptx',
        originPath: 'gse/official/lecture.pptx',
        assetKey: originalHash + '.pptx',
        pages: [{ number: 7, start: 0, end: slideText.length }],
      }),
    });
    expect((await retrieve(store, 'slideonlyanchor', ['slides']))[0]!.location).toBe('幻灯片 7');
  });
  it('applies course selection before the SQL candidate limit and supports unclassified originals', async () => {
    await store.transaction(async (tx) => {
      for (let i = 0; i < 85; i++) {
        const sourceId = 'distractor-' + i;
        await putSource(tx, { id: sourceId, title: 'GSE ' + i, content: 'sharedneedle', metadata: metadata() });
        await tx.exec('UPDATE app.chunks SET id=$2 WHERE source_id=$1', [sourceId, 'a-' + String(i).padStart(3, '0')]);
      }
      await putSource(tx, {
        id: 'target-course',
        title: '数据库课程',
        content: 'sharedneedle',
        metadata: metadata({ course: 'database', courseName: '数据库概论', originPath: 'database/lecture.pdf' }),
      });
      await tx.exec("UPDATE app.chunks SET id='z-target' WHERE source_id='target-course'");
      await putSource(tx, { id: 'unclassified', title: '个人原始笔记', content: 'sharedneedle' });
      await tx.exec("UPDATE app.chunks SET id='z-unclassified' WHERE source_id='unclassified'");
    });
    expect((await app.search('sharedneedle')).some((item) => item.sourceId === 'target-course')).toBe(false);
    expect((await app.search('sharedneedle', 'database')).map((item) => item.sourceId)).toEqual(['target-course']);
    expect((await app.search('sharedneedle', 'unclassified')).map((item) => item.sourceId)).toEqual(['unclassified']);
    expect(await app.search('sharedneedle', 'does-not-exist')).toEqual([]);
  });
  it('rejects extraction ranges beyond the text before any source version is committed', async () => {
    await expect(
      put({
        id: 'bad-range',
        title: '错误范围',
        content: '短文',
        metadata: metadata({ pages: [{ number: 1, start: 0, end: 200 }] }),
      }),
    ).rejects.toThrow('超出了资料正文');
    expect(await store.one("SELECT id FROM app.sources WHERE id='bad-range'")).toBeUndefined();
  });
  it('keeps existing source upload, detail and search APIs compatible without metadata', async () => {
    const built = await buildServer({ url, folder, assets: false });
    try {
      const token = (await readFile(join(folder, 'access-token'), 'utf8')).trim(),
        headers = { authorization: 'Bearer ' + token };
      const uploaded = await built.server.inject({
        method: 'POST',
        url: '/api/v2/sources',
        headers: { ...headers, 'idempotency-key': 'old-client' },
        payload: { title: '普通笔记', content: 'compatibilityneedle 原始内容' },
      });
      expect(uploaded.statusCode).toBe(200);
      const identity = uploaded.json().id;
      const detail = await built.server.inject({ url: '/api/v2/sources/' + identity, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ version: 1, content: 'compatibilityneedle 原始内容', metadata: null });
      const searched = await built.server.inject({ url: '/api/v2/search?q=compatibilityneedle', headers });
      expect(searched.statusCode).toBe(200);
      expect(searched.json()[0]).toMatchObject({ sourceId: identity, version: 1 });
      expect(Citation.safeParse(searched.json()[0]).success).toBe(true);
    } finally {
      await built.server.close();
    }
  });
  it('supports authenticated source maintenance, duplicate receipts and historic API links', async () => {
    const built = await buildServer({ url, folder, assets: false });
    try {
      const headers = { authorization: 'Bearer ' + (await readFile(join(folder, 'access-token'), 'utf8')).trim() };
      const post = (key: string, payload: unknown) =>
        built.server.inject({
          method: 'POST',
          url: '/api/v2/sources',
          headers: { ...headers, 'idempotency-key': key },
          payload,
        });
      const first = await post('api-first', { title: 'API 原标题', content: 'apineedle 原始材料' });
      expect(first.statusCode).toBe(200);
      const identity = first.json().id,
        base = '/api/v2/sources/' + identity;
      const duplicate = await post('api-duplicate', { title: '另一标题', content: 'apineedle 原始材料' });
      expect(duplicate.json()).toMatchObject({ id: identity, duplicate: true, version: 1 });
      expect((await post('api-duplicate', { title: '另一标题', content: 'apineedle 原始材料' })).json()).toEqual(
        duplicate.json(),
      );
      expect(
        (await built.server.inject({ method: 'PATCH', url: base, payload: { revision: 1, title: '未经授权' } }))
          .statusCode,
      ).toBe(401);
      const patch = await built.server.inject({
        method: 'PATCH',
        url: base,
        headers: { ...headers, 'idempotency-key': 'api-update' },
        payload: { revision: 1, title: 'API 新标题', content: 'apineedle 新材料' },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toMatchObject({ version: 2, revision: 2 });
      const old = await built.server.inject({ url: base + '?version=1', headers });
      expect(old.json()).toMatchObject({
        title: 'API 原标题',
        content: 'apineedle 原始材料',
        current_version: 2,
        editableText: true,
      });
      expect(
        (
          await built.server.inject({
            method: 'PATCH',
            url: base,
            headers: { ...headers, 'idempotency-key': 'api-stale' },
            payload: { revision: 1, title: '过期编辑' },
          })
        ).statusCode,
      ).toBe(409);
      const archived = await built.server.inject({
        method: 'PATCH',
        url: base + '/archive',
        headers: { ...headers, 'idempotency-key': 'api-archive' },
        payload: { revision: 2, archived: true },
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().revision).toBe(3);
      expect((await built.server.inject({ url: '/api/v2/sources', headers })).json()).toEqual([]);
      expect((await built.server.inject({ url: '/api/v2/sources?archived=false', headers })).json()).toEqual([]);
      expect((await built.server.inject({ url: '/api/v2/sources?archived=true', headers })).json()).toHaveLength(1);
      expect((await built.server.inject({ url: '/api/v2/sources?archived=yes', headers })).statusCode).toBe(400);
      expect((await built.server.inject({ url: '/api/v2/search?q=apineedle', headers })).json()).toEqual([]);
      const restored = await built.server.inject({
        method: 'PATCH',
        url: base + '/archive',
        headers: { ...headers, 'idempotency-key': 'api-restore' },
        payload: { revision: 3, archived: false },
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ revision: 4, archivedAt: null });
      expect((await built.server.inject({ url: '/api/v2/search?q=apineedle', headers })).json()[0]).toMatchObject({
        sourceId: identity,
        version: 2,
        title: 'API 新标题',
      });
      expect((await built.server.inject({ url: base + '?version=99', headers })).statusCode).toBe(404);
    } finally {
      await built.server.close();
    }
  });
});
