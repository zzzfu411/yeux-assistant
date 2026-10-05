import { test, expect, type Page } from '@playwright/test';

const secret = 'yeux_agent_' + 'c'.repeat(64), timestamp = '2026-10-04T00:00:00.000Z';
async function setup(page: Page, options: { lost?: boolean } = {}) {
  const state = { credentials: [] as any[], writes: [] as { path: string; body: any; key: string | undefined }[], attempts: 0 };
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v2'.length);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/session') return json({ username: 'synthetic-owner' });
    if (path === '/today/overview') return json({ goalTotal: 0, activeGoalTotal: 0, pendingTotal: 0, sessions: [], unread: 0, modelConfigured: true, workerOnline: true, backgroundIssues: 0 });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/settings/model') return json({ base_url: '', model: '', has_api_key: false, tools: true, revision: 'fixture', mail_configured: false });
    if (path === '/status') return json({ checkedAt: timestamp, state: 'starting', issueCount: 0, components: [] });
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); state.writes.push({ path, body, key: request.headers()['idempotency-key'] });
      if (path === '/agents') {
        state.attempts++;
        const credential = { id: '00000000-0000-4000-8000-000000000001', ...body, createdAt: timestamp, expiresAt: '2026-11-03T00:00:00.000Z', revokedAt: null, lastUsedAt: null, dailyWriteLimit: body.dailyWriteLimit, writesToday: 0, active: true };
        state.credentials = [credential];
        if (options.lost && state.attempts === 1) return route.abort('failed');
        return json({ credential, token: options.lost ? null : secret });
      }
      if (path.endsWith('/revoke')) { state.credentials[0].active = false; state.credentials[0].revokedAt = timestamp; return json({ ok: true }); }
    }
    if (path === '/agents') return json(state.credentials);
    if (path === '/agents/audit') return json({ items: [], total: 0 });
    return json({ error: { code: 'not_found', message: 'fixture missing' } }, 404);
  });
  await page.goto('/#/settings?view=agents');
  await expect(page.getByRole('heading', { name: 'Agent 连接', exact: true })).toBeVisible();
  return state;
}

test('连接入口保留主导航，默认只读，令牌仅本次显示且不进入浏览器存储', async ({ page }, testInfo) => {
  const state = await setup(page);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(3);
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('连接名称').fill('Hermes');
  await expect(page.getByLabel('读取目标和任务', { exact: true })).toBeChecked();
  await expect(page.getByLabel('创建学习目标', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await expect(page.getByLabel('连接令牌')).toHaveValue(secret);
  await expect(page.getByLabel('连接令牌')).toBeFocused();
  expect(state.writes[0]!.body.scopes).toEqual(['workspace:read']);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(secret);
  await page.screenshot({ path: testInfo.outputPath('agent-connection.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '关闭令牌显示' }).click();
  await expect(page.getByLabel('连接令牌')).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel('连接令牌')).toHaveCount(0);
  await page.getByText('连接说明', { exact: true }).click();
  await expect(page.getByLabel('MCP 地址')).toHaveValue(/\/api\/agent\/mcp$/);
});

test('创建权限连带查询权限，关闭查询同步关闭创建，期限与额度明确保存', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('连接名称').fill('Muse');
  await page.getByLabel('读取目标和任务', { exact: true }).uncheck();
  await page.getByLabel('创建学习目标', { exact: true }).check();
  await expect(page.getByLabel('读取目标和任务', { exact: true })).toBeChecked();
  await page.getByLabel('读取目标和任务', { exact: true }).uncheck();
  await expect(page.getByLabel('创建学习目标', { exact: true })).not.toBeChecked();
  await page.getByLabel('准备工作与管理任务', { exact: true }).check();
  await page.getByLabel('有效期', { exact: true }).selectOption('7');
  await page.getByLabel('每日写入上限').fill('3');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  expect(state.writes[0]!.body).toMatchObject({ expiresInDays: 7, dailyWriteLimit: 3, scopes: ['tasks:create', 'workspace:read'] });
  await expect(page.getByText('今日已写入 0/3（UTC）', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '撤销 Muse', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '连接已撤销' })).toBeVisible();
  await expect(page.getByLabel('连接令牌')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤销 Muse', exact: true })).toHaveCount(0);
});

test('创建响应丢失后复用请求键，并引导撤销无法恢复令牌的连接', async ({ page }) => {
  const state = await setup(page, { lost: true });
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('连接名称').fill('Retry fixture');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('输入已保留');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '令牌无法再次读取' })).toBeVisible();
  expect(state.writes[0]!.key).toBe(state.writes[1]!.key); expect(state.credentials).toHaveLength(1);
  await page.getByRole('button', { name: '撤销此连接', exact: true }).click();
  expect(state.credentials[0].active).toBe(false);
});

test('设置页按钮可到连接管理，窄屏和放大字体保留操作', async ({ page }) => {
  await setup(page); await page.getByRole('link', { name: '返回设置' }).click();
  await page.getByRole('link', { name: '管理连接', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: 'html { font-size: 20px }' });
  await page.getByRole('button', { name: '添加连接' }).click();
  await expect(page.getByLabel('连接名称')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 812, height: 375 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
