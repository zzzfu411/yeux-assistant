import { test, expect, type Page } from '@playwright/test';

const secret = 'yeux_device_' + 'd'.repeat(64),
  id = '00000000-0000-4000-8000-000000000001';
async function setup(page: Page, lost = false) {
  const state = { devices: [] as any[], writes: [] as any[], attempts: 0 };
  await page.route('**/api/v2/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.slice('/api/v2'.length);
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/session') return json({ username: 'synthetic-owner' });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/devices' && request.method() === 'GET')
      return json({
        control: { enabled: true, revision: 1 },
        devices: state.devices,
        workerOnline: true,
        serverTime: new Date().toISOString(),
      });
    if (path === '/device-commands') return json([]);
    if (path === '/devices/bridges') {
      state.attempts++;
      state.writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
      state.devices = [
        {
          id,
          name: '我的 Mac 音量',
          adapter: 'macos.audio',
          mode: 'physical',
          revision: 1,
          enabled: true,
          available: false,
          connection: { online: false, expiresAt: '2026-11-04T00:00:00Z', revoked: false, lastSeenAt: null },
          observedState: null,
          observedAt: null,
          capabilities: [
            { id: 'audio.volume.set', label: '输出音量', choices: [{ label: '音量 25%', arguments: { percent: 25 } }] },
          ],
        },
      ];
      if (lost && state.attempts === 1) return route.abort('failed');
      return json({
        deviceId: id,
        token: lost ? null : secret,
        adapter: 'macos.audio',
        expiresAt: '2026-11-04T00:00:00Z',
      });
    }
    if (path.endsWith('/revoke-bridge')) {
      state.devices[0].connection.revoked = true;
      state.devices[0].available = false;
      return json({ ok: true });
    }
    return json({ error: { message: 'fixture route missing' } }, 404);
  });
  await page.goto('/#/devices');
  await expect(page.getByRole('heading', { name: '设备', exact: true })).toBeVisible();
  return state;
}
test('连接配置只显示一次，离线不可操作，刷新不会保存令牌', async ({ page }, info) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '连接 Mac', exact: true }).click();
  await page.getByRole('button', { name: '生成连接配置', exact: true }).click();
  const config = page.getByLabel('连接配置', { exact: true });
  await expect(config).toBeFocused();
  expect(JSON.parse(await config.inputValue())).toMatchObject({ deviceId: id, token: secret, adapter: 'macos.audio' });
  await expect(page.getByRole('button', { name: '音量 25%', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(secret);
  expect(state.writes[0].body).toEqual({ name: '我的 Mac 音量', adapter: 'macos.audio', expiresInDays: 30 });
  await page.screenshot({ path: info.outputPath('device-connection.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(config).toHaveCount(0);
  state.devices[0].available = true;
  state.devices[0].connection.online = true;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '音量 25%', exact: true })).toBeEnabled();
  await expect(page.getByText('尚未核验', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '音量 25%', exact: true })).toBeDisabled();
});
test('响应丢失后保留请求键并提供撤销入口', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('button', { name: '连接 Mac', exact: true }).click();
  await page.getByRole('button', { name: '生成连接配置', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '生成连接配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '配置无法再次读取' })).toBeVisible();
  expect(state.writes[0].key).toBe(state.writes[1].key);
  await page.getByRole('button', { name: '撤销此设备连接', exact: true }).click();
  expect(state.devices[0].connection.revoked).toBe(true);
});
test('小屏、大字和横屏均能查看启动步骤和连接操作', async ({ page }) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: 'html { font-size: 20px }' });
  await page.getByText('执行器启动说明', { exact: true }).click();
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByText('pnpm device:run --config private/device.json', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
