import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/src/index.js';
import { digest } from '../packages/core/src/common.js';
import { migrateLegacy } from '../packages/core/src/migration.js';

export function legacyFixture(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA user_version=3; PRAGMA journal_mode=WAL;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,source_key TEXT UNIQUE,subject TEXT,notice TEXT,recipient TEXT,state TEXT,draft TEXT,packet TEXT,sources TEXT,created TEXT,error TEXT,revision INTEGER,kind TEXT,priority INTEGER,due_at REAL,updated REAL,run_no INTEGER,workflow_version INTEGER,request_digest TEXT);
    CREATE TABLE documents(path TEXT PRIMARY KEY,content TEXT,digest TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE steps(id TEXT PRIMARY KEY,task_id TEXT,run_no INTEGER,ordinal INTEGER,tool TEXT,state TEXT,output TEXT,attempts INTEGER,not_before REAL,lease_owner TEXT,lease_until REAL,started REAL,finished REAL,error TEXT,lease_token TEXT);
    CREATE TABLE inputs(id TEXT PRIMARY KEY,task_id TEXT,content TEXT,created REAL);
    CREATE TABLE events(id INTEGER PRIMARY KEY,task_id TEXT,kind TEXT,detail TEXT,created REAL);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,task_id TEXT,run_no INTEGER,title TEXT,content TEXT,provenance TEXT,created REAL);
    CREATE TABLE artifact_versions(id TEXT PRIMARY KEY,task_id TEXT,run_no INTEGER,revision INTEGER,kind TEXT,title TEXT,content TEXT,created REAL);
    CREATE TABLE memories(key TEXT PRIMARY KEY,scope TEXT,content TEXT,version INTEGER,enabled INTEGER,source_task TEXT,updated REAL);
    CREATE TABLE memory_versions(key TEXT,version INTEGER,scope TEXT,content TEXT,enabled INTEGER,source_task TEXT,created REAL,PRIMARY KEY(key,version));
    CREATE TABLE schedules(id TEXT PRIMARY KEY,title TEXT,kind TEXT,prompt TEXT,interval_seconds INTEGER,next_run REAL,enabled INTEGER,created REAL,version INTEGER);
    CREATE TABLE notifications(id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE,task_id TEXT,title TEXT,body TEXT,created REAL,read_at REAL,delivered_at REAL);
    CREATE TABLE health(name TEXT PRIMARY KEY,heartbeat REAL,last_success REAL,last_error TEXT,failures INTEGER,enabled INTEGER);
    CREATE TABLE source_errors(path TEXT PRIMARY KEY,error TEXT,updated REAL);
    CREATE TABLE mail_quarantine(identity TEXT PRIMARY KEY,raw_path TEXT,error TEXT,created REAL);
    CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,digest TEXT,payload TEXT,state TEXT,created REAL,decided REAL,finished REAL,message_id TEXT,error TEXT,action TEXT);
    CREATE TABLE commands(key TEXT PRIMARY KEY,kind TEXT,digest TEXT,result TEXT,created REAL);
    INSERT INTO tasks VALUES('task-1','manual:1','学习需求','原始输入不能丢失','receiver@example.invalid','ready','原始草稿','带出处的材料','[]','2026-09-18T12:34:56.123456+00:00','',0,'work',1,NULL,1789734896.123456,1,1,'hash');
    INSERT INTO inputs VALUES('input-1','task-1','用户后续纠正',1789734897);
    INSERT INTO artifacts VALUES('artifact-1','task-1',1,'输出标题','原始生成内容','generated',1789734898);
    INSERT INTO artifact_versions VALUES('version-1','task-1',1,0,'draft','修订标题','本人修改内容',1789734899);
    INSERT INTO memories VALUES('规则','all','逐步讲解',2,1,'task-1',1789734900);
    INSERT INTO memory_versions VALUES('规则',1,'all','先给提示',1,'task-1',1789734890),('规则',2,'all','逐步讲解',1,'task-1',1789734900);
    INSERT INTO schedules VALUES('schedule-1','复盘','study','总结错题',86400,1790000000,1,1789734800,3);
    INSERT INTO notifications VALUES('notification-1','n1','task-1','需要反馈','继续学习',1789734901,NULL,NULL);
    INSERT INTO settings VALUES('mail:sender@example.invalid:100','42');
    INSERT INTO events VALUES(7,'task-1','created','{"kind":"work"}',1789734896);
    INSERT INTO steps VALUES('step-1','task-1',1,0,'recall','done','{"original":true}',1,0,NULL,NULL,1789734896,1789734897,'',NULL);
    INSERT INTO health VALUES('worker',1789734900,1789734900,'',0,1);
    INSERT INTO source_errors VALUES('bad.txt','不是 UTF-8',1789734900);
    INSERT INTO mail_quarantine VALUES('mail:bad:1','mail-quarantine/example.eml','无效邮件',1789734900);
    INSERT INTO commands VALUES('request-1','create','digest','{"task_id":"task-1"}',1789734896);
  `);
  const content = '原始资料\n' + '学习'.repeat(1500) + '\n尾部关键证据';
  db.prepare('INSERT INTO documents VALUES(?,?,?)').run('chapter.md', content, digest(content));
  const payload = {
    action: 'mail.send',
    task_id: 'task-1',
    revision: 0,
    subject: '学习需求',
    recipient: 'receiver@example.invalid',
    sender: 'sender@example.invalid',
    draft: '原始草稿',
  };
  db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'approval-1',
    'task-1',
    digest(payload),
    JSON.stringify(payload),
    'approved',
    1789734900,
    1789734901,
    null,
    '<test@example.invalid>',
    '',
    'mail.send',
  );
  return db;
}

const url = process.env.MIGRATION_TEST_DATABASE_URL;
describe.skipIf(!url)('SQLite v3 → PostgreSQL preservation', () => {
  let store: Store, folder: string, source: string, sqlite: DatabaseSync | undefined;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Only a disposable *_test database is allowed');
    store = new Store(url);
  });
  afterAll(async () => {
    await store?.close();
  });
  beforeEach(async () => {
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    folder = await mkdtemp(join(tmpdir(), 'gse-migration-'));
    source = join(folder, 'assistant.sqlite3');
    sqlite = legacyFixture(source);
    await writeFile(join(folder, 'config.json'), '{"llm":{"api_key":"synthetic-only"}}');
    await writeFile(join(folder, 'access-token'), 'synthetic-token');
  });
  afterEach(async () => {
    sqlite?.close();
    sqlite = undefined;
    await rm(folder, { recursive: true, force: true });
  });
  it('dry-run uses online backup, preserves WAL rows, and leaves the target empty', async () => {
    sqlite!.prepare('INSERT INTO inputs VALUES(?,?,?,?)').run('input-wal', 'task-1', '刚提交的 WAL 数据', 1789734999);
    const before = sqlite!.prepare('SELECT * FROM tasks').all();
    const report = await migrateLegacy(undefined, source, folder);
    expect(report.state).toBe('ready');
    expect(report.counts.inputs).toBe(2);
    expect(Object.keys(report.counts)).toHaveLength(17);
    expect(sqlite!.prepare('SELECT * FROM tasks').all()).toEqual(before);
    expect((await stat(report.snapshot)).mode & 0o777).toBe(0o400);
    expect((await store.one('SELECT count(*) n FROM app.sessions'))?.n).toBe('0');
    const backup = new DatabaseSync(report.snapshot, { readOnly: true });
    expect(backup.prepare('SELECT * FROM inputs').all()).toHaveLength(2);
    backup.close();
    expect(await readFile(join(report.snapshot, '..', 'access-token'), 'utf8')).toBe('synthetic-token');
  });
  it('imports every raw row and all active content, versions, IDs and relationships', async () => {
    const report = await migrateLegacy(store, source, folder, true);
    expect(report.state).toBe('imported');
    expect(report.verifiedRows).toBe(Object.values(report.counts).reduce((sum, n) => sum + n, 0));
    const session = await store.one('SELECT * FROM app.sessions WHERE id=$1', ['task-1']);
    expect(session).toMatchObject({
      goal_id: null,
      prompt: '原始输入不能丢失',
      content: '原始草稿',
      revision: 0,
      state: 'ready',
    });
    expect((await store.one('SELECT count(*) n FROM app.goals'))?.n).toBe('0');
    expect((await store.one('SELECT * FROM app.approvals WHERE id=$1', ['approval-1']))?.state).toBe('invalidated');
    expect((await store.one('SELECT * FROM app.schedules WHERE id=$1', ['schedule-1']))?.version).toBe(3);
    expect((await store.one("SELECT value FROM app.settings WHERE key='mail:sender@example.invalid:100'"))?.value).toBe(
      '42',
    );
    expect(
      (await store.one("SELECT snapshot FROM app.memory_versions WHERE key='规则' AND version=1"))?.snapshot.content,
    ).toBe('先给提示');
    const originals = sqlite!.prepare('SELECT * FROM documents').all() as any[];
    expect((await store.one('SELECT content FROM app.source_versions'))?.content).toBe(originals[0].content);
    for (const row of await store.rows('SELECT * FROM app.legacy_rows')) expect(digest(row.payload)).toBe(row.digest);
    expect((await store.one("SELECT payload FROM app.legacy_rows WHERE table_name='tasks'"))?.payload.created).toBe(
      '2026-09-18T12:34:56.123456+00:00',
    );
    const replay = await migrateLegacy(store, source, folder, true);
    expect(replay.state).toBe('already-imported');
    expect(replay.sourceDigest).toBe(report.sourceDigest);
  });
  it('refuses a nonempty destination and preserves unrelated data', async () => {
    await store.exec(
      "INSERT INTO app.sessions(id,title,kind,prompt,state) VALUES('existing','Keep','study','Keep me','ready')",
    );
    await expect(migrateLegacy(store, source, folder, true)).rejects.toThrow('已有业务数据');
    expect((await store.one('SELECT count(*) n FROM app.legacy_rows'))?.n).toBe('0');
    expect((await store.one('SELECT id FROM app.sessions'))?.id).toBe('existing');
  });
  it('blocks running tasks, unrecognized tables and mismatched original digests', async () => {
    sqlite!.exec(
      "UPDATE tasks SET state='running'; CREATE TABLE surprise(id TEXT PRIMARY KEY); UPDATE documents SET digest='bad'",
    );
    const report = await migrateLegacy(undefined, source, folder);
    expect(report.state).toBe('blocked');
    expect(report.blockers.join(' ')).toContain('running');
    expect(report.blockers.join(' ')).toContain('surprise');
    expect(report.blockers.join(' ')).toContain('原始摘要');
    await expect(migrateLegacy(store, source, folder, true)).rejects.toThrow('迁移检查未通过');
    expect((await store.one('SELECT count(*) n FROM app.legacy_rows'))?.n).toBe('0');
  });
  it('rolls back the complete import if any business row cannot map', async () => {
    await store.exec("ALTER TABLE app.artifacts ADD CONSTRAINT injected_test_failure CHECK(content<>'本人修改内容')");
    await expect(migrateLegacy(store, source, folder, true)).rejects.toThrow();
    expect((await store.one('SELECT count(*) n FROM app.sessions'))?.n).toBe('0');
    expect((await store.one('SELECT count(*) n FROM app.legacy_rows'))?.n).toBe('0');
  });
  it('dry-run catches invalid mapped timestamps before any apply is attempted', async () => {
    sqlite!.exec("UPDATE artifact_versions SET created='not-a-date'");
    const report = await migrateLegacy(undefined, source, folder);
    expect(report.state).toBe('blocked');
    expect(report.blockers.join(' ')).toContain('无法转换的时间');
  });
  it('preserves an old uncertain send as a gate without inventing sent contents', async () => {
    sqlite!.exec("UPDATE tasks SET state='uncertain'; DELETE FROM approvals");
    await migrateLegacy(store, source, folder, true);
    const approval = await store.one('SELECT * FROM app.approvals');
    expect(approval?.state).toBe('uncertain');
    expect(approval?.payload.unverified).toBe(true);
    expect(approval?.payload.draft).toBeUndefined();
    expect((await store.one('SELECT count(*) n FROM app.artifacts'))?.n).toBe('2');
  });
  it('maps only verified original citations and translates Python code-point offsets', async () => {
    const content = '😀开头\n这是可核对的原文结论';
    const quote = '这是可核对的原文结论',
      start = content.indexOf(quote);
    sqlite!.prepare('UPDATE documents SET content=?,digest=?').run(content, digest(content));
    const references = [
      {
        path: 'documents/chapter.md',
        provenance: 'source',
        offset: Array.from(content.slice(0, start)).length,
        text: quote,
        digest: digest(content),
      },
      { path: 'documents/chapter.md', provenance: 'source', offset: 0, text: '旧版原文', digest: 'old-version' },
    ];
    sqlite!.prepare('UPDATE tasks SET sources=?').run(JSON.stringify(references));
    const report = await migrateLegacy(store, source, folder, true);
    expect(report.warnings.join(' ')).toContain('1 条无法对照');
    const citations = (await store.one('SELECT citations FROM app.sessions'))?.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ start, end: content.length, quote });
    expect((await store.one("SELECT payload FROM app.legacy_rows WHERE table_name='tasks'"))?.payload.sources).toBe(
      JSON.stringify(references),
    );
  });
  it('recovers a missing offset only from the complete quote uniquely matching a verified source', async () => {
    const content = '😀介绍\n唯一的完整引用内容\n其他文字',
      quote = '唯一的完整引用内容';
    sqlite!.prepare('UPDATE documents SET content=?,digest=?').run(content, digest(content));
    const valid = { path: 'documents/chapter.md', line: 2, text: quote, digest: digest(content), provenance: 'source' };
    const references = [
      valid,
      { ...valid, digest: 'unverified' },
      { path: valid.path, line: 2, text: quote },
      { ...valid, text: '原文中没有这段内容' },
    ];
    sqlite!.prepare('UPDATE tasks SET sources=?').run(JSON.stringify(references));
    const report = await migrateLegacy(store, source, folder, true);
    const citations = (await store.one('SELECT citations FROM app.sessions'))?.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      start: content.indexOf(quote),
      end: content.indexOf(quote) + quote.length,
      quote,
      digest: digest(content),
    });
    expect(report.warnings.join(' ')).toContain('3 条无法对照');
    expect((await store.one("SELECT payload FROM app.legacy_rows WHERE table_name='tasks'"))?.payload.sources).toBe(
      JSON.stringify(references),
    );
  });
  it('rejects ambiguous missing offsets including overlapping matches, while honoring a valid explicit offset', async () => {
    const content = '😀重复内容\n重复内容\naaaa',
      quote = '重复内容';
    sqlite!.prepare('UPDATE documents SET content=?,digest=?').run(content, digest(content));
    const common = { path: 'documents/chapter.md', digest: digest(content), provenance: 'source' };
    const second = content.lastIndexOf(quote),
      offset = Array.from(content.slice(0, second)).length;
    const references = [
      { ...common, line: 1, text: quote },
      { ...common, text: 'aa' },
      { ...common, text: quote, offset },
      { ...common, text: quote, offset: 0 },
    ];
    sqlite!.prepare('UPDATE tasks SET sources=?').run(JSON.stringify(references));
    const report = await migrateLegacy(store, source, folder, true),
      citations = (await store.one('SELECT citations FROM app.sessions'))?.citations;
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ start: second, end: second + quote.length, quote });
    expect(report.warnings.join(' ')).toContain('3 条无法对照');
  });
  it('detects corruption of retained raw rows on an idempotent re-import', async () => {
    await migrateLegacy(store, source, folder, true);
    await store.exec("UPDATE app.legacy_rows SET payload='{}' WHERE table_name='inputs'");
    await expect(migrateLegacy(store, source, folder, true)).rejects.toThrow('摘要核对失败');
  });
});
