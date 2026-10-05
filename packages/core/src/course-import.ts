import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, mkdir, realpath, link, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SourceMetadata } from '../../contracts/src/index.js';
import type { Store } from '../../storage/src/index.js';
import { AppError, canonical, digest, id, once } from './common.js';
import { putSource } from './knowledge.js';

const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const assetKey = /^[a-f0-9]{64}\.(pdf|ppt|pptx|doc|docx|html|md|txt)$/;
const protectedPath =
  /(^|\/)(?:private|\.git|\.obsidian|node_modules|exercises|answers?|solutions?|past|exams?)(\/|$)|(?:答案|解答|试卷|模拟卷|回忆版)|(?:^|[_\-.])sol(?:[_\-.]|$)/i;
export const CourseBundle = z.object({
  version: z.literal(1),
  documents: z
    .array(
      z
        .object({
          key: z.string().min(1).max(1000),
          title: z.string().min(1).max(200),
          content: z.string().min(1),
          metadata: SourceMetadata,
        })
        .strict(),
    )
    .min(1)
    .max(1000),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
});
export type CourseBundle = z.infer<typeof CourseBundle>;

export function validateBundle(value: unknown): CourseBundle {
  const bundle = CourseBundle.parse(value),
    keys = new Set<string>();
  for (const document of bundle.documents) {
    const metadata = document.metadata;
    if (keys.has(document.key)) throw new AppError('同一来源在导入包中重复出现。');
    keys.add(document.key);
    if (
      document.key !== metadata.originPath ||
      !document.key.startsWith(metadata.course + '/') ||
      protectedPath.test(document.key)
    )
      throw new AppError('来源路径与课程不符，或属于未开放的答案、试卷、私人目录。');
    if (
      Buffer.byteLength(document.content) > 2_000_000 ||
      document.content.includes('\0') ||
      Buffer.from(document.content).toString('utf8') !== document.content
    )
      throw new AppError('提取文本超过 2 MB 或含无效字符，不能截断导入。');
    if (
      !metadata.assetKey ||
      !assetKey.test(metadata.assetKey) ||
      !metadata.assetKey.startsWith(metadata.originHash + '.')
    )
      throw new AppError('导入包缺少与来源摘要匹配的原件。');
    let end = 0;
    for (const page of metadata.pages) {
      if (page.start < end || page.end > document.content.length || page.end <= page.start)
        throw new AppError('原文页码范围无效。');
      const splitsPair = (at: number) =>
        at > 0 &&
        at < document.content.length &&
        /[\uD800-\uDBFF]/.test(document.content[at - 1]!) &&
        /[\uDC00-\uDFFF]/.test(document.content[at]!);
      if (splitsPair(page.start) || splitsPair(page.end)) throw new AppError('页码范围切断了 Unicode 字符。');
      end = page.end;
    }
  }
  return bundle;
}

/** Read only an immutable, hash-addressed asset, never a caller-supplied path. */
async function readAsset(directory: string, key: string, expectedHash: string) {
  if (!assetKey.test(key)) throw new AppError('原文件标识无效。', 404);
  let root: string;
  try {
    root = await realpath(directory);
  } catch {
    throw new AppError('原文件尚未保存，请重新准备资料。', 404);
  }
  const path = join(root, key);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new AppError('原文件类型或大小不受支持。');
    const actual = await realpath(path);
    if (!actual.startsWith(root + sep)) throw new AppError('原文件路径越界。');
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
      throw new AppError('原文件摘要不匹配，已停止读取。', 409, 'source_asset_changed');
    return bytes;
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    throw new AppError('原文件缺失或不是可读取的普通文件。', 404, 'source_asset_missing');
  } finally {
    await handle?.close();
  }
}

export async function originalAsset(folder: string, metadata: unknown) {
  const parsed = SourceMetadata.safeParse(metadata);
  if (!parsed.success || !parsed.data.assetKey) throw new AppError('这份资料没有保存原文件。', 404);
  const bytes = await readAsset(join(folder, 'source-assets'), parsed.data.assetKey, parsed.data.originHash);
  return { bytes, filename: parsed.data.originPath.split('/').at(-1)! };
}

async function publishAsset(directory: string, key: string, bytes: Buffer, hash: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.import-' + id());
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    try {
      await link(temporary, join(directory, key));
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      await readAsset(directory, key, hash);
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function importCourses(store: Store | undefined, bundlePath: string, folder: string, apply = false) {
  const path = resolve(bundlePath),
    handle = await open(path, 'r');
  let bundle: CourseBundle;
  try {
    if ((await handle.stat()).size > 100 * 1024 * 1024) throw new AppError('导入包过大，请按课程分批。');
    bundle = validateBundle(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
  const courses: Record<string, number> = {};
  // Validate every asset before touching the database; originals remain local.
  for (const document of bundle.documents) {
    const metadata = document.metadata;
    const bytes = await readAsset(join(dirname(path), 'assets'), metadata.assetKey!, metadata.originHash);
    if (apply) await publishAsset(join(folder, 'source-assets'), metadata.assetKey!, bytes, metadata.originHash);
    courses[metadata.course] = (courses[metadata.course] || 0) + 1;
  }
  const summary = {
    documents: bundle.documents.length,
    courses,
    skipped: bundle.skipped,
    bundleDigest: digest(bundle),
    warnings: bundle.documents.flatMap((document) =>
      document.metadata.warnings.map((warning) => ({ path: document.key, warning })),
    ),
  };
  if (!apply) return { mode: 'dry-run', ...summary };
  if (!store) throw new AppError('正式导入需要 PostgreSQL。');
  const receipt = await store.transaction((tx) =>
    once(tx, 'courses:' + summary.bundleDigest, 'courses.import', summary, async () => {
      await tx.exec('SELECT pg_advisory_xact_lock(847392020)');
      const results: Array<{ key: string; sourceId: string; version: number; action: string }> = [];
      for (const document of bundle.documents) {
        const sourceId = 'course-' + digest(document.key).slice(0, 32);
        const prior = await tx.one(
          'SELECT s.version,s.title,s.digest,v.metadata FROM app.sources s JOIN app.source_versions v ON v.source_id=s.id AND v.version=s.version WHERE s.id=$1',
          [sourceId],
        );
        const same =
          prior?.title === document.title &&
          prior?.digest === digest(document.content) &&
          canonical(prior.metadata) === canonical(document.metadata);
        const result = await putSource(tx, {
          id: sourceId,
          title: document.title,
          content: document.content,
          metadata: document.metadata,
        });
        results.push({
          key: document.key,
          sourceId,
          version: result.version,
          action: !prior ? 'added' : same ? 'unchanged' : 'updated',
        });
      }
      return { mode: 'applied', ...summary, results };
    }),
  );
  return receipt;
}
