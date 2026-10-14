import { execFile } from 'node:child_process';
import { AudioInput, AudioState } from '../../../packages/contracts/src/device-bridge.js';

import type { LocalDevice } from './local.js';
export type { LocalDevice } from './local.js';
export const readAudioScript =
  'set v to get volume settings\nreturn ((output volume of v) as text) & "," & ((output muted of v) as text)';
export const writeAudioScript =
  'on run argv\nset level to (item 1 of argv) as integer\nif level < 0 or level > 50 then error "invalid volume"\nset wasMuted to output muted of (get volume settings)\nset volume output volume level output muted wasMuted\nend run';
export function runAppleScript(script: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    // This module supplies both scripts; external input is a checked integer argv, never source.
    const child = execFile(
      '/usr/bin/osascript',
      ['-e', script, ...args],
      { encoding: 'utf8', maxBuffer: 4096, timeout: 4500, killSignal: 'SIGKILL' },
      (error, stdout) => {
        signal.removeEventListener('abort', stop);
        if (error || signal.aborted) reject(new Error('local device operation failed'));
        else resolve(stdout.trim());
      },
    );
    const stop = () => {
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
export function macAudio(
  run = runAppleScript,
  platform = process.platform,
): LocalDevice<unknown, { volume: number; muted: boolean }> {
  const supported = () => {
    if (platform !== 'darwin') throw new Error('此适配器需要在 macOS 宿主机运行。');
  };
  return {
    async read(signal) {
      supported();
      const value = await run(readAudioScript, [], signal);
      const match = /^(\d{1,3}),(true|false)$/.exec(value);
      if (!match) throw new Error('无法读取系统输出音量。');
      return AudioState.parse({ volume: Number(match[1]), muted: match[2] === 'true' });
    },
    async execute(input, signal) {
      supported();
      const { percent } = AudioInput.parse(input);
      await run(writeAudioScript, [String(percent)], signal);
    },
  };
}
