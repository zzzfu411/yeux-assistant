import type { Store, Tx, Row } from '../../../storage/src/index.js';
import {
  ResearchOptions,
  stepRetries,
  type ResearchState,
  type ResearchDetail,
} from '../../../contracts/src/research.js';
import type { Citation } from '../../../contracts/src/index.js';
import { AppError, digest, event, id, notify } from '../common.js';
import { config, modelFor } from '../config.js';
import { citationFromRow, terms } from '../knowledge.js';
import { ModelGateway, type ModelContext } from '../model.js';
import {
  fence,
  readContext,
  step,
  transient,
  StaleRun,
  RuntimeLimit,
  publicRuntimeError,
  type RunIdentity,
} from '../runtime-state.js';
import { advanceResearch, bestCandidate, initialResearch, summarizeUsage } from './engine.js';

type Snapshot = {
  context: ModelContext;
  sources: ResearchDetail['sourceVersions'];
  model: string;
  /** Present only when an independent reviewer is configured. */
  reviewModel?: string;
  modelFingerprint: string;
};

/** Search frozen source versions, including older versions after the user edits a document. */
export async function researchSources(tx: Tx, sources: Snapshot['sources'], query: string, required: Citation[] = []) {
  if (!sources.length) return [];
  const patterns = terms(query).map((word) => '%' + word.replace(/[\\%_]/g, '\\$&') + '%');
  const rows = await tx.rows(
    `WITH ranked AS (
      SELECT c.*,v.title,v.digest,v.metadata,
        row_number() OVER(PARTITION BY c.source_id ORDER BY
          (c.content ILIKE ANY($2::text[])) DESC,word_similarity($3,c.content) DESC,c.start_offset) AS position,
        (c.content ILIKE ANY($2::text[])) AS matched
      FROM app.chunks c
      JOIN jsonb_to_recordset($1::jsonb) AS pinned(id text,version integer) ON pinned.id=c.source_id AND pinned.version=c.version
      JOIN app.source_versions v ON v.source_id=c.source_id AND v.version=c.version)
      SELECT * FROM ranked ORDER BY matched DESC,position,source_id,start_offset LIMIT 12`,
    [JSON.stringify(sources), patterns, query.slice(-500)],
  );
  const result: Citation[] = [];
  for (const citation of [...required, ...rows.map(citationFromRow)]) {
    if (
      !result.some(
        (c) =>
          c.sourceId === citation.sourceId &&
          c.version === citation.version &&
          c.start === citation.start &&
          c.end === citation.end,
      )
    )
      result.push(citation);
  }
  return result.slice(0, 12);
}

/**
 * "重新准备" after a failure continues from the saved candidates of the previous run instead of paying
 * for the same solve again. Only the same model settings may continue; otherwise the research restarts.
 */
async function resumeFrom(
  tx: Tx,
  sessionId: string,
  priorRunId: unknown,
  fingerprint: string,
  effort: ResearchState['effort'],
): Promise<{ snapshot: Snapshot; state: ResearchState } | null> {
  if (typeof priorRunId !== 'string') return null;
  const prior = await tx.one(
    'SELECT w.snapshot,w.state FROM app.research_workspaces w JOIN app.runs r ON r.id=w.run_id WHERE w.run_id=$1 AND r.session_id=$2',
    [priorRunId, sessionId],
  );
  const state = prior?.state as ResearchState | undefined;
  if (!prior || !state?.candidates.length || state.stopReason === 'accepted' || state.effort !== effort) return null;
  if ((prior.snapshot as Snapshot).modelFingerprint !== fingerprint) return null;
  const last = state.candidates.at(-1)!,
    pending = effort !== 'direct' && !last.review;
  const reviewed = state.candidates.length - (pending ? 1 : 0);
  return {
    snapshot: prior.snapshot as Snapshot,
    state: {
      ...state,
      phase: pending ? 'review' : 'solve',
      stopReason: null,
      offset: reviewed,
      retried: 0,
      warnings: [
        `接续上一轮已保存的 ${state.candidates.length} 份候选${pending ? '，先补做未完成的评阅' : ''}；本轮预算单独计算。`,
      ],
    },
  };
}

