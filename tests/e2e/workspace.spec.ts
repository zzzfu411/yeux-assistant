import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
  const state = { changed: true, commits: 0, scans: 0 };
  await page.route('**/api/v2/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.slice('/api/v2'.length);
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/session') return json({ username: 'synthetic-owner' });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/today/overview')
      return json({
        goalTotal: 0,
        activeGoalTotal: 0,
        pendingTotal: 0,
        sessions: [],
        unread: 0,
        modelConfigured: true,
        workerOnline: true,
        backgroundIssues: 0,
      });
    if (path === '/settings/model')
      return json({
        base_url: '',
        model: '',
        has_api_key: false,
        tools: true,
        revision: 'fixture',
        mail_configured: false,
      });
    if (path === '/workspace')
      return json({
        head: 'a'.repeat(40),
        revision: 'b'.repeat(64),
        changes: state.changed ? [{ path: 'rules/correction/notice.md', status: ' M', digest: 'c'.repeat(64) }] : [],
        locked: false,
        rules: 1,
        flows: 0,
      });
    if (path === '/workspace/file') return json({ content: '报名截止时间不是活动开始时间。' });
    if (path === '/workspace/scan') {
      state.scans++;
      return json({ rules: 1, flows: 0 });
    }
    if (path === '/workspace/commit') {
      expect(request.postDataJSON()).toEqual({ revision: 'b'.repeat(64), message: '区分截止与开始' });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      state.changed = false;
      state.commits++;
      return json({ commitSha: 'd'.repeat(40) });
    }
    if (path === '/sources/exact')
      return json({
        id: 'exact',
        title: '合成通知',
        version: 1,
        current_version: 1,
        content: '前文。报名于10月6日截止。活动10月8日开始。后文。',
        digest: 'f'.repeat(64),
        metadata: null,
        revision: 1,
        archivedAt: null,
        managed: false,
        editableText: false,
        versions: [],
      });
    return json([]);
  });
  return state;
}

test('规则工作区核对手工修改后提交，刷新恢复提交说明草稿', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/#/settings?view=workspace');
  await expect(page.getByRole('heading', { name: '规则工作区', exact: true })).toBeVisible();
  expect(state.commits).toBe(0);
  await page.getByRole('button', { name: 'rules/correction/notice.md', exact: true }).click();
  await expect(page.getByText('报名截止时间不是活动开始时间。', { exact: true })).toBeVisible();
  await page.getByLabel('提交说明').fill('区分截止与开始');
  await page.reload();
  await expect(page.getByLabel('提交说明')).toHaveValue('区分截止与开始');
  await page.getByRole('button', { name: '载入文件修改' }).click();
  await expect.poll(() => state.scans).toBe(1);
  expect(state.commits).toBe(0);
  await page.getByRole('button', { name: '提交这些修改' }).click();
  await expect.poll(() => state.commits).toBe(1);
  await expect(page.getByText('所有修改均已保存到本地 Git。')).toBeVisible();
});

test('引用定位到指定版本与字符范围，并在375px下不溢出', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/source/exact?version=1&start=3&end=14');
  await expect(page.getByRole('heading', { name: '合成通知' })).toBeVisible();
  await expect(page.locator('mark[aria-label="引用片段"]')).toHaveText('报名于10月6日截止。');
  await expect(page.locator('mark')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('畸形引用范围显示完整原文，不伪造高亮', async ({ page }) => {
  await setup(page);
  await page.goto('/#/source/exact?version=1&start=99&end=999');
  await expect(page.getByText('引用范围无效，已显示完整原文。')).toBeVisible();
  await expect(page.locator('mark')).toHaveCount(0);
});
