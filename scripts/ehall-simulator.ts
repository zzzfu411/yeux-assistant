import { startEhallSimulator } from './ehall-simulator-server.js';
const fixture = await startEhallSimulator();
console.log('模拟 ehall：' + fixture.origin + '；仅含合成数据，手动登录后可体验表单。按 Ctrl+C 停止。');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void fixture.close());
