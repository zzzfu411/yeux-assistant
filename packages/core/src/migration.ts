import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import { AppError, canonical, digest, event, id } from './common.js';
import { chunks } from './knowledge.js';
import type { Citation } from '../../contracts/src/index.js';

const TABLES = ['approvals','artifact_versions','artifacts','commands','documents','events','health','inputs','mail_quarantine','memories','memory_versions','notifications','schedules','settings','source_errors','steps','tasks'];
const TARGETS = ['goals','plans','sessions','attempts','runs','artifacts','sources','source_versions','chunks','memories','memory_versions','schedules','notifications','events','commands','approvals','settings','legacy_rows'];
type LegacyRow = { key:string; payload:Row; digest:string };
export type LegacySnapshot = { directory:string; database:string; source:string; schemaVersion:number; sourceDigest:string; tables:Record<string,LegacyRow[]>; schemas:Record<string,string>; blockers:string[] };
export type MigrationReport = { version:1; source:string; snapshot:string; sourceDigest:string; schemaVersion:number; counts:Record<string,number>; tableDigests:Record<string,string>; blockers:string[]; warnings:string[]; mode:'dry-run'|'apply'; state:'ready'|'blocked'|'imported'|'already-imported'; verifiedRows?:number; createdAt:string };

const quote = (value:string) => '"'+value.replaceAll('"','""')+'"';
function legacyValue(value:unknown):unknown {
  if(value instanceof Uint8Array) return {$sqliteBlob:Buffer.from(value).toString('base64')};
  if(typeof value==='bigint') return {$sqliteInteger:value.toString()};
  return value;
}
function date(value:unknown, label:string):string {
  const parsed=typeof value==='number'?new Date(value*1000):new Date(String(value));
  if(!Number.isFinite(parsed.getTime())) throw new AppError(`${label} 含无法转换的时间。`);
  return parsed.toISOString();
}
const rows = (snapshot:LegacySnapshot, table:string) => (snapshot.tables[table]||[]).map(r=>r.payload);
function parseJSON(value:unknown,label:string) { try { return JSON.parse(String(value)); } catch { throw new AppError(`${label} 包含无效 JSON，已保留原始快照。`); } }
function requireText(row:Row,keys:string[],label:string) { for(const key of keys) if(typeof row[key]!=='string') throw new AppError(`${label}.${key} 不是文本，无法无损映射。`); }
function citationsFor(snapshot:LegacySnapshot,task:Row):Citation[] {
  const references=parseJSON(task.sources,'tasks.sources');
  if(!Array.isArray(references))throw new AppError('tasks.sources 不是来源数组。');
  const result:Citation[]=[];
  for(const reference of references) {
    if(!reference || typeof reference!=='object' || reference.provenance!=='source' || typeof reference.path!=='string' || typeof reference.text!=='string' || !reference.text.length)continue;
    const path=reference.path.replace(/^documents\//,'');
    const document=rows(snapshot,'documents').find(row=>row.path===path);
    if(!document || document.digest!==reference.digest)continue;
    let start:number;
    if(Number.isInteger(reference.offset) && reference.offset>=0) {
      // Python offsets count Unicode code points; browser/JS offsets count UTF-16 units.
      const characters=Array.from(document.content as string);
      if(reference.offset>characters.length)continue;
      start=characters.slice(0,reference.offset).join('').length;
    } else if(reference.offset===undefined || reference.offset===null) {
      // Some earlier snapshots recorded only a line number. Recover a position
      // only when the complete quote occurs exactly once in the verified source.
      start=document.content.indexOf(reference.text);
      if(start<0 || document.content.indexOf(reference.text,start+1)!==-1)continue;
    } else continue;
    const end=start+reference.text.length;
    if(document.content.slice(start,end)!==reference.text)continue;
    result.push({sourceId:'legacy-source-'+digest(path).slice(0,24),version:1,title:path,start,end,quote:reference.text,digest:document.digest});
  }
  return result;
}

/** SQLite's online backup API produces one consistent snapshot, including WAL data. */
export async function snapshotLegacy(source:string, folder:string):Promise<LegacySnapshot> {
  const directory=join(resolve(folder),'backups','typescript-import-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+id().slice(0,8));
  await mkdir(directory,{recursive:true,mode:0o700});
  const database=join(directory,'assistant.sqlite3');
  const live=new DatabaseSync(resolve(source),{readOnly:true});
  try { live.exec('PRAGMA query_only=ON'); await backup(live,database); } finally { live.close(); }
  await chmod(database,0o400);
  const db=new DatabaseSync(database,{readOnly:true});
  const tables:Record<string,LegacyRow[]>={}, schemas:Record<string,string>={};
  let schemaVersion=0; const blockers:string[]=[];
  try {
    db.exec('PRAGMA query_only=ON');
    schemaVersion=Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
    if(schemaVersion!==3) blockers.push(`旧库 schema_version=${schemaVersion}，当前只支持已核对的 v3。`);
    const check=db.prepare('PRAGMA integrity_check').all() as Row[];
    if(check.length!==1 || check[0]?.integrity_check!=='ok') blockers.push('SQLite 完整性检查失败。');
    if(db.prepare('PRAGMA foreign_key_check').all().length) blockers.push('SQLite 有失效外键。');
    for(const table of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]) {
      const name=String(table.name); schemas[name]=String(table.sql);
      if(!TABLES.includes(name)) blockers.push(`发现尚未定义业务映射的表：${name}。`);
      const columns=db.prepare('PRAGMA table_info('+quote(name)+')').all() as Row[];
      const keys=columns.filter(c=>Number(c.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(c=>String(c.name));
      if(!keys.length) blockers.push(`${name} 没有稳定主键。`);
      const statement=db.prepare('SELECT * FROM '+quote(name));
      tables[name]=(statement.all() as Row[]).map(row=>{
        const payload=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,legacyValue(value)]));
        return {key:canonical(keys.map(key=>payload[key])),payload,digest:digest(payload)};
      }).sort((a,b)=>a.key.localeCompare(b.key,'en'));
      if(new Set(tables[name]!.map(row=>row.key)).size!==tables[name]!.length) blockers.push(`${name} 有重复主键。`);
      for(const row of tables[name]!) if(canonical(row.payload).includes('\\u0000')) blockers.push(`${name} 含 PostgreSQL JSONB 无法保存的 NUL 字符。`);
    }
    for(const table of TABLES) if(!tables[table]) blockers.push(`旧库缺少表：${table}。`);
  } finally { db.close(); }
  const sourceDigest=digest({schemaVersion,schemas,tables});
  const snapshot={directory,database,source:resolve(source),schemaVersion,sourceDigest,tables,schemas,blockers};
  for(const file of ['config.json','access-token']) {
    // Preserve secrets in the ignored backup directory; never include them in reports.
    try { await copyFile(join(resolve(source,'..'),file),join(directory,file)); await chmod(join(directory,file),0o600); }
    catch(error:any) { if(error.code!=='ENOENT') throw error; }
  }
  await writeFile(join(directory,'schema.json'),JSON.stringify(schemas,null,2)+'\n',{mode:0o600});
  return snapshot;
}

