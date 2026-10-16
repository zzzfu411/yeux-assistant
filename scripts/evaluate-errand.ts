import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { Store } from '../packages/storage/src/index.js';
import { Application } from '../packages/core/src/application.js';
import { RunSupervisor } from '../packages/core/src/runtime.js';
import { createBoss } from '../packages/core/src/queue.js';
import { openCheckpoints } from '../packages/core/src/learning.js';
import { putSource } from '../packages/core/src/knowledge.js';
import {
  cleanupEvaluation,
  pickEvaluationModel,
  validateEvaluationEnvironment,
  redactEvaluation,
} from './evaluate-learning.js';

const Case = z.object({
  id: z.string(),
  notice: z.string(),
  profile: z.string(),
  answer: z.string(),
  expect: z.object({ facts: z.array(z.string()), subjectHas: z.array(z.string()) }),
});
export function errandEvaluationArgs(args: string[]) {
  let live = false,
    file = '',
    selected = '',
    maxCalls = 8;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live' && !live) live = true;
    else if (args[i] === '--config' && !file && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i]!;
    else if (args[i] === '--case' && !selected && args[i + 1] && !args[i + 1]!.startsWith('--')) selected = args[++i]!;
    else if (args[i] === '--max-calls' && args[i + 1])
      maxCalls = z.coerce.number().int().min(1).max(10).parse(args[++i]);
    else throw new Error('用法：pnpm errand:eval [--live --config <配置路径> --case <案例 ID> --max-calls <1–10>]');
  }
  if (live && (!file || !selected)) throw new Error('真实测量需要显式指定 --live、--config 和一个 --case。');
  return { live, file, selected, maxCalls };
}
function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0)
    throw new Error('隔离测试数据库操作失败；请先手动启动 Docker。脚本不会启动虚拟机。');
  return result.stdout.trim();
}
/**
 * One notice through the real executor: extraction and plan (which asks for what the profile lacks),
 * then the owner's answer, a second plan and the letter. Every step's timing comes from the trace.
 * Synthetic data in a throwaway PostgreSQL; no mail is sent and the real database is never touched.
 */
