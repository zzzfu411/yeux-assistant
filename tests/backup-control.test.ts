import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);

it.each([false,true])('backup stops and restores only previously running services (dump fails: %s)',async failure=>{
  const folder=await mkdtemp(join(tmpdir(),'assistant-control-')), bin=join(folder,'bin'), data=join(folder,'data'), log=join(folder,'commands.jsonl');
  try {
    await mkdir(bin);await mkdir(data);await writeFile(join(data,'runtime.env'),'POSTGRES_PASSWORD=synthetic\n');
    await writeFile(join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='info')console.log('fixture');
else if(args.includes('ps'))console.log('api\\ndb');
else if(args.includes('pg_dump')){process.stdout.write('synthetic dump');if(process.env.FIXTURE_FAIL==='1')process.exitCode=1;}
`,{mode:0o700});
    const command=execute(process.execPath,[resolve('scripts/control.mjs'),'backup'],{env:{...process.env,PATH:bin+':'+process.env.PATH,ASSISTANT_DATA_DIR:data,FIXTURE_LOG:log,FIXTURE_FAIL:failure?'1':'0'}});
    if(failure)await expect(command).rejects.toThrow();else expect((await command).stdout).toContain('备份已保存');
    const commands=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
    expect(commands.find(args=>args.includes('stop'))?.slice(-4)).toEqual(['stop','--timeout','120','api']);
    expect(commands.at(-1)?.slice(-2)).toEqual(['start','api']);
    expect(await readdir(join(data,'backups'))).toHaveLength(failure?0:1);
  } finally {await rm(folder,{recursive:true,force:true});}
});
