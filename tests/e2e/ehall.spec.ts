import { test, expect, type Page } from '@playwright/test';
const deviceId = '00000000-0000-4000-8000-000000000031',
  preparedId = '00000000-0000-4000-8000-000000000032',
  submitId = '00000000-0000-4000-8000-000000000033';
const fields = { applicant: '合成示例同学', purpose: '用于生成式软件工程实验的模拟在读证明' },
  sources = { applicant: '本人填写', purpose: '本人填写' };
const args = { profile: 'lab1-simulation', profileVersion: '1', fields, sources };
async function setup(page: Page) {
  const state = {
    writes: [] as any[],
    commands: [
      {
        id: preparedId,
        deviceId,
        deviceName: 'ehall 模拟连接',
        mode: 'simulation',
        capability: 'ehall.form.prepare',
        arguments: args,
        summary: '准备模拟在读证明',
        digest: 'a'.repeat(64),
        state: 'succeeded',
        revision: 3,
        expiresAt: new Date(Date.now() + 240000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: '',
        receipt: {
          source: 'simulation',
          outcome: 'verified',
          checkedAt: new Date().toISOString(),
          after: {
            profile: 'lab1-simulation',
            profileVersion: '1',
            simulation: true,
            loggedIn: true,
            account: '模拟学生',
            phase: 'form',
            fields,
            formDigest: 'b'.repeat(64),
            screenshotDigest: 'c'.repeat(64),
          },
        },
      },
    ] as any[],
  };
  await page.route('**/api/v2/**', (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.slice('/api/v2'.length);
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/session') return json({ username: 'synthetic-owner' });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/devices')
      return json({
        control: { enabled: true, revision: 1 },
        workerOnline: true,
        serverTime: new Date().toISOString(),
        devices: [
          {
            id: deviceId,
            name: 'ehall 模拟连接',
            adapter: 'browser.ehall',
            mode: 'simulation',
            enabled: true,
            revision: 1,
            available: true,
            connection: {
              online: true,
              revoked: false,
              expiresAt: '2026-12-01T00:00:00Z',
              lastSeenAt: new Date().toISOString(),
            },
            capabilities: [],
            observedState: state.commands.find((cmd) => cmd.id === preparedId).receipt.after,
            observedAt: new Date().toISOString(),
          },
        ],
      });
    if (path === '/device-commands') return json(state.commands);
    if (path.includes('/evidence/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
    if (req.method() === 'POST') {
      state.writes.push({ path, body: req.postDataJSON() });
      if (path === '/devices/' + deviceId + '/commands') {
        const input = req.postDataJSON();
        const cmd = {
          ...state.commands[0],
          id: submitId,
          arguments: input.arguments,
          capability: input.capability,
          state: 'pending',
          revision: 1,
          receipt: null,
          summary: '提交模拟在读证明',
          digest: 'd'.repeat(64),
        };
        state.commands.unshift(cmd);
        return json(cmd);
      }
      if (path === '/device-commands/' + submitId + '/decision') {
        const cmd = state.commands[0];
        cmd.state = 'approved';
        cmd.revision++;
        return json(cmd);
      }
    }
    if (path.startsWith('/device-commands/')) return json(state.commands.find((cmd) => path.endsWith('/' + cmd.id)));
    return json([]);
  });
  await page.goto('/#/devices');
  return state;
}
test('模拟表单保留填写草稿；核对字段、预览截图之后仍需单独确认提交', async ({ page }, info) => {
  const state = await setup(page);
  await page.getByLabel('申请人', { exact: true }).fill('新示例');
  await page.getByLabel('申请用途', { exact: true }).fill('新的模拟用途');
  await page.reload();
  await expect(page.getByLabel('申请人', { exact: true })).toHaveValue('新示例');
  const prepare = page.locator('#device-command-' + preparedId);
  await expect(prepare.getByRole('definition').filter({ hasText: fields.purpose })).toBeVisible();
  await prepare.getByText('查看页面截图', { exact: true }).click();
  await expect(prepare.getByAltText('模拟 ehall 页面核验截图')).toBeVisible();
  await expect(prepare.getByRole('button', { name: '生成提交确认' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await prepare.getByLabel('已核对字段与后果，准备提交模拟申请').check();
  await prepare.getByRole('button', { name: '生成提交确认' }).click();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body.arguments).toEqual({
    ...args,
    preparedCommandId: preparedId,
    formDigest: 'b'.repeat(64),
    screenshotDigest: 'c'.repeat(64),
  });
  await page.getByRole('button', { name: '确认提交模拟申请', exact: true }).click();
  expect(state.writes[1].body).toEqual({ revision: 1, digest: 'd'.repeat(64), approve: true });
  await page.screenshot({ path: info.outputPath('ehall-confirmation.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('模拟界面在375px、大字、横屏和深色模式下保留可见操作', async ({ page }) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addStyleTag({ content: 'html{font-size:20px}' });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('button', { name: '准备表单', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