export async function main(args = process.argv.slice(2)) {
  const options = errandEvaluationArgs(args);
  const cases = z.array(Case).parse(JSON.parse(await readFile(resolve('quality/errand-cases.json'), 'utf8')).cases);
  const selected = cases.find((item) => item.id === options.selected);
  if (options.selected && !selected)
    throw new Error('没有这个固定案例。可用：' + cases.map((item) => item.id).join(', '));
  if (!options.live) {
    console.log(
      JSON.stringify(
        { mode: 'dry-run', cases: cases.map(({ id, expect }) => ({ id, expect })), maxCalls: options.maxCalls },
        null,
        2,
      ),
    );
    return;
  }
  validateEvaluationEnvironment(process.env);
  const llm = pickEvaluationModel(JSON.parse(await readFile(resolve(options.file), 'utf8')));
  if (!llm.model || !llm.base_url || !llm.tools) throw new Error('测量需要有效模型设置及开启资料引用。');
  const name = 'yeux-errand-eval-' + randomBytes(5).toString('hex'),
    password = randomBytes(24).toString('hex');
  await mkdir('private', { recursive: true, mode: 0o700 });
  const output = await mkdtemp(resolve('private/errand-eval-')),
    folder = await mkdtemp(join(tmpdir(), 'yeux-errand-eval-'));
  let admin: pg.Pool | undefined,
    store: Store | undefined,
    boss: Awaited<ReturnType<typeof createBoss>> | undefined,
    supervisor: RunSupervisor | undefined,
    started = false;
  const oldFolder = process.env.ASSISTANT_DATA;
  try {
    await writeFile(join(folder, 'config.json'), JSON.stringify({ llm }), { mode: 0o600 });
    docker([
      'run',
      '-d',
      '--rm',
      '--pull=never',
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
    const port = docker(['port', name, '5432/tcp']).split(':').at(-1)!;
    if (!/^\d+$/.test(port)) throw new Error('隔离数据库端口无效。');
    const base = `postgres://postgres:${password}@127.0.0.1:${port}/`;
    admin = new pg.Pool({ connectionString: base + 'postgres', connectionTimeoutMillis: 1000 });
    for (let n = 0; ; n++) {
      try {
        await admin.query('SELECT 1');
        break;
      } catch {
        if (n > 40) throw new Error('测试库未就绪。');
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await admin.query('CREATE DATABASE assistant_errand_test');
    await admin.end();
    admin = undefined;
    process.env.DATABASE_URL = base + 'assistant_errand_test';
    process.env.ASSISTANT_DATA = folder;
    store = new Store();
    await store.migrate();
    boss = await createBoss();
    const saver = await openCheckpoints(process.env.DATABASE_URL, true);
    await saver.end();
    supervisor = new RunSupervisor(store);
    const app = new Application(store, boss, folder, 'isolated-evaluation');
    await store.transaction((tx) =>
      putSource(tx, {
        id: 'profile-me',
        title: '本人信息',
        content: selected!.profile,
        path: 'workspace/profile/me.md',
      }),
    );
    let spent = 0;
    const rounds: Array<Record<string, unknown>> = [];
    const runOnce = async (sessionId: string, runId: string, label: string) => {
      await store!.exec('UPDATE app.runs SET max_model_calls=least(max_model_calls,$2) WHERE id=$1', [
        runId,
        Math.max(1, options.maxCalls - spent),
      ]);
      const begun = Date.now();
      await supervisor!.handle(runId).catch(() => {});
      const wall = Date.now() - begun;
      spent += Number((await store!.one('SELECT model_calls FROM app.runs WHERE id=$1', [runId]))!.model_calls);
      const detail = await app.session(sessionId),
        trace = (await app.trace(sessionId)).runs.find((run) => run.id === runId);
      rounds.push({
        label,
        wallMs: wall,
        state: detail.session.state,
        error: detail.session.error,
        questions: detail.errand?.state.questions ?? [],
        calls: trace?.calls ?? [],
        steps: trace?.steps ?? [],
      });
      return detail;
    };
    const created = await app.addErrand(randomUUID(), { text: selected!.notice });
    let detail = await runOnce(created.sessionId, created.runId, '收到通知');
    if (detail.session.state === 'waiting_feedback' && spent < options.maxCalls) {
      const answered = await app.feedback(randomUUID(), created.sessionId, {
        revision: detail.session.revision,
        answer: selected!.answer,
      });
      detail = await runOnce(created.sessionId, answered.runId, '回答之后');
    }
    const facts = detail.errand?.state.facts,
      letter = detail.errand?.state.plan?.mail;
    const factsText = JSON.stringify(facts ?? {});
    await writeFile(
      join(output, 'report.json'),
      JSON.stringify(
        redactEvaluation(
          {
            mode: 'live',
            case: selected!.id,
            model: llm.model,
            maxCalls: options.maxCalls,
            spentCalls: spent,
            rounds,
            outcome: {
              state: detail.session.state,
              factsFound: selected!.expect.facts.filter((text) => factsText.includes(text)),
              factsMissing: selected!.expect.facts.filter((text) => !factsText.includes(text)),
              letterTo: letter?.to ?? null,
              letterSubject: letter?.subject ?? null,
              subjectChecks: selected!.expect.subjectHas.filter((text) => letter?.subject.includes(text)),
              letterLength: letter?.body.length ?? 0,
            },
            note: '时间来自运行记录；要素与主题只做字面核对，信件质量仍需本人阅读。',
          },
          [llm.api_key || '', llm.base_url],
        ),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await writeFile(join(output, 'letter.md'), letter?.body || '（没有生成信件）', { mode: 0o600 });
    console.log('测量记录已保存：' + output);
    if (detail.session.state !== 'ready') process.exitCode = 1;
  } finally {
    const cleanup = await cleanupEvaluation({
      closeStore: async () => {
        await supervisor?.stop();
        await boss?.stop();
        await store?.close();
      },
      closeAdmin: async () => {
        await admin?.end();
      },
      removeContainer: () => {
        if (started) docker(['rm', '-f', name]);
      },
      removeConfig: () => rm(folder, { recursive: true, force: true }),
    });
    if (!cleanup.ok) {
      console.error('测量清理需要处理：' + cleanup.failures.join(', '));
      process.exitCode = 1;
    }
    delete process.env.DATABASE_URL;
    if (oldFolder === undefined) delete process.env.ASSISTANT_DATA;
    else process.env.ASSISTANT_DATA = oldFolder;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('办事测量未完成：' + (error instanceof Error ? error.message : '请检查参数、Docker 与模型设置。'));
    process.exitCode = 1;
  });
}
