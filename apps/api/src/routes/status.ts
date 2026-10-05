import type { Store } from '../../../../packages/storage/src/index.js';
import { RuntimeStatus } from '../../../../packages/contracts/src/health.js';
import { readRuntimeStatus } from '../../../../packages/core/src/health.js';
import type { ApiServer } from './shared.js';
export function registerStatusRoutes(server: ApiServer, store: Store) {
  server.get('/status', { schema: { response: { 200: RuntimeStatus } } }, () => store.snapshot(readRuntimeStatus));
}
