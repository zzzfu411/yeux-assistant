import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../packages/storage/src/index.js';
import { buildServer } from '../apps/api/src/server.js';
import { claimRun } from '../packages/core/src/runtime-state.js';
import { executeMailReplyRun } from '../packages/core/src/mail/reply.js';
import { executeErrandRun } from '../packages/core/src/errands/service.js';
import { SimulatedMailbox, compose } from '../packages/core/src/mail/mailbox.js';
import { putSource } from '../packages/core/src/knowledge.js';
import { simpleParser } from 'mailparser';
import { proposeRule } from '../packages/core/src/proposals.js';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
const me = 'me@smail.example.edu';
const notice =
  '关于课程展示报名的通知\n课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行。报名截止时间为 11 月 10 日 23:59，请将报名表发送至 gse-ta@example.edu。';

describe.runIf(Boolean(url))('mail threads, reply drafts and notice handling (synthetic mailbox and model)', () => {
  let built: Awaited<ReturnType<typeof buildServer>>, folder: string, model: Server, token: string;
  const instructions: string[] = [];
  let proposalDelay = 0,
    planQuestions: string[] = [],
    failMail = 0;
  beforeEach(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Isolated runtime test DB required');
    const setup = new Store(url!);
    await setup.exec(
      'DROP SCHEMA IF EXISTS checkpoints CASCADE; DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS app CASCADE',
    );
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-flows-'));
    built = await buildServer({ url, folder, assets: false });
    token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
    instructions.length = 0;
    proposalDelay = 0;
    planQuestions = [];
    failMail = 0;
    model = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const system: string = JSON.parse(raw).messages[0].content;
      instructions.push(system.split('\n')[1] || '');
      if (system.includes('RULE_PROPOSAL') && proposalDelay)
        await new Promise((resolve) => setTimeout(resolve, proposalDelay));
      if (system.includes('ERRAND_MAIL') && failMail > 0) {
        failMail--;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream busy' } }));
        return;
      }
      const content = system.includes('MAIL_REPLY')
        ? {
            subject: 'Re: 组会报告安排',
            body: '老师好：\n可以，周五 15:00 报告。\n张同学',
            sourceIds: ['profile-name'],
            questions: [],
          }
        : system.includes('ERRAND_EXTRACT')
          ? {
              title: '课程展示',
              organizer: { value: null, quote: '' },
              // A deliberate mistake: the registration deadline offered as the event start.
              eventStart: { value: '2026-11-10 23:59', quote: '报名截止时间为 11 月 10 日 23:59' },
              eventEnd: { value: null, quote: '' },
              registrationDeadline: { value: '2026-11-10 23:59', quote: '报名截止时间为 11 月 10 日 23:59' },
              submissionDeadline: { value: null, quote: '' },
              location: { value: '仙Ⅱ-204', quote: '在仙Ⅱ-204 举行' },
              contact: { value: 'gse-ta@example.edu', quote: '发送至 gse-ta@example.edu' },
              materials: [{ name: '报名表', quote: '请将报名表发送至', required: true }],
              actions: [{ action: '邮件报名', quote: '请将报名表发送至 gse-ta@example.edu', channel: 'email' }],
              unknowns: [],
            }
          : system.includes('ERRAND_PLAN')
            ? {
                summary: '需要在 11 月 10 日前邮件报名。',
                checklist: [{ item: '报名表', status: 'missing', note: '资料中没有模板', sourceIds: ['not-provided'] }],
                questions: planQuestions,
                mail: { needed: true, subject: '展示报名+张同学' },
                todos: [{ title: '填写报名表', due: '2026-11-10' }],
              }
            : system.includes('ERRAND_MAIL')
              ? { subject: '展示报名+张同学', body: '老师好：我报名参加课程展示。张同学' }
              : {
                  key: 'Mail Greeting',
                  scope: 'mail',
                  content: '给老师的邮件以“老师好”开头。',
                  rationale: '本人把称呼改为老师好',
                };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } }),
      );
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({
        llm: { base_url: 'http://127.0.0.1:' + (model.address() as AddressInfo).port + '/v1', model: 'synthetic' },
        mail_mode: 'simulation',
        mail_user: me,
        mail_auto_draft: 'direct',
        mail_daily_limit: 5,
      }),
    );
    await built.store.transaction((tx) =>
      putSource(tx, { id: 'profile-name', title: '本人信息', content: '本人姓名：张同学。组会报告一般安排在周五。' }),
    );
  });
  afterEach(async () => {
    model?.closeAllConnections();
    await new Promise<void>((resolve) => (model ? model.close(() => resolve()) : resolve()));
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  const api = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: unknown,
    key = path + JSON.stringify(payload ?? ''),
  ) =>
    built.server.inject({
      method,
      url: '/api/v2' + path,
      headers: {
        authorization: 'Bearer ' + token,
        ...(method === 'GET' ? {} : { 'idempotency-key': key.slice(0, 150) }),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function deliver(raw: Promise<Buffer>) {
    await new SimulatedMailbox(folder).append('inbox', await raw);
    return built.mail.poll();
  }
  async function execute(sessionId: string, executor: typeof executeMailReplyRun) {
    const session = await built.store.one('SELECT current_run_id FROM app.sessions WHERE id=$1', [sessionId]);
    const claim = (await claimRun(built.store, session!.current_run_id))!;
    await executor(built.store, folder, { runId: claim.id, generation: claim.generation });
  }

  it('threads a conversation, drafts with personal data, sends with reply headers and never duplicates', async () => {
    expect(
      await deliver(
        compose({
          from: 'ta@example.edu',
          to: me,
          subject: '组会报告安排',
          text: '请确认周五 15:00 报告。',
          messageId: '<q1@example.edu>',
        }),
      ),
    ).toEqual({ imported: 1, quarantined: 0 });
    const thread = (await built.store.one('SELECT * FROM app.mail_threads'))!;
    const session = (await built.store.one("SELECT * FROM app.sessions WHERE flow='mail-reply'"))!;
    expect(thread).toMatchObject({ subject: '组会报告安排', triage: 'drafting', session_id: session.id });
    expect(session.mail).toMatchObject({ threadId: thread.id, inReplyTo: '<q1@example.edu>' });
    await execute(session.id, executeMailReplyRun);
    const drafted = (await built.store.one('SELECT * FROM app.sessions WHERE id=$1', [session.id]))!;
    expect(drafted).toMatchObject({ state: 'ready', title: 'Re: 组会报告安排', recipient: 'ta@example.edu' });
    expect(drafted.citations.map((c: { sourceId: string }) => c.sourceId)).toEqual(['profile-name']);
    expect(instructions.some((line) => line === 'MAIL_REPLY')).toBe(true);

    const approval = (await api('POST', `/sessions/${session.id}/approval`, { revision: drafted.revision })).json();
    expect(approval.payload).toMatchObject({ inReplyTo: '<q1@example.edu>', references: ['<q1@example.edu>'], cc: [] });
    expect(
      (await api('POST', `/approvals/${approval.id}/decision`, { digest: approval.digest, approve: true })).statusCode,
    ).toBe(200);
    expect(await built.mail.sendOne()).toBe(true);
    const sent = await readdir(join(folder, 'mail-sim', 'Sent'));
    expect(sent).toHaveLength(1);
    const raw = await readFile(join(folder, 'mail-sim', 'Sent', sent[0]!), 'utf8');
    const parsed = await simpleParser(raw);
    expect(parsed).toMatchObject({ subject: 'Re: 组会报告安排', inReplyTo: '<q1@example.edu>' });
    expect(parsed.text).toContain('周五 15:00');
    expect((await built.store.one('SELECT triage FROM app.mail_threads WHERE id=$1', [thread.id]))!.triage).toBe(
      'replied',
    );

    // Polling again reads the Sent copy: same Message-ID, no duplicate message, no new session.
    await built.mail.poll();
    await built.mail.poll();
    expect(Number((await built.store.one('SELECT count(*) n FROM app.mail_messages'))!.n)).toBe(2);
    expect(Number((await built.store.one("SELECT count(*) n FROM app.sessions WHERE flow='mail-reply'"))!.n)).toBe(1);
    expect(Number((await built.store.one("SELECT count(*) n FROM app.approvals WHERE state='sent'"))!.n)).toBe(1);

    // The teacher answers in the same thread: it joins the thread and starts a fresh draft.
    const sentId = raw.match(/Message-ID: (<[^>]+>)/i)![1]!;
    await deliver(
      compose({
        from: 'ta@example.edu',
        to: me,
        subject: 'Re: Re: 组会报告安排',
        text: '收到，谢谢。',
        messageId: '<q2@example.edu>',
        inReplyTo: sentId,
        references: ['<q1@example.edu>', sentId],
      }),
    );
    expect(Number((await built.store.one('SELECT count(*) n FROM app.mail_threads'))!.n)).toBe(1);
    expect(Number((await built.store.one("SELECT count(*) n FROM app.sessions WHERE flow='mail-reply'"))!.n)).toBe(2);
  });

  it('keeps lists as history, converts HTML-only mail and hands matching notices to a flow', async () => {
    await built.store.exec(
      `INSERT INTO app.flows(id,path,version,digest,enabled,definition) VALUES('showcase','flows/showcase.md',1,'d',true,$1)`,
      [
        JSON.stringify({
          id: 'showcase',
          title: '课程展示报名',
          version: 1,
          trigger: { manual: true, mail: { subject_any: ['报名'] } },
          steps: ['extract_notice', 'retrieve', 'draft_mail', 'calendar', 'archive'],
          instructions: '截止时间与活动时间分开。',
        }),
      ],
    );
    const list = (
      await compose({
        from: 'lib@example.edu',
        to: 'all@example.edu',
        subject: '讲座周报',
        text: '本周讲座……',
        messageId: '<l1@example.edu>',
      })
    )
      .toString()
      .replace('Subject:', 'List-Id: <weekly.example.edu>\r\nSubject:');
    await deliver(Promise.resolve(Buffer.from(list)));
    const html = Buffer.from(
      `From: office@example.edu\r\nTo: ${me}\r\nSubject: Web notice\r\nMessage-ID: <h1@example.edu>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>请<b>周三</b>前提交表格</p>`,
    );
    await deliver(Promise.resolve(html));
    await deliver(
      compose({
        from: 'gse-ta@example.edu',
        to: me,
        subject: '课程展示报名通知',
        text: notice,
        messageId: '<n1@example.edu>',
      }),
    );
    const threads = await built.store.rows('SELECT subject,triage FROM app.mail_threads ORDER BY subject');
    expect(threads).toEqual(
      expect.arrayContaining([
        { subject: '讲座周报', triage: 'bulk' },
        { subject: 'Web notice', triage: 'drafting' },
        { subject: '课程展示报名通知', triage: 'errand' },
      ]),
    );
    expect(
      await built.store.one("SELECT body_origin,body_text FROM app.mail_messages WHERE message_id='<h1@example.edu>'"),
    ).toMatchObject({ body_origin: 'html', body_text: expect.stringContaining('周三') });
    const errand = (await built.store.one("SELECT * FROM app.sessions WHERE flow='errand'"))!;
    expect(errand).toMatchObject({ flow_id: 'showcase', flow_version: 1 });
    expect(Number((await built.store.one("SELECT count(*) n FROM app.sessions WHERE title='讲座周报'"))!.n)).toBe(0);
  });

  it('verifies notice facts, drafts a confirmable email, exports a calendar and archives into Git', async () => {
    const created = (await api('POST', '/errands', { text: notice })).json();
    // Two long structured calls on a real model: the flow gets its own budget, not the 180 s default.
    expect(
      await built.store.one('SELECT max_model_calls,max_seconds FROM app.runs WHERE session_id=$1', [
        created.sessionId,
      ]),
    ).toEqual({ max_model_calls: 5, max_seconds: 480 });
    await execute(created.sessionId, executeErrandRun);
    // Nothing to ask: the plan is followed by one separate call for the letter.
    expect(instructions.filter((line) => line.startsWith('ERRAND'))).toEqual([
      'ERRAND_EXTRACT',
      'ERRAND_PLAN',
      'ERRAND_MAIL',
    ]);
    const detail = (await api('GET', '/sessions/' + created.sessionId)).json();
    const facts = detail.errand.state.facts;
    expect(facts.eventStart.value).toBeNull();
    expect(facts.unknowns.join()).toContain('不能当作活动开始时间');
    expect(facts.registrationDeadline.value).toBe('2026-11-10 23:59');
    // The raw extraction is kept so later runs re-check it with the current guards, without a model call.
    expect(detail.errand.state.extracted.eventStart.value).toBe('2026-11-10 23:59');
    expect(detail.session.state).toBe('ready');
    expect(detail.errand.state.plan.checklist[0].sourceIds).toEqual([]);
    expect(detail.errand.mailSession).toMatchObject({ recipient: 'gse-ta@example.edu', state: 'ready' });
    expect(detail.related).toEqual([expect.objectContaining({ relation: 'child' })]);
    expect(await built.store.one("SELECT id FROM app.sources WHERE id LIKE 'notice-%'")).toBeTruthy();

    const calendar = await api('GET', `/sessions/${created.sessionId}/errand/calendar`);
    expect(calendar.headers['content-type']).toContain('text/calendar');
    expect(calendar.body).toContain('截止：报名');
    expect(calendar.body).not.toContain('SUMMARY:课程展示\r');

    const suggestion = (await api('GET', `/sessions/${created.sessionId}/errand/flow-draft`)).json();
    expect(suggestion.definition.steps[0]).toBe('extract_notice');
    expect(suggestion.definition.steps).toContain('draft_mail');

    const archived = (
      await api('POST', `/sessions/${created.sessionId}/errand/archive`, { revision: detail.session.revision })
    ).json();
    expect(archived.path).toMatch(/^records\/\d{4}\/\d{2}-\d{2}-/);
    const record = await readFile(join(folder, 'workspace', archived.path), 'utf8');
    expect(record).toContain('## 事实：通知要素');
    expect(record).toContain('报名截止时间：2026-11-10 23:59');
    expect(
      await built.store.one('SELECT id FROM app.sources WHERE path=$1', ['workspace/' + archived.path]),
    ).toBeTruthy();
    expect((await built.store.one('SELECT state FROM app.sessions WHERE id=$1', [created.sessionId]))!.state).toBe(
      'completed',
    );
    // Replaying the same archive request does not commit twice.
    const replay = (
      await api('POST', `/sessions/${created.sessionId}/errand/archive`, { revision: detail.session.revision })
    ).json();
    expect(replay.commit).toBe(archived.commit);
  });

  it('asks before writing the letter, writes it once after the answer, and a retry reuses the saved plan', async () => {
    planQuestions = ['请提供你的学号。'];
    const created = (await api('POST', '/errands', { text: notice })).json();
    await execute(created.sessionId, executeErrandRun);
    let detail = (await api('GET', '/sessions/' + created.sessionId)).json();
    expect(detail.session.state).toBe('waiting_feedback');
    expect(detail.errand.state.questions).toEqual(['请提供你的学号。']);
    // A letter written before the answer would be thrown away: it is not requested yet.
    expect(instructions.filter((line) => line === 'ERRAND_MAIL')).toHaveLength(0);
    expect(detail.errand.mailSession).toBeNull();

    planQuestions = [];
    failMail = 1;
    const answered = await api('POST', `/sessions/${created.sessionId}/feedback`, {
      revision: detail.session.revision,
      answer: '学号 MG00000001',
    });
    expect(answered.statusCode).toBe(202);
    // The letter request fails once; the checklist is already saved for the owner to read.
    await expect(execute(created.sessionId, executeErrandRun)).rejects.toThrow(/HTTP 500/);
    detail = (await api('GET', '/sessions/' + created.sessionId)).json();
    expect(detail.errand.state.plan.checklist[0].item).toBe('报名表');
    const plans = instructions.filter((line) => line === 'ERRAND_PLAN').length;

    // The retry of that same run asks only for the letter, not for a second plan or extraction.
    const run = (await built.store.one('SELECT current_run_id FROM app.sessions WHERE id=$1', [created.sessionId]))!;
    const claim = (await claimRun(built.store, run.current_run_id))!;
    await executeErrandRun(built.store, folder, { runId: claim.id, generation: claim.generation });
    expect(instructions.filter((line) => line === 'ERRAND_PLAN')).toHaveLength(plans);
    expect(instructions.filter((line) => line === 'ERRAND_EXTRACT')).toHaveLength(1);
    detail = (await api('GET', '/sessions/' + created.sessionId)).json();
    expect(detail.session.state).toBe('ready');
    expect(detail.errand.mailSession).toMatchObject({ recipient: 'gse-ta@example.edu', state: 'ready' });
    expect(detail.errand.state.answers).toHaveLength(1);
  });

  it('turns an owner edit into an unconfirmed rule proposal, never straight into Git', async () => {
    await deliver(
      compose({
        from: 'ta@example.edu',
        to: me,
        subject: '材料确认',
        text: '请确认材料。',
        messageId: '<r1@example.edu>',
      }),
    );
    const session = (await built.store.one("SELECT * FROM app.sessions WHERE flow='mail-reply'"))!;
    await execute(session.id, executeMailReplyRun);
    const ready = (await built.store.one('SELECT revision FROM app.sessions WHERE id=$1', [session.id]))!;
    const edited = await api('PATCH', `/sessions/${session.id}/draft`, {
      revision: ready.revision,
      content: '老师好：\n材料我已经核对完毕，周五前发给您，另附清单与说明，谢谢老师。\n张同学',
      recipient: 'ta@example.edu',
    });
    expect(edited.statusCode).toBe(200);
    const proposal = await api('POST', `/sessions/${session.id}/rule-proposal`, { revision: edited.json().revision });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json()).toMatchObject({ key: 'mail-greeting', scope: 'mail' });
    expect(await built.store.one('SELECT confirmed,path FROM app.memories WHERE key=$1', ['mail-greeting'])).toEqual({
      confirmed: false,
      path: null,
    });
  });
  it('answers "pending" when the model is slower than the request, then notifies once without a second call', async () => {
    await deliver(
      compose({
        from: 'ta@example.edu',
        to: me,
        subject: '材料确认',
        text: '请确认材料。',
        messageId: '<r2@example.edu>',
      }),
    );
    const session = (await built.store.one("SELECT * FROM app.sessions WHERE flow='mail-reply'"))!;
    await execute(session.id, executeMailReplyRun);
    const ready = (await built.store.one('SELECT revision FROM app.sessions WHERE id=$1', [session.id]))!;
    const edited = await api('PATCH', `/sessions/${session.id}/draft`, {
      revision: ready.revision,
      content: '老师好：\n材料我已经核对完毕，周五前发给您，另附清单与说明，谢谢老师。\n张同学',
      recipient: 'ta@example.edu',
    });
    proposalDelay = 400;
    const rules = built.app.workspace.rules;
    const revision = edited.json().revision;
    // Real models take 30–60 s while the API closes idle requests at 20 s: answer early instead.
    const first = await proposeRule(built.store, folder, rules, 'slow-proposal', session.id, revision, 50);
    const retry = await proposeRule(built.store, folder, rules, 'slow-proposal-retry', session.id, revision, 50);
    expect(first).toEqual({ pending: true });
    expect(retry).toEqual({ pending: true });
    await expect
      .poll(() => built.store.one("SELECT title FROM app.notifications WHERE dedupe_key='rule-proposal:slow-proposal'"))
      .toEqual({ title: '规则提议已生成，等你确认' });
    expect(instructions.filter((line) => line === 'RULE_PROPOSAL')).toHaveLength(1);
    expect(await built.store.one('SELECT confirmed FROM app.memories WHERE key=$1', ['mail-greeting'])).toEqual({
      confirmed: false,
    });
    // The owner's retry with the original request key now gets the saved result.
    expect(await proposeRule(built.store, folder, rules, 'slow-proposal', session.id, revision, 50)).toMatchObject({
      key: 'mail-greeting',
    });
  });
});
