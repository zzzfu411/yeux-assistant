import { Store } from '../../../packages/storage/src/index.js';
import { dataFolder, initializeData } from '../../../packages/core/src/config.js';
import { createBoss } from '../../../packages/core/src/queue.js';
import { startWorker } from '../../../packages/core/src/runtime.js';

const store = new Store();
await initializeData();
await store.migrate();
const boss = await createBoss(process.env.DATABASE_URL!, true);
const worker = await startWorker(store, boss, dataFolder());
console.info('学习 Worker 已启动。');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await worker.stop(); await store.close(); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
