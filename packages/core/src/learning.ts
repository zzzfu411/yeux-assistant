import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Store, Row } from '../../storage/src/index.js';
import { ModelLesson, ModelPlan, Citation } from '../../contracts/src/index.js';
import { ModelAssessment } from '../../contracts/src/assessment.js';
import { ASSESSMENT_INSTRUCTION, guardAssessment } from './assessment.js';
import { AppError, digest, event, id, notify } from './common.js';
import { citationFromRow, retrieve } from './knowledge.js';
import { ModelGateway, type ModelContext } from './model.js';
import { commitNode, fence, nodeReceipt, readContext, type RunIdentity } from './runtime-state.js';

type Step = { id: string; title: string; objective: string; state: 'pending' | 'practicing' | 'practiced' };
const LearningState = Annotation.Root({
  sessionId: Annotation<string>,
  stepId: Annotation<string | null>,
  attemptId: Annotation<string | null>,
  done: Annotation<boolean>,
  waits: Annotation<boolean>,
});
type State = typeof LearningState.State;

export async function openCheckpoints(url: string, setup = false) {
  const saver = PostgresSaver.fromConnString(url, { schema: 'checkpoints' });
  if (setup) await saver.setup();
  return saver;
}

async function contextFor(store: Store, identity: RunIdentity, stepId: string | null, assessment = false) {
  return store.transaction(async (tx) => {
    const context = await fence(tx, identity);
    const plan = context.goal
      ? await tx.one('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version DESC LIMIT 1', [context.goal.id])
      : undefined;
    const steps = (plan?.steps || []) as Step[];
    let step = steps.find((s) => s.id === stepId) || steps.find((s) => s.state !== 'practiced') || steps[0];
    const delivered = await tx.one(
      "SELECT id,run_id,content,citations FROM app.artifacts WHERE session_id=$1 AND kind IN ('lesson','response') ORDER BY created_at DESC,id DESC LIMIT 1",
      [context.session.id],
    );
    const attempt = context.run.input.attemptId
      ? await tx.one('SELECT * FROM app.attempts WHERE id=$1 AND session_id=$2', [
          context.run.input.attemptId,
          context.session.id,
        ])
      : undefined;
    if (assessment && context.goal && attempt?.verdict === 'pending') {
      // The graph's current choice can change after a failed run or another
      // review. Grade the step that produced this session's delivered exercise.
      const prepared = delivered?.run_id
        ? await tx.one(
            `SELECT s.value FROM app.settings s JOIN app.runs r ON s.key='runtime:' || r.id || ':prepare'
        WHERE r.id=$1 AND r.session_id=$2`,
            [delivered.run_id, context.session.id],
          )
        : undefined;
      const originalStep =
        typeof prepared?.value?.stepId === 'string'
          ? steps.find((item) => item.id === prepared.value.stepId)
          : undefined;
      if (!originalStep)
        throw new AppError(
          '这份练习的学习步骤无法核对，回答已保留。请在目标页暂停后继续学习，重新准备练习。',
          409,
          'exercise_binding_missing',
        );
      step = originalStep;
    }
    const query = [context.goal?.title, context.goal?.outcome, step?.title, step?.objective, context.session.prompt]
      .filter(Boolean)
      .join(' ');
    // Assessment belongs to the delivered exercise; later edits or archival cannot change its evidence.
    // Preparing the next exercise uses current, active sources.
    const savedCitations = assessment
      ? Citation.array().safeParse(delivered?.citations ?? context.session.citations ?? [])
      : null;
    let citations = assessment
      ? savedCitations?.success
        ? savedCitations.data
        : []
      : context.goal && !context.goal.source_ids.length
        ? []
        : await retrieve(tx, query, context.goal?.source_ids || [], 6);
    // A goal's explicitly selected short document can be useful even without lexical overlap.
    if (!assessment && !citations.length && context.goal?.source_ids?.length) {
      citations = (
        await tx.rows(
          `SELECT c.*,v.title,v.digest,v.metadata FROM app.chunks c JOIN app.sources s ON s.id=c.source_id AND s.version=c.version
        JOIN app.source_versions v ON v.source_id=c.source_id AND v.version=c.version
        WHERE s.id=ANY($1::text[]) AND s.archived_at IS NULL ORDER BY c.source_id,c.start_offset LIMIT 6`,
          [context.goal.source_ids],
        )
      ).map(citationFromRow);
    }
    const memories = await tx.rows(
      "SELECT * FROM app.memories WHERE enabled AND (scope IN ('all','preference','fact','correction') OR scope=$1) ORDER BY updated_at DESC,key",
      [context.session.kind],
    );
    const previous = delivered?.content || context.session.content;
    const modelContext: ModelContext = {
      task: [
        context.goal?.title || context.session.title,
        context.goal?.outcome || context.session.prompt,
        step ? '当前学习点：' + step.title + '\n' + step.objective : '',
      ]
        .filter(Boolean)
        .join('\n'),
      latest: attempt?.answer || context.run.input.answer || context.session.prompt,
      previous,
      rules: memories.filter((m) => m.confirmed).map((m) => m.key + ': ' + m.content),
      notes: memories.filter((m) => !m.confirmed).map((m) => m.key + ': ' + m.content),
      sources: citations,
    };
    const intent = context.goal
      ? digest({ title: context.goal.title, outcome: context.goal.outcome, sources: context.goal.source_ids })
      : '';
    const savedIntent = context.goal
      ? (await tx.one('SELECT value FROM app.settings WHERE key=$1', ['plan-intent:' + context.goal.id]))?.value
      : undefined;
    const reviewIndex = context.goal
      ? Number(
          (await tx.one('SELECT value FROM app.settings WHERE key=$1', ['review-index:' + context.goal.id]))?.value ||
            0,
        )
      : 0;
    return {
      ...context,
      plan,
      steps,
      step,
      citations,
      attempt,
      delivered,
      modelContext,
      intent,
      savedIntent,
      reviewIndex,
    };
  });
}

