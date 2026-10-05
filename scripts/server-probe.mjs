import { platform, arch, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Read-only inventory, safe to run before selecting a cloud deployment method.
const probe = (args) => {
  const result = spawnSync('docker', args, {encoding:'utf8',timeout:8000,stdio:['ignore','pipe','ignore']});
  return result.status === 0;
};
let freeGiB = null;
try { const disk=await statfs(process.cwd());freeGiB=Math.floor(disk.bavail*disk.bsize/1024**3); } catch {}
const client=probe(['--version']),compose=client&&probe(['compose','version']),engine=client&&probe(['info','--format','{{.ServerVersion}}']);
const nodeMajor=Number(process.versions.node.split('.')[0]);
console.log(JSON.stringify({os:platform(),architecture:arch(),nodeMajor,memoryGiB:Math.round(totalmem()/1024**3),freeGiB,docker:{client,compose,engine},ready:nodeMajor>=24&&compose&&engine,note:'只读检查；未安装软件、启动服务或读取账号与密钥。'},null,2));
