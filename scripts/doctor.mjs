import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose } from './doctor-diagnostics.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--json') || args.length > 1) {
  console.error('用法：pnpm run doctor [--json]'); process.exitCode = 1;
} else {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const result = await diagnose({ root, folder: resolve(root, process.env.ASSISTANT_DATA_DIR || 'private') });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('只读启动诊断');
      for (const item of result.checks) console.log(`${{ ok: '✓', warning: '·', error: '✗' }[item.status]} ${item.message}${item.action ? '\n  ' + item.action : ''}`);
      console.log(result.ok ? '未发现阻止启动的问题；提示项按需处理。' : '请先处理标记为 ✗ 的问题，再运行 pnpm start。');
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error('诊断未能完成，请检查项目与私密目录读取权限。未修改配置或运行状态。'); process.exitCode = 1;
  }
}
