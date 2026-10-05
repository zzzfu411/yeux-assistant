import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const execute = (folder: string, command: string) =>
  spawnSync(process.execPath, [resolve('scripts/server-control.mjs'), command], {
    env: { ...process.env, ASSISTANT_SERVER_DATA_DIR: folder },
    encoding: 'utf8',
  });
describe('independent server initialization', () => {
  it('creates private configuration once, with a non-root owner and no personal data or credentials in output', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'yeux-server-test-'));
    try {
      const first = execute(folder, 'init');
      expect(first.status).toBe(0);
      const before = await readFile(join(folder, 'runtime.env'), 'utf8'),
        config = parseEnv(before);
      expect(config.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
      expect(config.ASSISTANT_UID).not.toBe('0');
      expect(config.ASSISTANT_PUBLIC_ORIGIN).toBe('http://127.0.0.1:8765');
      expect(first.stdout + first.stderr).not.toContain(config.POSTGRES_PASSWORD);
      expect(execute(folder, 'init').status).toBe(0);
      expect(await readFile(join(folder, 'runtime.env'), 'utf8')).toBe(before);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('preserves a nonempty legacy folder and refuses to initialize it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'yeux-server-test-'));
    try {
      await writeFile(join(folder, 'config.json'), 'synthetic-private-data');
      const result = execute(folder, 'init');
      expect(result.status).toBe(1);
      expect(await readFile(join(folder, 'config.json'), 'utf8')).toBe('synthetic-private-data');
      await expect(readFile(join(folder, 'runtime.env'))).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('rejects exposed HTTP, zero UID and inconsistent ports before invoking Docker', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'yeux-server-test-'));
    try {
      expect(execute(folder, 'init').status).toBe(0);
      const path = join(folder, 'runtime.env'),
        valid = await readFile(path, 'utf8');
      for (const text of [
        valid.replace('http://127.0.0.1:8765', 'http://public.invalid:8765'),
        valid.replace(/ASSISTANT_UID=\d+/, 'ASSISTANT_UID=0'),
        valid.replace('ASSISTANT_PORT=8765', 'ASSISTANT_PORT=9000'),
      ]) {
        await writeFile(path, text);
        const result = execute(folder, 'check');
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain('Docker');
        expect(result.stdout + result.stderr).not.toContain(parseEnv(valid).POSTGRES_PASSWORD);
        expect(await readFile(path, 'utf8')).toBe(text);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
