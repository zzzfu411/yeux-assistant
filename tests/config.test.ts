import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PgBoss } from 'pg-boss';
import type { Store, Tx } from '../packages/storage/src/index.js';
import { Settings, initializeData, config, modelFor } from '../packages/core/src/config.js';
import { Application } from '../packages/core/src/application.js';

describe('configuration snapshots and durable acknowledgements', () => {
  let folder: string, settings: Settings;
  const token = 'synthetic-token';
  const original = {
    mail_user: 'sender@example.invalid',
    mail_password: 'synthetic-mail-password',
    poll_mail: false,
    custom: { preserve: ['every', 'field'] },
    llm: {
      base_url: 'https://old.example.invalid/v1',
      model: 'old-model',
      api_key: 'synthetic-original-secret',
      tools: true,
      timeout_seconds: 150,
    },
  };
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'gse-config-'));
    await writeFile(join(folder, 'config.json'), JSON.stringify(original));
    settings = new Settings(folder, token);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });
  async function input(model = 'new-model') {
    return {
      revision: (await settings.get()).revision,
      base_url: 'https://provider.example.invalid/v1',
      model,
      api_key: '',
      tools: true,
    };
  }
  it('refuses an existing empty access token and preserves the original file', async () => {
    await writeFile(join(folder, 'access-token'), ' \n\t');
    await expect(initializeData(folder)).rejects.toThrow('访问口令为空');
    expect(await readFile(join(folder, 'access-token'), 'utf8')).toBe(' \n\t');
    await writeFile(join(folder, 'access-token'), token);
    expect(await initializeData(folder)).toBe(token);
  });
  it('generates a token only when missing and preserves it across startups', async () => {
    const created = await initializeData(folder);
    expect(created.length).toBeGreaterThanOrEqual(32);
    expect(await initializeData(folder)).toBe(created);
  });
  it('gets public content and revision from one raw snapshot', async () => {
    const raw = JSON.stringify({ ...original, llm: { ...original.llm, model: 'first-snapshot' } });
    vi.spyOn(settings, 'raw').mockImplementationOnce(async () => {
      await writeFile(
        join(folder, 'config.json'),
        JSON.stringify({ ...original, llm: { ...original.llm, model: 'changed-on-disk' } }),
      );
      return raw;
    });
    const view = await settings.get();
    expect(view.model).toBe('first-snapshot');
    expect(view.revision).toBe(settings.revision(raw));
    expect(settings.raw).toHaveBeenCalledTimes(1);
  });
  it('preserves all unrelated config and an existing secret when the new secret is blank', async () => {
    const saved = await settings.save(await input(), 'save-1');
    const value = await config(folder);
    expect(value.mail_password).toBe(original.mail_password);
    expect(value.custom).toEqual(original.custom);
    expect(value.llm.api_key).toBe(original.llm.api_key);
    expect(value.llm.timeout_seconds).toBe(150);
    expect(saved).toEqual(await settings.get());
    expect(JSON.stringify(value._assistant_config_commands)).not.toContain(original.llm.api_key);
    expect(JSON.stringify(value._assistant_config_commands)).not.toContain(original.mail_password);
    expect(saved).not.toHaveProperty('api_key');
  });
  it('keeps an optional reviewer separate, never moving its key to another service', async () => {
    const reviewer = {
      review_base_url: 'https://review.example.invalid/v1',
      review_model: 'review-model',
      review_api_key: 'synthetic-review-secret',
    };
    let view = await settings.save({ ...(await input()), ...reviewer }, 'review-1');
    expect(view).toMatchObject({ review_base_url: reviewer.review_base_url, review_model: 'review-model' });
    expect(view.has_review_api_key).toBe(true);
    expect(JSON.stringify(view)).not.toContain('synthetic-review-secret');
    // Omitted reviewer fields keep it; a blank key on the same service keeps the key.
    await settings.save(await input('another-model'), 'review-2');
    view = await settings.save(
      { ...(await input()), review_base_url: reviewer.review_base_url, review_model: 'r2' },
      'review-3',
    );
    expect((await config(folder)).llm.review).toEqual({
      base_url: reviewer.review_base_url,
      model: 'r2',
      api_key: 'synthetic-review-secret',
    });
    // Moving to another address requires entering a key again.
    await settings.save(
      { ...(await input()), review_base_url: 'https://other.example.invalid/v1', review_model: 'r3' },
      'review-4',
    );
    expect((await config(folder)).llm.review).toEqual({ base_url: 'https://other.example.invalid/v1', model: 'r3' });
    const before = await readFile(join(folder, 'config.json'), 'utf8');
    await expect(
      settings.save({ ...(await input()), review_base_url: '', review_model: 'only-name' }, 'review-5'),
    ).rejects.toThrow('评阅模型需要同时填写地址和名称');
    expect(await readFile(join(folder, 'config.json'), 'utf8')).toBe(before);
    view = await settings.save({ ...(await input()), review_base_url: '', review_model: '' }, 'review-6');
    expect((await config(folder)).llm).not.toHaveProperty('review');
    expect(view).toMatchObject({ review_base_url: '', review_model: '', has_review_api_key: false });
  });
  it('routes reviews to the reviewer and reuses the main key only on the same service', () => {
    const llm = { base_url: 'https://a.example/v1', model: 'solver', api_key: 'main', tools: true };
    expect(modelFor(llm, 'review')).toMatchObject({ model: 'solver', independent: false });
    expect(modelFor({ ...llm, review: { base_url: 'https://a.example/v1', model: 'judge' } }, 'review')).toMatchObject({
      base_url: 'https://a.example/v1',
      model: 'judge',
      api_key: 'main',
      independent: true,
      tools: true,
    });
    const other = modelFor({ ...llm, review: { base_url: 'https://b.example/v1', model: 'judge' } }, 'review');
    expect(other.api_key).toBeUndefined();
    expect(modelFor({ ...llm, review: { base_url: 'https://b.example/v1', model: 'judge' } }, 'solve').model).toBe(
      'solver',
    );
  });
  it('still reads acknowledgements stored before the reviewer existed', async () => {
    const request = await input();
    await settings.save(request, 'legacy-ack');
    const value = await config(folder);
    for (const record of Object.values(value._assistant_config_commands.records) as Array<{ response: any }>) {
      delete record.response.review_base_url;
      delete record.response.review_model;
      delete record.response.has_review_api_key;
    }
    await writeFile(join(folder, 'config.json'), JSON.stringify(value));
    const replay = await settings.save(request, 'legacy-ack');
    expect(replay.model).toBe('new-model');
    expect(replay).not.toHaveProperty('review_model');
  });
  it('recovers the same request after config rename succeeds and PostgreSQL command insert rolls back', async () => {
    // The production Application invokes Settings inside a transaction. Here the
    // PostgreSQL failure is injected only after the atomic file write completed.
    let fail = true;
    const committed = new Map<string, any>();
    const tx = {
      one: async (sql: string, values: any[]) => (sql.includes('app.commands') ? committed.get(values[0]) : undefined),
      exec: async (sql: string, values: any[] = []) => {
        if (sql.startsWith('INSERT INTO app.commands')) {
          if (fail) {
            fail = false;
            throw new Error('simulated PostgreSQL commit outage');
          }
          committed.set(values[0], { operation: values[1], digest: values[2], response: JSON.parse(values[3]) });
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Tx;
    const store = { transaction: async (work: (tx: Tx) => Promise<unknown>) => work(tx) } as unknown as Store;
    const app = new Application(store, {} as PgBoss, folder, token),
      data = await input();
    await expect(app.saveSettings('uncertain-save', data)).rejects.toThrow('PostgreSQL commit outage');
    expect(committed.size).toBe(0);
    const applied = await settings.get();
    expect(applied.model).toBe('new-model');
    expect(applied.revision).not.toBe(data.revision);
    const retried = await app.saveSettings('uncertain-save', data);
    expect(retried).toEqual(applied);
    expect(committed.size).toBe(1);
    expect(await settings.get()).toEqual(applied);
    expect(JSON.stringify(retried)).not.toContain(original.llm.api_key);
  });
  it('replays the original acknowledgement after restart without overwriting later changes', async () => {
    const firstInput = await input('first');
    const first = await settings.save(firstInput, 'first-key');
    const latest = await settings.save(await input('second'), 'second-key');
    const restarted = new Settings(folder, token);
    expect(await restarted.save(firstInput, 'first-key')).toEqual(first);
    expect(await restarted.get()).toEqual(latest);
    await expect(restarted.save({ ...firstInput, model: 'different' }, 'first-key')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('does not count internal receipts or JSON formatting as a business revision', async () => {
    await settings.save(await input(), 'one');
    const before = await settings.get(),
      value = await config(folder);
    const noOp = await settings.save(await input(), 'two');
    expect(noOp.revision).toBe(before.revision);
    const updated = await config(folder);
    expect(Object.keys(updated._assistant_config_commands.records)).toHaveLength(2);
    delete updated._assistant_config_commands;
    await writeFile(join(folder, 'config.json'), JSON.stringify(updated, null, 4));
    expect((await settings.get()).revision).toBe(before.revision);
    expect(value.llm.model).toBe('new-model');
  });
  it('rejects a stale revision from a different request and preserves both the current value and secret', async () => {
    const stale = await input();
    await settings.save({ ...stale, model: 'fresh', api_key: 'synthetic-new-secret' }, 'fresh');
    await expect(settings.save(stale, 'other-key')).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await config(folder)).llm.api_key).toBe('synthetic-new-secret');
    expect((await settings.get()).model).toBe('fresh');
  });
  it('preserves malformed internal receipts instead of silently discarding history', async () => {
    const value = { ...original, _assistant_config_commands: { unexpected: 'preserve this' } };
    await writeFile(join(folder, 'config.json'), JSON.stringify(value));
    const data = await input();
    await expect(settings.save(data, 'new-key')).rejects.toThrow('回执格式无效');
    expect(await config(folder)).toEqual(value);
  });
  it('never exposes embedded credentials in a legacy endpoint', async () => {
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({
        ...original,
        llm: { ...original.llm, base_url: 'https://user:secret@example.invalid/v1?api_key=secret' },
      }),
    );
    const publicView = await settings.get();
    expect(publicView.base_url).toBe('');
    expect(JSON.stringify(publicView)).not.toContain('secret');
  });
});
