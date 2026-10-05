import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createBackup } from './backup.mjs';
import { verifyBackup, validateManifest } from './backup-integrity.mjs';
const root = process.cwd(),
  name = 'yeux-audit-' + randomBytes(5).toString('hex'),
  password = randomBytes(24).toString('hex');
await mkdir(resolve('private'), { recursive: true });
const folder = await mkdtemp(resolve('private/real-e2e-'));
const processes = [];
let pool,
  started = false;
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(binary + ' failed: ' + result.stderr);
  return result.stdout.trim();
}
const stopping = new WeakMap();
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
function stopService(child) {
  if (stopping.has(child)) return stopping.get(child);
  const task = (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForExit(child, 15000)) return;
    child.kill('SIGKILL');
    if (!(await waitForExit(child, 5000))) throw new Error('Disposable service did not exit after SIGKILL');
  })();
  stopping.set(child, task);
  return task;
}
async function postgres(args, { input, output } = {}) {
  const source = input ? await open(input, 'r') : null,
    destination = output ? await open(output, 'wx', 0o600) : null;
  try {
    await new Promise((done, reject) => {
      const child = spawn('docker', ['exec', ...(input ? ['-i'] : []), name, ...args], {
        stdio: [source?.fd ?? 'ignore', destination?.fd ?? 'ignore', 'ignore'],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 120000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? done()
          : reject(
              new Error(
                timedOut ? 'Disposable PostgreSQL operation timed out' : 'Disposable PostgreSQL operation failed',
              ),
            );
      });
    });
  } finally {
    await source?.close();
    await destination?.close();
  }
}
async function fileDigest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}
async function appSnapshot(url) {
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Refusing a non-test database snapshot');
  const connection = new pg.Client({ connectionString: url });
  await connection.connect();
  try {
    await connection.query("SET TIME ZONE 'UTC'");
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = [];
    for (const { tablename } of (
      await connection.query('SELECT tablename FROM pg_tables WHERE schemaname=\'app\' ORDER BY tablename COLLATE "C"')
    ).rows) {
      const identifier = '"' + tablename.replaceAll('"', '""') + '"';
      const rows = (
        await connection.query(
          'SELECT to_jsonb(row)::text AS value FROM app.' +
            identifier +
            ' AS row ORDER BY to_jsonb(row)::text COLLATE "C"',
        )
      ).rows;
      const rowHashes = rows.map(({ value }) => createHash('sha256').update(value).digest('hex'));
      tables.push({
        table: tablename,
        count: rowHashes.length,
        sha256: createHash('sha256').update(JSON.stringify(rowHashes)).digest('hex'),
        rowHashes,
      });
    }
    const checks = (
      await connection.query(`SELECT
   (SELECT count(*)::int FROM app.goals WHERE status='completed') AS completed_goals,
   (SELECT count(*)::int FROM app.device_commands WHERE state='succeeded' AND receipt->>'source'='simulation') AS verified_device_commands,
   (SELECT count(*)::int FROM app.approvals WHERE id='restore-uncertain-approval' AND state='uncertain') AS uncertain_approvals`)
    ).rows[0];
    await connection.query('COMMIT');
    return { tables, checks };
  } finally {
    await connection.end();
  }
}
async function checkRestoredApi({ databaseUrl, dataDirectory, credentials, original, originalHash, approvalDigest }) {
  // The restored instance has its own data directory, database and loopback port.
  // Only the API entry point is spawned; queued work and approvals stay untouched.
  if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Refusing a non-test restored API');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const log = await open(resolve(folder, 'restored-api.log'), 'w', 0o600);
  const api = spawn(process.execPath, ['dist/apps/api/src/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ASSISTANT_DATA: dataDirectory,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  processes.push(api);
  let startupError;
  api.once('error', (error) => {
    startupError = error;
  });
  const url = 'http://127.0.0.1:' + port;
  try {
    let healthy = false;
    for (let n = 0; n < 80; n++) {
      if (startupError || api.exitCode !== null || api.signalCode !== null)
        throw new Error('Restored API failed to start; see its private log');
      try {
        if ((await fetch(url + '/healthz', { signal: AbortSignal.timeout(2000) })).ok) {
          healthy = true;
          break;
        }
      } catch {}
      await sleep(250);
    }
    if (!healthy) throw new Error('Restored API did not become ready');
    const anonymous = await fetch(url + '/api/v2/today/overview', { signal: AbortSignal.timeout(8000) });
    if (anonymous.status !== 401) throw new Error('Restored API allowed unauthenticated learning access');
    const login = await fetch(url + '/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(8000),
    });
    if (!login.ok) throw new Error('Restored administrator login failed');
    const loggedIn = await login.json(),
      setCookie = login.headers.get('set-cookie');
    if (loggedIn.username !== credentials.username || !setCookie || !/;\s*HttpOnly(?:;|$)/i.test(setCookie))
      throw new Error('Restored login did not return the expected administrator session');
    const cookie = setCookie.split(';')[0];
    async function get(path) {
      const response = await fetch(url + '/api/v2' + path, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Restored API read failed: ' + path);
      return response;
    }
    const auth = await (await get('/auth/session')).json();
    if (auth.username !== credentials.username) throw new Error('Restored login cookie did not authenticate');
    const overview = await (await get('/today/overview')).json();
    const goals = await (await get('/goals/list?limit=50')).json();
    const history = await (await get('/sessions/list?limit=50')).json();
    if (
      overview.goalTotal !== 2 ||
      goals.total !== 2 ||
      goals.items.length !== 2 ||
      history.total !== 3 ||
      history.items.length !== 3
    )
      throw new Error('Restored overview, goals or history are incomplete');
    const references = [];
    for (const goal of goals.items) {
      const detail = await (await get('/goals/' + encodeURIComponent(goal.id) + '/overview')).json();
      if (
        detail.goal.id !== goal.id ||
        detail.goal.status !== 'completed' ||
        detail.sessionTotal !== 1 ||
        detail.attemptTotal !== 1
      )
        throw new Error('Restored goal detail or learning evidence is incomplete');
      const session = history.items.find((item) => item.goalId === goal.id);
      if (!session) throw new Error('Restored goal session is missing from history');
      const record = await (await get('/sessions/' + encodeURIComponent(session.id))).json();
      if (
        record.session.state !== 'completed' ||
        record.attempts.length !== 1 ||
        record.attempts[0].verdict !== 'pass' ||
        !record.session.citations.length
      )
        throw new Error('Restored learning session has lost its evidence');
      for (const citation of record.session.citations) {
        const source = await (
          await get('/sources/' + encodeURIComponent(citation.sourceId) + '?version=' + citation.version)
        ).json();
        if (
          source.id !== citation.sourceId ||
          source.version !== citation.version ||
          source.digest !== citation.digest ||
          source.content.slice(citation.start, citation.end) !== citation.quote
        )
          throw new Error('Restored historic citation does not match its source version');
        references.push({
          sourceId: citation.sourceId,
          version: citation.version,
          currentVersion: source.current_version,
          sha256: createHash('sha256').update(source.content).digest('hex'),
        });
      }
    }
    if (references.filter((item) => item.version < item.currentVersion).length < 2)
      throw new Error('Restored API did not exercise historic source versions');
    const asset = Buffer.from(await (await get('/sources/restore-original-source/original?version=1')).arrayBuffer());
    if (!asset.equals(original)) throw new Error('Restored source original download differs byte-for-byte');
    const mail = await (await get('/sessions/restore-mail-session')).json();
    if (
      mail.session.state !== 'ready' ||
      mail.approvals.length !== 1 ||
      mail.approvals[0].id !== 'restore-uncertain-approval' ||
      mail.approvals[0].state !== 'uncertain' ||
      mail.approvals[0].digest !== approvalDigest
    )
      throw new Error('Restored API changed or lost the uncertain approval');
    return {
      ok: true,
      workerStarted: false,
      authenticated: true,
      anonymousStatus: anonymous.status,
      goalCount: goals.total,
      historyCount: history.total,
      referenceCount: references.length,
      references,
      original: { bytes: asset.length, sha256: originalHash },
      uncertainApprovalPreserved: true,
    };
  } finally {
    await stopService(api);
  }
}
try {
  console.log('Building the disposable real-browser test instance.');
  command('pnpm', ['build']);
  const { setAdministrator } = await import('../dist/packages/core/src/auth.js');
  const credentials = { username: 'fixture-admin', password: randomBytes(20).toString('hex') };
  await setAdministrator(folder, credentials.username, credentials.password);
  await writeFile(resolve(folder, 'test-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  command('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'yeux.assistant.test=true',
    '-e',
    'POSTGRES_PASSWORD=' + password,
    '-p',
    '127.0.0.1::5432',
    'postgres:18-bookworm',
  ]);
  started = true;
  const port = command('docker', ['port', name, '5432/tcp']).split(':').at(-1),
    base = 'postgres://postgres:' + password + '@127.0.0.1:' + port + '/';
  pool = new pg.Pool({ connectionString: base + 'postgres', connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let n = 0; n < 40; n++) {
    try {
      await pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ready) throw new Error('test DB not ready');
  await pool.query('CREATE DATABASE assistant_real_test');
  await pool.end();
  pool = undefined;
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const webPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await mkdir(folder, { recursive: true });
  const env = {
    ...process.env,
    DATABASE_URL: base + 'assistant_real_test',
    ASSISTANT_DATA: folder,
    HOST: '127.0.0.1',
    PORT: String(webPort),
  };
  for (const [entry, log] of [
    ['apps/api', 'api.log'],
    ['apps/worker', 'worker.log'],
  ]) {
    const file = await open(resolve(folder, log), 'w', 0o600);
    processes.push(
      spawn(process.execPath, ['dist/' + entry + '/src/main.js'], {
        cwd: root,
        env,
        stdio: ['ignore', file.fd, file.fd],
      }),
    );
    await file.close();
  }
  const url = 'http://127.0.0.1:' + webPort;
  let healthy = false;
  for (let n = 0; n < 80; n++) {
    try {
      if ((await fetch(url + '/healthz')).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!healthy) throw new Error('API not ready');
  const child = spawn(
    'pnpm',
    ['exec', 'playwright', 'test', 'tests/e2e/real.spec.ts', '--output', resolve(folder, 'browser-results')],
    {
      cwd: root,
      env: {
        ...env,
        PLAYWRIGHT_BASE_URL: url,
        ASSISTANT_REAL_E2E: '1',
        ASSISTANT_E2E_CREDENTIAL_FILE: resolve(folder, 'test-credentials.json'),
        ASSISTANT_E2E_TOKEN_FILE: resolve(folder, 'access-token'),
      },
      stdio: 'inherit',
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error('real browser regression failed');
  await Promise.all(processes.map(stopService));
  // Add controlled recovery fixtures after all writers have stopped. No sender is started.
  const { Store } = await import('../dist/packages/storage/src/index.js');
  const { putSource } = await import('../dist/packages/core/src/knowledge.js');
  const { digest } = await import('../dist/packages/core/src/common.js');
  const fixtureStore = new Store(base + 'assistant_real_test');
  const original = Buffer.concat([Buffer.from('%PDF-synthetic-backup-original\n'), Buffer.from([0, 255, 128, 13, 10])]);
  const originalHash = createHash('sha256').update(original).digest('hex'),
    assetKey = originalHash + '.pdf';
  const payload = {
    action: 'mail.send',
    sender: 'synthetic-sender@example.invalid',
    recipient: 'synthetic-recipient@example.invalid',
    subject: '恢复演练',
    draft: '合成待核实草稿，未发送。',
    revision: 1,
  };
  try {
    await fixtureStore.transaction(async (tx) => {
      await tx.exec(
        "INSERT INTO app.agent_credentials(id,name,token_hash,scopes,expires_at,revoked_at,daily_write_limit) VALUES('restore-revoked-agent','合成已撤销连接',$1,'[\"workspace:read\"]',now()+interval '30 days',now(),10)",
        [digest('synthetic-noncredential-restore-fixture')],
      );
      await tx.exec(
        "INSERT INTO app.sessions(id,title,kind,prompt,state,content) VALUES('restore-mail-session','恢复演练邮件','work','合成数据','ready',$1)",
        [payload.draft],
      );
      await tx.exec(
        "INSERT INTO app.approvals(id,session_id,action,digest,payload,state,message_id,error) VALUES('restore-uncertain-approval','restore-mail-session','mail.send',$1,$2,'uncertain','<restore-fixture@example.invalid>','合成未知结果，必须先核实。')",
        [digest(payload), JSON.stringify(payload)],
      );
      await putSource(tx, {
        id: 'restore-original-source',
        title: '恢复演练原件',
        content: 'backup-original-needle 合成原件提取文本',
        metadata: {
          course: 'gse',
          courseName: 'GSE',
          originPath: 'gse/synthetic/backup-original.pdf',
          originHash: originalHash,
          assetKey,
          format: 'pdf',
          extraction: 'synthetic-only',
          pages: [],
          warnings: [],
        },
      });
    });
  } finally {
    await fixtureStore.close();
  }
  await mkdir(resolve(folder, 'source-assets'), { recursive: true });
  await writeFile(resolve(folder, 'source-assets', assetKey), original, { mode: 0o600 });
  await mkdir(resolve(folder, 'receipts'), { recursive: true });
  await writeFile(
    resolve(folder, 'receipts', 'restore-uncertain.json'),
    JSON.stringify({
      approvalId: 'restore-uncertain-approval',
      state: 'uncertain',
      messageId: '<restore-fixture@example.invalid>',
      payloadDigest: digest(payload),
    }) + '\n',
    { mode: 0o600 },
  );

  const before = await appSnapshot(base + 'assistant_real_test');
  const backup = await createBackup(folder, (path) =>
    postgres(['pg_dump', '-U', 'postgres', '-d', 'assistant_real_test', '-Fc'], { output: path }),
  );
  const integrity = await verifyBackup(backup, {
    checkDump: async (path) => {
      // Fully decode using PostgreSQL 18 from the test container; SQL goes to discarded stdout.
      // No database argument is supplied and no restore SQL is executed in this check.
      await postgres(['pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--file=-'], { input: path });
      return { status: 'decoded', message: 'Disposable PostgreSQL 18 decoded the complete archive.' };
    },
  });
  await writeFile(resolve(folder, 'backup-integrity.json'), JSON.stringify(integrity, null, 2) + '\n', { mode: 0o600 });
  if (!integrity.ok || !integrity.complete)
    throw new Error('Full backup integrity check failed; see the private report');
  const manifest = validateManifest(JSON.parse(await readFile(resolve(backup, 'manifest.json'), 'utf8')));
  const restoredFolder = resolve(folder, 'restored-data');
  await mkdir(restoredFolder, { mode: 0o700 });
  const files = [];
  for (const entry of manifest.files) {
    const destination = resolve(restoredFolder, entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(resolve(backup, entry.path), destination);
    const restoredFile = await fileDigest(destination);
    if (restoredFile.bytes !== entry.bytes || restoredFile.sha256 !== entry.sha256)
      throw new Error('Restored backup file differs from its manifest');
    if (entry.path !== 'database.dump') {
      const live = await fileDigest(resolve(folder, entry.path));
      if (live.bytes !== entry.bytes || live.sha256 !== entry.sha256)
        throw new Error('Backup differs from the stopped source data directory');
    }
    files.push({ ...entry, restored: true });
  }
  command('docker', ['exec', name, 'createdb', '-U', 'postgres', 'assistant_restore_test']);
  await postgres(
    [
      'pg_restore',
      '-U',
      'postgres',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '-d',
      'assistant_restore_test',
    ],
    { input: resolve(backup, 'database.dump') },
  );
  const after = await appSnapshot(base + 'assistant_restore_test');
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Restored app tables differ from the stopped source database');
  if (
    after.checks.completed_goals !== 2 ||
    after.checks.verified_device_commands !== 2 ||
    after.checks.uncertain_approvals !== 1
  )
    throw new Error('Restored learning/device/uncertain approval records mismatch');
  // Compare the complete restore before login legitimately writes auth records.
  const restoredApi = await checkRestoredApi({
    databaseUrl: base + 'assistant_restore_test',
    dataDirectory: restoredFolder,
    credentials,
    original,
    originalHash,
    approvalDigest: digest(payload),
  });
  const afterApi = await appSnapshot(base + 'assistant_restore_test');
  const businessTables = (snapshot) =>
    snapshot.tables.filter((table) => !['auth_sessions', 'auth_limits'].includes(table.table));
  if (
    JSON.stringify(businessTables(after)) !== JSON.stringify(businessTables(afterApi)) ||
    JSON.stringify(after.checks) !== JSON.stringify(afterApi.checks)
  )
    throw new Error('Restored API smoke checks changed learning, approvals or other business records');
  restoredApi.businessTablesUnchanged = true;
  restoredApi.checkedBusinessTables = businessTables(afterApi).map((table) => table.table);
  restoredApi.apiStopped = true;
  const report = {
    ok: true,
    completedAt: new Date().toISOString(),
    backup,
    restoredFolder,
    integrity,
    before,
    after,
    files,
    restoredApi,
  };
  await writeFile(resolve(folder, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    'Full synthetic recovery verified: ' +
      after.tables.length +
      ' app tables, ' +
      after.tables.reduce((count, table) => count + table.count, 0) +
      ' rows, ' +
      files.length +
      ' manifest files; uncertain approval preserved without replay.',
  );
  console.log(
    'Restored API verified: administrator login, ' +
      restoredApi.goalCount +
      ' goals, ' +
      restoredApi.historyCount +
      ' history items, historic citations and exact original bytes; no Worker started and business records unchanged.',
  );
  console.log('Private recovery evidence: ' + resolve(folder, 'restore-report.json'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const stopped = await Promise.allSettled(processes.map(stopService));
  for (const result of stopped)
    if (result.status === 'rejected') {
      console.error(result.reason.message);
      process.exitCode = 1;
    }
  try {
    await pool?.end();
  } catch {
    process.exitCode = 1;
    console.error('Test database connection cleanup failed.');
  }
  if (started) {
    const cleanup = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    if (cleanup.error || cleanup.status !== 0) {
      process.exitCode = 1;
      console.error('Test container cleanup failed: ' + name);
    }
  }
}
