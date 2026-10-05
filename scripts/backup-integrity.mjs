import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fileRoots = new Set(['database.dump', 'admin-auth.json', 'config.json', 'access-token', 'runtime.env', 'compose.override.yaml', 'v2-cutover.json']);
const directoryRoots = new Set(['source-assets', 'documents', 'artifacts', 'receipts', 'mail-quarantine']);
const metadata = new Set(['manifest.json', 'README.txt']);
const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !/[\\:\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const supportedPath = path => {
  const [root, ...rest] = path.split('/');
  return (fileRoots.has(root) && rest.length === 0) || (directoryRoots.has(root) && rest.length > 0);
};
const failure = (code, message) => Object.assign(new Error(message), { code });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Consumers receive stable messages, never archive contents or subprocess stderr.
export function validateManifest(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'completedAt,files,version' || value.version !== 1
      || typeof value.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.completedAt)
      || !Number.isFinite(Date.parse(value.completedAt)) || new Date(value.completedAt).toISOString() !== value.completedAt
      || !Array.isArray(value.files) || !value.files.length || value.files.length > 100000) {
    throw failure('manifest_invalid', '备份清单格式无效或版本不受支持。');
  }
  const paths = new Set();
  for (const entry of value.files) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256'
        || !safePath(entry.path) || !supportedPath(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw failure('manifest_entry_invalid', '备份清单包含无效文件项或不安全路径。');
    }
    if (paths.has(entry.path)) throw failure('manifest_duplicate', '备份清单包含重复文件项。');
    paths.add(entry.path);
  }
  if (!paths.has('database.dump')) throw failure('dump_missing', '备份清单缺少 database.dump。');
  return value;
}

async function plainFile(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile()) throw failure('unsupported_file', '备份包含符号链接或非普通文件。');
  if (maximum !== undefined && info.size > maximum) throw failure('manifest_too_large', '备份清单超过可验证的大小限制。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const current = await handle.stat();
  if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) {
    await handle.close(); throw failure('backup_changed', '备份在验证期间发生变化，请停止修改后重试。');
  }
  return handle;
}

