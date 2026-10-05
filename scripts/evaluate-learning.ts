import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { z } from 'zod';
import { ModelAssessment } from '../packages/contracts/src/assessment.js';
import type { Citation } from '../packages/contracts/src/index.js';
import { ASSESSMENT_INSTRUCTION, guardAssessment } from '../packages/core/src/assessment.js';
import { validateBaseURL } from '../packages/core/src/config.js';
import { ModelGateway, type ModelContext } from '../packages/core/src/model.js';
import { claimRun } from '../packages/core/src/runtime-state.js';
import { Store } from '../packages/storage/src/index.js';

const Verdict=z.enum(['pass','retry','unclear']);
const Case=z.object({id:z.string().min(1),course:z.string().min(1),kind:z.string().min(1),material:z.string().max(12000),question:z.string().min(1).max(12000),answer:z.string().min(1).max(12000),expected:Verdict,rubric:z.string().min(1)});
export type EvaluationCase=z.infer<typeof Case>;
type Llm={base_url:string;model:string;api_key?:string;tools:boolean};
type Invocation={response?:ModelAssessment;rawResponse:unknown;providedCitations:Citation[];exerciseComplete:boolean;usage:unknown[];modelCalls:number;latencyMs:number;error?:string};
export type EvaluationCall=(item:EvaluationCase,context:ModelContext,index:number)=>Promise<Invocation>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

export function parseEvaluationArgs(args:string[]){
  let live=false,config:string|undefined,help=false;const caseIds:string[]=[];
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--live'&&!live)live=true;
    else if(arg==='--help'&&!help)help=true;
    else if(arg==='--config'&&config===undefined&&args[index+1]&&!args[index+1]!.startsWith('--'))config=args[++index];
    else if(arg==='--case'&&args[index+1]&&/^[a-z][a-z0-9-]{0,79}$/.test(args[index+1]!))caseIds.push(args[++index]!);
    else throw new Error('只支持 --live --config <模型配置路径>、--case <固定案例 ID> 或 --help。');
  }
  if(live&&!config&&!help)throw new Error('真实调用必须同时指定 --live 和 --config。');
  if(caseIds.length>15||new Set(caseIds).size!==caseIds.length)throw new Error('案例选择不能重复，最多 15 项。');
  return {live,config,help,caseIds};
}
export function validateEvaluationEnvironment(env:NodeJS.ProcessEnv){
  const forbidden=['DATABASE_URL','API_TEST_DATABASE_URL','RUNTIME_TEST_DATABASE_URL','MIGRATION_TEST_DATABASE_URL','PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPASSFILE'];
  if(forbidden.some(key=>env[key]!==undefined))throw new Error('请先移除外部数据库环境变量；评测只使用脚本创建的临时测试库。');
}
export function pickEvaluationModel(value:unknown):Llm{
  const parsed=z.object({llm:z.object({base_url:z.string().max(2000).default(''),model:z.string().max(300).default(''),api_key:z.string().max(10000).optional(),tools:z.boolean().default(true)}).default({base_url:'',model:'',tools:true})}).parse(value);
  const llm=parsed.llm;validateBaseURL(llm.base_url);
  if(llm.api_key&&/[\x00-\x1f\x7f]/.test(llm.api_key))throw new Error('模型密钥包含无效字符。');
  return llm;
}
export function evaluationContext(item:EvaluationCase,index:number):ModelContext{
  // IDs and titles cannot expose case labels such as "correct" or "wrong".
  const sources:Citation[]=item.material?[{sourceId:'evaluation-source-'+String(index+1).padStart(3,'0'),title:'合成参考资料',version:1,start:0,end:item.material.length,quote:item.material,digest:sha(item.material)}]:[];
  return {task:'评阅给定的练习与回答。',latest:item.answer,previous:item.question,rules:[],notes:[],sources};
}
export function redactEvaluation(value:unknown,secrets:string[]):unknown{
  if(typeof value==='string')return secrets.filter(Boolean).reduce((text,secret)=>text.split(secret).join('[已隐藏]'),value);
  if(Array.isArray(value))return value.map(item=>redactEvaluation(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[String(redactEvaluation(key,secrets)),redactEvaluation(item,secrets)]));
  return value;
}
const errorMessages:Record<string,string>={model_unconfigured:'模型尚未配置，未发送请求。',model_invalid:'模型响应未通过结构检查。',model_unavailable:'模型连接或读取超时，本项未重试。',model_http_error:'模型返回 HTTP 错误。',runtime_limit:'本项超出运行预算。',cancelled:'评测已停止，本项未调用。',failure_limit_reached:'此前连续三项网络或 HTTP 失败，本项未调用。',unexpected_error:'本项未完成，未将错误计作评阅结果。'};
export type EvaluationProgress={index:number;total:number;status:'running'|'evaluated'|'error'|'not_run'|'cancelled'};
const emptyInvocation=(error:string):Invocation=>({rawResponse:null,providedCitations:[],exerciseComplete:false,usage:[],modelCalls:0,latencyMs:0,error});

