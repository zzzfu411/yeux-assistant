import { z } from 'zod';
import type { Application } from '../../../../packages/core/src/application.js';
import {
  MailSettingsInput,
  MailSimulateInput,
  MailThreadAction,
  MailTriageInput,
  PushRemoveInput,
  PushSubscriptionInput,
} from '../../../../packages/contracts/src/mail.js';
import { CreateErrandInput, ErrandActionInput } from '../../../../packages/contracts/src/errands.js';
import { type ApiServer, key, params } from './shared.js';

const empty = z.object({}).strict();
const threadQuery = z
  .object({
    filter: z.enum(['all', 'new', 'drafting', 'replied', 'errand', 'bulk', 'ignored']).default('all'),
    page: z.coerce.number().int().min(0).max(1000).default(0),
  })
  .strict();

/** Mail threads, notice handling (errands), rule proposals and phone push. */
export function registerAssistantRoutes(server: ApiServer, app: Application) {
  server.get('/mail/threads', { schema: { querystring: threadQuery } }, (r) =>
    app.mail.threads(r.query.filter, r.query.page),
  );
  server.get('/mail/threads/:id', { schema: { params } }, (r) => app.mail.thread(r.params.id));
  server.post('/mail/threads/:id/draft', { schema: { params, body: MailThreadAction } }, (r) =>
    app.mail.draft(key(r), r.params.id, r.body),
  );
  server.post('/mail/threads/:id/triage', { schema: { params, body: MailTriageInput } }, (r) =>
    app.mail.triage(key(r), r.params.id, r.body),
  );
  server.post('/mail/threads/:id/errand', { schema: { params, body: MailThreadAction } }, (r) =>
    app.mail.errand(key(r), r.params.id, r.body),
  );
  server.post('/mail/poll', { schema: { body: empty } }, () => app.mail.pollNow());
  server.post('/mail/simulate', { schema: { body: MailSimulateInput } }, (r) => app.mail.simulate(key(r), r.body));
  server.get('/settings/mail', () => app.settings.getMail());
  server.patch('/settings/mail', { schema: { body: MailSettingsInput } }, (r) => app.saveMailSettings(key(r), r.body));
  server.post('/settings/mail/test', { schema: { body: empty } }, () => app.testMail());

  server.post('/errands', { schema: { body: CreateErrandInput } }, (r) => app.addErrand(key(r), r.body));
  server.post('/sessions/:id/errand/archive', { schema: { params, body: ErrandActionInput } }, (r) =>
    app.archiveErrand(key(r), r.params.id, r.body),
  );
  server.get('/sessions/:id/errand/calendar', { schema: { params } }, async (r, reply) => {
    const ics = await app.errandCalendar(r.params.id);
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="yeux-errand.ics"');
    return ics;
  });
  server.get('/sessions/:id/errand/flow-draft', { schema: { params } }, (r) => app.errandFlowDraft(r.params.id));
  server.post('/sessions/:id/rule-proposal', { schema: { params, body: ErrandActionInput } }, (r) =>
    app.proposeRule(key(r), r.params.id, r.body),
  );

  server.get('/push/key', () => app.push.publicKey());
  server.get('/push/devices', () => app.push.devices());
  server.post('/push/subscriptions', { schema: { body: PushSubscriptionInput } }, (r) =>
    app.push.subscribe(key(r), r.body),
  );
  server.post('/push/subscriptions/remove', { schema: { body: PushRemoveInput } }, (r) =>
    app.push.unsubscribe(key(r), r.body),
  );
  server.post('/push/test', { schema: { body: empty } }, () => app.push.test());
}