export function localLesson(title: string, citations: Citation[], feedback = '') {
  const passages = citations
    .slice(0, 3)
    .map(
      (c) =>
        `**${c.title}**（原始资料，${c.location || `第 ${c.start + 1}–${c.end} 字符`}）\n\n> ${c.quote.replace(/\n/g, '\n> ')}`,
    )
    .join('\n\n');
  return [
    feedback,
    `**${title}**`,
    '尚未配置模型，先用原始资料进行练习；当前内容没有经过模型讲解或评阅。',
    passages || '还没有匹配的资料。可以先补充资料，或用自己的话描述这个主题。',
    '用自己的话解释一个关键概念，并举一个例子。提交回答时，可以注明“已理解”或“需要练习”。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function nextReview(stage: number, intervals: number[], verdict: string, now = Date.now()) {
  if (verdict === 'unclear') return { stage, at: new Date(now + intervals[0]! * 1000) };
  const current = verdict === 'pass' ? Math.max(0, Math.min(stage, intervals.length - 1)) : 0;
  return {
    stage: verdict === 'pass' ? Math.min(current + 1, intervals.length - 1) : 0,
    at: new Date(now + intervals[current]! * 1000),
  };
}

export function buildLearningGraph(store: Store, folder: string, saver: PostgresSaver, identity: RunIdentity) {
  const model = new ModelGateway(store, folder, identity);
  const graph = new StateGraph(LearningState)
    .addNode('plan', async () => {
      const saved = await nodeReceipt<Partial<State>>(store, identity, 'plan');
      if (saved) return saved;
      const ctx = await contextFor(store, identity, null);
      let proposed: { steps: { title: string; objective: string }[]; rationale: string } | undefined;
      if (ctx.goal && (!ctx.plan || (ctx.savedIntent && ctx.savedIntent !== ctx.intent))) {
        proposed = (await model.configured())
          ? await model.json(
              ModelPlan,
              '把学习目标拆成 1–6 个有顺序、可以练习验证的知识点。只准备学习计划，不声称用户已掌握。根据现有原始资料安排，不编造课程要求。',
              ctx.modelContext,
            )
          : {
              steps: [{ title: ctx.goal.title, objective: ctx.goal.outcome || '阅读资料，用自己的话解释并举例。' }],
              rationale: '尚未配置模型，先从一个可自评的学习步骤开始。',
            };
      }
      return commitNode(store, identity, 'plan', async (tx, current) => {
        let steps = ctx.steps;
        if (proposed && current.goal) {
          const version =
            Number(
              (await tx.one('SELECT coalesce(max(version),0) n FROM app.plans WHERE goal_id=$1', [current.goal.id]))!.n,
            ) + 1;
          steps = proposed.steps.map((s) => ({ ...s, id: id(), state: 'pending' as const }));
          await tx.exec(
            'INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,$3,$4,$5,$6)',
            [id(), current.goal.id, version, JSON.stringify(steps), proposed.rationale, current.goal.revision],
          );
          await tx.exec(
            'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ['plan-intent:' + current.goal.id, JSON.stringify(ctx.intent)],
          );
          await event(tx, 'plan.updated', current.goal.id, { version });
        }
        return {
          stepId: (steps.find((s) => s.state !== 'practiced') || steps[ctx.reviewIndex % steps.length])?.id || null,
          done: false,
          waits: current.session.kind === 'study',
        };
      });
    })
    .addNode('prepare', async (state) => {
      const saved = await nodeReceipt<Partial<State>>(store, identity, 'prepare');
      if (saved) return saved;
      const ctx = await contextFor(store, identity, state.stepId);
      const study = ctx.session.kind === 'study';
      const feedback = ctx.attempt && ctx.attempt.verdict !== 'pending' ? ctx.attempt.feedback : '';
      const enabled = await model.configured();
      const result = enabled
        ? await model.json(
            ModelLesson,
            study
              ? '准备当前知识点的一小段讲解和一个可回答的练习；若已有评阅反馈，针对薄弱点调整，若上一点已通过则进入下一点。保留原始来源，引用只用给定的 sourceId。不要自行作答或宣布用户学完。'
              : '按用户最新请求生成可直接使用的草稿或分析。结合最新反馈与先前交付内容；对外发送、提交和真实执行都未发生，不能声称已完成。引用只用给定的 sourceId。',
            { ...ctx.modelContext, task: ctx.modelContext.task + (feedback ? '\n最近反馈：' + feedback : '') },
          )
        : {
            content: study
              ? localLesson(ctx.step?.title || ctx.session.title, ctx.citations, feedback)
              : [
                  '尚未配置模型，已保存这项请求。',
                  ctx.modelContext.latest,
                  ...ctx.citations.slice(0, 3).map((c) => `资料：${c.title}\n\n${c.quote}`),
                ].join('\n\n'),
            sourceIds: ctx.citations.map((c) => c.sourceId),
          };
      const provided = new Set(enabled ? model.providedSourceIds : ctx.citations.map((c) => c.sourceId));
      if (result.sourceIds.some((source) => !provided.has(source)))
        throw new AppError('模型引用了未提供的资料，已保留进度并重新核对。', 503, 'model_invalid_citation');
      const citations = (enabled ? model.providedCitations : ctx.citations).filter((c) =>
        result.sourceIds.includes(c.sourceId),
      );
      return commitNode(store, identity, 'prepare', async (tx, current) => {
        if (ctx.plan && ctx.step && ctx.step.state !== 'practiced') {
          const latest = await tx.one('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version DESC LIMIT 1', [
            ctx.goal!.id,
          ]);
          if (latest && latest.version === ctx.plan.version && ctx.step.state === 'pending') {
            const steps = (latest.steps as Step[]).map((s) =>
              s.id === ctx.step!.id ? { ...s, state: 'practicing' } : s,
            );
            await tx.exec(
              'INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,$3,$4,$5,$6)',
              [
                id(),
                current.goal!.id,
                latest.version + 1,
                JSON.stringify(steps),
                '开始准备下一步练习。',
                current.goal!.revision,
              ],
            );
            await event(tx, 'plan.updated', current.goal!.id, { version: latest.version + 1 });
          }
        }
        await tx.exec(
          'INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,citations,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dedupe_key) DO NOTHING',
          [
            id(),
            current.session.id,
            current.run.id,
            study ? 'lesson' : 'response',
            result.content,
            enabled ? 'model_generated' : 'local_guidance',
            JSON.stringify(citations),
            `lesson:${current.run.id}`,
          ],
        );
        // Publish an actionable state only after the synchronous graph checkpoint commits.
        await tx.exec(
          "UPDATE app.sessions SET content=$2,citations=$3,state='running',error='',revision=revision+1,updated_at=now() WHERE id=$1",
          [current.session.id, result.content, JSON.stringify(citations)],
        );
        if (!study && ctx.attempt?.verdict === 'pending')
          await tx.exec(
            "UPDATE app.attempts SET verdict='unclear',feedback='已作为后续请求处理；这不是学习掌握评估。',evidence=answer WHERE id=$1",
            [ctx.attempt.id],
          );
        await event(tx, 'session.updated', current.session.id, { runId: current.run.id });
        return { stepId: ctx.step?.id || null, waits: study, done: !study };
      });
    })
    .addNode('answer', () => {
      const answer = interrupt<unknown, { attemptId: string }>({
        kind: 'learning_feedback',
        instruction: '请先完成当前练习，再提交回答。',
      });
      return { attemptId: answer.attemptId };
    })
    .addNode('assess', async (state) => {
      const saved = await nodeReceipt<Partial<State>>(store, identity, 'assess');
      if (saved) return saved;
      const ctx = await contextFor(store, identity, state.stepId, true);
      if (!ctx.attempt || ctx.attempt.id !== state.attemptId)
        throw new AppError('没有找到这次回答，当前进度已保留。', 409, 'attempt_missing');
      // A manual retry starts a new graph thread. The old answer must resume its
      // committed continuation, never be reassessed against a newly selected step.
      if (ctx.attempt.verdict !== 'pending')
        return store.transaction(async (tx) => {
          await fence(tx, identity);
          const receipt =
            (await tx.one('SELECT value FROM app.settings WHERE key=$1', ['assessment:' + ctx.attempt!.id])) ??
            (await tx.one(
              `SELECT s.value FROM app.settings s JOIN app.runs r ON s.key='runtime:' || r.id || ':assess'
            WHERE r.session_id=$1 AND r.input->>'attemptId'=$2 ORDER BY r.created_at LIMIT 1`,
              [ctx.session.id, ctx.attempt!.id],
            ));
          if (!receipt)
            throw new AppError(
              '这次回答已评阅，但缺少恢复记录。已有判定已保留，请重新开始练习。',
              409,
              'assessment_receipt_missing',
            );
          return { stepId: receipt.value.stepId, done: receipt.value.done };
        });
      const self = ctx.attempt.self_report;
      const enabled = await model.configured();
      const proposed: ModelAssessment = self
        ? {
            verdict: self === 'understood' ? 'pass' : 'retry',
            feedback:
              self === 'understood'
                ? '已记录你的自评：理解了这个知识点。后续会安排复习。'
                : '已记录你的自评：还需要练习。继续巩固当前知识点。',
            evidence: ctx.attempt.answer,
            answerQuotes: [],
            citationRefs: [],
          }
        : enabled
          ? await model.json(ModelAssessment, ASSESSMENT_INSTRUCTION, ctx.modelContext, { assessment: true })
          : {
              verdict: 'unclear',
              feedback: '回答已保存。尚未配置模型，因此没有自动评阅；可以继续练习，或提交“已理解 / 需要练习”的自评。',
              evidence: ctx.attempt.answer,
              answerQuotes: [],
              citationRefs: [],
            };
      const guarded =
        !self && enabled
          ? guardAssessment(proposed, {
              answer: ctx.attempt.answer,
              exerciseComplete: model.exerciseComplete,
              providedCitations: model.providedCitations,
            })
          : null;
      const assessment = guarded?.assessment ?? proposed;
      const audit = guarded
        ? {
            version: 1,
            attemptId: ctx.attempt.id,
            stepId: ctx.step?.id ?? null,
            modelResponse: model.lastResponse,
            accepted: assessment,
            reasons: guarded.reasons,
            downgraded: guarded.downgraded,
            exercise: {
              artifactId: ctx.delivered?.id ?? null,
              digest: digest(ctx.modelContext.previous),
              characters: ctx.modelContext.previous.length,
              complete: model.exerciseComplete,
            },
            providedCitations: model.providedCitations,
            scope: '仅保存结构有效且应用到本次回答的模型回复；证据可追溯性检查不代表语义判定已经验证。',
          }
        : null;
      const source = self ? 'user_report' : enabled ? 'model_estimate' : 'ungraded';
      return commitNode(store, identity, 'assess', async (tx, current) => {
        await tx.exec(
          'UPDATE app.attempts SET verdict=$2,feedback=$3,evidence=$4,source=$5 WHERE id=$1 AND session_id=$6',
          [ctx.attempt!.id, assessment.verdict, assessment.feedback, assessment.evidence, source, current.session.id],
        );
        await tx.exec(
          'INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING',
          [
            id(),
            current.session.id,
            current.run.id,
            'feedback',
            assessment.feedback,
            source,
            `feedback:${ctx.attempt!.id}`,
          ],
        );
        if (audit)
          await tx.exec(
            'INSERT INTO app.artifacts(id,session_id,run_id,kind,content,provenance,citations,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(dedupe_key) DO NOTHING',
            [
              id(),
              current.session.id,
              current.run.id,
              'assessment_audit',
              JSON.stringify(audit, null, 2),
              'model_estimate',
              JSON.stringify(model.providedCitations),
              `assessment-audit:${ctx.attempt!.id}`,
            ],
          );
        let nextStep = ctx.step?.id || null,
          done = assessment.verdict === 'pass' && !current.goal;
        if (current.goal) {
          const latest = await tx.one('SELECT * FROM app.plans WHERE goal_id=$1 ORDER BY version DESC LIMIT 1', [
            current.goal.id,
          ]);
          const steps = (latest?.steps || []) as Step[];
          if (
            assessment.verdict === 'retry' &&
            ctx.step &&
            steps.some((s) => s.id === ctx.step!.id && s.state === 'practiced')
          ) {
            const changed = steps.map((s) => (s.id === ctx.step!.id ? { ...s, state: 'practicing' as const } : s));
            await tx.exec(
              'INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,$3,$4,$5,$6)',
              [
                id(),
                current.goal.id,
                latest!.version + 1,
                JSON.stringify(changed),
                '复习中需要继续练习，保留此前的作答记录。',
                current.goal.revision,
              ],
            );
            await event(tx, 'plan.updated', current.goal.id, { version: latest!.version + 1 });
          }
          if (assessment.verdict === 'pass' && ctx.step && steps.some((s) => s.id === ctx.step!.id)) {
            const changed = steps.map((s) => (s.id === ctx.step!.id ? { ...s, state: 'practiced' as const } : s));
            await tx.exec(
              'INSERT INTO app.plans(id,goal_id,version,steps,rationale,goal_revision) VALUES($1,$2,$3,$4,$5,$6)',
              [
                id(),
                current.goal.id,
                latest!.version + 1,
                JSON.stringify(changed),
                assessment.feedback,
                current.goal.revision,
              ],
            );
            const pending = changed.find((s) => s.state !== 'practiced');
            nextStep = pending?.id || null;
            done = !pending;
            await tx.exec(
              'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              [
                'review-index:' + current.goal.id,
                JSON.stringify((changed.findIndex((s) => s.id === ctx.step!.id) + 1) % changed.length),
              ],
            );
            await event(tx, 'plan.updated', current.goal.id, { version: latest!.version + 1 });
          }
          const review =
            assessment.verdict === 'pass' && !done
              ? { stage: current.goal.review_stage, at: new Date(Date.now() + current.goal.intervals[0] * 1000) }
              : nextReview(current.goal.review_stage, current.goal.intervals, assessment.verdict);
          await tx.exec('UPDATE app.goals SET review_stage=$2,next_review=$3,updated_at=now() WHERE id=$1', [
            current.goal.id,
            review.stage,
            review.at,
          ]);
          await event(tx, 'goal.updated', current.goal.id);
        }
        if (done) {
          const content =
            assessment.feedback +
            (current.goal
              ? '\n\n这轮练习已完成。目标仍保持进行中，复习会按计划准备；是否完成整个目标由你确认。'
              : '\n\n这轮练习已完成。');
          await tx.exec(
            "UPDATE app.sessions SET content=$2,state='running',revision=revision+1,updated_at=now() WHERE id=$1",
            [current.session.id, content],
          );
        }
        await event(tx, 'attempt.assessed', current.session.id, {
          attemptId: ctx.attempt!.id,
          verdict: assessment.verdict,
          source,
        });
        await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)', [
          'assessment:' + ctx.attempt!.id,
          JSON.stringify({
            attemptId: ctx.attempt!.id,
            assessedStepId: ctx.step?.id ?? null,
            artifactId: ctx.delivered?.id ?? null,
            verdict: assessment.verdict,
            stepId: nextStep,
            done,
          }),
        ]);
        return { stepId: nextStep, done };
      });
    })
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', (state) => (state.attemptId && state.waits ? 'assess' : 'prepare'), [
      'assess',
      'prepare',
    ])
    .addConditionalEdges('prepare', (state) => (state.waits ? 'answer' : END), ['answer', END])
    .addEdge('answer', 'assess')
    .addConditionalEdges('assess', (state) => (state.done ? END : 'prepare'), [END, 'prepare']);
  return graph.compile({ checkpointer: saver });
}

