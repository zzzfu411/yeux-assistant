import Fastify, { type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z, ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../../../packages/storage/src/index.js';
import { Application } from '../../../packages/core/src/application.js';
import { MailActions } from '../../../packages/core/src/mail.js';
import { createBoss } from '../../../packages/core/src/queue.js';
import { dataFolder, initializeData, config, validateBaseURL } from '../../../packages/core/src/config.js';
import { AppError } from '../../../packages/core/src/common.js';
import { originalAsset } from '../../../packages/core/src/course-import.js';
import { Id, Revision, CreateGoal, UpdateGoal, Feedback, CreateSession, SourceInput, MemoryInput, ScheduleInput, DraftInput, ModelSettingsInput, ApprovalDecision, ApprovalResolution } from '../../../packages/contracts/src/index.js';

const params=z.object({id:Id});
const pageQuery=z.object({page:z.coerce.number().int().min(0).max(100000).default(0)});
const revisionBody=z.object({revision:Revision}).strict();
export async function buildServer(options: {url?:string;folder?:string;assets?:boolean}={}) {
  const folder=options.folder||dataFolder(), token=await initializeData(folder);
  const store=new Store(options.url); await store.migrate();
  const boss=await createBoss(options.url||process.env.DATABASE_URL!);
  const app=new Application(store,boss,folder,token), mail=new MailActions(store,boss,folder);
  const server=Fastify({logger:false,bodyLimit:2_100_000,requestTimeout:20000,connectionTimeout:20000,keepAliveTimeout:10000}).withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);server.setSerializerCompiler(serializerCompiler);
  let closing=false; const connections=new Set<()=>void>();
  const key=(request:FastifyRequest)=>{const value=request.headers['idempotency-key'];if(typeof value!=='string')throw new AppError('需要 Idempotency-Key。');return value;};
  server.addHook('onRequest',async (request,reply)=>{
    if(!request.url.startsWith('/api/v2'))return;
    const raw=request.headers.authorization||'', supplied=Buffer.from(raw.startsWith('Bearer ')?raw.slice(7):''), expected=Buffer.from(token);
    if(!expected.length || !raw.startsWith('Bearer ') || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return reply.code(401).send({error:{code:'unauthorized',message:'请输入访问口令。'}});
    if(!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin) {
      const origin=new URL(request.headers.origin); if(origin.host!==request.headers.host) throw new AppError('请求来源与当前服务不一致。',403,'origin_mismatch');
    }
    reply.header('Cache-Control','no-store');
  });
  server.addHook('onSend',async (_request,reply,payload)=>{
    reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");return payload;
  });
  server.setErrorHandler((error,request,reply)=>{
    const err=error as any;
    const invalid=error instanceof ZodError || err.validation;
    const conflict=(err.code||err.cause?.code)==='23505';
    const status=error instanceof AppError ? error.status : invalid ? 400 : conflict ? 409 : err.statusCode && err.statusCode<500 ? err.statusCode : 500;
    reply.code(status).send({error:{code:error instanceof AppError ? error.code : invalid ? 'invalid_request' : conflict ? 'conflict' : 'internal_error',message:error instanceof AppError ? error.message : invalid ? '输入格式不正确，请检查填写内容。' : conflict ? '已有正在进行的记录，请载入最新状态。' : status===500 ? '服务暂时无法完成操作，请重试。' : err.message}});
  });
  server.get('/healthz',async()=>({ok:!closing,version:2}));
  server.get('/api/v2/today',async()=>app.today());
  server.get('/api/v2/goals',async()=>app.goals());
  server.get('/api/v2/goals/:id',{schema:{params}},r=>app.goal(r.params.id));
  server.post('/api/v2/goals',{schema:{body:CreateGoal}},async(r,p)=>{p.code(202);return app.addGoal(key(r),r.body);});
  server.patch('/api/v2/goals/:id',{schema:{params,body:UpdateGoal}},r=>app.changeGoal(key(r),r.params.id,r.body));
  server.get('/api/v2/sessions',{schema:{querystring:pageQuery}},r=>app.history(r.query.page));
  server.get('/api/v2/sessions/:id',{schema:{params}},r=>app.session(r.params.id));
  server.post('/api/v2/sessions',{schema:{body:CreateSession}},async(r,p)=>{p.code(202);return app.addSession(key(r),r.body);});
  server.post('/api/v2/sessions/:id/feedback',{schema:{params,body:Feedback}},async(r,p)=>{p.code(202);return app.feedback(key(r),r.params.id,r.body);});
  server.post('/api/v2/sessions/:id/retry',{schema:{params,body:revisionBody}},r=>app.retry(key(r),r.params.id,r.body.revision));
  server.post('/api/v2/sessions/:id/archive',{schema:{params,body:revisionBody}},r=>app.archive(key(r),r.params.id,r.body.revision));
  server.post('/api/v2/runs/:id/cancel',{schema:{params}},r=>app.cancel(key(r),r.params.id));
  server.patch('/api/v2/sessions/:id/draft',{schema:{params,body:DraftInput}},r=>app.saveDraft(key(r),r.params.id,r.body));
  server.get('/api/v2/sessions/:id/export',{schema:{params}},async(r,p)=>{
    const detail=await app.session(r.params.id);
    p.header('Content-Disposition',`attachment; filename="session-${encodeURIComponent(r.params.id)}.md"`).type('text/markdown; charset=utf-8');
    return '# '+detail.session.title+'\n\n'+detail.session.content+'\n\n'+detail.artifacts.map(a=>'## '+a.kind+' ('+a.createdAt+')\n\n'+a.content).join('\n\n');
  });
  server.get('/api/v2/sources',async()=>app.sources());
  server.get('/api/v2/sources/:id',{schema:{params,querystring:z.object({version:z.coerce.number().int().positive().optional()})}},r=>app.source(r.params.id,r.query.version));
  server.get('/api/v2/sources/:id/original',{schema:{params,querystring:z.object({version:z.coerce.number().int().positive().optional()})}},async(r,p)=>{
    const detail=await app.source(r.params.id,r.query.version);
    const asset=await originalAsset(folder,detail.metadata);
    const filename=encodeURIComponent(asset.filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
    p.type('application/octet-stream').header('Content-Disposition',`attachment; filename="source"; filename*=UTF-8''${filename}`);
    return asset.bytes;
  });
  server.post('/api/v2/sources',{schema:{body:SourceInput}},r=>app.importSource(key(r),r.body));
  server.get('/api/v2/search',{schema:{querystring:z.object({q:z.string().trim().min(1).max(2000),course:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/).optional()})}},r=>app.search(r.query.q,r.query.course));
  server.get('/api/v2/memories',async()=>app.memories());
  server.get('/api/v2/memories/:id/history',{schema:{params}},r=>store.rows('SELECT * FROM app.memory_versions WHERE key=$1 ORDER BY version DESC LIMIT 100',[r.params.id]));
  server.post('/api/v2/memories',{schema:{body:MemoryInput}},r=>app.saveMemory(key(r),r.body));
  server.get('/api/v2/schedules',async()=>app.schedules());
  server.post('/api/v2/schedules',{schema:{body:ScheduleInput}},r=>app.saveSchedule(key(r),undefined,r.body));
  server.patch('/api/v2/schedules/:id',{schema:{params,body:ScheduleInput}},r=>app.saveSchedule(key(r),r.params.id,r.body));
  server.get('/api/v2/notifications',{schema:{querystring:pageQuery}},r=>app.notifications(r.query.page));
  server.post('/api/v2/notifications/:id/read',{schema:{params}},r=>app.readNotification(key(r),r.params.id));
  server.get('/api/v2/settings/model',async()=>app.settings.get());
  server.patch('/api/v2/settings/model',{schema:{body:ModelSettingsInput}},r=>app.saveSettings(key(r),r.body));
  server.post('/api/v2/settings/model/test',async()=>{
    const current=(await config(folder)).llm;
    if(!current?.base_url || !current?.model)throw new AppError('请先保存模型地址与名称。');
    try {
      const response=await fetch(validateBaseURL(current.base_url)+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...(current.api_key?{Authorization:'Bearer '+current.api_key}:{})},body:JSON.stringify({model:current.model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:8}),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new AppError('模型连接失败（HTTP '+response.status+'），请检查地址、名称和密钥。',502,'provider_error');
      const body=await response.json() as any;if(!body.choices?.[0]?.message)throw new AppError('服务未返回兼容的对话结果。',502,'provider_error');
      return {ok:true,message:'连接成功。'};
    } catch(error) { if(error instanceof AppError)throw error;throw new AppError('连接模型超时或网络不可用，请检查设置。',502,'provider_error'); }
  });
  server.post('/api/v2/sessions/:id/approval',{schema:{params,body:revisionBody}},r=>mail.request(key(r),r.params.id,r.body));
  server.post('/api/v2/approvals/:id/decision',{schema:{params,body:ApprovalDecision}},r=>mail.decide(key(r),r.params.id,r.body));
  server.post('/api/v2/approvals/:id/resolve',{schema:{params,body:ApprovalResolution}},r=>mail.resolve(key(r),r.params.id,r.body));
  server.get('/api/v2/events',{schema:{querystring:z.object({after:z.string().regex(/^\d+$/).max(20).default('0')})}},async(r,p)=>{
    if(connections.size>=16)throw new AppError('打开的实时连接过多，请关闭不用的页面。',429);
    p.hijack();p.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});
    let after=r.query.after, busy=false, closed=false;
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(poll);clearInterval(heartbeat);connections.delete(stop);};
    const stop=()=>{cleanup();p.raw.end();};
    const flush=async()=>{if(busy||closed)return;busy=true;try { for(const item of await app.events(after)) {if(closed)break;after=item.id;if(!p.raw.write('id: '+item.id+'\ndata: '+JSON.stringify(item)+'\n\n'))break;} }catch{stop();}finally{busy=false;}};
    const poll=setInterval(()=>void flush(),1000), heartbeat=setInterval(()=>{if(!closed)p.raw.write(': heartbeat\n\n');},15000);
    connections.add(stop);p.raw.on('close',cleanup);await flush();
  });
  if(options.assets!==false && existsSync(resolve('dist/web/index.html'))) {
    await server.register(staticFiles,{root:resolve('dist/web'),index:'index.html',wildcard:true});
    server.setNotFoundHandler((r,p)=>r.url.startsWith('/api/') || r.url.startsWith('/assets/') || /\.[a-z0-9]+(?:\?|$)/i.test(r.url)?p.code(404).send({error:{code:'not_found',message:'请求的内容不存在，请刷新页面。'}}):p.sendFile('index.html'));
  }
  server.addHook('preClose',async()=>{closing=true;for(const close of connections)close();});
  server.addHook('onClose',async()=>{await boss.stop();await store.close();});
  return {server,app,store,boss,mail};
}
