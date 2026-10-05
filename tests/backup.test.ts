import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
// @ts-expect-error Operational scripts execute directly in Node.
import { createBackup } from '../scripts/backup.mjs';

describe('complete local backup', () => {
  it('captures runtime files and verifiable checksums, excluding old backups and tool caches', async () => {
    const folder=await mkdtemp(join(tmpdir(),'assistant-backup-'));
    try {
      for(const directory of ['documents','source-assets','artifacts','receipts','mail-quarantine','pnpm-store']) {await mkdir(join(folder,directory));await writeFile(join(folder,directory,'synthetic.txt'),directory);}
      await writeFile(join(folder,'config.json'),'{}');
      const output=await createBackup(folder,(path:string)=>writeFile(path,'synthetic dump'));
      const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
      expect(manifest.files.map((f:any)=>f.path).sort()).toEqual(['artifacts/synthetic.txt','config.json','database.dump','documents/synthetic.txt','mail-quarantine/synthetic.txt','receipts/synthetic.txt','source-assets/synthetic.txt']);
      for(const file of manifest.files) {const bytes=await readFile(join(output,file.path));expect(bytes.length).toBe(file.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);}
    } finally {await rm(folder,{recursive:true,force:true});}
  });
  it('never reports a partial dump or an external symlink as a complete backup', async () => {
    const folder=await mkdtemp(join(tmpdir(),'assistant-backup-'));
    try {
      await expect(createBackup(folder,async(path:string)=>{await writeFile(path,'partial');throw new Error('dump failed');})).rejects.toThrow('dump failed');
      expect(await readdir(join(folder,'backups'))).toEqual([]);
      await symlink('/etc',join(folder,'documents'));
      await expect(createBackup(folder,(path:string)=>writeFile(path,'synthetic dump'))).rejects.toThrow('符号链接');
      expect(await readdir(join(folder,'backups'))).toEqual([]);
    } finally {await rm(folder,{recursive:true,force:true});}
  });
});
