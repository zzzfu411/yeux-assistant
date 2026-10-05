import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { bridgeOrigin, executeCall } from '../apps/device-bridge/src/client.js';
import { macAudio, readAudioScript, writeAudioScript } from '../apps/device-bridge/src/audio.js';

describe('local device executor without real hardware', () => {
  const config = {
    server: 'https://assistant.example',
    deviceId: randomUUID(),
    adapter: 'macos.audio' as const,
    token: 'yeux_device_' + '0'.repeat(64),
  };
  const call = () => ({
    id: randomUUID(),
    lease: randomUUID(),
    deviceId: config.deviceId,
    commandId: randomUUID(),
    adapter: 'macos.audio',
    version: '1',
    kind: 'execute',
    capability: 'audio.volume.set',
    arguments: { percent: 25 },
  });
  it('permits HTTPS or explicit loopback and rejects credential-bearing or arbitrary URL routes', () => {
    expect(bridgeOrigin('https://example.test:443/')).toBe('https://example.test');
    expect(bridgeOrigin('http://127.0.0.1:8766')).toBe('http://127.0.0.1:8766');
    for (const value of [
      'http://192.168.1.2',
      'http://example.test',
      'https://user:pass@example.test',
      'https://example.test/path',
      'https://example.test?secret=x',
      'file:///tmp/anything',
    ])
      expect(() => bridgeOrigin(value)).toThrow();
  });
  it('dispatches only fixed AppleScript source with checked numeric argv and validates readback', async () => {
    const calls: any[] = [],
      driver = macAudio(async (...args) => {
        calls.push(args);
        return '25,true';
      }, 'darwin');
    expect(await driver.read(new AbortController().signal)).toEqual({ volume: 25, muted: true });
    await driver.execute({ percent: 25 }, new AbortController().signal);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      [readAudioScript, []],
      [writeAudioScript, ['25']],
    ]);
    await expect(driver.execute({ percent: '25; something' }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toHaveLength(2);
    await expect(macAudio(async () => '101,false', 'darwin').read(new AbortController().signal)).rejects.toThrow();
    await expect(macAudio(async () => '0,false', 'linux').read(new AbortController().signal)).rejects.toThrow();
  });
  it('persists the write marker before dispatch and refuses the same command after restart or receipt loss', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'device-ledger-')),
      action = call();
    let writes = 0,
      replies = 0;
    const results: any[] = [];
    const driver = {
      read: async () => ({ volume: 25, muted: false }),
      execute: async () => {
        expect(JSON.parse(await readFile(join(folder, action.commandId + '.json'), 'utf8')).commandId).toBe(
          action.commandId,
        );
        writes++;
      },
    };
    const request = async (path: string, body: any) => {
      if (path.endsWith('/start')) return { remainingMs: 5000 };
      results.push(body.result);
      if (++replies === 1) throw new Error('response lost');
      return { ok: true };
    };
    try {
      await executeCall(action, config, driver, folder, request, new AbortController().signal);
      await executeCall(
        { ...action, id: randomUUID(), lease: randomUUID() },
        config,
        driver,
        folder,
        request,
        new AbortController().signal,
      );
      expect(writes).toBe(1);
      expect(results).toEqual([{ ok: true }, { ok: true }, { ok: false, effect: 'unknown' }]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('does not execute on an expired/lost grant, wrong device, or invalid payload', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'device-denial-'));
    let writes = 0;
    const driver = {
      read: async () => ({ volume: 0, muted: true }),
      execute: async () => {
        writes++;
      },
    };
    try {
      await executeCall(call(), config, driver, folder, async () => ({ remainingMs: 0 }), new AbortController().signal);
      await expect(
        executeCall(
          call(),
          config,
          driver,
          folder,
          async () => {
            throw new Error('lost start reply');
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await expect(
        executeCall(
          { ...call(), deviceId: randomUUID() },
          config,
          driver,
          folder,
          async () => ({ remainingMs: 5000 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await expect(
        executeCall(
          { ...call(), arguments: { percent: 99 } },
          config,
          driver,
          folder,
          async () => ({ remainingMs: 5000 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(writes).toBe(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