export function inspectSnapshot(snapshot:LegacySnapshot):MigrationReport {
  const blockers=[...snapshot.blockers], warnings:string[]=[];
  const tasks=rows(snapshot,'tasks'), taskIds=new Set(tasks.map(r=>r.id));
  for(const task of tasks) {
    if(['queued','running','sending'].includes(task.state)) blockers.push(`任务 ${task.id} 仍处于 ${task.state}；先收敛旧版执行再迁移。`);
    else if(!['ready','waiting_input','waiting_approval','uncertain','failed','cancelled','archived','completed','sent'].includes(task.state)) blockers.push(`任务 ${task.id} 状态 ${task.state} 无法映射。`);
    if(!['study','work','manage'].includes(task.kind)) blockers.push(`任务 ${task.id} 类型无法映射。`);
    try {
      requireText(task,['id','subject','notice','draft','packet','recipient'],'tasks');date(task.created,'tasks.created');date(task.updated,'tasks.updated');
      const original=parseJSON(task.sources,'tasks.sources'),mapped=citationsFor(snapshot,task);
      if(original.length>mapped.length)warnings.push(`任务 ${task.id} 有 ${original.length-mapped.length} 条无法对照当前原文版本的历史引用；原始引用保留在 legacy 详情。`);
    }
    catch(error:any) { blockers.push(error.message); }
  }
  for(const table of ['artifacts','artifact_versions','inputs','approvals','steps']) for(const row of rows(snapshot,table)) if(row.task_id && !taskIds.has(row.task_id)) blockers.push(`${table}.${row.id} 关联任务不存在。`);
  const artifactIds=new Set<string>();
  for(const row of [...rows(snapshot,'artifacts'),...rows(snapshot,'artifact_versions')]) {
    if(!row.task_id) blockers.push(`产物 ${row.id} 未关联任务，无法映射。`);
    if(artifactIds.has(row.id)) blockers.push(`产物 ID ${row.id} 跨表冲突。`); artifactIds.add(row.id);
  }
  for(const row of rows(snapshot,'schedules')) if(!Number.isInteger(row.interval_seconds) || (row.interval_seconds!==0 && row.interval_seconds<60)) blockers.push(`计划 ${row.id} 间隔不受支持。`);
  for(const row of rows(snapshot,'approvals')) { try { parseJSON(row.payload,'approvals.payload'); } catch(error:any) { blockers.push(error.message); } }
  for(const row of rows(snapshot,'documents')) {
    if(typeof row.content!=='string' || digest(row.content)!==row.digest) blockers.push(`资料 ${row.path} 原始摘要不一致。`);
    if(typeof row.path!=='string' || row.path.startsWith('/') || row.path.split(/[\\/]/).includes('..')) blockers.push(`资料 ${row.path} 路径无法安全映射。`);
  }
  const shapes:Record<string,{text:string[];times:string[];optionalTimes?:string[]}>={
    tasks:{text:['id','source_key','subject','notice','recipient','draft','packet','error'],times:['created','updated'],optionalTimes:['due_at']},
    artifacts:{text:['id','task_id','title','content','provenance'],times:['created']},
    artifact_versions:{text:['id','task_id','title','content','kind'],times:['created']},
    documents:{text:['path','content','digest'],times:[]},
    memories:{text:['key','scope','content'],times:['updated']},
    memory_versions:{text:['key','scope','content'],times:['created']},
    schedules:{text:['id','title','kind','prompt'],times:['next_run','created']},
    notifications:{text:['id','dedupe_key','title','body'],times:['created'],optionalTimes:['read_at','delivered_at']},
    approvals:{text:['id','task_id','action','digest','payload','state','message_id','error'],times:['created'],optionalTimes:['decided','finished']},
    settings:{text:['key','value'],times:[]}
  };
  for(const [table,shape] of Object.entries(shapes))for(const row of rows(snapshot,table))try{
    requireText(row,shape.text,table);
    for(const field of shape.times)date(row[field],table+'.'+field);
    for(const field of shape.optionalTimes||[])if(row[field]!==null)date(row[field],table+'.'+field);
    const version=table==='tasks'?row.revision:['memories','memory_versions','schedules'].includes(table)?row.version:undefined;
    if(version!==undefined && (!Number.isInteger(version)||version<(table==='tasks'?0:1)))throw new AppError(`${table} 版本无法映射。`);
  }catch(error:any){blockers.push(error.message);}
  if(rows(snapshot,'approvals').some(a=>['pending','approved'].includes(a.state))) warnings.push('旧版待确认或已批准动作将作废，必须重新核对；不会自动发送。');
  if(tasks.some(t=>t.state==='uncertain') || rows(snapshot,'approvals').some(a=>['executing','uncertain'].includes(a.state))) warnings.push('发送结果不明的记录保留为待核实，不会自动执行。');
  warnings.push('原始 17 表全部保留在 legacy_rows；旧任务保留为独立历史会话，不生成学习目标。');
  return {version:1,source:snapshot.source,snapshot:snapshot.database,sourceDigest:snapshot.sourceDigest,schemaVersion:snapshot.schemaVersion,
    counts:Object.fromEntries(Object.entries(snapshot.tables).map(([name,data])=>[name,data.length])),
    tableDigests:Object.fromEntries(Object.entries(snapshot.tables).map(([name,data])=>[name,digest(data)])),
    blockers:[...new Set(blockers)],warnings,mode:'dry-run',state:blockers.length?'blocked':'ready',createdAt:new Date().toISOString()};
}

