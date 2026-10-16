import type { Application } from '../../../../packages/core/src/application.js';
import {
  CreateGoal,
  UpdateGoal,
  CreateSession,
  Feedback,
  DraftInput,
} from '../../../../packages/contracts/src/index.js';
import { GoalListQuery, SessionListQuery, AttemptListQuery } from '../../../../packages/contracts/src/pagination.js';
import { SessionTrace } from '../../../../packages/contracts/src/trace.js';
import { ComposeDraft, SaveComposeDraft, ClearComposeDraft } from '../../../../packages/contracts/src/drafts.js';
import { type ApiServer, key, params, pageQuery, revisionBody } from './shared.js';
export function registerLearningRoutes(server: ApiServer, app: Application) {
  server.get('/today', async () => app.today());
  server.get('/today/overview', () => app.today(true));
  server.get('/goals', async () => app.goals());
  server.get('/drafts/compose', { schema: { response: { 200: ComposeDraft } } }, () => app.composeDraft());
  server.put('/drafts/compose', { schema: { body: SaveComposeDraft, response: { 200: ComposeDraft } } }, (r) =>
    app.saveComposeDraft(r.body),
  );
  server.post('/drafts/compose/clear', { schema: { body: ClearComposeDraft } }, (r) => app.clearComposeDraft(r.body));
  server.get('/goals/list', { schema: { querystring: GoalListQuery } }, (r) => app.goalList(r.query));
  server.get('/goals/:id/overview', { schema: { params } }, (r) => app.goal(r.params.id, true));
  server.get('/goals/:id/attempts/list', { schema: { params, querystring: AttemptListQuery } }, (r) =>
    app.goalAttempts(r.params.id, r.query),
  );
  server.get('/goals/:id', { schema: { params } }, (r) => app.goal(r.params.id));
  server.post('/goals', { schema: { body: CreateGoal } }, async (r, p) => {
    p.code(202);
    return app.addGoal(key(r), r.body);
  });
  server.patch('/goals/:id', { schema: { params, body: UpdateGoal } }, (r) =>
    app.changeGoal(key(r), r.params.id, r.body),
  );
  server.get('/sessions', { schema: { querystring: pageQuery } }, (r) => app.history(r.query.page));
  server.get('/sessions/list', { schema: { querystring: SessionListQuery } }, (r) => app.sessionList(r.query));
  server.get('/sessions/:id', { schema: { params } }, (r) => app.session(r.params.id));
  server.get('/sessions/:id/trace', { schema: { params, response: { 200: SessionTrace } } }, (r) =>
    app.trace(r.params.id),
  );
  server.get('/sessions/:id/research/export', { schema: { params } }, async (r, p) => {
    const detail = await app.session(r.params.id);
    p.header('Content-Disposition', `attachment; filename="research-${encodeURIComponent(r.params.id)}.json"`);
    return { question: detail.session.prompt, research: detail.research };
  });
  server.post('/sessions', { schema: { body: CreateSession } }, async (r, p) => {
    p.code(202);
    return app.addSession(key(r), r.body);
  });
  server.post('/sessions/:id/feedback', { schema: { params, body: Feedback } }, async (r, p) => {
    p.code(202);
    return app.feedback(key(r), r.params.id, r.body);
  });
  server.post('/sessions/:id/retry', { schema: { params, body: revisionBody } }, (r) =>
    app.retry(key(r), r.params.id, r.body.revision),
  );
  server.post('/sessions/:id/archive', { schema: { params, body: revisionBody } }, (r) =>
    app.archive(key(r), r.params.id, r.body.revision),
  );
  server.post('/runs/:id/cancel', { schema: { params } }, (r) => app.cancel(key(r), r.params.id));
  server.patch('/sessions/:id/draft', { schema: { params, body: DraftInput } }, (r) =>
    app.saveDraft(key(r), r.params.id, r.body),
  );
  server.get('/sessions/:id/export', { schema: { params } }, async (r, p) => {
    const detail = await app.session(r.params.id);
    p.header('Content-Disposition', `attachment; filename="session-${encodeURIComponent(r.params.id)}.md"`).type(
      'text/markdown; charset=utf-8',
    );
    return (
      '# ' +
      detail.session.title +
      '\n\n' +
      detail.session.content +
      '\n\n' +
      detail.artifacts.map((a) => '## ' + a.kind + ' (' + a.createdAt + ')\n\n' + a.content).join('\n\n')
    );
  });
}
