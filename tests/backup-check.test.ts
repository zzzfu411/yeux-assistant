import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
// @ts-expect-error Operational modules execute directly in Node.
import { createBackup } from '../scripts/backup.mjs';
// @ts-expect-error Operational modules execute directly in Node.
import { inspectDump, validateManifest, verifyBackup } from '../scripts/backup-integrity.mjs';
// @ts-expect-error Operational modules execute directly in Node.
import { inspectDockerDump } from '../scripts/backup-docker.mjs';

const customHeader = Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 16, 0, 4, 8, 1]), Buffer.alloc(30)]);
const decoded = () => ({ status: 'decoded', message: 'synthetic decoder' });
async function fixture(check: (folder: string, output: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'assistant-backup-check-'));
  try {
    await mkdir(join(folder, 'documents'));
    await writeFile(join(folder, 'documents', 'note.txt'), '合成资料');
    await writeFile(join(folder, 'config.json'), '{"api_key":"synthetic-secret-not-output"}');
    const output = await createBackup(folder, (path: string) => writeFile(path, customHeader));
    await check(folder, output);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
async function editManifest(output: string, edit: (manifest: any) => void) {
  const path = join(output, 'manifest.json'), value = JSON.parse(await readFile(path, 'utf8'));
  edit(value); await writeFile(path, JSON.stringify(value));
}
describe('read-only backup verification', () => {
  it('verifies every file without changing data and separates archive decoding from restore', async () => fixture(async (_folder, output) => {
    const before = await readFile(join(output, 'manifest.json'));
    expect(await verifyBackup(output, { checkDump: decoded })).toMatchObject({ ok: true, complete: true, files: 3, dump: 'decoded', errors: [], warnings: [] });
    expect(await readFile(join(output, 'manifest.json'))).toEqual(before);
    const limited = await verifyBackup(output, { checkDump: () => inspectDump('', () => ({ error: { code: 'ENOENT' } })) });
    expect(limited).toMatchObject({ ok: true, complete: false, dump: 'header_only' });
    expect(limited.warnings).toHaveLength(1);
  }));
  it.each(['../config.json', '/config.json', 'documents/../config.json', 'documents//note.txt', 'documents\\note.txt', 'C:/config.json', 'documents/\u0000note.txt'])('rejects unsafe manifest path %j before accessing it', path => {
    expect(() => validateManifest({ version: 1, completedAt: '2026-10-03T00:00:00.000Z', files: [{ path, bytes: 0, sha256: '0'.repeat(64) }] })).toThrow('不安全路径');
  });
  it.each([
    ['duplicate', 'manifest_duplicate', (value: any) => value.files.push(value.files[0])],
    ['dump absent', 'dump_missing', (value: any) => { value.files = value.files.filter((file: any) => file.path !== 'database.dump'); }],
    ['version', 'manifest_invalid', (value: any) => { value.version = 2; }],
    ['negative size', 'manifest_entry_invalid', (value: any) => { value.files[0].bytes = -1; }],
    ['unlisted file', 'file_unlisted', (value: any) => { value.files = value.files.filter((file: any) => file.path !== 'config.json'); }],
  ])('rejects %s', async (_name, code, edit) => fixture(async (_folder, output) => {
    await editManifest(output, edit as (value: any) => void);
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe(code);
  }));
  it('rejects missing files, file corruption, unexpected content and linked files', async () => fixture(async (folder, output) => {
    const path = join(output, 'documents', 'note.txt'), original = await readFile(path);
    await rm(path);
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('file_missing');
    await writeFile(path, '损坏的内容');
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('checksum_mismatch');
    await writeFile(path, original); await writeFile(join(output, 'extra.txt'), 'unexpected');
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('unexpected_file');
    await rm(join(output, 'extra.txt')); await rm(path); await symlink(join(folder, 'config.json'), path);
    const result = await verifyBackup(output, { checkDump: decoded });
    expect(result.errors[0].code).toBe('unsupported_file');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  }));
  it('rejects directory and manifest links, including empty directory links', async () => fixture(async (folder, output) => {
    await symlink(join(folder, 'documents'), join(output, 'artifacts'));
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('unsupported_file');
    await rm(join(output, 'artifacts'));
    const manifest = await readFile(join(output, 'manifest.json'));
    await writeFile(join(folder, 'manifest-copy.json'), manifest); await rm(join(output, 'manifest.json'));
    await symlink(join(folder, 'manifest-copy.json'), join(output, 'manifest.json'));
    expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('unsupported_file');
    await symlink(output, join(folder, 'linked-backup'));
    expect((await verifyBackup(join(folder, 'linked-backup'), { checkDump: decoded })).errors[0].code).toBe('backup_directory_invalid');
  }));
  it('does not accept matching checksums as proof of a valid dump', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'assistant-invalid-dump-'));
    try {
      const output = await createBackup(folder, (path: string) => writeFile(path, 'not a custom PostgreSQL archive'));
      expect((await verifyBackup(output, { checkDump: decoded })).errors[0].code).toBe('dump_header_invalid');
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('rejects a backup changed after hashing while the archive decoder runs', async () => fixture(async (_folder, output) => {
    const result = await verifyBackup(output, { checkDump: async () => {
      await writeFile(join(output, 'config.json'), '{"changed":true}'); return decoded();
    } });
    expect(result).toMatchObject({ ok: false, complete: false });
    expect(result.errors[0].code).toBe('backup_changed');
  }));
  it.each(['complete', 'limited', 'corrupt'])('uses distinct CLI exit codes for %s verification', async mode => fixture(async (folder, output) => {
    const bin = join(folder, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'pg_restore'), `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('synthetic pg_restore');else if(process.env.FIXTURE_CORRUPT==='1'){console.error('must-not-output-secret');process.exitCode=1;}\n`, { mode: 0o700 });
    const result: any = await promisify(execFile)(process.execPath, [resolve('scripts/backup-check.mjs'), output, '--json'], {
      env: { ...process.env, PATH: mode === 'limited' ? '' : bin, FIXTURE_CORRUPT: mode === 'corrupt' ? '1' : '0' },
    }).catch(error => error);
    expect(result.code ?? 0).toBe(mode === 'complete' ? 0 : mode === 'limited' ? 2 : 1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: mode !== 'corrupt', complete: mode === 'complete' });
    expect(result.stdout + result.stderr).not.toContain('must-not-output-secret');
  }));
  it('decodes all archive data without connecting to a database or exposing pg_restore output', () => {
    const calls: any[] = [];
    expect(inspectDump('/synthetic/database.dump', (_binary: string, args: string[], options: any) => {
      calls.push({ args, options }); return { status: 0 };
    }).status).toBe('decoded');
    expect(calls[1].args).toEqual(['--no-owner', '--no-privileges', '--file=-', '/synthetic/database.dump']);
    expect(calls[1].options.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    let invocation = 0;
    expect(() => inspectDump('/synthetic/database.dump', () => ++invocation === 1 ? { status: 0 } : { status: 1, stderr: 'credential-that-must-not-escape' })).toThrow('pg_restore 无法读取');
    invocation = 0;
    expect(inspectDump('/synthetic/database.dump', () => ++invocation === 1 ? { status: 0 } : { error: { code: 'ETIMEDOUT' } }).status).toBe('unverified');
  });
  it('requires an existing Docker image, streams the file to a bounded decoder and cleans its unique resources', async () => fixture(async (_folder, output) => {
    const calls: any[] = [];
    const result = await inspectDockerDump(join(output, 'database.dump'), { run: async (args: string[], options: any) => {
      calls.push({ args, options }); return { status: 0 };
    } });
    expect(result.status).toBe('decoded');
    expect(calls[0].args).toEqual(['image', 'inspect', 'postgres:18-bookworm']);
    const create = calls[1].args, name = create[create.indexOf('--name') + 1];
    expect(name).toMatch(/^yeux-backup-check-[a-f0-9-]+$/);
    expect(create).toEqual(['create', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=postgres', '--log-driver=none', '--interactive', '--entrypoint', 'pg_restore', 'postgres:18-bookworm', '--no-owner', '--no-privileges', '--file=-']);
    expect(calls[2]).toMatchObject({ args: ['start', '--attach', '--interactive', name], options: { stdin: expect.any(Number), timeout: 30000 } });
    expect(calls[3]).toEqual({ args: ['rm', '--force', '--volumes', name], options: { timeout: 5000 } });
    expect(JSON.stringify(calls)).not.toContain(output);
  }));
  it.each(['missing_image', 'start_timeout', 'start_interrupted', 'create_timeout', 'cleanup_failed', 'corrupt'])('does not certify Docker %s and always attempts owned-resource cleanup after create', async mode => fixture(async (_folder, output) => {
    const calls: string[][] = [];
    const check = () => inspectDockerDump(join(output, 'database.dump'), { run: async (args: string[]) => {
      calls.push(args);
      if (mode === 'missing_image' && args[0] === 'image') return { status: 1 };
      if (mode === 'create_timeout' && args[0] === 'create') return { status: null, timedOut: true };
      if (args[0] === 'start') {
        if (mode === 'start_timeout') return { status: null, timedOut: true };
        if (mode === 'start_interrupted') return { status: null, interrupted: true };
        if (mode === 'corrupt') return { status: 1 };
      }
      return { status: mode === 'cleanup_failed' && args[0] === 'rm' ? 1 : 0 };
    } });
    if (mode === 'corrupt') await expect(check()).rejects.toMatchObject({ code: 'dump_invalid' });
    else expect((await check()).status).toBe('unverified');
    expect(calls.map(args => args[0])).toEqual(mode === 'missing_image' ? ['image'] : mode === 'create_timeout' ? ['image', 'create', 'rm'] : ['image', 'create', 'start', 'rm']);
  }));
  it.each(['complete', 'unavailable', 'corrupt'])('supports explicit Docker CLI JSON mode: %s, without pg_restore or leaked subprocess output', async mode => fixture(async (folder, output) => {
    const bin = join(folder, 'bin'), log = join(folder, 'docker-calls.jsonl'); await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');console.error('docker-secret-must-not-escape');if(args[0]==='image'&&process.env.FIXTURE_MODE==='unavailable')process.exit(1);if(args[0]==='start'){const data=fs.readFileSync(0);if(data.subarray(0,5).toString()!=='PGDMP'||process.env.FIXTURE_MODE==='corrupt')process.exit(1);}\n`, { mode: 0o700 });
    const result: any = await promisify(execFile)(process.execPath, [resolve('scripts/backup-check.mjs'), '--docker', output, '--json'], {
      env: { ...process.env, PATH: bin, FIXTURE_MODE: mode, FIXTURE_LOG: log },
    }).catch(error => error);
    expect(result.code ?? 0).toBe(mode === 'complete' ? 0 : mode === 'unavailable' ? 2 : 1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: mode !== 'corrupt', complete: mode === 'complete' });
    expect(result.stdout + result.stderr).not.toContain('docker-secret');
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0]);
    expect(commands).toEqual(mode === 'unavailable' ? ['image'] : ['image', 'create', 'start', 'rm']);
  }));
  it('keeps invalid --json CLI usage machine-readable and never enables Docker implicitly', async () => {
    const result: any = await promisify(execFile)(process.execPath, [resolve('scripts/backup-check.mjs'), '--json', '--docker', '--unknown']).catch(error => error);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, errors: [{ code: 'usage' }] });
  });
  it('terminates an actual stalled decoder child at its deadline', async () => fixture(async (folder) => {
    const bin = join(folder, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const program = `import {runDocker} from ${JSON.stringify(resolve('scripts/backup-docker.mjs'))}; console.log(JSON.stringify(await runDocker(['synthetic-stall'], {timeout:100})));`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, PATH: bin }, timeout: 3000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ timedOut: true, status: null });
  }));
  it('cleans the decoder container before exiting a CLI interrupted by SIGTERM', async () => fixture(async (folder, output) => {
    const bin = join(folder, 'bin'), marker = join(folder, 'started'), log = join(folder, 'docker-calls.jsonl'); await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');if(args[0]==='start'){fs.writeFileSync(process.env.FIXTURE_MARKER,'started');setInterval(()=>{},1000);}\n`, { mode: 0o700 });
    const child = spawn(process.execPath, [resolve('scripts/backup-check.mjs'), output, '--docker', '--json'], {
      env: { ...process.env, PATH: bin, FIXTURE_LOG: log, FIXTURE_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const ended = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    try {
      const deadline = Date.now() + 2000; let started = false;
      while (Date.now() < deadline) {
        started = await readFile(marker, 'utf8').then(() => true, () => false);
        if (started) break;
        await new Promise(done => setTimeout(done, 25));
      }
      expect(started).toBe(true); child.kill('SIGTERM');
      expect(await ended).toBe(143);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, complete: false, dump: 'unverified' });
      expect(stderr).toBe('');
      expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0])).toEqual(['image', 'create', 'start', 'rm']);
    } finally { child.kill('SIGKILL'); }
  }));
});
