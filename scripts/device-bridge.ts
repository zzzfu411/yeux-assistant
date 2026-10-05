import { readFile, lstat, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { BridgeConfig } from '../packages/contracts/src/device-bridge.js';
import { runDeviceBridge } from '../apps/device-bridge/src/client.js';
import { macAudio } from '../apps/device-bridge/src/audio.js';

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 2 || args[0] !== '--config')
    throw new Error('用法：pnpm device:run --config private/device.json');
  if (process.platform !== 'darwin') throw new Error('当前 macos.audio 适配器需要在 macOS 宿主机运行。');
  const path = resolve(args[1]!),
    info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('设备配置必须是小于 4KB 的普通 JSON 文件。');
  const config = BridgeConfig.parse(JSON.parse(await readFile(path, 'utf8')));
  await chmod(path, 0o600);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let previous = '';
  console.log('设备执行器手动启动；仅处理已确认的默认输出音量操作。按 Ctrl+C 停止。');
  try {
    await runDeviceBridge(
      config,
      macAudio(),
      join(dirname(path), 'device-state', config.deviceId),
      controller.signal,
      (state) => {
        if (state !== previous)
          console.log(state === 'connected' ? '设备连接正常。' : '连接中断，等待恢复；不重放已领取的操作。');
        previous = state;
      },
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(() => {
  console.error(
    '设备执行器未能启动或继续运行。检查配置、连接有效期和 device-state 中的进程锁；诊断步骤见 docs/devices.md。',
  );
  process.exitCode = 1;
});
