import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Operational modules execute directly in Node.
import { diagnose } from '../scripts/doctor-diagnostics.mjs';

async function fixture(check: (root: string, folder: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-doctor-')),
    folder = join(root, 'private');
  try {
    await mkdir(folder);
    await writeFile(join(root, 'compose.yaml'), 'synthetic compose');
    await writeFile(join(folder, 'runtime.env'), 'POSTGRES_PASSWORD=synthetic-database-secret\n');
    await writeFile(join(folder, 'access-token'), 'synthetic-bearer-secret');
    await writeFile(
      join(folder, 'admin-auth.json'),
      JSON.stringify({ username: 'synthetic-account-private', salt: 'a'.repeat(32), hash: 'b'.repeat(128) }),
    );
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({
        llm: { base_url: 'https://model.invalid/v1', model: 'synthetic-model', api_key: 'synthetic-model-secret' },
      }),
    );
    await check(root, folder);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const successful = { status: 0, stdout: '' };
function dockerFixture(
  root: string,
  folder: string,
  calls: any[],
  options: { occupied?: boolean; foreignRoot?: boolean; foreignData?: boolean } = {},
) {
  return (binary: string, args: string[], runOptions: any) => {
    calls.push({ binary, args, options: runOptions });
    if (args[0] === 'ps') return { status: 0, stdout: options.occupied ? 'a'.repeat(12) : '' };
    if (args[0] === 'inspect')
      return {
        status: 0,
        stdout: JSON.stringify({
          labels: {
            'com.docker.compose.project.working_dir': options.foreignRoot ? '/other-project' : root,
            'com.docker.compose.project.config_files': join(root, 'compose.yaml'),
          },
          mounts: [{ Type: 'bind', Source: options.foreignData ? '/other-data' : folder, Destination: '/app/private' }],
          ports: { '8765/tcp': [{ HostIp: '0.0.0.0', HostPort: '8765' }] },
          state: 'running',
        }),
      };
    return successful;
  };
}
describe('read-only startup diagnosis', () => {
  it('recognizes its own running instance without exposing credentials or modifying files', async () =>
    fixture(async (root, folder) => {
      const calls: any[] = [],
        files = await readdir(folder),
        before = await Promise.all(files.map((file) => readFile(join(folder, file), 'utf8')));
      const report = await diagnose({
        root,
        folder,
        env: {},
        nodeVersion: '24.0.0',
        run: dockerFixture(root, folder, calls, { occupied: true }),
        probePort: async () => 'occupied',
      });
      expect(report.ok).toBe(true);
      expect(report.checks.every((check: any) => check.status === 'ok')).toBe(true);
      expect(report.checks.find((check: any) => check.id === 'port').message).toContain('本项目');
      expect(JSON.stringify(report)).not.toContain('synthetic-');
      expect(await readdir(folder)).toEqual(files);
      expect(await Promise.all(files.map((file) => readFile(join(folder, file), 'utf8')))).toEqual(before);
      expect(calls.every((call) => call.binary === 'docker')).toBe(true);
      expect(calls.map((call) => call.args[0])).toEqual(['--version', 'compose', 'info', 'ps', 'inspect', 'compose']);
      expect(
        calls.some(
          (call) =>
            call.args.includes('up') ||
            call.args.includes('down') ||
            call.args.includes('start') ||
            call.args.includes('stop'),
        ),
      ).toBe(false);
    }));
  it.each(['foreignRoot', 'foreignData'])(
    'detects same-project collisions by %s and refuses to call the occupied port its own',
    async (conflict) =>
      fixture(async (root, folder) => {
        const report = await diagnose({
          root,
          folder,
          env: {},
          nodeVersion: '24.0.0',
          run: dockerFixture(root, folder, [], { occupied: true, [conflict]: true }),
          probePort: async () => 'occupied',
        });
        expect(report.ok).toBe(false);
        expect(report.checks.find((check: any) => check.id === 'instance').status).toBe('error');
        expect(report.checks.find((check: any) => check.id === 'port').status).toBe('error');
      }),
  );
  it('reports fresh setup steps without generating credentials or starting Docker', async () =>
    fixture(async (root, folder) => {
      for (const file of await readdir(folder)) await rm(join(folder, file));
      const calls: any[] = [];
      const report = await diagnose({
        root,
        folder,
        env: {},
        nodeVersion: '22.0.0',
        run: dockerFixture(root, folder, calls),
        probePort: async () => 'free',
      });
      expect(report.ok).toBe(true);
      expect(report.checks.filter((check: any) => check.status === 'warning').map((check: any) => check.id)).toEqual([
        'node',
        'runtime',
        'administrator',
        'access_token',
        'model_config',
      ]);
      expect(await readdir(folder)).toEqual([]);
      expect(calls.some((call) => call.args.includes('config'))).toBe(false);
    }));
  it('redacts corrupt config, command failures and blocks unconfirmed legacy data', async () =>
    fixture(async (root, folder) => {
      await writeFile(join(folder, 'config.json'), '{"api_key":"do-not-output-secret"');
      await writeFile(join(folder, 'admin-auth.json'), '{"username":"do-not-output-account"}');
      await writeFile(join(folder, 'assistant.sqlite3'), 'synthetic old data');
      const report = await diagnose({
        root,
        folder,
        env: {},
        nodeVersion: '24.0.0',
        run: () => ({ status: 1, stderr: 'do-not-output-secret' }),
        probePort: async () => 'free',
      });
      expect(report.ok).toBe(false);
      expect(report.checks.filter((check: any) => check.status === 'error').map((check: any) => check.id)).toEqual([
        'administrator',
        'model_config',
        'legacy_data',
        'docker_client',
      ]);
      expect(JSON.stringify(report)).not.toContain('do-not-output');
    }));
  it.each([{ ASSISTANT_PORT: '123abc' }, { ASSISTANT_BIND: '203.0.113.100' }])(
    'does not probe an invalid port or remote listening address',
    async (env) =>
      fixture(async (root, folder) => {
        let probes = 0;
        const report = await diagnose({
          root,
          folder,
          env,
          nodeVersion: '24.0.0',
          run: dockerFixture(root, folder, []),
          localAddresses: [],
          probePort: async () => {
            probes++;
            return 'free';
          },
        });
        expect(probes).toBe(0);
        expect(report.checks.find((check: any) => check.id === 'port').status).toBe('error');
      }),
  );
  it('does not treat a foreign occupied port or an unreadable instance as healthy', async () =>
    fixture(async (root, folder) => {
      const report = await diagnose({
        root,
        folder,
        env: {},
        nodeVersion: '24.0.0',
        run: dockerFixture(root, folder, []),
        probePort: async () => 'occupied',
      });
      expect(report.ok).toBe(false);
      expect(report.checks.find((check: any) => check.id === 'port').status).toBe('error');
      const unreadable = await diagnose({
        root,
        folder,
        env: {},
        nodeVersion: '24.0.0',
        run: (binary: string, args: string[], options: any) =>
          args[0] === 'inspect'
            ? { status: 0, stdout: 'invalid-secret' }
            : dockerFixture(root, folder, [], { occupied: true })(binary, args, options),
        probePort: async () => 'occupied',
      });
      expect(unreadable.checks.find((check: any) => check.id === 'instance').status).toBe('error');
      expect(unreadable.checks.find((check: any) => check.id === 'port').status).toBe('error');
      expect(JSON.stringify(unreadable)).not.toContain('invalid-secret');
    }));
});
