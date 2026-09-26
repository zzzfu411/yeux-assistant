import { resolve } from 'node:path';
import { Store } from '../packages/storage/src/index.js';
import { importCourses } from '../packages/core/src/course-import.js';

const args = process.argv.slice(2).filter(value => value !== '--');
let store: Store | undefined;
try {
  const allowed = new Set(['--bundle', '--data', '--dry-run', '--apply']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!allowed.has(argument)) throw new Error('支持 --bundle <文件> --data <目录> --dry-run 或 --apply。');
    if (argument === '--bundle' || argument === '--data') { if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(argument + ' 需要路径。'); index++; }
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('预演和正式导入不能同时使用。');
  const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]!; };
  const folder = resolve(option('--data', process.env.ASSISTANT_DATA || 'private'));
  const path = resolve(option('--bundle', 'private/course-import/bundle.json'));
  const apply = args.includes('--apply');
  // Preflight validates all files without creating database schemas or business rows.
  const preview = await importCourses(undefined, path, folder, false);
  if (apply) { store = new Store(); await store.migrate(); }
  console.log(JSON.stringify(apply ? await importCourses(store, path, folder, true) : preview, null, 2));
} catch (error: any) { console.error(error?.name === 'ZodError' ? '资料包格式无效，请重新生成。' : error.message); process.exitCode = 1; }
finally { await store?.close(); }
