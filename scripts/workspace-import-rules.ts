import { Store } from '../packages/storage/src/index.js';
import { dataFolder, initializeData } from '../packages/core/src/config.js';
import { Rules } from '../packages/core/src/workspace/rules.js';
const args = process.argv.slice(2).filter((value) => value !== '--');
if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0]!))
  throw new Error('用法：pnpm workspace:import-rules -- --dry-run | --apply');
const store = new Store();
try {
  const apply = args[0] === '--apply';
  if (apply) await initializeData();
  console.log(JSON.stringify(await new Rules(store, dataFolder()).importExisting(apply), null, 2));
} finally {
  await store.close();
}
