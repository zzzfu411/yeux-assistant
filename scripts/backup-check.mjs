import { verifyBackup } from './backup-integrity.mjs';
import { inspectDockerDump } from './backup-docker.mjs';

const args = process.argv.slice(2), json = args.includes('--json'), docker = args.includes('--docker');
const paths = args.filter(arg => arg !== '--json' && arg !== '--docker');
if (paths.length !== 1 || paths[0].startsWith('-') || new Set(args).size !== args.length) {
  const message = '用法：pnpm backup:check <备份目录> [--docker] [--json]';
  if (json) console.log(JSON.stringify({ ok: false, complete: false, errors: [{ code: 'usage', message }] }));
  else console.error(message);
  process.exitCode = 1;
} else {
  const abort = new AbortController(); let interrupted;
  const interrupt = signal => { interrupted = signal; abort.abort(); };
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  if (docker) { process.on('SIGINT', sigint); process.on('SIGTERM', sigterm); }
  let result;
  try { result = await verifyBackup(paths[0], docker ? { checkDump: path => inspectDockerDump(path, { signal: abort.signal }) } : {}); }
  finally { if (docker) { process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm); } }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.complete ? `备份校验通过：${result.files} 个文件，${result.bytes} 字节。` : result.ok ? '文件完整性通过；dump 结构验证尚未完成。' : '备份校验失败。');
    for (const item of [...result.errors, ...result.warnings]) console.log(item.message);
    if (result.complete) console.log('未恢复数据库；正式切换仍需在新库中恢复并核对业务记录。');
  }
  process.exitCode = interrupted ? interrupted === 'SIGINT' ? 130 : 143 : !result.ok ? 1 : result.complete ? 0 : 2;
}
