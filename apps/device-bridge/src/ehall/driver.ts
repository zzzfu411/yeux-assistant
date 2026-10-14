import { createHash } from 'node:crypto';
import type { BrowserContext, Locator, Page } from 'playwright';
import { BridgeCall } from '../../../../packages/contracts/src/device-bridge.js';
import {
  EhallFields,
  EhallPrepare,
  EhallSubmit,
  ehallProfile,
  type EhallState,
} from '../../../../packages/contracts/src/ehall.js';
import { LocalNotApplied, type LocalDevice } from '../local.js';

const forbiddenText = /退课|撤销|撤回|删除|取消申请|放弃|注销/;
const forbiddenPath = /withdraw|cancel|delete|tuike/i;
export async function clickReviewed(button: Locator, expected: string) {
  const text = (await button.innerText()).trim();
  if (forbiddenText.test(text) || text !== expected) throw new LocalNotApplied('blocked');
  await button.click({ timeout: 5000 });
}
export function allowedEhallRequest(raw: string, method: string, origin: string, submit: boolean, manual: boolean) {
  const url = new URL(raw);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    forbiddenPath.test(decodeURIComponent(url.pathname))
  )
    return false;
  if (method === 'GET')
    return ['/', '/login', '/form', '/frame', '/query', '/status', '/favicon.ico'].includes(url.pathname);
  return method === 'POST' && ((url.pathname === '/api/submit' && submit) || (url.pathname === '/api/login' && manual));
}
export async function ehallDriver(
  context: BrowserContext,
  origin = 'http://127.0.0.1:8777',
): Promise<LocalDevice & { close(): Promise<void> }> {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin)
    throw new Error('模拟 ehall 仅接受本机回环站点。');
  let page: Page | undefined,
    active = false,
    submit = false,
    blocked = false,
    expectedBody: unknown;
  const base = { profile: ehallProfile.id, profileVersion: '1', simulation: true } as const;
  await context.route('**/*', async (route) => {
    if (!allowedEhallRequest(route.request().url(), route.request().method(), origin, submit, !active)) {
      if (active) blocked = true;
      await route.abort();
    } else if (route.request().method() === 'POST' && new URL(route.request().url()).pathname === '/api/submit') {
      let body: unknown;
      try {
        body = route.request().postDataJSON();
      } catch {}
      if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
        blocked = true;
        await route.abort();
      } else {
        submit = false;
        await route.continue();
      }
    } else await route.continue();
  });
  await context.routeWebSocket('**/*', (socket) => {
    blocked = true;
    socket.close();
  });
  context.on('page', (other) => {
    if (page && other !== page) void other.close();
  });
  for (const existing of context.pages()) await existing.close();
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10000 });
  const current = () => {
    if (!page || page.isClosed()) throw new LocalNotApplied('not_applied');
    return page;
  };
  const identity = async () => {
    const node = current().locator('[data-account]');
    const account = (await node.count()) ? await node.getAttribute('data-account') : null;
    if (!account) throw new LocalNotApplied('login_required');
    return account;
  };
  const form = async (): Promise<EhallState> => {
    const account = await identity(),
      frame = current().frameLocator('#application');
    const fields = EhallFields.parse({
      applicant: await frame.locator('#applicant').inputValue(),
      purpose: await frame.locator('#purpose').inputValue(),
    });
    const formDigest = createHash('sha256')
      .update(JSON.stringify([ehallProfile.id, '1', account, fields.applicant, fields.purpose]))
      .digest('hex');
    return { ...base, loggedIn: true, account, phase: 'form', fields, formDigest };
  };
  const bounded = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (active) throw new LocalNotApplied('not_applied');
    active = true;
    blocked = false;
    let closing: Promise<unknown> | undefined;
    const stop = () => {
      submit = false;
      closing = page?.close().catch(() => {});
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      const value = await work();
      signal.throwIfAborted();
      if (blocked) throw new Error('Unreviewed request blocked during operation');
      return value;
    } finally {
      submit = false;
      active = false;
      signal.removeEventListener('abort', stop);
      await closing;
    }
  };
  return {
    async read(signal, raw) {
      const call = BridgeCall.parse(raw);
      if (call.adapter !== 'browser.ehall') throw new LocalNotApplied('blocked');
      return bounded(signal, async () => {
        const p = current();
        if (call.capability === 'ehall.form.submit' && call.phase === 'before') return form();
        if (call.capability === 'ehall.form.prepare' && call.phase === 'after') return form();
        const route =
          call.capability === 'ehall.query' ? '/query' : call.capability === 'ehall.form.submit' ? '/status' : '/';
        await p.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 10000 });
        let account: string;
        try {
          account = await identity();
        } catch (error) {
          if (call.capability === 'ehall.session.check')
            return { ...base, loggedIn: false, account: null, phase: 'session' };
          throw error;
        }
        if (call.capability === 'ehall.query') {
          const rows = await p.locator('[data-course]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              course: node.getAttribute('data-course') || '',
              time: node.getAttribute('data-time') || '',
            })),
          );
          return { ...base, loggedIn: true, account, phase: 'query', rows };
        }
        if (call.capability === 'ehall.form.submit') {
          const row = p.locator('[data-application="' + call.commandId + '"]');
          if ((await row.count()) !== 1) throw new Error('Submitted application not found');
          return {
            ...base,
            loggedIn: true,
            account,
            phase: 'status',
            application: {
              id: call.commandId,
              state: await row.innerText(),
              formDigest: await row.getAttribute('data-digest'),
            },
          };
        }
        return { ...base, loggedIn: true, account, phase: 'session' };
      });
    },
    async execute(input, signal, raw) {
      const call = BridgeCall.parse(raw);
      if (call.adapter !== 'browser.ehall') throw new LocalNotApplied('blocked');
      await bounded(signal, async () => {
        if (call.capability === 'ehall.session.check' || call.capability === 'ehall.query') return;
        if (call.capability === 'ehall.form.prepare') {
          const data = EhallPrepare.parse(input),
            p = current();
          await p.goto(origin + '/form', { waitUntil: 'domcontentloaded', timeout: 10000 });
          await identity();
          const frame = p.frameLocator('#application');
          await frame.locator('#applicant').fill(data.fields.applicant);
          await frame.locator('#purpose').fill(data.fields.purpose);
          // Preparation never clicks a button or enables a write request.
          return;
        }
        const data = EhallSubmit.parse(input),
          before = await form();
        if (before.formDigest !== data.formDigest || JSON.stringify(before.fields) !== JSON.stringify(data.fields))
          throw new LocalNotApplied('not_applied');
        const frame = current().frameLocator('#application');
        await frame.locator('#command').fill(call.commandId);
        const button = frame.locator('#submit');
        // Check before arming POST. No model-provided selector, URL, script, or button text is accepted.
        if ((await button.innerText()).trim() !== '提交' || forbiddenText.test(await button.innerText()))
          throw new LocalNotApplied('blocked');
        signal.throwIfAborted();
        expectedBody = { id: call.commandId, fields: data.fields };
        submit = true;
        const response = current().waitForResponse(
          (r) => r.url() === origin + '/api/submit' && r.request().method() === 'POST',
          { timeout: 10000 },
        );
        await button.click();
        if (!(await response).ok()) throw new Error('Submission response unknown');
        submit = false;
      });
    },
    async evidence(signal, raw) {
      const call = BridgeCall.parse(raw);
      if (call.adapter !== 'browser.ehall' || call.phase !== 'after') return null;
      return bounded(signal, () => current().screenshot({ type: 'png', fullPage: false, timeout: 5000 }));
    },
    async close() {
      await context.close();
    },
  };
}
