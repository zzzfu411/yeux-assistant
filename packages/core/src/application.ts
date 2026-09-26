import type { PgBoss } from 'pg-boss';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import { CreateGoal, UpdateGoal, Feedback, CreateSession, SourceInput, MemoryInput, ScheduleInput, DraftInput } from '../../contracts/src/index.js';
import { AppError, id, event, once, notify, requireRow, checkVersion, goalDTO, sessionDTO, attemptDTO, planDTO, iso, canonical } from './common.js';
import { enqueue } from './queue.js';
import { Knowledge, retrieve } from './knowledge.js';
import { config, Settings } from './config.js';

export async function createRun(tx: Tx, boss: PgBoss, sessionId: string, input: Row = {}) {
  const runId=id();
  await tx.exec('INSERT INTO app.runs(id,session_id,input,graph_thread) VALUES($1,$2,$3,$4)',[runId,sessionId,JSON.stringify(input),input.freshThread ? sessionId+':'+runId : sessionId]);
  await tx.exec("UPDATE app.sessions SET current_run_id=$2,state='queued',error='',updated_at=now() WHERE id=$1",[sessionId,runId]);
  await enqueue(boss,tx,runId); await event(tx,'run.queued',sessionId,{runId}); return runId;
}
export async function createSession(tx: Tx, boss: PgBoss, data: {title:string;prompt:string;kind:string;goalId?:string;sessionId?:string}) {
  const sessionId=data.sessionId||id();
  await tx.exec('INSERT INTO app.sessions(id,goal_id,title,kind,prompt) VALUES($1,$2,$3,$4,$5)',[sessionId,data.goalId||null,data.title||data.prompt.slice(0,60),data.kind,data.prompt]);
  const runId=await createRun(tx,boss,sessionId,{type:'initial'}); return {sessionId,runId};
}
export async function lockSession(tx: Tx, sessionId: string) {
  const before=await requireRow(tx,'SELECT goal_id FROM app.sessions WHERE id=$1',[sessionId]);
  if(before.goal_id) await tx.one('SELECT id FROM app.goals WHERE id=$1 FOR UPDATE',[before.goal_id]);
  return requireRow(tx,'SELECT * FROM app.sessions WHERE id=$1 FOR UPDATE',[sessionId]);
}
async function ensureNoPendingSend(tx: Tx, sessionId: string) {
  if(await tx.one("SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",[sessionId])) throw new AppError('请先处理发送记录，再修改这项任务。',409,'action_in_progress');
}
export class Application {
  readonly knowledge: Knowledge;
  readonly settings: Settings;
  constructor(readonly store: Store, readonly boss: PgBoss, readonly folder: string, token: string) { this.knowledge=new Knowledge(store,folder); this.settings=new Settings(folder,token); }
  command<T>(key: string, operation: string, input: unknown, work:(tx:Tx)=>Promise<T>) { return this.store.transaction(tx=>once(tx,key,operation,input,()=>work(tx))); }
  async today() {
    const configured=Boolean((await config(this.folder)).llm?.base_url);
    return this.store.snapshot(async tx=>({
      goals:(await tx.rows("SELECT * FROM app.goals WHERE status='active' ORDER BY updated_at DESC,id LIMIT 100")).map(goalDTO),
      sessions:(await tx.rows("SELECT * FROM app.sessions WHERE state IN ('queued','running','waiting_feedback','failed') ORDER BY CASE state WHEN 'waiting_feedback' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,updated_at DESC,id LIMIT 3")).map(sessionDTO),
      unread:Number((await tx.one('SELECT count(*) AS n FROM app.notifications WHERE read_at IS NULL'))?.n||0),
      modelConfigured:configured,workerOnline:Boolean(await tx.one("SELECT name FROM app.health WHERE name='worker' AND heartbeat>now()-interval '20 seconds'"))
    }));
  }
  async goals() { return (await this.store.rows('SELECT * FROM app.goals ORDER BY created_at DESC,id LIMIT 200')).map(goalDTO); }
  async goal(goalId: string) {
    return this.store.snapshot(async tx=>{
      const goal=await requireRow(tx,'SELECT * FROM app.goals WHERE id=$1',[goalId]);
      return {goal:goalDTO(goal),plan:planDTO(await tx.one('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version DESC LIMIT 1',[goalId])),
        sessions:(await tx.rows('SELECT * FROM app.sessions WHERE goal_id=$1 ORDER BY created_at DESC,id LIMIT 50',[goalId])).map(sessionDTO),
        attempts:(await tx.rows('SELECT a.* FROM app.attempts a JOIN app.sessions s ON a.session_id=s.id WHERE s.goal_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 100',[goalId])).map(attemptDTO)};
    });
  }
  async sourceSelection(tx: Tx, ids: string[]) { if(ids.length && Number((await tx.one('SELECT count(*) n FROM app.sources WHERE id=ANY($1::text[])',[[...new Set(ids)]]))?.n)!==new Set(ids).size) throw new AppError('有一份所选资料已不存在，请重新选择。'); }
  async addGoal(key: string, input: unknown) {
    const data=CreateGoal.parse(input);
    return this.command(key,'goal.create',data,async tx=>{
      await this.sourceSelection(tx,data.sourceIds); const goalId=id();
      await tx.exec('INSERT INTO app.goals(id,title,outcome,source_ids,intervals) VALUES($1,$2,$3,$4,$5)',[goalId,data.title,data.outcome,JSON.stringify(data.sourceIds),JSON.stringify(data.intervals)]);
      const created=await createSession(tx,this.boss,{goalId,title:data.title,prompt:data.outcome||data.title,kind:'study'});
      await event(tx,'goal.created',goalId); return {goalId,...created};
    });
  }
  async changeGoal(key:string,goalId:string,input:unknown) {
    const data=UpdateGoal.parse(input);
    return this.command(key,'goal.update:'+goalId,data,async tx=>{
      const old=await requireRow(tx,'SELECT * FROM app.goals WHERE id=$1 FOR UPDATE',[goalId]); checkVersion(old,data.revision);
      if(await tx.one("SELECT a.id FROM app.approvals a JOIN app.sessions s ON a.session_id=s.id WHERE s.goal_id=$1 AND a.state IN ('approved','executing','uncertain')",[goalId])) throw new AppError('请先处理这个目标的发送记录。',409,'action_in_progress');
      await this.sourceSelection(tx,data.sourceIds||old.source_ids);
      const status=data.status||old.status;
      const changed=(data.title!==undefined && data.title!==old.title) || (data.outcome!==undefined && data.outcome!==old.outcome) || (data.sourceIds!==undefined && canonical(data.sourceIds)!==canonical(old.source_ids));
      await tx.exec('UPDATE app.goals SET title=$2,outcome=$3,status=$4,source_ids=$5,intervals=$6,revision=revision+1,updated_at=now() WHERE id=$1',[goalId,data.title??old.title,data.outcome??old.outcome,status,JSON.stringify(data.sourceIds??old.source_ids),JSON.stringify(data.intervals??old.intervals)]);
      if(status!=='active' || changed) {
        const sessions=await tx.rows("SELECT * FROM app.sessions WHERE goal_id=$1 AND state IN ('queued','running','waiting_feedback') FOR UPDATE",[goalId]);
        for(const session of sessions) {
          await tx.exec("UPDATE app.runs SET state='cancelled',generation=generation+1,finished_at=now() WHERE session_id=$1 AND state IN ('queued','running')",[session.id]);
          await tx.exec("UPDATE app.sessions SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1",[session.id]);
          await event(tx,'session.updated',session.id);
        }
      }
      if(status==='active' && (old.status!=='active' || changed)) {
        const title=data.title??old.title,outcome=data.outcome??old.outcome;
        await createSession(tx,this.boss,{goalId,title,prompt:outcome||title,kind:'study'});
      }
      await event(tx,'goal.updated',goalId); return {goalId,revision:old.revision+1};
    });
  }
  async addSession(key:string,input:unknown) { const data=CreateSession.parse(input); return this.command(key,'session.create',data,tx=>createSession(tx,this.boss,data)); }
  async history(page=0) { return this.store.snapshot(async tx=>({items:(await tx.rows('SELECT * FROM app.sessions ORDER BY created_at DESC,id LIMIT 30 OFFSET $1',[page*30])).map(sessionDTO), total:Number((await tx.one('SELECT count(*) n FROM app.sessions'))?.n)})); }
  async session(sessionId:string) {
    return this.store.snapshot(async tx=>({session:sessionDTO(await requireRow(tx,'SELECT * FROM app.sessions WHERE id=$1',[sessionId])),
      attempts:(await tx.rows('SELECT * FROM app.attempts WHERE session_id=$1 ORDER BY created_at,id',[sessionId])).map(attemptDTO),
      artifacts:(await tx.rows('SELECT * FROM app.artifacts WHERE session_id=$1 ORDER BY created_at,id',[sessionId])).map(r=>({id:r.id,content:r.content,kind:r.kind,provenance:r.provenance,createdAt:iso(r.created_at)})),
      approvals:(await tx.rows('SELECT id,state,digest,payload,error FROM app.approvals WHERE session_id=$1 ORDER BY created_at DESC',[sessionId])),
      legacy:(await tx.one("SELECT payload FROM app.legacy_rows WHERE table_name='tasks' AND payload->>'id'=$1",[sessionId]))?.payload||null }));
  }
  async feedback(key:string,sessionId:string,input:unknown) {
    const data=Feedback.parse(input);
    return this.command(key,'session.feedback:'+sessionId,data,async tx=>{
      const session=await lockSession(tx,sessionId); checkVersion(session,data.revision);
      await ensureNoPendingSend(tx,sessionId);
      if(!['waiting_feedback','ready','completed'].includes(session.state)) throw new AppError('当前任务尚不能接收回答。',409,'state_conflict');
      if(session.goal_id && (await tx.one('SELECT status FROM app.goals WHERE id=$1',[session.goal_id]))?.status!=='active') throw new AppError('请先恢复这个目标。',409);
      if(session.goal_id && await tx.one("SELECT id FROM app.sessions WHERE goal_id=$1 AND id<>$2 AND state IN ('queued','running','waiting_feedback')",[session.goal_id,sessionId])) throw new AppError('这个目标已有新的学习步骤，请在目标页继续。',409,'state_conflict');
      const attemptId=id();
      await tx.exec('INSERT INTO app.attempts(id,session_id,answer,self_report,source) VALUES($1,$2,$3,$4,$5)',[attemptId,sessionId,data.answer,data.selfReport||null,data.selfReport?'user_report':'ungraded']);
      await tx.exec('UPDATE app.sessions SET revision=revision+1 WHERE id=$1',[sessionId]);
      const prior=await tx.one('SELECT graph_thread FROM app.runs WHERE id=$1',[session.current_run_id]);
      const resume=session.state==='waiting_feedback' && prior;
      const runId=await createRun(tx,this.boss,sessionId,{type:resume?'feedback':'followup',attemptId,answer:data.answer,selfReport:data.selfReport||null,freshThread:!resume});
      if(resume) await tx.exec('UPDATE app.runs SET graph_thread=$2 WHERE id=$1',[runId,prior.graph_thread]);
      return {sessionId,runId,attemptId,revision:session.revision+1};
    });
  }
  async cancel(key:string,runId:string) {
    return this.command(key,'run.cancel:'+runId,{},async tx=>{
      const run=await requireRow(tx,'SELECT * FROM app.runs WHERE id=$1',[runId]); const session=await lockSession(tx,run.session_id);
      await ensureNoPendingSend(tx,session.id);
      if(['queued','running'].includes(run.state) && session.current_run_id===runId) {
        await tx.exec("UPDATE app.runs SET state='cancelled',generation=generation+1,finished_at=now() WHERE id=$1",[runId]);
        await tx.exec("UPDATE app.sessions SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1",[session.id]);
        await event(tx,'run.cancelled',session.id,{runId});
      }
      return {sessionId:session.id};
    });
  }
  async retry(key:string,sessionId:string,revision:number) {
    return this.command(key,'session.retry:'+sessionId,{revision},async tx=>{
      const session=await lockSession(tx,sessionId); checkVersion(session,revision);
      await ensureNoPendingSend(tx,sessionId);
      if(!['failed','cancelled'].includes(session.state)) throw new AppError('当前状态无需重试。',409);
      if(session.goal_id) {
        const goal=await requireRow(tx,'SELECT * FROM app.goals WHERE id=$1',[session.goal_id]);
        if(goal.status!=='active' || await tx.one("SELECT id FROM app.sessions WHERE goal_id=$1 AND id<>$2 AND state IN ('queued','running','waiting_feedback')",[session.goal_id,sessionId])) throw new AppError('请先处理目标中当前的学习步骤。',409);
      }
      const prior=await tx.one('SELECT * FROM app.runs WHERE id=$1',[session.current_run_id]);
      await tx.exec('UPDATE app.sessions SET revision=revision+1 WHERE id=$1',[sessionId]);
      const runId=await createRun(tx,this.boss,sessionId,{type:'followup',answer:prior?.input.answer||'',attemptId:prior?.input.attemptId||null,freshThread:true}); return {sessionId,runId};
    });
  }
  async archive(key:string,sessionId:string,revision:number) {
    return this.command(key,'session.archive:'+sessionId,{revision},async tx=>{
      const s=await lockSession(tx,sessionId);checkVersion(s,revision);
      if(['queued','running'].includes(s.state)) throw new AppError('请先停止当前执行。',409);
      if(await tx.one("SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",[sessionId])) throw new AppError('请先处理发送记录。',409);
      await tx.exec("UPDATE app.sessions SET state='archived',revision=revision+1,updated_at=now() WHERE id=$1",[sessionId]);
      await tx.exec('INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)',[id(),sessionId,'archive',s.content,'user_revision',key]);
      await event(tx,'session.updated',sessionId); return {sessionId};
    });
  }
  async saveDraft(key:string,sessionId:string,input:unknown) {
    const data=DraftInput.parse(input);
    return this.command(key,'session.draft:'+sessionId,data,async tx=>{
      const s=await lockSession(tx,sessionId);checkVersion(s,data.revision);
      if(['running','queued'].includes(s.state) || await tx.one("SELECT id FROM app.approvals WHERE session_id=$1 AND state IN ('approved','executing','uncertain')",[sessionId])) throw new AppError('请先结束运行或处理发送记录。',409);
      await tx.exec('UPDATE app.sessions SET content=$2,recipient=$3,revision=revision+1,updated_at=now() WHERE id=$1',[sessionId,data.content,data.recipient]);
      await tx.exec("UPDATE app.approvals SET state='invalidated',error='草稿已修改，请重新核对。' WHERE session_id=$1 AND state='pending'",[sessionId]);
      await tx.exec('INSERT INTO app.artifacts(id,session_id,kind,content,provenance,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)',[id(),sessionId,'draft',data.content,'user_revision',key]);
      await event(tx,'session.updated',sessionId);return {sessionId,revision:s.revision+1};
    });
  }
  async sources() { return (await this.store.rows('SELECT s.id,s.title,s.version,s.digest,s.updated_at,v.metadata FROM app.sources s JOIN app.source_versions v ON v.source_id=s.id AND v.version=s.version ORDER BY s.updated_at DESC,s.id')).map(r=>({id:r.id,title:r.title,version:r.version,digest:r.digest,updatedAt:iso(r.updated_at),metadata:r.metadata})); }
  async source(sourceId:string,version?:number) { return requireRow(this.store,'SELECT s.id,s.title,v.version,v.content,v.digest,v.metadata,s.version AS current_version FROM app.sources s JOIN app.source_versions v ON s.id=v.source_id WHERE s.id=$1 AND v.version=coalesce($2,s.version)',[sourceId,version||null]); }
  async importSource(key:string,input:unknown) { const data=SourceInput.parse(input);return this.command(key,'source.import',data,tx=>this.knowledge.import(tx,key,data.title,data.content)); }
  async search(query:string,course?:string) { return retrieve(this.store,query,[],20,course); }
  async memories() { return this.store.rows('SELECT * FROM app.memories ORDER BY updated_at DESC,key'); }
  async saveMemory(key:string,input:unknown) {
    const data=MemoryInput.parse(input);
    return this.command(key,'memory.save',data,async tx=>{
      await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['memory:'+data.key]);
      const old=await tx.one('SELECT * FROM app.memories WHERE key=$1 FOR UPDATE',[data.key]);
      if((old?.version||0)!==data.revision) throw new AppError('偏好已修改，请载入最新版本。',409,'version_conflict');
      const version=data.revision+1;
      await tx.exec('INSERT INTO app.memories(key,scope,content,version,confirmed,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,content=excluded.content,version=excluded.version,confirmed=excluded.confirmed,enabled=excluded.enabled,updated_at=now()',[data.key,data.scope,data.content,version,data.confirmed,data.enabled]);
      await tx.exec('INSERT INTO app.memory_versions(key,version,snapshot) VALUES($1,$2,$3)',[data.key,version,JSON.stringify({...data,version})]);await event(tx,'memory.updated',data.key);return {key:data.key,version};
    });
  }
  async schedules() { return (await this.store.rows('SELECT * FROM app.schedules ORDER BY created_at,id')).map(r=>({...r,next_run:iso(r.next_run)})); }
  async saveSchedule(key:string,scheduleId:string|undefined,input:unknown) {
    const data=ScheduleInput.parse(input);
    if(data.intervalSeconds>0 && data.intervalSeconds<60) throw new AppError('重复间隔至少为 60 秒。');
    return this.command(key,'schedule.save:'+(scheduleId||'new'),data,async tx=>{
      const old=scheduleId ? await requireRow(tx,'SELECT * FROM app.schedules WHERE id=$1 FOR UPDATE',[scheduleId]) : null;
      if((old?.version||0)!==data.revision) throw new AppError('计划已修改，请载入最新版本。',409,'version_conflict');
      const identity=scheduleId||id();
      await tx.exec('INSERT INTO app.schedules(id,title,kind,prompt,interval_seconds,next_run,enabled,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,prompt=excluded.prompt,interval_seconds=excluded.interval_seconds,next_run=excluded.next_run,enabled=excluded.enabled,version=excluded.version',[identity,data.title,data.kind,data.prompt,data.intervalSeconds,data.nextRun,data.enabled,data.revision+1]);
      await event(tx,'schedule.updated',identity);return {id:identity,version:data.revision+1};
    });
  }
  async notifications(page=0) { return this.store.snapshot(async tx=>({items:await tx.rows('SELECT * FROM app.notifications ORDER BY created_at DESC,id LIMIT 30 OFFSET $1',[page*30]),total:Number((await tx.one('SELECT count(*) n FROM app.notifications'))?.n)})); }
  async readNotification(key:string,identity:string) { return this.command(key,'notification.read:'+identity,{},async tx=>{await tx.exec('UPDATE app.notifications SET read_at=now() WHERE id=$1',[identity]);await event(tx,'notification.read',identity);return {id:identity};}); }
  async events(after:string) { return (await this.store.rows('SELECT * FROM app.events WHERE id>$1 ORDER BY id LIMIT 100',[after])).map(r=>({id:String(r.id),kind:r.kind,entityId:r.entity_id,data:r.data,createdAt:iso(r.created_at)})); }
  async saveSettings(key:string,input:unknown) { return this.command(key,'settings.model',input,async tx=>{await tx.exec('SELECT pg_advisory_xact_lock(847392003)');return this.settings.save(input,key);}); }
}
