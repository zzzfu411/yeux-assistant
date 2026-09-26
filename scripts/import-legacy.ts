import { resolve } from 'node:path';
import { Store } from '../packages/storage/src/index.js';
import { migrateLegacy } from '../packages/core/src/migration.js';
import { AppError } from '../packages/core/src/common.js';

const args=process.argv.slice(2).filter(a=>a!=='--');
function option(name:string,fallback:string) { const index=args.indexOf(name); if(index<0)return fallback; const value=args[index+1]; if(!value || value.startsWith('--')) throw new AppError(`${name} 需要路径。`); return value; }
if(args.includes('--help')) {
  console.log('pnpm legacy:import -- --source <assistant.sqlite3> [--data <private>] [--dry-run|--apply]\n默认只做一致快照和核对。--apply 需要 DATABASE_URL，目标库必须为空；不会修改原 SQLite、配置或口令。');
} else {
  let store:Store|undefined;
  try {
    if(args.includes('--apply') && args.includes('--dry-run')) throw new AppError('--apply 和 --dry-run 不能同时使用。');
    const known=new Set(['--source','--data','--dry-run','--apply']);
    for(let i=0;i<args.length;i++) { const arg=args[i]!; if(!known.has(arg)) throw new AppError('未知参数：'+arg); if(arg==='--source'||arg==='--data') i++; }
    const folder=resolve(option('--data',process.env.ASSISTANT_DATA||'private'));
    const source=resolve(option('--source',resolve(folder,'assistant.sqlite3')));
    const apply=args.includes('--apply');
    if(apply) { store=new Store(); await store.migrate(); }
    const report=await migrateLegacy(store,source,folder,apply);
    console.log(JSON.stringify(report,null,2));
    if(report.state==='blocked') process.exitCode=2;
  } catch(error) { console.error(error instanceof AppError?error.message:'迁移未完成；检查本地报告和数据库连接，原 SQLite 已保留。'); process.exitCode=1; }
  finally { await store?.close(); }
}
