import { Store } from '../../../packages/storage/src/index.js';
import { dataFolder } from '../../../packages/core/src/config.js';
import { executeLearningRun, openCheckpoints } from '../../../packages/core/src/learning.js';
import { AppError } from '../../../packages/core/src/common.js';
import { publicRuntimeError, RuntimeLimit, StaleRun } from '../../../packages/core/src/runtime-state.js';

// A dead supervisor must not leave orphaned model requests or checkpoint writers.
if (!process.send || !process.connected) process.exit(70);
const parent = process.ppid;
process.once('disconnect', () => process.exit(70));
const watchdog = setInterval(() => { if (process.ppid !== parent || !process.connected) process.exit(70); }, 500);
const store = new Store(), saver = await openCheckpoints(process.env.DATABASE_URL!);
let result: { ok: boolean; error?: string; permanent?: boolean };
try {
  const runId = process.argv[2]!, generation = Number(process.argv[3]);
  if (!runId || !Number.isInteger(generation)) throw new AppError('执行参数无效。');
  await executeLearningRun(store, dataFolder(), { runId, generation }, saver);
  result = { ok: true };
} catch (error) {
  result = { ok: false, error: publicRuntimeError(error), permanent: error instanceof RuntimeLimit || error instanceof StaleRun || (error instanceof AppError && error.status < 500) };
} finally {
  clearInterval(watchdog);
  await Promise.allSettled([saver.end(), store.close()]);
}
await new Promise<void>(resolve => { if (process.connected) process.send!(result, () => resolve()); else resolve(); });
process.exit(result.ok ? 0 : 1);
