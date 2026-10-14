import { parseDocument, stringify } from 'yaml';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, digest } from '../common.js';
import type { WorkspaceRepo } from './repo.js';

export function parseFile<T>(text: string, schema: z.ZodType<T>): { header: T; content: string } {
  if (Buffer.byteLength(text) > 100000 || text.includes('\0')) throw new AppError('文件过大或包含无效字符。');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new AppError('需要 YAML 元数据和 Markdown 正文。');
  const doc = parseDocument(match[1]!, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new AppError('文件元数据格式无效。');
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new AppError('元数据不接受别名。');
  }
  const header = schema.safeParse(data);
  if (!header.success) throw new AppError('元数据字段、范围或流程步骤无效。');
  const content = match[2]!.trim();
  if (content.length > 30000) throw new AppError('文件正文超过 30000 字。');
  return { header: header.data, content };
}
export function formatFile(header: unknown, content: string) {
  return '---\n' + stringify(header, { lineWidth: 0 }) + '---\n' + content.trim() + '\n';
}
export function rulePath(scope: string, key: string) {
  const slug =
    key
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+/, '')
      .slice(0, 70) || 'rule';
  const suffix = key === slug ? '' : '-' + digest(key).slice(0, 8);
  return 'rules/' + scope + '/' + slug + suffix + '.md';
}
export async function files(repo: WorkspaceRepo, root: 'rules' | 'flows'): Promise<string[]> {
  await repo.check();
  const result: string[] = [];
  const walk = async (path: string) => {
    const target = path === root ? join(repo.root, root) : await repo.path(path);
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (error: any) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const name = path + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new AppError('规则目录不接受符号链接。');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        await repo.path(name);
        result.push(name);
      }
    }
  };
  await walk(root);
  return result.sort();
}
