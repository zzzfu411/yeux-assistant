import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../apps/api/src/server.js';
import { Store } from '../packages/storage/src/index.js';
import { DeviceBridges } from '../packages/core/src/devices/bridge.js';
import { setAdministrator } from '../packages/core/src/auth.js';
import { BridgeCall } from '../packages/contracts/src/device-bridge.js';
import { ehallProfile, EhallState } from '../packages/contracts/src/ehall.js';
import { ehallDriver, allowedEhallRequest, clickReviewed } from '../apps/device-bridge/src/ehall/driver.js';
import { runDeviceBridge } from '../apps/device-bridge/src/client.js';
import { startEhallSimulator } from '../scripts/ehall-simulator-server.js';

const url = process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('ehall simulation: real browser, bridge HTTP and isolated PostgreSQL', () => {
  let built: Awaited<ReturnType<typeof buildServer>>,
    browser: Browser,
    context: BrowserContext,
    folder: string,
    address: string,
    cookie: string;
  let fixture: Awaited<ReturnType<typeof startEhallSimulator>>,
    driver: Awaited<ReturnType<typeof ehallDriver>>,
    stop: AbortController,
    loop: Promise<void>;
  let deviceId: string, token: string;
  const base = { profile: ehallProfile.id, profileVersion: '1' },
    fields = { applicant: '示例同学', purpose: 'Lab1 合成申请' },
    sources = { applicant: '本人填写', purpose: '本人填写' };
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
    const setup = new Store(url);
    await setup.exec('DROP SCHEMA IF EXISTS queue CASCADE');
    await setup.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await setup.close();
    folder = await mkdtemp(join(tmpdir(), 'yeux-ehall-'));
    built = await buildServer({ url, folder, assets: false });
    await setAdministrator(folder, 'fixture-owner', 'Synthetic-only-password');
    const login = await built.server.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: 'fixture-owner', password: 'Synthetic-only-password' },
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    address = await built.server.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({
      headless: true,
      channel: existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined,
    });
  });
  beforeEach(async () => {
    await built.store.exec(
      'TRUNCATE app.action_evidence,app.device_bridge_calls,app.device_bridges,app.device_commands,app.device_simulation_state,app.devices,app.commands,app.notifications',
    );
    await built.store.exec('UPDATE app.device_control SET enabled=true,revision=1');
    fixture = await startEhallSimulator(0);
    fixture.state.loggedIn = true;
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 900, height: 760 },
      acceptDownloads: false,
    });
    driver = await ehallDriver(context, fixture.origin);
    const issued = await new DeviceBridges(built.store, folder).issue(randomUUID(), {
      name: 'ehall 合成连接',
      adapter: 'browser.ehall',
    });
    deviceId = issued.deviceId;
    token = issued.token!;
    stop = new AbortController();
    loop = runDeviceBridge(
      { server: address, deviceId, token, adapter: 'browser.ehall' },
      driver,
      join(folder, 'journal', deviceId),
      stop.signal,
    );
  });
  afterEach(async () => {
    stop?.abort();
    await loop;
    await driver?.close();
    await fixture?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await built?.server.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });
  async function command(capability: string, args: unknown) {
    const pending = await built.devices.request(randomUUID(), deviceId, { revision: 1, capability, arguments: args });
    expect(pending.state).toBe('pending');
    await built.devices.decide(randomUUID(), pending.id, {
      revision: pending.revision,
      digest: pending.digest,
      approve: true,
    });
    await built.devices.process(pending.id);
    return built.devices.getCommand(pending.id);
  }
  async function prepare() {
    const cmd = await command('ehall.form.prepare', { ...base, fields, sources });
    expect(cmd.state, cmd.error).toBe('succeeded');
    const state = EhallState.parse(cmd.receipt!.after);
    return {
      cmd,
      args: {
        ...base,
        fields,
        sources,
        preparedCommandId: cmd.id,
        formDigest: state.formDigest,
        screenshotDigest: state.screenshotDigest,
      },
    };
  }
  it('queries into versioned knowledge, previews without submitting, confirms exact fields, and reads back the application', async () => {
    expect((await command('ehall.session.check', base)).receipt?.after?.loggedIn).toBe(true);
    const query = await command('ehall.query', base);
    expect(query.state, query.error).toBe('succeeded');
    const source = await built.store.one('SELECT id,version FROM app.sources WHERE path=$1', [
      'ehall/' + deviceId + '/timetable',
    ]);
    expect(source).toBeTruthy();
    expect((await command('ehall.query', base)).state).toBe('succeeded');
    expect((await built.store.one('SELECT version FROM app.sources WHERE id=$1', [source!.id]))!.version).toBe(2);
    const { cmd, args } = await prepare();
    expect(fixture.state.submissions).toHaveLength(0);
    const evidence = await built.server.inject({
      url: '/api/v2/device-commands/' + cmd.id + '/evidence/' + args.screenshotDigest,
      headers: { cookie },
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(
      (await built.server.inject({ url: '/api/v2/device-commands/' + cmd.id + '/evidence/' + args.screenshotDigest }))
        .statusCode,
    ).toBe(401);
    const submitted = await command('ehall.form.submit', args);
    expect(submitted.state, submitted.error).toBe('succeeded');
    expect(submitted.receipt?.after?.application).toMatchObject({ id: submitted.id, state: '待审核（模拟）' });
    expect(fixture.state.submissions).toHaveLength(1);
    await built.devices.process(submitted.id);
    expect(fixture.state.submissions).toHaveLength(1);
    await expect(
      built.devices.request(randomUUID(), deviceId, { revision: 1, capability: 'ehall.form.submit', arguments: args }),
    ).rejects.toMatchObject({ code: 'ehall_already_submitted' });
  });
  it('refuses forged previews and detects a manually changed field before dispatch', async () => {
    const { args } = await prepare();
    await expect(
      built.devices.request(randomUUID(), deviceId, {
        revision: 1,
        capability: 'ehall.form.submit',
        arguments: { ...args, fields: { ...fields, purpose: '篡改' } },
      }),
    ).rejects.toMatchObject({ code: 'ehall_preview_changed' });
    await context.pages()[0]!.frameLocator('#application').locator('#purpose').fill('准备后手动修改');
    const result = await command('ehall.form.submit', args);
    expect(result.state).toBe('failed');
    expect(fixture.state.submissions).toHaveLength(0);
  });
  it('blocks forbidden selectors, requests, and cross-origin navigation; preparation cannot POST', async () => {
    const { args } = await prepare(),
      page = context.pages()[0]!;
    await expect(clickReviewed(page.frameLocator('#application').locator('#withdraw'), '提交')).rejects.toMatchObject({
      effect: 'blocked',
    });
    await page.frameLocator('#application').locator('#withdraw').click();
    await delay(100);
    expect(fixture.state.forbidden).toBe(0);
    expect(allowedEhallRequest(fixture.origin + '/api/submit', 'POST', fixture.origin, false, false)).toBe(false);
    expect(allowedEhallRequest('https://example.com/', 'GET', fixture.origin, true, true)).toBe(false);
    await page
      .frameLocator('#application')
      .locator('#submit')
      .evaluate((node) => (node.textContent = '撤销申请'));
    expect((await command('ehall.form.submit', args)).state).toBe('failed');
    expect(fixture.state.submissions).toHaveLength(0);
    await expect(page.goto('https://example.com/')).rejects.toThrow();
  });
  it('reports logged out explicitly and never submits through an expired login', async () => {
    fixture.state.loggedIn = false;
    const check = await command('ehall.session.check', base);
    expect(check.state).toBe('succeeded');
    expect(check.receipt?.after?.loggedIn).toBe(false);
    const result = await command('ehall.form.prepare', { ...base, fields, sources });
    expect(result.state).toBe('failed');
    expect(result.error).toContain('登录');
    expect(fixture.state.submissions).toHaveLength(0);
  });
  it('cancellation after dispatch keeps an uncertain receipt and rejects the late browser result without resubmitting', async () => {
    const { args } = await prepare();
    fixture.state.delaySubmit = 800;
    const pending = await built.devices.request(randomUUID(), deviceId, {
      revision: 1,
      capability: 'ehall.form.submit',
      arguments: args,
    });
    await built.devices.decide(randomUUID(), pending.id, {
      revision: pending.revision,
      digest: pending.digest,
      approve: true,
    });
    const processing = built.devices.process(pending.id);
    const until = Date.now() + 10000;
    while (!fixture.state.submissions.length) {
      if (Date.now() > until) throw new Error('submit not reached');
      await delay(20);
    }
    const current = await built.devices.getCommand(pending.id);
    await built.devices.cancel(randomUUID(), current.id, { revision: current.revision });
    await processing;
    expect((await built.devices.getCommand(pending.id)).state).toBe('uncertain');
    await built.devices.process(pending.id);
    expect(fixture.state.submissions).toHaveLength(1);
  }, 40000);
  it('strict protocol rejects arbitrary URLs, unknown actions, and altered profile versions', () => {
    const sample = {
      id: randomUUID(),
      lease: randomUUID(),
      deviceId,
      commandId: randomUUID(),
      adapter: 'browser.ehall',
      version: '1',
      phase: 'write',
      kind: 'execute',
      capability: 'ehall.form.prepare',
      arguments: { ...base, fields, sources },
    };
    expect(BridgeCall.safeParse(sample).success).toBe(true);
    for (const modified of [
      { ...sample, capability: 'ehall.withdraw' },
      { ...sample, arguments: { ...sample.arguments, url: 'https://example.com' } },
      { ...sample, arguments: { ...sample.arguments, profileVersion: '2' } },
    ])
      expect(BridgeCall.safeParse(modified).success).toBe(false);
  });
});
