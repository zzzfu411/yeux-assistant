import { Store } from '../packages/storage/src/index.js';
const store = new Store();
try {
  await store.migrate();
  console.log('业务数据库迁移完成。');
} finally {
  await store.close();
}
