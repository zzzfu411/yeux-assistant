import { mkdir, readdir, lstat, copyFile, writeFile, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Exclude caches, prior backups and arbitrary host paths. All active application files are included.
const entries = [
  'admin-auth.json',
  'config.json',
  'access-token',
  'runtime.env',
  'compose.override.yaml',
  'v2-cutover.json',
  'source-assets',
  'documents',
  'artifacts',
  'receipts',
  'mail-quarantine',
];
export async function createBackup(folder, dump) {
  const parent = join(folder, 'backups');
  const name = 'postgres-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const staging = join(parent, '.' + name + '.partial'),
    output = join(parent, name);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const files = [];
  async function record(path) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(join(staging, path))) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    files.push({ path, bytes, sha256: hash.digest('hex') });
  }
  async function copy(path) {
    const source = join(folder, path),
      destination = join(staging, path),
      info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error('备份遇到符号链接：' + path + '。请将原件保存在数据目录中。');
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const child of (await readdir(source)).sort()) await copy(join(path, child));
    } else if (info.isFile()) {
      await copyFile(source, destination);
      await record(path);
    } else throw new Error('备份遇到不支持的文件：' + path);
  }
  try {
    await dump(join(staging, 'database.dump'));
    if (!(await lstat(join(staging, 'database.dump'))).size) throw new Error('数据库备份为空。');
    await record('database.dump');
    for (const entry of entries) {
      try {
        await lstat(join(folder, entry));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await copy(entry);
    }
    await writeFile(
      join(staging, 'manifest.json'),
      JSON.stringify({ version: 1, completedAt: new Date().toISOString(), files }, null, 2) + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, 'README.txt'),
      '完整备份：database.dump 与 manifest.json 列出的文件需一起恢复。包含账号和密钥，请私密保存。\n恢复到新数据库和新数据目录，先核对 SHA-256，再 pg_restore；不要覆盖现有数据。操作步骤见 docs/development.md。\n',
      { mode: 0o600 },
    );
    await rename(staging, output);
    return output;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
