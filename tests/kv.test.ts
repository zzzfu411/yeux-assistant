import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../packages/storage/src/index.js';
import { addValue, getValue, insertValue, putValue } from '../packages/core/src/kv.js';
import { LOCKS } from '../packages/storage/src/locks.js';

describe('fixed advisory lock keys', () => {
  it('are unique and keep their deployed numbers', () => {
    const values = Object.values(LOCKS);
    expect(new Set(values).size).toBe(values.length);
    expect(LOCKS).toMatchObject({ migrations: 847392001, workerOwnership: 847392007, workspace: 847392030 });
  });
});

const url = process.env.RUNTIME_TEST_DATABASE_URL;
describe.runIf(Boolean(url))('typed records in app.settings', () => {
  let store: Store;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Isolated runtime test DB required');
    store = new Store(url!);
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
  });
  afterAll(async () => {
    await store?.close();
  });
  it('keeps the stored formats of earlier releases readable and writable', async () => {
    // Written by earlier releases before this module existed.
    await store.exec(`INSERT INTO app.settings(key,value) VALUES
      ('mail:me@example.edu:42','"17"'),('review-index:goal-1','2'),('mail-drafts:2026-10-16','3')`);
    expect(await getValue(store, 'mail', 'me@example.edu:42')).toBe(17);
    expect(await getValue(store, 'review-index', 'goal-1')).toBe(2);
    expect(await getValue(store, 'mail-drafts', '2026-10-16')).toBe(3);
    await putValue(store, 'mail', 'me@example.edu:42', '18');
    expect((await store.one("SELECT value FROM app.settings WHERE key='mail:me@example.edu:42'"))!.value).toBe('18');
    await addValue(store, 'plan-intent', 'goal-1', 'first');
    await addValue(store, 'plan-intent', 'goal-1', 'second');
    expect(await getValue(store, 'plan-intent', 'goal-1')).toBe('first');
    const receipt = { attemptId: 'a1', verdict: 'pass', stepId: null, done: true };
    await insertValue(store, 'assessment', 'a1', receipt);
    await expect(insertValue(store, 'assessment', 'a1', receipt)).rejects.toThrow();
  });
  it('refuses to write a malformed value and stops on a corrupted record', async () => {
    await expect(putValue(store, 'mail-drafts', 'day', -1 as number)).rejects.toThrow();
    await store.exec(`INSERT INTO app.settings(key,value) VALUES ('mail:broken:1','"not a number"')`);
    await expect(getValue(store, 'mail', 'broken:1')).rejects.toMatchObject({ code: 'record_invalid' });
    expect(await getValue(store, 'mail', 'absent')).toBeUndefined();
  });
});

describe.runIf(Boolean(url))('pruning derived data', () => {
  it('removes old published events and old finished-run traces once a day, and nothing else', async () => {
    const { pruneDerived } = await import('../packages/core/src/retention.js');
    const store = new Store(url!);
    try {
      await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
      await store.migrate();
      await store.exec(`INSERT INTO app.sessions(id,title,kind,prompt) VALUES('s1','t','work','p');
        INSERT INTO app.runs(id,session_id,graph_thread,state,finished_at) VALUES
          ('old','s1','s1','succeeded',now()-interval '200 days'),('waiting','s1','s1','running',NULL);
        INSERT INTO app.model_calls(run_id,generation,profile,model) VALUES('old',1,'solve','m'),('waiting',1,'solve','m');
        INSERT INTO app.run_steps(run_id,name,output) VALUES('old','prepare','{}');
        INSERT INTO app.events(kind,stream_id,created_at) VALUES('old',1,now()-interval '40 days'),('new',2,now());
        INSERT INTO app.events(kind,created_at) VALUES('unpublished',now()-interval '40 days')`);
      expect(await pruneDerived(store)).toEqual({ events: 1, modelCalls: 1 });
      expect(await pruneDerived(store)).toBeNull();
      expect((await store.rows('SELECT kind FROM app.events ORDER BY id')).map((row) => row.kind)).toEqual([
        'new',
        'unpublished',
      ]);
      expect((await store.rows('SELECT run_id FROM app.model_calls')).map((row) => row.run_id)).toEqual(['waiting']);
      expect(await store.rows('SELECT run_id FROM app.run_steps')).toEqual([{ run_id: 'old' }]);
    } finally {
      await store.close();
    }
  });
});