async function initialize(
  store: Store,
  folder: string,
  identity: RunIdentity,
): Promise<{ snapshot: Snapshot; state: ResearchState }> {
  const settings = (await config(folder)).llm;
  if (!settings?.base_url || !settings?.model) throw new AppError('深入研究需要先在设置中连接模型。');
  if (settings.tools === false) throw new AppError('深入研究需要开启资料引用，再进行原文查证。');
  return store.transaction(async (tx) => {
    const { session, run } = await fence(tx, identity);
    const saved = await tx.one('SELECT snapshot,state FROM app.research_workspaces WHERE run_id=$1', [run.id]);
    if (saved) return saved as { snapshot: Snapshot; state: ResearchState };
    const options = ResearchOptions.parse(session.research);
    const resumed = await resumeFrom(tx, session.id, run.input.resumeFrom, digest(settings), options.effort);
    if (resumed) {
      await tx.exec('INSERT INTO app.research_workspaces(run_id,snapshot,state) VALUES($1,$2,$3)', [
        run.id,
        JSON.stringify(resumed.snapshot),
        JSON.stringify(resumed.state),
      ]);
      await event(tx, 'research.started', session.id, { runId: run.id, effort: options.effort, resumed: true });
      return resumed;
    }
    const sources = await tx.rows(
      `SELECT id,version,digest,title FROM app.sources WHERE archived_at IS NULL AND missing_at IS NULL
      AND (path IS NULL OR path NOT LIKE 'workspace/profile/%')
      AND (cardinality($1::text[])=0 OR id=ANY($1::text[])) ORDER BY id LIMIT 101`,
      [options.sourceIds],
    );
    if (sources.length > 100) throw new AppError('可用资料超过 100 份，请选择本次研究需要的资料。');
    if (options.sourceIds.length && sources.length !== new Set(options.sourceIds).size)
      throw new AppError('所选资料已不可用，请重新选择。', 409, 'source_conflict');
    const memories = await tx.rows(
      "SELECT * FROM app.memories WHERE enabled AND (scope IN ('all','preference','fact','correction','work')) ORDER BY key",
    );
    const snapshot: Snapshot = {
      context: {
        task: session.prompt,
        latest: run.input.answer || session.prompt,
        previous: session.content,
        rules: memories.filter((m) => m.confirmed).map((m) => m.key + ': ' + m.content),
        notes: memories.filter((m) => !m.confirmed).map((m) => m.key + ': ' + m.content),
        ruleRecords: memories
          .filter((m) => m.confirmed)
          .map((m) => ({ key: m.key, version: m.version, commitSha: m.commit_sha ?? null, content: m.content })),
        sources: [],
      },
      sources: sources as Snapshot['sources'],
      model: settings.model,
      ...(modelFor(settings, 'review').independent ? { reviewModel: modelFor(settings, 'review').model } : {}),
      modelFingerprint: digest(settings),
    };
    const state = initialResearch(options.effort);
    if (!sources.length) state.warnings.push('资料库没有可用资料；答案仅为模型生成，无法用原文核查。');
    await tx.exec('INSERT INTO app.research_workspaces(run_id,snapshot,state) VALUES($1,$2,$3)', [
      run.id,
      JSON.stringify(snapshot),
      JSON.stringify(state),
    ]);
    await event(tx, 'research.started', session.id, { runId: run.id, effort: options.effort });
    return { snapshot, state };
  });
}

async function saveState(store: Store, identity: RunIdentity, state: ResearchState) {
  await store.transaction(async (tx) => {
    const { run, session } = await fence(tx, identity);
    await writeState(tx, run, session, state);
  });
}
async function writeState(tx: Tx, run: Row, session: Row, state: ResearchState) {
  await tx.exec('UPDATE app.research_workspaces SET state=$2,updated_at=now() WHERE run_id=$1', [
    run.id,
    JSON.stringify(state),
  ]);
  const best = bestCandidate(state);
  if (best) {
    await tx.exec('UPDATE app.sessions SET content=$2,citations=$3,revision=revision+1,updated_at=now() WHERE id=$1', [
      session.id,
      best.answer.content,
      JSON.stringify(best.citations),
    ]);
    await tx.exec(
      'INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,citations,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dedupe_key) DO NOTHING',
      [
        id(),
        session.id,
        run.id,
        'research_candidate',
        best.answer.content,
        'model_generated',
        JSON.stringify(best.citations),
        `research:${run.id}:${best.index}`,
      ],
    );
  }
  await event(tx, 'research.progress', session.id, {
    runId: run.id,
    phase: state.phase,
    candidates: state.candidates.length,
    best: state.best,
  });
}