export function selectEvaluationCases(cases:EvaluationCase[],ids:string[]){
  if(!ids.length)return cases;
  const selected=ids.map(id=>cases.find(item=>item.id===id));
  if(selected.some(item=>!item)||new Set(ids).size!==ids.length||ids.length>15)throw new Error('只能选择固定清单中存在且不重复的案例 ID。');
  return selected as EvaluationCase[];
}

export async function evaluateLearningCases(cases:EvaluationCase[],call:EvaluationCall,options:{model:string;sourceSharing:boolean;secrets?:string[];shouldStop?:()=>boolean;onProgress?:(progress:EvaluationProgress)=>void}){
  if(!cases.length||cases.length>15||new Set(cases.map(item=>item.id)).size!==cases.length)throw new Error('评测需要 1–15 个唯一的合成案例。');
  const startedAt=new Date().toISOString(),results=[];
  let consecutiveNetworkErrors=0,cancelled=false;
  for(let index=0;index<cases.length;index++){
    const item=Case.parse(cases[index]),context=evaluationContext(item,index),started=Date.now();
    let invocation:Invocation;
    if(cancelled||options.shouldStop?.())invocation=emptyInvocation('cancelled');
    else if(consecutiveNetworkErrors>=3)invocation=emptyInvocation('failure_limit_reached');
    else {
      options.onProgress?.({index:index+1,total:cases.length,status:'running'});
      try {invocation=await call(item,context,index);}
      catch {invocation={...emptyInvocation('unexpected_error'),latencyMs:Date.now()-started};}
    }
    const parsed=invocation.response?ModelAssessment.safeParse(invocation.response):null;
    const code=invocation.error?(errorMessages[invocation.error]?invocation.error:'unexpected_error'):!parsed?.success?'model_invalid':invocation.modelCalls>1?'runtime_limit':null;
    const status=code==='cancelled'?'cancelled':code==='failure_limit_reached'?'not_run':code?'error':'evaluated';
    if(status==='cancelled')cancelled=true;
    else if(status!=='not_run')consecutiveNetworkErrors=invocation.modelCalls>0&&(code==='model_unavailable'||code==='model_http_error')?consecutiveNetworkErrors+1:0;
    const guarded=!code&&parsed?.success?guardAssessment(parsed.data,{answer:item.answer,exerciseComplete:invocation.exerciseComplete,providedCitations:invocation.providedCitations}):null;
    results.push({id:item.id,course:item.course,kind:item.kind,question:item.question,answer:item.answer,material:item.material,expected:item.expected,rubric:item.rubric,
      status,error:code?{code,message:errorMessages[code]}:null,modelResponse:invocation.rawResponse,accepted:guarded?.assessment??null,
      reasons:guarded?.reasons??[],downgraded:guarded?.downgraded??false,exerciseComplete:invocation.exerciseComplete,providedCitations:invocation.providedCitations,
      modelCalls:invocation.modelCalls,usage:invocation.usage,usageRecorded:invocation.usage.length>0,latencyMs:invocation.latencyMs,
      rawMatchesExpected:!code&&parsed?.success?parsed.data.verdict===item.expected:null,acceptedMatchesExpected:guarded?guarded.assessment.verdict===item.expected:null});
    options.onProgress?.({index:index+1,total:cases.length,status});
  }
  const errors=results.filter(item=>item.status==='error').length,notRun=results.filter(item=>item.status==='not_run').length,cancelledCount=results.filter(item=>item.status==='cancelled').length;
  const evaluated=results.filter(item=>item.status==='evaluated').length;
  const rawMatches=results.filter(item=>item.rawMatchesExpected===true).length,acceptedMatches=results.filter(item=>item.acceptedMatchesExpected===true).length;
  const report={version:2,mode:'live',status:evaluated<results.length?'completed_with_errors':'completed',startedAt,completedAt:new Date().toISOString(),model:options.model,sourceSharing:options.sourceSharing,
    selection:cases.length===15?'full':'subset',selectedCaseIds:cases.map(item=>item.id),stopReason:cancelled?'cancelled':consecutiveNetworkErrors>=3?'consecutive_network_failures':null,
    scope:'15 项以内的合成固定案例；一致率是自动判定对照，不是人工确认的教学准确率，也不写入真实学习进度。子集仅用于诊断，不能替代 15 项整体比较。',
    summary:{total:results.length,evaluated,errors,notRun,cancelled:cancelledCount,modelCalls:results.reduce((sum,item)=>sum+item.modelCalls,0),
      networkErrors:results.filter(item=>item.modelCalls>0&&(item.error?.code==='model_unavailable'||item.error?.code==='model_http_error')).length,
      rawAgreement:{matches:rawMatches,total:results.length,rate:rawMatches/results.length},acceptedAgreement:{matches:acceptedMatches,total:results.length,rate:acceptedMatches/results.length},
      guardDowngrades:results.filter(item=>item.downgraded).length,
      invalidCitationCases:results.filter(item=>item.reasons.includes('invalid_citation')).length,
      engineeringErrors:results.filter(item=>item.status==='error'||item.reasons.includes('invalid_citation')||item.reasons.includes('invalid_answer_quote')).length,
      falsePasses:results.filter(item=>item.accepted?.verdict==='pass'&&item.expected!=='pass').length,
      missedPasses:results.filter(item=>item.accepted&&item.accepted.verdict!=='pass'&&item.expected==='pass').length},results};
  return redactEvaluation(report,options.secrets??[]) as typeof report;
}

