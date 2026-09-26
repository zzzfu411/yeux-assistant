import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const command=process.argv[2]||'status';
const folder=resolve(process.env.ASSISTANT_DATA_DIR||'private');
const envFile=join(folder,'runtime.env');
const project=process.env.COMPOSE_PROJECT_NAME||'yeux-assitant';
const compose=['compose','--env-file',envFile,'-p',project];
const environment={...process.env,ASSISTANT_DATA_DIR:folder};
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
    ensureEngine();run('docker',[...compose,'up','-d','--build']);
    console.log('学习助手：http://127.0.0.1:'+(process.env.ASSISTANT_PORT||'8765')+'；口令文件：'+join(folder,'access-token'));
  } else if(command==='stop') {
    if(!existsSync(envFile) || !engineReady())console.log('当前未运行。');else run('docker',[...compose,'down','--timeout','120']);
  } else if(command==='status') {
    if(!existsSync(envFile) || !engineReady())console.log('当前未运行。');else run('docker',[...compose,'ps']);
  } else if(command==='backup') {
    if(!engineReady() || !existsSync(envFile))throw new Error('请先启动数据库，再创建一致备份。');
    const output=join(folder,'backups','postgres-'+new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(output,{recursive:true,mode:0o700});
    const stream=createWriteStream(join(output,'database.dump'),{mode:0o600});
    const child=spawn('docker',[...compose,'exec','-T','db','pg_dump','-U','assistant','-d','assistant','-Fc'],{env:environment,stdio:['ignore','pipe','inherit']});child.stdout.pipe(stream);
    await new Promise((done,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error('数据库备份失败。')));});
    await new Promise((done,reject)=>{if(stream.writableFinished)return done();stream.on('finish',done);stream.on('error',reject);});
    for(const file of ['config.json','access-token','v2-cutover.json','runtime.env'])if(existsSync(join(folder,file)))copyFileSync(join(folder,file),join(output,file));
    if(existsSync(join(folder,'source-assets')))cpSync(join(folder,'source-assets'),join(output,'source-assets'),{recursive:true,errorOnExist:true,force:false});
    writeFileSync(join(output,'README.txt'),'PostgreSQL 使用 pg_restore 恢复到新的数据库；source-assets 保存课程原件，恢复时一并复制到 private/source-assets。其他原始文件仍在 private/documents；恢复前保留切换后的新增数据。\n',{mode:0o600});
    console.log('备份已保存：'+output);
  } else throw new Error('支持 start / stop / status / backup。');
} catch(error) {console.error(error.message);process.exitCode=1;}