export async function executeResearchRun(store: Store, folder: string, identity: RunIdentity) {
  const saved = await initialize(store, folder, identity),
    snapshot = saved.snapshot;
  let state = saved.state;
  const model = new ModelGateway(store, folder, identity);
  while (state.phase !== 'finished') {
    const current = await readContext(store, identity);
    const callsLeft = current.run.max_model_calls - current.run.model_calls;
    if (
      callsLeft <= 0 ||
      // A new version that cannot be reviewed can never be adopted, so the last call is not spent on it.
      (state.phase === 'solve' && state.effort !== 'direct' && callsLeft < 2) ||
      new Date(current.run.deadline).getTime() - Date.now() <= 5000
    ) {
      state = { ...state, phase: 'finished', stopReason: 'budget' };
      break;
    }
    // A restart cannot silently switch the model half-way through a comparison.
    if (digest((await config(folder)).llm) !== snapshot.modelFingerprint)
      throw new AppError('模型设置已改变，请查看已保存候选，再重新开始研究。', 409, 'research_model_changed');
    const best = bestCandidate(state),
      pending = state.candidates.at(-1);
    const queries = best?.review?.queries || pending?.review?.queries || [];
    const citations = await store.transaction(async (tx) => {
      await fence(tx, identity);
      return researchSources(
        tx,
        snapshot.sources,
        [snapshot.context.task, ...queries].join('\n'),
        state.phase === 'review' ? pending?.citations : [],
      );
    });
    try {
      // Each solve or review is one step; its workspace state commits with the step receipt.
      const current = state;
      state = await step(
        store,
        identity,
        `${current.phase}:${current.candidates.length}`,
        {},
        () => advanceResearch(current, model, { ...snapshot.context, sources: citations }),
        (tx, next, { run, session }) => writeState(tx, run, session, next),
      );
    } catch (error) {
      if (error instanceof StaleRun || error instanceof RuntimeLimit) throw error;
      const left = await readContext(store, identity);
      // A broken stream, a 5xx or a malformed answer repeats this one step while the budget allows it.
      if (
        transient(error) &&
        (state.retried ?? 0) < stepRetries(state.effort) &&
        // A repeated solve is only worth it if a review can still follow.
        left.run.max_model_calls - left.run.model_calls >=
          (state.phase === 'solve' && state.effort !== 'direct' ? 2 : 1) &&
        new Date(left.run.deadline).getTime() - Date.now() > 60000
      ) {
        const step = state.phase === 'review' ? '评阅' : '求解';
        state = {
          ...state,
          retried: (state.retried ?? 0) + 1,
          warnings: [...state.warnings, `${step}时遇到服务错误，已自动重试这一步：${publicRuntimeError(error)}`],
        };
        await saveState(store, identity, state);
        continue;
      }
      if (!bestCandidate(state)) throw error;
      state = {
        ...state,
        phase: 'finished',
        stopReason: error instanceof AppError && error.code === 'model_time_budget' ? 'budget' : 'error',
        warnings: [...state.warnings, publicRuntimeError(error)],
      };
    }
  }
  if (!bestCandidate(state)) {
    await saveState(store, identity, state);
    throw new AppError('预算内未得到可交付的已评阅答案，候选已保留供查看。', 409, 'research_incomplete');
  }
  await saveState(store, identity, state);
  await store.transaction(async (tx) => {
    const { run, session } = await fence(tx, identity);
    if (run.input.attemptId)
      await tx.exec(
        "UPDATE app.attempts SET verdict='unclear',feedback='已作为研究修改要求处理，不作为学习掌握证据。',source='ungraded' WHERE id=$1 AND session_id=$2",
        [run.input.attemptId, session.id],
      );
    await tx.exec("UPDATE app.runs SET state='succeeded',finished_at=now(),error='' WHERE id=$1", [run.id]);
    await tx.exec("UPDATE app.sessions SET state='ready',revision=revision+1,error='',updated_at=now() WHERE id=$1", [
      session.id,
    ]);
    await notify(
      tx,
      `delivered:${run.id}`,
      session.id,
      '研究结果已准备好',
      state.stopReason === 'error' ? '后续查证未完成，保留此前较好版本。' : '引用与模型评阅可在记录中核对。',
    );
    await event(tx, 'run.finished', session.id, { runId: run.id });
  });
}

export async function researchDetail(tx: Tx, sessionId: string): Promise<ResearchDetail | null> {
  const row = await tx.one(
    `SELECT r.*,w.state AS research_state,w.snapshot FROM app.runs r
    JOIN app.research_workspaces w ON w.run_id=r.id WHERE r.session_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
    [sessionId],
  );
  if (!row) return null;
  return {
    runId: row.id,
    state: row.research_state,
    calls: row.model_calls,
    maxCalls: row.max_model_calls,
    maxSeconds: row.max_seconds,
    elapsedMs: Math.max(
      0,
      (row.finished_at ? new Date(row.finished_at).getTime() : Date.now()) - new Date(row.started_at).getTime(),
    ),
    usage: summarizeUsage(row.usage, row.model_calls),
    model: row.snapshot.model,
    ...(row.snapshot.reviewModel ? { reviewModel: row.snapshot.reviewModel } : {}),
    sourceVersions: row.snapshot.sources,
  };
}