export async function cleanupEvaluation(actions:{closeStore:()=>Promise<void>;closeAdmin:()=>Promise<void>;removeContainer:()=>void;removeConfig:()=>Promise<void>}){
  const failures:string[]=[];
  const bounded=async(operation:()=>Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cleanup timeout')),5000);})]);}finally{clearTimeout(timer);}};
  const closed=await Promise.allSettled([bounded(actions.closeStore),bounded(actions.closeAdmin)]);
  closed.forEach((result,index)=>{if(result.status==='rejected')failures.push(index===0?'store_close_failed':'admin_close_failed');});
  try {actions.removeContainer();}catch{failures.push('container_remove_failed');}
  try {await actions.removeConfig();}catch{failures.push('temporary_config_remove_failed');}
  return {ok:failures.length===0,failures,temporaryConfigRemoved:!failures.includes('temporary_config_remove_failed')};
}

async function loadCases(root:string){
  const cases=z.array(Case).length(15).parse(JSON.parse(await readFile(join(root,'quality/learning-cases.json'),'utf8')));
  if(new Set(cases.map(item=>item.id)).size!==15)throw new Error('固定案例存在重复标识。');
  return cases;
}
function docker(args:string[]){
  const result=spawnSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw new Error('临时 PostgreSQL 操作失败；请检查 Docker 与本机 postgres:18-bookworm 镜像。');
  return result.stdout.trim();
}
export async function main(args=process.argv.slice(2)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),options=parseEvaluationArgs(args),allCases=await loadCases(root);
  const cases=selectEvaluationCases(allCases,options.caseIds);
  if(options.help){console.log('用法：pnpm quality（预演）\npnpm quality --live --config /绝对路径/config.json（最多 15 次合成评阅，不重试）\n可重复 --case <固定案例 ID> 选择诊断子集；省略时评测全部 15 项。');return 0;}
  if(!options.live){
    console.log(JSON.stringify({mode:'dry-run',cases:cases.length,caseIds:cases.map(item=>item.id),selection:cases.length===15?'full':'subset',courses:[...new Set(cases.map(item=>item.course))],networkRequests:0,configurationRead:false,
      sends:['material','question','answer'],excludes:['expected','rubric','proposed','fault','个人资料与邮件'],maximumLiveRequests:cases.length,
      next:'明确执行 --live --config <模型配置文件> 才会读取模型配置并调用。'},null,2));return 0;
  }
  validateEvaluationEnvironment(process.env);
  const handle=await open(resolve(options.config!),'r');let llm:Llm;
  try {if((await handle.stat()).size>1024*1024)throw new Error('模型配置文件过大。');llm=pickEvaluationModel(JSON.parse(await handle.readFile('utf8')));}
  catch {throw new Error('模型配置无法读取；需要仅含有效 llm 设置的 JSON，地址不得含账号或查询凭据。');}
  finally {await handle.close();}
  await mkdir(join(root,'private'),{recursive:true,mode:0o700});
  const output=await mkdtemp(join(root,'private/quality-')),folder=await mkdtemp(join(tmpdir(),'yeux-quality-data-'));
  const name='yeux-quality-'+randomBytes(6).toString('hex'),database='assistant_quality_'+randomBytes(4).toString('hex')+'_test',password=randomBytes(32).toString('hex');
  let store:Store|undefined,admin:pg.Pool|undefined,started=false,stopped=false,exitCode=1;
  let completedReport:Awaited<ReturnType<typeof evaluateLearningCases>>|undefined;
  const stop=()=>{stopped=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    await writeFile(join(folder,'config.json'),JSON.stringify({llm}),{mode:0o600,flag:'wx'});
    started=true;docker(['run','-d','--rm','--pull=never','--name',name,'--label','yeux.assistant.test=true','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','postgres:18-bookworm']);
    const endpoint=docker(['port',name,'5432/tcp']).split(':').at(-1)!;
    if(!/^\d+$/.test(endpoint))throw new Error('临时数据库端口无效。');
    const base='postgres://postgres:'+password+'@127.0.0.1:'+endpoint+'/';
    admin=new pg.Pool({connectionString:base+'postgres',connectionTimeoutMillis:1000});
    let ready=false;for(let index=0;index<40&&!stopped;index++){try{await admin.query('SELECT 1');ready=true;break;}catch{await sleep(250);}}
    if(!ready||stopped)throw new Error('临时数据库尚未就绪或评测已停止。');
    await admin.query('CREATE DATABASE "'+database+'"');await admin.end();admin=undefined;
    store=new Store(base+database);await store.migrate();
    completedReport=await evaluateLearningCases(cases,async(item,context)=>{
      if(stopped)return {rawResponse:null,providedCitations:[],exerciseComplete:false,usage:[],modelCalls:0,latencyMs:0,error:'cancelled'};
      const identity=randomUUID(),runId=randomUUID();
      await store!.transaction(async tx=>{
        await tx.exec("INSERT INTO app.sessions(id,title,kind,prompt,current_run_id) VALUES($1,'合成评阅','study',$2,$3)",[identity,item.question,runId]);
        await tx.exec('INSERT INTO app.runs(id,session_id,graph_thread) VALUES($1,$2,$2)',[runId,identity]);
      });
      const run=await claimRun(store!,runId);if(!run)throw new Error('Synthetic run unavailable');
      const gateway=new ModelGateway(store!,folder,{runId,generation:run.generation}),begin=Date.now();
      let response:ModelAssessment|undefined,error:string|undefined;
      try {if(!await gateway.configured())error='model_unconfigured';else response=await gateway.json(ModelAssessment,ASSESSMENT_INSTRUCTION,context,{assessment:true});}
      catch(failure){const code=(failure as {code?:unknown})?.code;error=typeof code==='string'&&errorMessages[code]?code:'unexpected_error';}
      const usage=(await store!.one('SELECT model_calls,usage FROM app.runs WHERE id=$1',[runId]))!;
      await store!.exec("UPDATE app.runs SET state=$2,finished_at=now() WHERE id=$1",[runId,error?'failed':'succeeded']);
      await store!.exec('UPDATE app.sessions SET state=$2 WHERE id=$1',[identity,error?'failed':'completed']);
      return {response,rawResponse:gateway.lastResponse,providedCitations:gateway.providedCitations,exerciseComplete:gateway.exerciseComplete,usage:usage.usage,modelCalls:Number(usage.model_calls),latencyMs:Date.now()-begin,error};
    },{model:llm.model,sourceSharing:llm.tools,secrets:[llm.api_key??'',llm.base_url],shouldStop:()=>stopped,
      onProgress:({index,total,status})=>console.error('['+index+'/'+total+'] '+status)});
    await writeFile(join(output,'report.json'),JSON.stringify(completedReport,null,2)+'\n',{mode:0o600,flag:'wx'});
    exitCode=completedReport.status==='completed'?0:2;
  } finally {
    const cleanup=await cleanupEvaluation({closeStore:async()=>{await store?.close();},closeAdmin:async()=>{await admin?.end();},
      removeContainer:()=>{if(started){const result=spawnSync('docker',['rm','-f',name],{stdio:'ignore',timeout:30000});if(result.error||result.status!==0)throw new Error('Container cleanup failed');}},
      removeConfig:()=>rm(folder,{recursive:true,force:true})});
    const details={...cleanup,...(cleanup.failures.includes('container_remove_failed')?{residualContainer:name}:{})};
    await writeFile(join(output,'cleanup.json'),JSON.stringify(details,null,2)+'\n',{mode:0o600});
    if(completedReport)await writeFile(join(output,'report.json'),JSON.stringify({...completedReport,cleanup:details},null,2)+'\n',{mode:0o600});
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    if(!cleanup.ok){console.error('临时资源清理未全部完成，请查看 '+join(output,'cleanup.json')+(details.residualContainer?'；残留容器：'+details.residualContainer:''));throw new Error('Evaluation cleanup incomplete');}
  }
  console.log(JSON.stringify({status:completedReport!.status,summary:completedReport!.summary,report:join(output,'report.json'),meaning:'自动对照结果；仍需逐项人工核对反馈与引用。'},null,2));
  return exitCode;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('质量检查未完成。请检查显式参数、模型配置格式及隔离测试环境；没有修改真实学习进度。');process.exitCode=1;});
}
