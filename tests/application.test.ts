import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { chunks } from '../packages/core/src/knowledge.js';
import { digest, notify } from '../packages/core/src/common.js';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('API and transactional application contracts', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, token: string;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Tests require a dedicated *_test database.');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'gse-api-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
  });
  afterAll(async () => {
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await built.server.inject({
      method: method as any,
      url: '/api/v2' + path,
      headers: { authorization: 'Bearer ' + token, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body,
    });
    return { status: response.statusCode, body: response.json() };
  };
  it('probes the saved complete endpoint and rejects an empty model answer', async () => {
    const path = join(folder, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ llm: { base_url: 'https://fixture.example/v1/chat/completions/', model: 'fixture' } }),
    );
    const mock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    try {
      expect((await call('POST', '/settings/model/test')).body.ok).toBe(true);
      expect(mock).toHaveBeenCalledWith(
        'https://fixture.example/v1/chat/completions',
        expect.objectContaining({ redirect: 'error' }),
      );
      mock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: {} }] })));
      expect((await call('POST', '/settings/model/test')).status).toBe(503);
      await writeFile(path, JSON.stringify({ llm: { base_url: 'https://fixture.example/v1', model: '' } }));
      expect((await call('GET', '/today')).body.modelConfigured).toBe(false);
    } finally {
      mock.mockRestore();
      await rm(path, { force: true });
    }
  });
  it('authenticates private APIs and validates runtime input', async () => {
    expect((await built.server.inject({ url: '/api/v2/today' })).statusCode).toBe(401);
    expect((await call('POST', '/goals', { title: '' }, 'invalid')).status).toBe(400);
    expect((await call('POST', '/goals', { title: '学习数据库' })).status).toBe(400);
    expect((await built.store.one('SELECT count(*) n FROM app.goals'))?.n).toBe('0');
  });
  it('commits the goal, session, job and idempotency result together', async () => {
    const input = { title: '理解数据库事务', outcome: '用反例解释隔离性' };
    const [a, b] = await Promise.all([
      call('POST', '/goals', input, 'goal-one'),
      call('POST', '/goals', input, 'goal-one'),
    ]);
    expect(a.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect((await built.store.one('SELECT count(*) n FROM app.goals'))?.n).toBe('1');
    expect(
      (
        await built.store.one("SELECT count(*) n FROM queue.job WHERE name='learning' AND data->>'runId'=$1", [
          a.body.runId,
        ])
      )?.n,
    ).toBe('1');
    expect((await call('POST', '/goals', { title: '完全不同的目标' }, 'goal-one')).status).toBe(409);
  });
  it('rejects obsolete edits and cancels work when the goal meaning changes', async () => {
    const original = (await call('GET', '/goals')).body[0];
    expect((await call('PATCH', '/goals/' + original.id, { revision: 99, title: '无效' }, 'old-version')).status).toBe(
      409,
    );
    const before = await built.store.one('SELECT * FROM app.sessions WHERE goal_id=$1', [original.id]);
    const result = await call(
      'PATCH',
      '/goals/' + original.id,
      { revision: original.revision, title: '理解数据库持久性' },
      'edit-goal',
    );
    expect(result.status).toBe(200);
    expect((await built.store.one('SELECT state FROM app.runs WHERE id=$1', [before!.current_run_id]))?.state).toBe(
      'cancelled',
    );
    const sessions = await built.store.rows('SELECT * FROM app.sessions WHERE goal_id=$1', [original.id]);
    expect(sessions.filter((s) => s.state === 'queued')).toHaveLength(1);
    expect(sessions.filter((s) => s.state === 'cancelled')).toHaveLength(1);
  });
  it('accepts feedback once and carries its graph cursor without claiming mastery', async () => {
    const s = (await built.store.one("SELECT * FROM app.sessions WHERE state='queued' LIMIT 1"))!;
    await built.store.exec("UPDATE app.sessions SET state='waiting_feedback',content='请解释原子性' WHERE id=$1", [
      s.id,
    ]);
    await built.store.exec("UPDATE app.runs SET state='paused' WHERE id=$1", [s.current_run_id]);
    const input = { revision: s.revision, answer: '要么全部完成，要么全部不发生。' };
    const first = await call('POST', '/sessions/' + s.id + '/feedback', input, 'answer-one');
    expect(first.status).toBe(202);
    expect((await call('POST', '/sessions/' + s.id + '/feedback', input, 'answer-one')).body).toEqual(first.body);
    const attempts = await built.store.rows('SELECT * FROM app.attempts WHERE session_id=$1', [s.id]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.verdict).toBe('pending');
    const run = await built.store.one('SELECT * FROM app.runs WHERE id=$1', [first.body.runId]);
    expect(run!.graph_thread).toBe(s.id);
    expect((await call('POST', '/sessions/' + s.id + '/feedback', input, 'answer-two')).status).toBe(409);
  });
  it.each(['completed', 'ready'])('rejects a new study answer in %s without creating facts or work', async (state) => {
    const created = await call(
        'POST',
        '/sessions',
        { prompt: '已结束的合成练习', kind: 'study' },
        'closed-study-' + state,
      ),
      sid = created.body.sessionId;
    await built.store.exec('UPDATE app.sessions SET state=$2 WHERE id=$1', [sid, state]);
    const before = await built.store.one('SELECT * FROM app.sessions WHERE id=$1', [sid]);
    const runs = await built.store.rows('SELECT * FROM app.runs WHERE session_id=$1', [sid]);
    const response = await call(
      'POST',
      '/sessions/' + sid + '/feedback',
      { revision: before!.revision, answer: '对上一题补充回答', selfReport: 'understood' },
      'closed-study-answer-' + state,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('state_conflict');
    expect(await built.store.one('SELECT * FROM app.sessions WHERE id=$1', [sid])).toEqual(before);
    expect(await built.store.rows('SELECT * FROM app.runs WHERE session_id=$1', [sid])).toEqual(runs);
    expect(await built.store.rows('SELECT * FROM app.attempts WHERE session_id=$1', [sid])).toEqual([]);
  });
  it.each(['work', 'manage'].flatMap((kind) => ['ready', 'completed'].map((state) => ({ kind, state }))))(
    'keeps $kind follow-up available in $state',
    async ({ kind, state }) => {
      const created = await call(
          'POST',
          '/sessions',
          { prompt: '合成工作草稿', kind },
          'followup-' + kind + '-' + state,
        ),
        sid = created.body.sessionId;
      await built.store.exec('UPDATE app.sessions SET state=$2 WHERE id=$1', [sid, state]);
      const response = await call(
        'POST',
        '/sessions/' + sid + '/feedback',
        { revision: 1, answer: '补充一个具体例子' },
        'followup-answer-' + kind + '-' + state,
      );
      expect(response.status).toBe(202);
      expect((await built.store.one('SELECT state FROM app.sessions WHERE id=$1', [sid]))!.state).toBe('queued');
      expect(await built.store.rows('SELECT * FROM app.attempts WHERE session_id=$1', [sid])).toHaveLength(1);
      expect(
        (await built.store.one('SELECT input FROM app.runs WHERE id=$1', [response.body.runId]))!.input,
      ).toMatchObject({ type: 'followup', freshThread: true });
    },
  );
  it('imports originals idempotently and retrieves short Chinese terms across long chunks', async () => {
    const content = '甲'.repeat(1799) + '原子性需要全部成功。' + '乙'.repeat(2100) + '持久保存证据。';
    const source = await call('POST', '/sources', { title: '事务笔记', content }, 'source-one');
    expect(source.status).toBe(200);
    expect((await call('POST', '/sources', { title: '事务笔记', content }, 'source-one')).body).toEqual(source.body);
    const results = (await call('GET', '/search?q=' + encodeURIComponent('原子'))).body;
    expect(results.some((r: any) => r.quote.includes('原子性'))).toBe(true);
    const original = (await call('GET', '/sources/' + source.body.id + '?version=1')).body;
    expect(original.content).toBe(content);
    expect((await call('GET', '/sources')).body).toHaveLength(1);
  });
  it('preserves immutable drafts, detects version conflicts and keeps legacy revision zero editable', async () => {
    const created = await call('POST', '/sessions', { prompt: '整理回复', kind: 'work' }, 'work-one');
    const sid = created.body.sessionId;
    await built.store.exec("UPDATE app.sessions SET state='ready',revision=0 WHERE id=$1", [sid]);
    expect(
      (
        await call(
          'PATCH',
          '/sessions/' + sid + '/draft',
          { revision: 0, content: '第一版', recipient: '' },
          'draft-one',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'PATCH',
          '/sessions/' + sid + '/draft',
          { revision: 0, content: '过期版', recipient: '' },
          'draft-two',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          'PATCH',
          '/sessions/' + sid + '/draft',
          { revision: 1, content: '第二版', recipient: '' },
          'draft-three',
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', '/sessions/' + sid)).body.artifacts.map((a: any) => a.content)).toEqual([
      '第一版',
      '第二版',
    ]);
  });
  it('keeps secret and unrelated configuration fields while saving model settings', async () => {
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({
        mail_password: 'test-private-password',
        poll_mail: false,
        llm: { api_key: 'test-model-secret', model: 'old' },
      }),
    );
    const old = (await call('GET', '/settings/model')).body;
    expect(JSON.stringify(old)).not.toContain('test-model-secret');
    const saved = await call(
      'PATCH',
      '/settings/model',
      { revision: old.revision, base_url: 'https://example.invalid/v1', model: 'new', api_key: '', tools: true },
      'settings-one',
    );
    expect(saved.status).toBe(200);
    const data = JSON.parse(await readFile(join(folder, 'config.json'), 'utf8'));
    expect(data.mail_password).toBe('test-private-password');
    expect(data.llm.api_key).toBe('test-model-secret');
    expect(
      (
        await call(
          'PATCH',
          '/settings/model',
          { revision: old.revision, base_url: '', model: '', tools: true },
          'settings-two',
        )
      ).status,
    ).toBe(409);
  });
  it('stores preference versions and publishes durable ordered events', async () => {
    expect(
      (
        await call(
          'POST',
          '/memories',
          { key: 'style', content: '先问一个问题', scope: 'study', revision: 0 },
          'memory-one',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          '/memories',
          { key: 'style', content: '一次给一个练习', scope: 'study', revision: 1 },
          'memory-two',
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', '/memories/style/history')).body).toHaveLength(2);
    const first = await built.app.events('0');
    expect(first.length).toBeGreaterThan(0);
    expect(await built.app.events(first.at(-1)!.id)).toEqual([]);
  });
  it('adopts an original already indexed after an interrupted file import', async () => {
    const key = 'interrupted-source',
      name = 'source-' + digest(key).slice(0, 24) + '.md',
      content = '事务提交后才向本人报告完成。';
    await writeFile(join(folder, 'documents', name), content);
    await built.app.knowledge.scan();
    const indexed = await built.store.one('SELECT id FROM app.sources WHERE path=$1', [name]);
    const imported = await call('POST', '/sources', { title: '中断后恢复', content }, key);
    expect(imported.status).toBe(200);
    expect(imported.body.id).toBe(indexed!.id);
    expect((await built.store.one('SELECT count(*) n FROM app.sources WHERE path=$1', [name]))!.n).toBe('1');
  });
  it('round-trips non-BMP characters without splitting surrogate pairs in citations', async () => {
    const content = 'X' + '😀'.repeat(1000) + '原子性' + '😀'.repeat(1000);
    const saved = await call('POST', '/sources', { title: 'Unicode 原文', content }, 'unicode-source');
    expect(saved.status).toBe(200);
    const indexed = await built.store.rows('SELECT * FROM app.chunks WHERE source_id=$1', [saved.body.id]);
    for (const chunk of indexed) {
      expect(chunk.content).toBe(content.slice(chunk.start_offset, chunk.end_offset));
      expect(chunk.content.includes('�')).toBe(false);
    }
  });
  it('uses the new goal title when its outcome is explicitly cleared', async () => {
    const created = await call(
      'POST',
      '/goals',
      { title: '新的目标', outcome: '即将清空的旧细则' },
      'clear-outcome-create',
    );
    await call('PATCH', '/goals/' + created.body.goalId, { revision: 1, outcome: '' }, 'clear-outcome-update');
    const session = await built.store.one("SELECT prompt FROM app.sessions WHERE goal_id=$1 AND state='queued'", [
      created.body.goalId,
    ]);
    expect(session!.prompt).toBe('新的目标');
  });
  it('freezes feedback while an external send is approved or uncertain', async () => {
    const created = await call('POST', '/sessions', { prompt: '准备回复', kind: 'work' }, 'freeze-create');
    const sid = created.body.sessionId;
    await built.store.exec("UPDATE app.sessions SET state='ready' WHERE id=$1", [sid]);
    await built.store.exec(
      "INSERT INTO app.approvals(id,session_id,action,digest,payload,state,message_id) VALUES('frozen',$1,'mail.send','test','{}','uncertain','test-id')",
      [sid],
    );
    const result = await call(
      'POST',
      '/sessions/' + sid + '/feedback',
      { revision: 1, answer: '替换正文' },
      'freeze-answer',
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('action_in_progress');
    expect((await built.store.one('SELECT count(*) n FROM app.attempts WHERE session_id=$1', [sid]))!.n).toBe('0');
  });
  it('indexes originals and nested course archives while preserving and excluding legacy generated archives', async () => {
    const documents = join(folder, 'documents'),
      generated = join(documents, 'archive'),
      nested = join(documents, 'notes', 'archive');
    await mkdir(join(generated, 'old-run'), { recursive: true });
    await mkdir(nested, { recursive: true });
    const files = new Map([
      [join(documents, 'original-guide.md'), Buffer.from('originalonlyzz 是本人保存的原始课程资料。\r\n', 'utf8')],
      [join(nested, 'course-history.md'), Buffer.from('coursearchiveonlyzz 是课程目录中的原始历史讲义。\n', 'utf8')],
      [
        join(generated, 'old-result.md'),
        Buffer.from('generatedonlyzz 是旧版助手生成的结论，不能提升为原始证据。\r\n', 'utf8'),
      ],
      [
        join(generated, 'old-run', 'another-result.txt'),
        Buffer.from('generatedonlyzz 包含旧版生成结果的子目录。\n', 'utf8'),
      ],
    ]);
    for (const [path, content] of files) await writeFile(path, content);
    await built.app.knowledge.scan();
    expect(
      (await call('GET', '/search?q=originalonlyzz')).body.some((item: any) => item.quote.includes('originalonlyzz')),
    ).toBe(true);
    expect(
      (await call('GET', '/search?q=coursearchiveonlyzz')).body.some((item: any) =>
        item.quote.includes('coursearchiveonlyzz'),
      ),
    ).toBe(true);
    expect((await call('GET', '/search?q=generatedonlyzz')).body).toEqual([]);
    const indexed = await built.store.rows('SELECT path FROM app.sources');
    expect(indexed.some((row) => row.path === join('notes', 'archive', 'course-history.md'))).toBe(true);
    expect(
      indexed.some(
        (row) =>
          row.path === join('archive', 'old-result.md') ||
          row.path === join('archive', 'old-run', 'another-result.txt'),
      ),
    ).toBe(false);
    for (const [path, content] of files) expect(await readFile(path)).toEqual(content);
  });
  it('links device notifications to exact historical commands without changing learning links', async () => {
    const created = await call('POST', '/devices/simulated', { name: '通知验收灯' }, 'notice-device-create');
    const command = (
      await call(
        'POST',
        '/devices/' + created.body.deviceId + '/commands',
        { revision: 1, capability: 'power.set', arguments: { power: true } },
        'notice-device-preview',
      )
    ).body;
    expect(
      (
        await call(
          'POST',
          '/device-commands/' + command.id + '/decision',
          { revision: command.revision, digest: command.digest, approve: true },
          'notice-device-approve',
        )
      ).status,
    ).toBe(200);
    await built.devices.process(command.id);
    const session = (await built.store.one('SELECT id FROM app.sessions LIMIT 1'))!;
    await built.store.transaction(async (tx) => {
      await notify(tx, 'notice-learning', session.id, '学习步骤已准备');
      await notify(tx, 'notice-general', null, '普通通知');
    });
    await built.store.exec(
      "INSERT INTO app.device_commands(id,device_id,payload,digest,summary,expires_at,state,created_at) SELECT gen_random_uuid()::text,device_id,payload,digest,summary,expires_at,'cancelled',now()+n*interval '1 millisecond' FROM app.device_commands CROSS JOIN generate_series(1,55) n WHERE id=$1",
      [command.id],
    );
    expect((await call('GET', '/device-commands')).body.some((row: any) => row.id === command.id)).toBe(false);
    const notifications = (await call('GET', '/notifications')).body.items;
    expect(notifications.find((row: any) => row.dedupe_key === 'notice-learning')).toMatchObject({
      session_id: session.id,
      deviceCommandId: null,
    });
    expect(notifications.find((row: any) => row.dedupe_key === 'notice-general')).toMatchObject({
      session_id: null,
      deviceCommandId: null,
    });
    const notice = notifications.find((row: any) => row.deviceCommandId === command.id);
    expect(notice).toMatchObject({ session_id: null, title: '演示 · 通知验收灯 · 操作已核验' });
    expect((await call('GET', '/device-commands/' + notice.deviceCommandId)).body).toMatchObject({
      id: command.id,
      state: 'succeeded',
    });
    expect((await call('GET', '/device-commands/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await built.server.inject({ url: '/api/v2/device-commands/' + command.id })).statusCode).toBe(401);
    for (const other of notifications.filter((row: any) => row.session_id)) expect(other.deviceCommandId).toBe(null);
  });
});
describe('source chunking', () => {
  it('retains the complete tail of a long paragraph', () => {
    const text = 'a'.repeat(5000) + 'boundary';
    const parts = chunks(text);
    expect(parts.at(-1)?.content.endsWith('boundary')).toBe(true);
    for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.content);
  });
});
