import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BridgeCall, type BridgeConfig, type BridgeResult } from '../../../packages/contracts/src/device-bridge.js';
import { LocalNotApplied, type LocalDevice } from './local.js';
import { createHash } from 'node:crypto';
import { bridgeGrantMs, bridgeVersions } from '../../../packages/contracts/src/ehall.js';
import { BridgeResult as ResultSchema } from '../../../packages/contracts/src/device-bridge.js';

export class BridgeHttpError extends Error {
  constructor(readonly status: number) {
    super('Device connection HTTP ' + status);
  }
}
export function bridgeOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('服务地址须为纯来源地址。');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('远程设备连接需要 HTTPS；HTTP 仅用于本机回环。');
  return url.origin;
}
export async function bridgeRequest(
  config: BridgeConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(bridgeOrigin(config.server) + '/api/device/v1' + path, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BridgeHttpError(response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty device response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error('Device response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
type Request = (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;

export async function executeCall(
  input: unknown,
  config: BridgeConfig,
  driver: LocalDevice,
  journal: string,
  request: Request,
  signal: AbortSignal,
): Promise<void> {
  const call = BridgeCall.parse(input);
  if (call.deviceId !== config.deviceId || call.adapter !== config.adapter)
    throw new Error('Received an action for another device');
  const started = performance.now();
  // A lost start reply is never retried: no local action follows an uncertain grant.
  const grant = z
    .object({ remainingMs: z.number().int().min(0).max(bridgeGrantMs(call.adapter)) })
    .strict()
    .parse(await request('/calls/' + call.id + '/start', { lease: call.lease }, signal));
  const remaining = Math.floor(grant.remainingMs - (performance.now() - started) - 100);
  let result: BridgeResult = { ok: false, effect: 'not_applied' };
  if (remaining > 0 && !signal.aborted) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    let dispatched = false;
    try {
      if (call.kind === 'read') {
        const state = await driver.read(bounded, call);
        const png = await driver.evidence?.(bounded, call);
        if (png) {
          if (png.length > 2 * 1024 * 1024) throw new Error('Evidence exceeds 2 MB');
          const hash = createHash('sha256').update(png).digest('hex');
          await request(
            '/calls/' + call.id + '/evidence',
            { lease: call.lease, digest: hash, png: png.toString('base64') },
            bounded,
          );
          state.screenshotDigest = hash;
        }
        result = ResultSchema.parse({ ok: true, state });
      } else {
        await mkdir(journal, { recursive: true, mode: 0o700 });
        let marker;
        try {
          marker = await open(join(journal, call.commandId + '.json'), 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            result = { ok: false, effect: 'unknown' };
          } else throw error;
        }
        if (marker) {
          try {
            await marker.writeFile(
              JSON.stringify({ commandId: call.commandId, callId: call.id, version: call.version }) + '\n',
            );
            await marker.sync();
          } finally {
            await marker.close();
          }
          const directory = await open(journal, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          bounded.throwIfAborted();
          dispatched = true;
          await driver.execute(call.arguments, bounded, call);
          bounded.throwIfAborted();
          result = { ok: true };
        }
      }
    } catch (error) {
      result = {
        ok: false,
        effect: error instanceof LocalNotApplied ? error.effect : dispatched ? 'unknown' : 'not_applied',
      };
    }
  }
  // Retrying only the receipt is safe; the hardware operation above is never repeated.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await request('/calls/' + call.id + '/result', { lease: call.lease, result }, signal);
      return;
    } catch (error) {
      if (signal.aborted || error instanceof BridgeHttpError || attempt) throw error;
    }
  }
}

export async function runDeviceBridge(
  config: BridgeConfig,
  driver: LocalDevice,
  journal: string,
  signal: AbortSignal,
  onStatus: (state: 'connected' | 'offline') => void = () => {},
) {
  bridgeOrigin(config.server);
  await mkdir(journal, { recursive: true, mode: 0o700 });
  // A stale lock is not automatically stolen after a crash; inspect the process before removing it.
  const lockFile = join(journal, 'executor.lock'),
    lock = await open(lockFile, 'wx', 0o600);
  await lock.writeFile(String(process.pid) + '\n');
  await lock.sync();
  const request: Request = (path, body, abort) => bridgeRequest(config, path, body, abort);
  try {
    while (!signal.aborted) {
      let wait = 1000;
      try {
        const response = z
          .object({ call: BridgeCall.nullable() })
          .strict()
          .parse(await request('/poll', { adapter: config.adapter, version: bridgeVersions[config.adapter] }, signal));
        onStatus('connected');
        if (response.call) {
          await executeCall(response.call, config, driver, journal, request, signal);
          wait = 0;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof BridgeHttpError && [401, 403].includes(error.status))
          throw new Error('设备连接已到期或撤销，请在助手中重新连接。');
        onStatus('offline');
        wait = error instanceof BridgeHttpError && error.status === 429 ? 60000 : 3000;
      }
      if (wait) await delay(wait, undefined, { signal }).catch(() => {});
    }
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}
