import { readFile, readdir, lstat, writeFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { AppError, canonical, digest, id, event, notify, iso } from './common.js';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import { SourceMetadata, type Citation } from '../../contracts/src/index.js';
import type { SourceImportResult } from '../../contracts/src/source-inputs.js';

export function chunks(content: string, size = 1800, overlap = 200) {
  if (size < 2 || overlap < 0 || overlap >= size - 1) throw new Error('Invalid chunk size/overlap');
  const result: Array<{ start: number; end: number; content: string }> = [];
  const splitPair = (offset: number) =>
    offset > 0 &&
    offset < content.length &&
    /[\uD800-\uDBFF]/.test(content[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(content[offset]!);
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + size);
    if (splitPair(end)) end--;
    result.push({ start, end, content: content.slice(start, end) });
    if (end === content.length) break;
    let next = end - overlap;
    if (splitPair(next)) next--;
    start = Math.max(start + 1, next);
  }
  return result;
}
export function terms(query: string) {
  const result: string[] = [];
  for (const token of query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) || []) {
    if (/\p{Script=Han}/u.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) result.push(token.slice(i, i + 2));
    } else result.push(token);
  }
  return [...new Set(result)].slice(-48);
}
export function validateSourceText(content: string) {
  if (Buffer.byteLength(content) > 2_000_000) throw new AppError('资料超过 2 MB，请拆成较小的文本。');
  if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content)
    throw new AppError('资料包含无法保存的字符，请使用有效的 UTF-8 文本。');
}
export async function putSource(
  tx: Tx,
  input: {
    id: string;
    title: string;
    content: string;
    path?: string;
    metadata?: SourceMetadata | null;
    managed?: boolean;
  },
) {
  validateSourceText(input.content);
  await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + input.id]);
  const hash = digest(input.content);
  const prior = await tx.one('SELECT * FROM app.sources WHERE id=$1 FOR UPDATE', [input.id]);
  const oldMetadata = prior
    ? ((
        await tx.one('SELECT metadata FROM app.source_versions WHERE source_id=$1 AND version=$2', [
          input.id,
          prior.version,
        ])
      )?.metadata ?? null)
    : null;
  // A plain scanner may observe the same extracted file. Keep its metadata only while its text matches.
  const metadata =
    input.metadata === undefined
      ? prior?.digest === hash
        ? oldMetadata
        : null
      : input.metadata === null
        ? null
        : SourceMetadata.parse(input.metadata);
  if (metadata?.pages.some((page: SourceMetadata['pages'][number]) => page.end > input.content.length))
    throw new AppError('提取页码范围超出了资料正文，尚未保存。');
  if (prior?.digest === hash && prior.title === input.title && canonical(oldMetadata) === canonical(metadata)) {
    if (input.managed && !prior.managed) {
      await tx.exec('UPDATE app.sources SET managed=true,revision=revision+1,updated_at=now() WHERE id=$1', [input.id]);
      await event(tx, 'source.updated', input.id, { version: prior.version });
    }
    return { id: input.id, version: prior.version };
  }
  const version = (prior?.version || 0) + 1;
  await tx.exec(
    'INSERT INTO app.sources(id,title,path,version,digest,managed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET title=excluded.title,version=excluded.version,digest=excluded.digest,managed=app.sources.managed OR excluded.managed,revision=app.sources.revision+1,updated_at=now()',
    [input.id, input.title, input.path || null, version, hash, input.managed ?? false],
  );
  await tx.exec(
    'INSERT INTO app.source_versions(source_id,version,title,content,digest,metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [input.id, version, input.title, input.content, hash, metadata === null ? null : JSON.stringify(metadata)],
  );
  for (const piece of chunks(input.content))
    await tx.exec(
      'INSERT INTO app.chunks(id,source_id,version,start_offset,end_offset,content) VALUES($1,$2,$3,$4,$5,$6)',
      [id(), input.id, version, piece.start, piece.end, piece.content],
    );
  await event(tx, 'source.updated', input.id, { version });
  return { id: input.id, version };
}
export function citationFromRow(row: Row): Citation {
  const citation: Citation = {
    sourceId: row.source_id,
    version: row.version,
    title: row.title,
    start: row.start_offset,
    end: row.end_offset,
    quote: row.content,
    digest: row.digest,
  };
  const parsed = SourceMetadata.safeParse(row.metadata);
  if (!parsed.success) return citation;
  const metadata = parsed.data;
  citation.course = metadata.course;
  citation.courseName = metadata.courseName;
  citation.originPath = metadata.originPath;
  const pages = metadata.pages
    .filter((page) => page.end > citation.start && page.start < citation.end && page.end > page.start)
    .map((page) => page.number);
  if (pages.length) {
    const first = Math.min(...pages),
      last = Math.max(...pages),
      range = first === last ? String(first) : `${first}–${last}`;
    citation.location = /^\.?(ppt|pptx|odp|slides)$/i.test(metadata.format) ? `幻灯片 ${range}` : `第 ${range} 页`;
  }
  return citation;
}
export async function retrieve(
  tx: Tx,
  query: string,
  sourceIds: string[] = [],
  limit = 6,
  course?: string,
  scope?: 'mail' | 'errand',
): Promise<Citation[]> {
  const words = terms(query);
  if (!words.length) return [];
  const patterns = words.map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
  const rows = await tx.rows(
    `SELECT c.*,v.title,v.digest,v.metadata FROM app.chunks c JOIN app.sources s ON c.source_id=s.id AND c.version=s.version
    JOIN app.source_versions v ON v.source_id=c.source_id AND v.version=c.version
    WHERE s.archived_at IS NULL AND s.missing_at IS NULL AND ($5::boolean OR s.path IS NULL OR s.path NOT LIKE 'workspace/profile/%') AND (cardinality($1::text[])=0 OR s.id=ANY($1::text[])) AND c.content ILIKE ANY($2::text[])
    AND ($4::text IS NULL OR ($4='unclassified' AND coalesce(v.metadata->>'course','')='') OR ($4<>'unclassified' AND v.metadata->>'course'=$4))
    ORDER BY word_similarity($3,c.content) DESC,c.id LIMIT 80`,
    [sourceIds, patterns, query.slice(-300), course || null, Boolean(scope)],
  );
  return rows
    .map((row) => ({ row, score: words.reduce((n, t) => n + Number(row.content.toLowerCase().includes(t)), 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => citationFromRow(row));
}
export class Knowledge {
  readonly seen = new Map<string, string>();
  constructor(
    readonly store: Store,
    readonly folder: string,
  ) {}
  async import(
    tx: Tx,
    key: string,
    title: string,
    content: string,
    allowDuplicate = false,
  ): Promise<SourceImportResult> {
    const sourceId = 'source-' + digest(key).slice(0, 24),
      path = sourceId + '.md';
    validateSourceText(content);
    // Serialize equal Web uploads, including requests using different idempotency keys.
    await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-digest:' + digest(content)]);
    await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-path:' + path]);
    const prior = await tx.one('SELECT id FROM app.sources WHERE path=$1', [path]);
    if (!prior && !allowDuplicate) {
      const duplicate = await tx.one(
        'SELECT id,version,revision,archived_at FROM app.sources WHERE digest=$1 ORDER BY (archived_at IS NOT NULL),created_at,id LIMIT 1 FOR SHARE',
        [digest(content)],
      );
      if (duplicate)
        return {
          id: duplicate.id,
          version: duplicate.version,
          revision: duplicate.revision,
          duplicate: true,
          archivedAt: duplicate.archived_at ? iso(duplicate.archived_at) : null,
        };
    }
    const file = join(this.folder, 'documents', path);
    try {
      await writeFile(file, content, { flag: 'wx', mode: 0o600, flush: true });
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if ((await readFile(file, 'utf8')) !== content)
        throw new AppError('原始资料已被修改，不能覆盖。', 409, 'source_conflict');
    }
    const saved = await putSource(tx, { id: prior?.id || sourceId, title, content, path, managed: true });
    const current = (await tx.one('SELECT revision,archived_at FROM app.sources WHERE id=$1', [saved.id]))!;
    return {
      ...saved,
      revision: current.revision,
      duplicate: false,
      archivedAt: current.archived_at ? iso(current.archived_at) : null,
    };
  }
  async scan() {
    const connection = await this.store.pool.connect();
    try {
      await connection.query('SELECT pg_advisory_lock(847392031)');
      return await this.scanRoots();
    } finally {
      await connection.query('SELECT pg_advisory_unlock(847392031)').catch(() => {});
      connection.release();
    }
  }
  private async scanRoots() {
    // Missing files are marked only after a complete successful traversal of that root.
    // An unreadable root must not make every source disappear from retrieval.
    const roots = [
      { directory: 'documents', prefix: '' },
      { directory: 'workspace/notes', prefix: 'workspace/notes/' },
      { directory: 'workspace/profile', prefix: 'workspace/profile/' },
      { directory: 'workspace/records', prefix: 'workspace/records/' },
    ];
    for (const root of roots) {
      const location = resolve(this.folder, root.directory);
      let base = location,
        rootMissing = false;
      try {
        const info = await lstat(location);
        if (!info.isDirectory()) throw new AppError('资料根目录必须是普通目录。');
        base = await realpath(location);
      } catch (error: any) {
        if (error.code === 'ENOENT') rootMissing = true;
        else throw error;
      }
      const present = new Set<string>();
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (directory === base && !root.prefix && entry.name === 'archive') continue;
            await visit(file);
            continue;
          }
          if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) continue;
          const name = root.prefix + relative(base, file).split(sep).join('/'),
            info = await lstat(file),
            stamp = info.mtimeMs + ':' + info.size;
          present.add(name);
          const observed = await this.store.one(
            'SELECT managed,archived_at,missing_at FROM app.sources WHERE path=$1',
            [name],
          );
          if (observed?.managed || observed?.archived_at) continue;
          if (this.seen.get(name) === stamp && !observed?.missing_at) continue;
          try {
            const actual = await realpath(file);
            if (!actual.startsWith(base + sep)) throw new AppError('资料路径越界。');
            if (info.size > 2_000_000) throw new AppError('资料超过 2 MB，尚未索引。');
            const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(actual));
            const indexed = await this.store.transaction(async (tx) => {
              await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-path:' + name]);
              const found = await tx.one('SELECT id FROM app.sources WHERE path=$1', [name]);
              const sourceId = found?.id || 'file-' + digest(name).slice(0, 24);
              await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + sourceId]);
              const old = await tx.one('SELECT * FROM app.sources WHERE path=$1', [name]);
              if (old?.managed || old?.archived_at) return false;
              await putSource(tx, { id: sourceId, title: old?.title || name, content, path: name });
              if (old?.missing_at) {
                await tx.exec(
                  'UPDATE app.sources SET missing_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1',
                  [sourceId],
                );
                await event(tx, 'source.restored', sourceId);
              }
              return true;
            });
            if (indexed) this.seen.set(name, stamp);
          } catch (error) {
            await this.store.transaction((tx) =>
              notify(
                tx,
                'source-error:' + digest(name + stamp),
                null,
                '有一份资料尚未索引',
                name + '：' + (error instanceof AppError ? error.message : '请检查文件编码与读取权限。'),
              ),
            );
          }
        }
      };
      if (!rootMissing) await visit(base);
      const candidates = await this.store.rows(
        'SELECT id,path FROM app.sources WHERE NOT managed AND path IS NOT NULL AND missing_at IS NULL',
      );
      for (const source of candidates) {
        const inRoot = root.prefix
          ? source.path.startsWith(root.prefix)
          : !source.path.startsWith('workspace/') && !source.path.startsWith('archive/');
        if (!inRoot || present.has(source.path)) continue;
        await this.store.transaction(async (tx) => {
          await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-path:' + source.path]);
          await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + source.id]);
          const result = await tx.exec(
            'UPDATE app.sources SET missing_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND NOT managed AND missing_at IS NULL',
            [source.id],
          );
          if (result.rowCount) await event(tx, 'source.missing', source.id);
        });
        this.seen.delete(source.path);
      }
    }
  }
}