async function mapRows(tx:Tx,snapshot:LegacySnapshot) {
  const exportedAt=new Date().toISOString();
  for(const task of rows(snapshot,'tasks')) {
    const state=({waiting_input:'ready',waiting_approval:'ready',uncertain:'ready',sent:'completed'} as Record<string,string>)[task.state]||task.state;
    const error=task.state==='uncertain'?'旧版发送结果待核实；请核对对应发送记录。':task.error;
    await tx.exec(`INSERT INTO app.sessions(id,title,kind,prompt,state,revision,content,citations,error,recipient,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[task.id,task.subject,task.kind,task.notice,state,task.revision,task.draft||task.packet,JSON.stringify(citationsFor(snapshot,task)),error,task.recipient,date(task.created,'tasks.created'),date(task.updated,'tasks.updated')]);
  }
  for(const [table,kind] of [['artifacts','generated'],['artifact_versions','version']] as const) for(const row of rows(snapshot,table)) {
    await tx.exec('INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [row.id,row.task_id,kind==='generated'?'generated':row.kind,row.content,kind==='generated'?row.provenance:row.kind==='draft'?'user_revision':'legacy_snapshot','legacy:'+table+':'+row.id,date(row.created,table+'.created')]);
  }
  for(const row of rows(snapshot,'documents')) {
    const sourceId='legacy-source-'+digest(row.path).slice(0,24);
    await tx.exec('INSERT INTO app.sources(id,title,path,version,digest,created_at,updated_at) VALUES($1,$2,$2,1,$3,$4,$4)',[sourceId,row.path,row.digest,exportedAt]);
    await tx.exec('INSERT INTO app.source_versions(source_id,version,content,digest,created_at) VALUES($1,1,$2,$3,$4)',[sourceId,row.content,row.digest,exportedAt]);
    for(const chunk of chunks(row.content)) await tx.exec('INSERT INTO app.chunks(id,source_id,version,start_offset,end_offset,content) VALUES($1,$2,1,$3,$4,$5)',[sourceId+':'+chunk.start,sourceId,chunk.start,chunk.end,chunk.content]);
  }
  for(const row of rows(snapshot,'memories')) await tx.exec('INSERT INTO app.memories(key,scope,content,version,confirmed,enabled,source_session,updated_at) VALUES($1,$2,$3,$4,true,$5,$6,$7)',[row.key,row.scope,row.content,row.version,Boolean(row.enabled),row.source_task,date(row.updated,'memories.updated')]);
  for(const row of rows(snapshot,'memory_versions')) await tx.exec('INSERT INTO app.memory_versions(key,version,snapshot,created_at) VALUES($1,$2,$3,$4)',[row.key,row.version,JSON.stringify(row),date(row.created,'memory_versions.created')]);
  for(const row of rows(snapshot,'schedules')) await tx.exec('INSERT INTO app.schedules(id,title,kind,prompt,interval_seconds,next_run,enabled,version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[row.id,row.title,row.kind,row.prompt,row.interval_seconds,date(row.next_run,'schedules.next_run'),Boolean(row.enabled),row.version,date(row.created,'schedules.created')]);
  for(const row of rows(snapshot,'notifications')) await tx.exec('INSERT INTO app.notifications(id,dedupe_key,session_id,title,body,read_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.dedupe_key,row.task_id,row.title,row.body,row.read_at===null?null:date(row.read_at,'notifications.read_at'),date(row.created,'notifications.created')]);
  for(const row of rows(snapshot,'settings')) await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)',[row.key,JSON.stringify(row.value)]);
  for(const row of rows(snapshot,'approvals')) {
    let state=row.state,error=row.error;
    if(['pending','approved'].includes(state)) { state='invalidated'; error='旧版确认已保留；迁移后须重新核对，不能自动发送。'; }
    if(['executing','uncertain'].includes(state)) { state='uncertain'; error='旧版发送结果待核实，不能自动重发。'; }
    await tx.exec('INSERT INTO app.approvals(id,session_id,action,digest,payload,state,message_id,error,created_at,decided_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[row.id,row.task_id,row.action,row.digest,JSON.stringify(parseJSON(row.payload,'approvals.payload')),state,row.message_id,error,date(row.created,'approvals.created'),row.decided===null?null:date(row.decided,'approvals.decided'),row.finished===null?null:date(row.finished,'approvals.finished')]);
  }
  // Some old send failures predate approval records. Keep a reconciliation gate.
  for(const task of rows(snapshot,'tasks').filter(t=>t.state==='uncertain')) {
    if(rows(snapshot,'approvals').some(a=>a.task_id===task.id && ['executing','uncertain'].includes(a.state))) continue;
    const payload={action:'mail.send',legacyTaskId:task.id,unverified:true};
    await tx.exec("INSERT INTO app.approvals(id,session_id,action,digest,payload,state,message_id,error,created_at) VALUES($1,$2,'mail.send',$3,$4,'uncertain','','旧版缺少完整发送快照，请人工核实。',$5)",[ 'legacy-uncertain-'+task.id,task.id,digest(payload),JSON.stringify(payload),date(task.updated,'tasks.updated')]);
  }
}

async function verifyLegacy(tx:Tx,snapshot:LegacySnapshot):Promise<number> {
  let count=0;
  for(const [table,expected] of Object.entries(snapshot.tables)) {
    const actual=await tx.rows('SELECT row_key,payload,digest FROM app.legacy_rows WHERE table_name=$1',[table]);
    const lookup=new Map(actual.map(row=>[row.row_key,row]));
    if(actual.length!==expected.length) throw new AppError(`${table} 迁移数量核对失败。`);
    for(const row of expected) { const found=lookup.get(row.key); if(!found || found.digest!==row.digest || digest(found.payload)!==row.digest) throw new AppError(`${table} 原文摘要核对失败。`); count++; }
  }
  return count;
}

export async function migrateLegacy(store:Store|undefined,source:string,folder:string,apply=false):Promise<MigrationReport> {
  const snapshot=await snapshotLegacy(source,folder),report=inspectSnapshot(snapshot);
  report.mode=apply?'apply':'dry-run';
  const reportPath=join(snapshot.directory,'report.json');
  try {
    if(apply && report.blockers.length) throw new AppError('迁移检查未通过：'+report.blockers.join(' '),409,'migration_blocked');
    if(apply) {
      if(!store) throw new AppError('实际导入需要 PostgreSQL 连接。');
      await store.transaction(async tx=>{
        await tx.exec('SELECT pg_advisory_xact_lock(847392002)');
        const previous=await tx.one('SELECT * FROM app.imports WHERE source_digest=$1',[snapshot.sourceDigest]);
        if(previous) { report.verifiedRows=await verifyLegacy(tx,snapshot); report.state='already-imported'; return; }
        // A mistaken concurrently running API cannot add rows between the empty
        // check and import. Reads remain possible; writes wait for this transaction.
        await tx.exec('LOCK TABLE '+TARGETS.map(table=>'app.'+table).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
        for(const table of TARGETS) if(await tx.one('SELECT 1 FROM app.'+table+' LIMIT 1')) throw new AppError('目标库已有业务数据，拒绝覆盖；请使用独立空数据库。',409,'migration_not_empty');
        for(const [table,data] of Object.entries(snapshot.tables)) for(const row of data) await tx.exec('INSERT INTO app.legacy_rows(table_name,row_key,payload,digest) VALUES($1,$2,$3,$4)',[table,row.key,JSON.stringify(row.payload),row.digest]);
        await mapRows(tx,snapshot);
        report.verifiedRows=await verifyLegacy(tx,snapshot); report.state='imported';
        // Compare mapped content, not only counts, before making the transaction visible.
        for(const task of rows(snapshot,'tasks')) {
          const row=await tx.one('SELECT * FROM app.sessions WHERE id=$1',[task.id]);
          if(!row || row.goal_id!==null || row.prompt!==task.notice || row.content!==(task.draft||task.packet) || row.revision!==task.revision) throw new AppError('任务内容或版本核对失败。');
        }
        for(const artifact of [...rows(snapshot,'artifacts'),...rows(snapshot,'artifact_versions')]) if((await tx.one('SELECT content FROM app.artifacts WHERE id=$1',[artifact.id]))?.content!==artifact.content) throw new AppError('产物原文核对失败。');
        for(const document of rows(snapshot,'documents')) if((await tx.one('SELECT v.content FROM app.sources s JOIN app.source_versions v ON s.id=v.source_id AND s.version=v.version WHERE s.path=$1',[document.path]))?.content!==document.content) throw new AppError('资料原文核对失败。');
        await tx.exec('INSERT INTO app.imports(id,source_digest,report) VALUES($1,$2,$3)',[id(),snapshot.sourceDigest,JSON.stringify(report)]);
        await event(tx,'legacy.imported',null,{sourceDigest:snapshot.sourceDigest,verifiedRows:report.verifiedRows});
      });
    }
  } catch(error:any) {
    report.state='blocked'; report.blockers.push(error instanceof AppError?error.message:'导入事务失败；未提交部分导入，请查看本地数据库诊断。');
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600}); throw error;
  }
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600}); return report;
}