export function inspectDump(path, run = spawnSync) {
  const version = run('pg_restore', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] });
  if (version.error?.code === 'ENOENT') return { status: 'header_only', message: '未找到 pg_restore；仅验证了文件校验和及 dump 头，请使用 PostgreSQL 18 的 pg_restore 完成结构验证。' };
  if (version.error || version.status !== 0) return { status: 'unverified', message: 'pg_restore 无法运行；文件校验和已核对，dump 结构尚未验证。' };
  // Decode the entire archive into discarded SQL. No database connection, SQL execution or output file.
  const result = run('pg_restore', ['--no-owner', '--no-privileges', '--file=-', path], {
    timeout: 30000, stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (result.error?.code === 'ETIMEDOUT') return { status: 'unverified', message: 'dump 结构检查超时；使用 PostgreSQL 18 的 pg_restore 在独立环境中继续检查。' };
  if (result.error || result.status !== 0) throw failure('dump_invalid', 'pg_restore 无法读取完整 dump；文件可能损坏或工具版本不兼容，请使用 PostgreSQL 18 再核对。');
  return { status: 'decoded', message: 'pg_restore 已读取完整归档；尚未执行数据库恢复。' };
}

export async function verifyBackup(folder, { checkDump = inspectDump } = {}) {
  const root = resolve(folder), errors = [], warnings = [];
  const snapshots = new Map(), sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  let files = 0, bytes = 0, dump = 'not_checked';
  try {
    if (!(await lstat(root)).isDirectory()) throw failure('backup_directory_invalid', '请选择普通备份目录；不接受符号链接。');
    const manifestHandle = await plainFile(join(root, 'manifest.json'), 32 * 1024 * 1024);
    let manifest;
    try {
      const before = await manifestHandle.stat();
      manifest = validateManifest(JSON.parse(await manifestHandle.readFile('utf8')));
      if (!sameFile(before, await manifestHandle.stat())) throw failure('backup_changed', '备份在验证期间发生变化，请停止修改后重试。');
      snapshots.set('manifest.json', before);
    }
    catch (error) { if (error.code) throw error; throw failure('manifest_invalid', '备份清单不是有效 JSON。'); }
    finally { await manifestHandle.close(); }
    const found = new Set();
    async function walk(relative = '') {
      for (const name of await readdir(join(root, relative))) {
        const path = relative ? relative + '/' + name : name;
        if (!safePath(path)) throw failure('unsafe_path', '备份包含不安全文件路径。');
        const info = await lstat(join(root, path));
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw failure('unsupported_file', '备份包含符号链接或非普通文件。');
        if (info.isDirectory()) {
          if (!directoryRoots.has(path.split('/')[0])) throw failure('unexpected_file', '备份包含清单范围之外的目录。');
          await walk(path);
        } else if (!metadata.has(path)) {
          if (!supportedPath(path)) throw failure('unexpected_file', '备份包含清单范围之外的文件。');
          found.add(path);
        }
      }
    }
    await walk();
    const expected = new Set(manifest.files.map(file => file.path));
    if ([...expected].some(path => !found.has(path))) throw failure('file_missing', '备份缺少清单中列出的文件。');
    if ([...found].some(path => !expected.has(path))) throw failure('file_unlisted', '备份包含未列入清单的文件。');
    for (const entry of manifest.files) {
      const handle = await plainFile(join(root, entry.path));
      try {
        const before = await handle.stat(), hash = createHash('sha256'); let size = 0;
        const header = Buffer.alloc(20); let headerBytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          hash.update(chunk); size += chunk.length;
          if (entry.path === 'database.dump' && headerBytes < 20) headerBytes += chunk.copy(header, headerBytes, 0, 20 - headerBytes);
        }
        const after = await handle.stat();
        if (!sameFile(before, after)) throw failure('backup_changed', '备份在验证期间发生变化，请停止修改后重试。');
        if (size !== entry.bytes || hash.digest('hex') !== entry.sha256) throw failure('checksum_mismatch', '备份文件的字节数或 SHA-256 与清单不符。');
        if (entry.path === 'database.dump' && (headerBytes < 20 || header.subarray(0, 5).toString('ascii') !== 'PGDMP'
            || header[5] !== 1 || ![4, 8].includes(header[8]) || ![4, 8].includes(header[9]) || header[10] !== 1)) {
          throw failure('dump_header_invalid', 'database.dump 不是有效的 PostgreSQL custom 归档头，或文件已截断。');
        }
        snapshots.set(entry.path, after); files++; bytes += size;
      } finally { await handle.close(); }
    }
    const result = await checkDump(join(root, 'database.dump'));
    for (const [path, before] of snapshots) if (!sameFile(before, await lstat(join(root, path)))) throw failure('backup_changed', '备份在验证期间发生变化，请停止修改后重试。');
    dump = result.status;
    if (dump !== 'decoded') warnings.push({ code: 'dump_not_decoded', message: result.message });
  } catch (error) {
    const known = new Set(['manifest_invalid', 'manifest_entry_invalid', 'manifest_duplicate', 'dump_missing', 'unsupported_file', 'manifest_too_large', 'backup_changed', 'dump_invalid', 'backup_directory_invalid', 'unsafe_path', 'unexpected_file', 'file_missing', 'file_unlisted', 'checksum_mismatch', 'dump_header_invalid']);
    errors.push({ code: known.has(error.code) ? error.code : 'backup_unreadable', message: known.has(error.code) ? error.message : '备份目录或文件无法读取，请检查路径与权限。' });
  }
  return { ok: errors.length === 0, complete: errors.length === 0 && dump === 'decoded', files, bytes, dump, errors, warnings };
}
