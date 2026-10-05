import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createBackup } from './backup.mjs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const command=process.argv[2]||'status';
const folder=resolve(process.env.ASSISTANT_DATA_DIR||'private');
const envFile=join(folder,'runtime.env');
const project=process.env.COMPOSE_PROJECT_NAME||'yeux-assitant';
const override=join(folder,'compose.override.yaml');
const compose=['compose','--env-file',envFile,'-f',join(root,'compose.yaml'),...(existsSync(override)?['-f',override]:[]),'-p',project];
const environment={...(existsSync(envFile)?parseEnv(readFileSync(envFile,'utf8')):{}),...process.env,ASSISTANT_DATA_DIR:folder};
function run(binary,args,options={}) { const result=spawnSync(binary,args,{cwd:root,env:environment,stdio:'inherit',...options});if(result.error)throw result.error;if(result.status!==0)throw new Error(binary+' 执行失败。');return result; }
function engineReady() {return spawnSync('docker',['info','--format','{{.ServerVersion}}'],{stdio:'ignore',timeout:8000}).status===0;}
function ensureEngine() {
  if(engineReady())return;
  if(process.platform==='darwin' && spawnSync('colima',['version'],{stdio:'ignore'}).status===0)run('colima',['start']);
  if(!engineReady())throw new Error('Docker 引擎未运行，请先手动启动 Docker 或 Colima。');
}
try {
  if(command==='start') {
    mkdirSync(folder,{recursive:true,mode:0o700});
    if(!existsSync(envFile))writeFileSync(envFile,'POSTGRES_PASSWORD='+randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
    if(existsSync(join(folder,'assistant.sqlite3')) && !existsSync(join(folder,'v2-cutover.json')) && process.env.ASSISTANT_MIGRATION_PREVIEW!=='1') throw new Error('检测到旧版数据。先按 README 完成迁移核对和切换，避免开启空白实例；旧数据未被修改。');
    ensureEngine();run('docker',[...compose,'up','-d','--build','--wait','--wait-timeout','120']);
    console.log('学习助手：http://127.0.0.1:'+(environment.ASSISTANT_PORT||'8765')+'；使用管理员账号登录。首次部署请按 docs/usage.md 设置管理员。');
  } else if(command==='stop') {
    if(!existsSync(envFile) || !engineReady())console.log('当前未运行。');else run('docker',[...compose,'down','--timeout','120']);
  } else if(command==='status') {
    if(!existsSync(envFile) || !engineReady())console.log('当前未运行。');else run('docker',[...compose,'ps']);
  } else if(command==='backup') {
    if(!engineReady() || !existsSync(envFile))throw new Error('请先启动数据库，再创建一致备份。');
    const result=run('docker',[...compose,'ps','--status','running','--services'],{stdio:['ignore','pipe','inherit']});
    const resume=result.stdout.toString().trim().split(/\s+/).filter(service=>['api','worker'].includes(service));
    console.log('备份期间暂停 API 和 Worker，请勿同时导入资料或修改 private 文件。');
    try {
      if(resume.length)run('docker',[...compose,'stop','--timeout','120',...resume]);
      const output=await createBackup(folder,async path=>{
        const child=spawn('docker',[...compose,'exec','-T','db','pg_dump','-U','assistant','-d','assistant','-Fc'],{env:environment,stdio:['ignore','pipe','inherit']});
        const ended=new Promise((done,reject)=>{child.on('error',reject);child.on('close',code=>code===0?done():reject(new Error('数据库备份失败。')));});
        try {await Promise.all([ended,pipeline(child.stdout,createWriteStream(path,{mode:0o600,flags:'wx'}))]);}
        catch(error){child.kill();await ended.catch(()=>{});throw error;}
      });
      console.log('备份已保存：'+output);
    } finally {if(resume.length)run('docker',[...compose,'start',...resume]);}
  } else throw new Error('支持 start / stop / status / backup。');
} catch(error) {console.error(error.message);process.exitCode=1;}
