import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {parseEnv} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),name='yeux-server-test-'+randomBytes(4).toString('hex');
const folder=join(root,'private/server-validation',name);await mkdir(folder,{recursive:true});
const env={...process.env,ASSISTANT_SERVER_DATA_DIR:folder,ASSISTANT_SERVER_PROJECT:name};
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const url='http://127.0.0.1:'+port;
async function command(binary,args,options={}){
  return new Promise((resolve,reject)=>{const child=spawn(binary,args,{cwd:root,env,...options});let stdout='',stderr='';child.stdout?.on('data',v=>stdout+=v);child.stderr?.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(new Error(binary+' failed: '+stderr.slice(-3000))));if(options.input){child.stdin.end(options.input);}});
}
const control=(cmd)=>command(process.execPath,['scripts/server-control.mjs',cmd]);
let compose,started=false;
const result={project:name,url,syntheticDataOnly:true};
function assert(value,message){if(!value)throw new Error(message);}
async function waitFor(check,label){for(let n=0;n<100;n++){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,300));}throw new Error(label+' timed out');}
try{
  await control('init');
  let settings=(await readFile(folder+'/runtime.env','utf8')).replace('ASSISTANT_PORT=8765','ASSISTANT_PORT='+port).replace('http://127.0.0.1:8765',url).replace('ASSISTANT_DATABASE=assistant','ASSISTANT_DATABASE=assistant_server_test');
  await writeFile(folder+'/runtime.env',settings);
  compose=['compose','--env-file',folder+'/runtime.env','--project-directory',root,'-f',root+'/deploy/compose.server.yaml','-p',name];
  Object.assign(env,parseEnv(settings),{ASSISTANT_DATA_DIR:folder,ASSISTANT_SOURCE_DIR:root});
  await control('check');console.log('Configuration verified. Starting isolated server.');
  started=true;await control('start');
  const credentials={username:'synthetic-cloud-admin',password:'Synthetic-server-password-42!'};
  await command('docker',[...compose,'exec','-T','api','node','dist/scripts/setup-admin.js'],{input:JSON.stringify(credentials)});
  const anon=await fetch(url+'/api/v2/today');assert(anon.status===401,'Anonymous access was not denied');
  const login=await fetch(url+'/api/v2/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify(credentials)});assert(login.ok,'Loopback login failed');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const get=async path=>{const response=await fetch(url+'/api/v2'+path,{headers:{Cookie:cookie}});assert(response.ok,'Authenticated read failed '+path);return response.json();};
  await waitFor(async()=>Boolean((await get('/today/overview')).workerOnline),'worker heartbeat');
  const issued=await fetch(url+'/api/v2/agents',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json','Idempotency-Key':'server-agent-credential'},body:JSON.stringify({name:'Synthetic remote agent',scopes:['workspace:read','goals:create']})});
  assert(issued.ok,'Agent credential creation failed');const agent=await issued.json();
  const agentHeaders={Authorization:'Bearer '+agent.token,'Content-Type':'application/json'};
  const created=await fetch(url+'/api/agent/v1/tools/create_goal',{method:'POST',headers:agentHeaders,body:JSON.stringify({requestKey:'server-smoke-goal',title:'服务器合成验收目标',outcome:'只验证部署，不代表本人学习',sourceIds:[]})});assert(created.status===200,'Agent create goal failed');
  const agentGoal=await created.json();
  await waitFor(async()=>(await get('/today')).sessions?.some(s=>s.state==='waiting_feedback'),'learning preparation');
  const before=await get('/goals/list');assert(before.total===1,'Unexpected goal count');
  const identity=JSON.parse(await command('docker',[...compose,'exec','-T','api','node','-e',"console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))"]));assert(identity.uid>0,'API ran as root');result.user=identity;
  await command('docker',[...compose,'restart','api','worker']);
  await waitFor(async()=>{const r=await fetch(url+'/healthz');return r.ok;},'restart');
  await waitFor(async()=>Boolean((await get('/today/overview')).workerOnline),'worker restart');
  assert((await get('/goals/list')).items[0].id===before.items[0].id,'Goal was lost across restart');
  const agentTask=await fetch(url+'/api/agent/v1/tools/get_task',{method:'POST',headers:agentHeaders,body:JSON.stringify({id:agentGoal.sessionId})});
  assert(agentTask.ok&&(await agentTask.json()).state==='waiting_feedback','Agent credential/task failed across restart');
  const mcp=await fetch(url+'/api/agent/mcp',{method:'POST',headers:{...agentHeaders,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'server-check',version:'1.0.0'}}})});
  assert(mcp.ok&&(await mcp.json()).result?.serverInfo?.name==='yeux-assitant','MCP handshake failed');
  const revoked=await fetch(url+'/api/v2/agents/'+agent.credential.id+'/revoke',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json'},body:'{}'});
  assert(revoked.ok,'Agent revoke failed');assert((await fetch(url+'/api/agent/v1/tools',{headers:agentHeaders})).status===401,'Revoked Agent retained access');
  result.agentPreparationAndRestart=true;result.mcpHandshake=true;result.agentRevocation=true;
  const backupOutput=await control('backup'),backup=backupOutput.split('\n').find(v=>v.startsWith('完整服务器备份已保存：')).split('：')[1];
  const manifest=JSON.parse(await readFile(backup+'/manifest.json','utf8'));
  for(const file of manifest.files){const bytes=await readFile(backup+'/'+file.path);assert(bytes.length===file.bytes&&createHash('sha256').update(bytes).digest('hex')===file.sha256,'Backup hash mismatch');}
  result.backupFiles=manifest.files.length;result.goalSurvivedRestart=true;result.sessionSurvivedRestart=true;
  settings=settings.replace(url,'https://study.example.invalid');await writeFile(folder+'/runtime.env',settings);env.ASSISTANT_PUBLIC_ORIGIN='https://study.example.invalid';
  await command('docker',[...compose,'up','-d','--no-build','--wait','api']);
  const proxied=await fetch(url+'/api/v2/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://study.example.invalid','X-Forwarded-Proto':'http','X-Forwarded-Host':'untrusted.invalid'},body:JSON.stringify(credentials)});
  assert(proxied.ok&&proxied.headers.get('set-cookie').includes('; Secure'),'Configured HTTPS cookie not secure');
  const rejected=await fetch(url+'/api/v2/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://study.example.invalid'},body:JSON.stringify(credentials)});assert(rejected.status===403,'Protocol mismatch accepted');
  result.explicitHttpsOrigin=true;result.forgedForwardedHeadersIgnored=true;result.noRealTlsClaim=true;
  const config=JSON.parse(await command('docker',[...compose,'config','--format','json']));assert(config.services.api.ports.every(p=>p.host_ip==='127.0.0.1'),'Public API exposure');assert(!config.services.db.ports,'Database port exposed');assert(config.services.api.read_only===true,'Mutable root filesystem');
  result.loopbackOnly=true;result.noDatabasePort=true;result.readOnlyRoot=true;result.status='passed';
}catch(error){result.status='failed';result.error=error.message;process.exitCode=1;if(compose){const logs=await command('docker',[...compose,'logs','--tail','50','api','worker']).catch(()=> 'logs unavailable');await writeFile(folder+'/container-diagnostics.log',logs);result.diagnostics=logs.slice(-5000);}}
finally{
  if(started&&compose){const clean=await command('docker',[...compose,'down','--volumes','--timeout','30']).then(()=>true).catch(()=>false);result.testContainersRemoved=clean;if(!clean){result.status='failed';result.cleanupError='Test containers could not be removed; inspect '+name;process.exitCode=1;}}
  await writeFile(folder+'/report.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