export async function executeLearningRun(store: Store, folder: string, identity: RunIdentity, saver: PostgresSaver) {
  const ctx = await readContext(store, identity);
  const graph = buildLearningGraph(store, folder, saver, identity);
  const options = {
    configurable: { thread_id: ctx.run.graph_thread, runId: identity.runId, generation: identity.generation },
    durability: 'sync' as const,
    recursionLimit: 12,
  };
  const snapshot = await graph.getState(options);
  const exists = Boolean(snapshot.values?.sessionId);
  const resumed = exists && snapshot.values.attemptId === ctx.run.input.attemptId;
  if (ctx.run.input.type === 'feedback' && !resumed) {
    if (!exists || !snapshot.next.includes('answer'))
      throw new AppError('学习检查点尚未就绪，稍后会重试。', 503, 'checkpoint_pending');
    await graph.invoke(new Command({ resume: { attemptId: ctx.run.input.attemptId } }), options);
  } else if (!exists) {
    await graph.invoke(
      {
        sessionId: ctx.session.id,
        stepId: null,
        attemptId: ctx.run.input.type === 'followup' ? ctx.run.input.attemptId || null : null,
        done: false,
        waits: ctx.session.kind === 'study',
      },
      options,
    );
  } else {
    // Pending writes may have completed a node while its successor checkpoint failed:
    // getState().next can be empty even though invoke(null) must advance those writes.
    await graph.invoke(null, options);
  }
  const final = await graph.getState(options);
  const waiting = final.next.includes('answer');
  await store.transaction(async (tx) => {
    const current = await fence(tx, identity);
    await tx.exec("UPDATE app.runs SET state='succeeded',finished_at=now(),error='' WHERE id=$1", [identity.runId]);
    await tx.exec('UPDATE app.sessions SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1', [
      current.session.id,
      waiting ? 'waiting_feedback' : current.session.kind === 'study' ? 'completed' : 'ready',
    ]);
    await notify(
      tx,
      `delivered:${current.run.id}`,
      current.session.id,
      waiting ? '下一步练习已准备好' : current.session.kind === 'study' ? '这轮练习已完成' : '任务结果已准备好',
    );
    await event(tx, 'session.updated', current.session.id, { runId: identity.runId });
    await event(tx, 'run.finished', current.session.id, { runId: identity.runId });
  });
}
