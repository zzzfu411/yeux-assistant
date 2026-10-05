import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { importCourses, type CourseBundle } from '../packages/core/src/course-import.js';

type Document = CourseBundle['documents'][number];
type Fixture = { document: Document; bytes: Buffer };
const fileHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const courseNames: Record<string, string> = { gse: '生成式软件工程', database: '数据库概论', se: '软件工程' };
function document(
  course: string,
  path = course + '/official/lecture.pdf',
  content = 'courseneedle 原始课程内容',
  bytes = Buffer.concat([Buffer.from('%PDF-synthetic ' + path + '\r\n'), Buffer.from([0, 255, 13, 10, 1, 128])]),
): Fixture {
  const hash = fileHash(bytes),
    format = extname(path).slice(1).toLowerCase();
  return {
    bytes,
    document: {
      key: path,
      title: basename(path),
      content,
      metadata: {
        course,
        courseName: courseNames[course] || course,
        originPath: path,
        originHash: hash,
        format,
        extraction: 'synthetic-integration-test',
        warnings: [],
        pages: [{ number: 1, start: 0, end: content.length }],
        assetKey: hash + '.' + format,
      },
    },
  };
}

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('course bundle import and authenticated original downloads', () => {
  let built: Awaited<ReturnType<typeof buildServer>>,
    temporary: string,
    folder: string,
    bundleFolder: string,
    bundlePath: string,
    headers: { authorization: string };
  beforeAll(() => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Only a disposable *_test database is allowed');
  });
  beforeEach(async () => {
    const setup = new Store(url);
    try {
      await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
      await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    } finally {
      await setup.close();
    }
    temporary = await mkdtemp(join(tmpdir(), 'gse-course-import-'));
    folder = join(temporary, 'assistant');
    bundleFolder = join(temporary, 'bundle');
    bundlePath = join(bundleFolder, 'bundle.json');
    await mkdir(join(bundleFolder, 'assets'), { recursive: true });
    built = await buildServer({ url, folder, assets: false });
    headers = { authorization: 'Bearer ' + (await readFile(join(folder, 'access-token'), 'utf8')).trim() };
  });
  afterEach(async () => {
    await built?.server.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  async function bundle(fixtures: Fixture[], skipped: CourseBundle['skipped'] = []) {
    for (const fixture of fixtures)
      await writeFile(join(bundleFolder, 'assets', fixture.document.metadata.assetKey!), fixture.bytes);
    await writeFile(
      bundlePath,
      JSON.stringify({ version: 1, documents: fixtures.map((item) => item.document), skipped }),
    );
    return bundlePath;
  }
  async function apply(fixtures: Fixture[]) {
    await bundle(fixtures);
    const result = await importCourses(built.store, bundlePath, folder, true);
    if (!('results' in result)) throw new Error('Expected applied import receipt');
    return result;
  }
  async function counts() {
    return Promise.all(
      ['sources', 'source_versions', 'chunks', 'commands', 'events'].map(async (table) =>
        Number((await built.store.one('SELECT count(*) n FROM app.' + table))!.n),
      ),
    );
  }
  const get = (path: string) => built.server.inject({ method: 'GET', url: '/api/v2' + path, headers });

  it('preflights without writing database rows or creating a target data directory', async () => {
    const fixture = document('gse');
    fixture.document.metadata.warnings = ['合成提取提示'];
    await bundle([fixture], [{ path: 'gse/official/unavailable.pdf', reason: '未能提取文字' }]);
    const untouched = join(temporary, 'unused-dry-target'),
      before = await counts(),
      original = await readFile(bundlePath);
    const preview = await importCourses(undefined, bundlePath, untouched, false);
    expect(preview).toMatchObject({
      mode: 'dry-run',
      documents: 1,
      courses: { gse: 1 },
      skipped: [{ path: 'gse/official/unavailable.pdf', reason: '未能提取文字' }],
      warnings: [{ path: fixture.document.key, warning: '合成提取提示' }],
    });
    expect(await counts()).toEqual(before);
    await expect(access(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(bundlePath)).toEqual(original);
    expect(await readFile(join(bundleFolder, 'assets', fixture.document.metadata.assetKey!))).toEqual(fixture.bytes);
  });
  it('applies a bundle idempotently and serves the exact binary original behind authentication', async () => {
    const fixture = document('gse', "gse/official/第一讲 (版本'1).pdf");
    const first = await apply([fixture]),
      second = await importCourses(built.store, bundlePath, folder, true);
    expect(second).toEqual(first);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ version: 1, action: 'added' });
    const sourceId = first.results[0]!.sourceId;
    expect((await built.store.one('SELECT count(*) n FROM app.source_versions'))!.n).toBe('1');
    expect((await built.store.one('SELECT count(*) n FROM app.commands'))!.n).toBe('1');
    const detail = (await get('/sources/' + sourceId)).json();
    expect(detail.metadata.originHash).toBe(fileHash(fixture.bytes));
    expect(detail.metadata.assetKey).toBe(fixture.document.metadata.assetKey);
    expect((await built.server.inject({ url: '/api/v2/sources/' + sourceId + '/original' })).statusCode).toBe(401);
    const downloaded = await get('/sources/' + sourceId + '/original');
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(fixture.bytes);
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-type']).toBe('application/octet-stream');
    expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(downloaded.headers['content-disposition']).toContain('%27');
  });
  it('preserves old metadata and original bytes after a newer revision and replay of an older import', async () => {
    const firstFixture = document(
      'database',
      'database/notes/lecture.pdf',
      '第一版 courseneedle',
      Buffer.from('%PDF-synthetic original revision one\0'),
    );
    const first = await apply([firstFixture]),
      sourceId = first.results[0]!.sourceId;
    const secondFixture = document(
      'database',
      firstFixture.document.key,
      '第二版 courseneedle',
      Buffer.from('%PDF-synthetic original revision two\xff', 'latin1'),
    );
    const second = await apply([secondFixture]);
    expect(second.results[0]).toMatchObject({ sourceId, version: 2, action: 'updated' });
    const oldDetail = (await get('/sources/' + sourceId + '?version=1')).json(),
      newDetail = (await get('/sources/' + sourceId)).json();
    expect(oldDetail.metadata).toEqual(firstFixture.document.metadata);
    expect(newDetail.metadata).toEqual(secondFixture.document.metadata);
    expect(oldDetail.content).toBe(firstFixture.document.content);
    expect(newDetail.content).toBe(secondFixture.document.content);
    expect((await get('/sources/' + sourceId + '/original?version=1')).rawPayload).toEqual(firstFixture.bytes);
    expect((await get('/sources/' + sourceId + '/original?version=2')).rawPayload).toEqual(secondFixture.bytes);
    expect((await get('/sources/' + sourceId + '/original')).rawPayload).toEqual(secondFixture.bytes);
    await bundle([firstFixture]);
    expect(await importCourses(built.store, bundlePath, folder, true)).toEqual(first);
    expect((await get('/sources/' + sourceId)).json().version).toBe(2);
    expect((await get('/sources/' + sourceId + '/original')).rawPayload).toEqual(secondFixture.bytes);
    expect((await built.store.one('SELECT count(*) n FROM app.source_versions'))!.n).toBe('2');
  });
  it.each(['tampered', 'missing'] as const)(
    'writes no part of a batch when a later original is %s',
    async (condition) => {
      const valid = document('gse'),
        broken = document('database');
      await bundle([valid, broken]);
      const invalidAsset = join(bundleFolder, 'assets', broken.document.metadata.assetKey!);
      if (condition === 'tampered') await writeFile(invalidAsset, 'wrong bytes');
      else await rm(invalidAsset);
      const before = await counts();
      await expect(importCourses(built.store, bundlePath, folder, true)).rejects.toMatchObject({
        status: condition === 'tampered' ? 409 : 404,
      });
      expect(await counts()).toEqual(before);
      expect((await built.store.one('SELECT count(*) n FROM app.sources'))!.n).toBe('0');
    },
  );
  it.each([
    'gse/answers/lab1.pdf',
    'gse/official/lab1_sol.pdf',
    'database/解答/lecture.pdf',
    'se/past/exams/review.pdf',
  ])('refuses protected source path %s before importing', async (path) => {
    const fixture = document(path.split('/')[0]!, path);
    await bundle([fixture]);
    await expect(importCourses(built.store, bundlePath, folder, true)).rejects.toThrow('未开放的答案');
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
    await expect(access(join(folder, 'source-assets'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects duplicate source identities in a bundle before creating source versions', async () => {
    const fixture = document('gse');
    await bundle([fixture, fixture]);
    await expect(importCourses(built.store, bundlePath, folder, true)).rejects.toThrow('重复出现');
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
  });
  it('returns 404 for missing originals and 409 for hash-mismatched stored originals', async () => {
    const fixture = document('gse'),
      result = await apply([fixture]),
      sourceId = result.results[0]!.sourceId;
    const assetPath = join(folder, 'source-assets', fixture.document.metadata.assetKey!);
    await rm(assetPath);
    const missing = await get('/sources/' + sourceId + '/original');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('source_asset_missing');
    await writeFile(assetPath, 'modified original');
    const modified = await get('/sources/' + sourceId + '/original');
    expect(modified.statusCode).toBe(409);
    expect(modified.json().error.code).toBe('source_asset_changed');
    expect((await get('/sources/' + sourceId)).json().metadata.originHash).toBe(fixture.document.metadata.originHash);
    expect((await get('/sources/' + sourceId + '/original?version=999')).statusCode).toBe(404);
  });
  it('does not follow a symlink substituted for a stored original', async () => {
    const fixture = document('gse'),
      result = await apply([fixture]),
      sourceId = result.results[0]!.sourceId;
    const outside = join(temporary, 'outside-original.pdf'),
      assetPath = join(folder, 'source-assets', fixture.document.metadata.assetKey!);
    await writeFile(outside, fixture.bytes);
    await rm(assetPath);
    await symlink(outside, assetPath);
    const response = await get('/sources/' + sourceId + '/original');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('source_asset_missing');
    expect(await readFile(outside)).toEqual(fixture.bytes);
  });
  it('filters search by course or unclassified source through the authenticated API', async () => {
    await apply([document('gse'), document('database'), document('se')]);
    const ordinary = await built.server.inject({
      method: 'POST',
      url: '/api/v2/sources',
      headers: { ...headers, 'idempotency-key': 'ordinary-source' },
      payload: { title: '个人笔记', content: 'courseneedle 个人原始笔记' },
    });
    expect(ordinary.statusCode).toBe(200);
    const plainId = ordinary.json().id;
    const all = await get('/search?q=courseneedle');
    expect(all.statusCode).toBe(200);
    expect(all.json()).toHaveLength(4);
    for (const course of ['gse', 'database', 'se']) {
      const response = await get('/search?q=courseneedle&course=' + course);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0]).toMatchObject({
        course,
        originPath: course + '/official/lecture.pdf',
        location: '第 1 页',
      });
    }
    const unclassified = await get('/search?q=courseneedle&course=unclassified');
    expect(unclassified.json().map((item: { sourceId: string }) => item.sourceId)).toEqual([plainId]);
    expect((await get('/sources/' + plainId + '/original')).statusCode).toBe(404);
    expect((await get('/search?q=courseneedle&course=unknown')).json()).toEqual([]);
    expect((await get('/search?q=courseneedle&course=..%2Foutside')).statusCode).toBe(400);
    expect((await built.server.inject({ url: '/api/v2/search?q=courseneedle&course=gse' })).statusCode).toBe(401);
  });
});
