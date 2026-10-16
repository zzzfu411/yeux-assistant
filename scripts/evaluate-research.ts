import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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
import { digest } from '../packages/core/src/common.js';
import { bestCandidate } from '../packages/core/src/research/engine.js';
import { Effort, RESEARCH_BUDGETS, RUBRIC } from '../packages/contracts/src/research.js';
import {
  cleanupEvaluation,
  pickEvaluationModel,
  validateEvaluationEnvironment,
  redactEvaluation,
} from './evaluate-learning.js';

const Case = z.object({
  id: z.string(),
  question: z.string(),
  materials: z.array(z.object({ title: z.string(), text: z.string() })),
  markers: z.array(z.string()),
  rubric: z.string(),
});
export function researchEvaluationArgs(args: string[]) {
  let live = false,
    file = '',
    selected = '';
  const efforts: Array<import('../packages/contracts/src/research.js').Effort> = [];
  let maxCalls = 13;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live' && !live) live = true;
    else if (args[i] === '--config' && !file && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i]!;
    else if (args[i] === '--case' && !selected && args[i + 1] && !args[i + 1]!.startsWith('--')) selected = args[++i]!;
    else if (args[i] === '--effort' && args[i + 1]) efforts.push(Effort.parse(args[++i]));
    else if (args[i] === '--max-calls' && args[i + 1])
      maxCalls = z.coerce.number().int().min(1).max(13).parse(args[++i]);
    else throw new Error('用法：pnpm research:eval [--live --config <配置路径> --case <案例 ID>]');
  }
  if (live && (!file || !selected))
    throw new Error('真实评测需要显式指定 --live、--config 和一个 --case；最多 13 次模型调用。');
  if (new Set(efforts).size !== efforts.length) throw new Error('投入档位不能重复。');
  return { live, file, selected, efforts, maxCalls };
}
export function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let n = result.length - 1; n > 0; n--) {
    const i = randomInt(n + 1);
    [result[n], result[i]] = [result[i]!, result[n]!];
  }
  return result;
}
function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0)
    throw new Error('隔离测试数据库操作失败；请先手动启动 Docker。脚本不会启动虚拟机。');
  return result.stdout.trim();
}
export async function main(args = process.argv.slice(2)) {
  const options = researchEvaluationArgs(args);
  const cases = z.array(Case).parse(JSON.parse(await readFile(resolve('quality/research-cases.json'), 'utf8')));
  const selected = cases.find((item) => item.id === options.selected);
  if (options.selected && !selected)
    throw new Error('没有这个固定案例。可用：' + cases.map((item) => item.id).join(', '));
  if (!options.live) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          cases: cases.map(({ id, question, rubric }) => ({ id, question, rubric })),
          budgets: RESEARCH_BUDGETS,
          rubric: RUBRIC,
          maximumLiveCalls: options.maxCalls,
          networkRequests: 0,
          configRead: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  validateEvaluationEnvironment(process.env);
  const llm = pickEvaluationModel(JSON.parse(await readFile(resolve(options.file), 'utf8')));
  if (!llm.model || !llm.base_url || !llm.tools) throw new Error('评测需要有效模型设置及开启资料引用。');
  const name = 'yeux-research-eval-' + randomBytes(5).toString('hex'),
    password = randomBytes(24).toString('hex');
  await mkdir('private', { recursive: true, mode: 0o700 });
  const output = await mkdtemp(resolve('private/research-eval-')),
    folder = await mkdtemp(join(tmpdir(), 'yeux-research-eval-'));
  let admin: pg.Pool | undefined,
    store: Store | undefined,
    boss: Awaited<ReturnType<typeof createBoss>> | undefined,
    supervisor: RunSupervisor | undefined,
    started = false,
    stopped = false;
  const stop = () => {
    stopped = true;
    void supervisor?.stop();
  };
  const oldFolder = process.env.ASSISTANT_DATA;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const results: Array<Record<string, unknown>> = [],
    blind: Array<{ label: string; content: string; citations: unknown }> = [];
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
    let ready = false;
    for (let n = 0; n < 40 && !stopped; n++) {
      try {
        await admin.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!ready || stopped) throw new Error('测试库未就绪或评测已取消。');
    await admin.query('CREATE DATABASE assistant_research_test');
    await admin.end();
    admin = undefined;
    process.env.DATABASE_URL = base + 'assistant_research_test';
    process.env.ASSISTANT_DATA = folder;
    store = new Store();
    await store.migrate();
    boss = await createBoss();
    const saver = await openCheckpoints(process.env.DATABASE_URL, true);
    await saver.end();
    supervisor = new RunSupervisor(store);
    const app = new Application(store, boss, folder, 'isolated-evaluation');
    const ids = selected!.materials.map((_, i) => 'material-' + i);
    for (const [i, material] of selected!.materials.entries())
      await store.transaction((tx) => putSource(tx, { id: ids[i]!, title: material.title, content: material.text }));
    const efforts = options.efforts.length ? options.efforts : shuffled(['direct', 'low', 'high'] as const);
    let spentCalls = 0;
    for (const effort of efforts) {
      if (stopped || spentCalls >= options.maxCalls) break;
      const created = await app.addSession(randomUUID(), {
        kind: 'work',
        prompt: selected!.question,
        research: { effort, sourceIds: ids },
      });
      await store.exec('UPDATE app.runs SET max_model_calls=least(max_model_calls,$2) WHERE id=$1', [
        created.runId,
        options.maxCalls - spentCalls,
      ]);
      try {
        await supervisor.handle(created.runId); // actual production child, no API retry on failure
      } catch {
        await store.transaction(async (tx) => {
          await tx.exec("UPDATE app.runs SET state='failed',finished_at=now() WHERE id=$1", [created.runId]);
          await tx.exec(
            "UPDATE app.sessions SET state='failed',error=coalesce(nullif(error,''),'本项评测未完成，不自动重试。') WHERE id=$1",
            [created.sessionId],
          );
        });
      }
      const detail = await app.session(created.sessionId);
      if (detail.session.state !== 'ready') stopped = true;
      spentCalls += Number(
        (await store.one('SELECT model_calls FROM app.runs WHERE id=$1', [created.runId]))!.model_calls,
      );
      const answer = detail.research ? bestCandidate(detail.research.state) : null;
      const label = String.fromCharCode(65 + blind.length);
      blind.push({ label, content: answer?.answer.content || '本项未交付答案。', citations: answer?.citations || [] });
      results.push({
        label,
        effort,
        status: detail.session.state,
        error: detail.session.error,
        research: detail.research,
        // Per-step timing and tokens of this run, from the trace.
        trace: (await app.trace(created.sessionId)).runs.find((run) => run.id === created.runId) ?? null,
        markerMatches: selected!.markers.filter((text) => answer?.answer.content.includes(text)),
        note: '关键词匹配仅是检查线索，不是语义正确率。',
      });
      await writeFile(
        join(output, 'report.json'),
        JSON.stringify(
          redactEvaluation(
            {
              mode: 'live',
              requestedEfforts: efforts,
              maxCalls: options.maxCalls,
              spentCalls,
              case: selected!.id,
              inputDigest: digest(selected),
              model: llm.model,
              reviewModel: llm.review?.model || null,
              rubric: selected!.rubric,
              results,
              stopped,
            },
            [llm.api_key || '', llm.base_url, llm.review?.api_key || '', llm.review?.base_url || ''],
          ),
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await writeFile(
        join(output, 'blind.json'),
        JSON.stringify(
          {
            question: selected!.question,
            materials: selected!.materials,
            rubric: selected!.rubric,
            answers: shuffled(blind),
            instruction: '隐藏投入档位，按预先给定标准比较答案，写出具体依据；完成后再看 report.json 的档位映射。',
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
    console.log('评测记录已保存：' + output);
    if (stopped || results.length !== efforts.length || results.some((result) => result.status !== 'ready'))
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
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
      console.error('评测清理需要处理：' + cleanup.failures.join(', '));
      process.exitCode = 1;
    }
    delete process.env.DATABASE_URL;
    if (oldFolder === undefined) delete process.env.ASSISTANT_DATA;
    else process.env.ASSISTANT_DATA = oldFolder;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('研究评测未完成；检查参数、Docker 与模型设置。已产出的记录保留在 private/。');
    process.exitCode = 1;
  });
}
