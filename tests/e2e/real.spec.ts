import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function openMore(page: Page) {
  // Desktop lists secondary pages in the sidebar; phones open them from the tab bar.
  const more = page.getByLabel('更多', { exact: true });
  if (await more.isVisible()) await more.click();
}

// Explicit opt-in: this suite only targets a disposable API/Worker instance.
test.skip(
  process.env.ASSISTANT_REAL_E2E !== '1',
  'Set ASSISTANT_REAL_E2E=1 and point PLAYWRIGHT_BASE_URL at the disposable instance.',
);
test('真实 PostgreSQL 与 Worker：资料→目标→自评→复习记录→本人确认完成', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const credentials = JSON.parse(await readFile(resolve(process.env.ASSISTANT_E2E_CREDENTIAL_FILE!), 'utf8'));
  const token = (
    await readFile(resolve(process.env.ASSISTANT_E2E_TOKEN_FILE || 'private/e2e-instance/access-token'), 'utf8')
  ).trim();
  const suffix = testInfo.project.name + '-' + Date.now(),
    title = '浏览器验收 ' + suffix,
    source = '验收资料 ' + suffix;
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
  const originalContent =
    '需求分析从使用者的具体问题开始。验收标准描述可观察的行为，例如点击保存后 2 秒内显示结果。\n独立用例：' + suffix;
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('button', { name: '添加资料', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill(source);
  await page.getByRole('textbox', { name: '原文', exact: true }).fill(originalContent);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: source, exact: true })).toBeVisible();
  const sourceId = decodeURIComponent(page.url().split('/source/')[1]!.split('?')[0]!);
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await page.getByLabel('学习目标').fill(title);
  await page.getByText('学习设置', { exact: true }).click();
  await page.getByLabel('预期成果').fill('理解需求分析，写出可验证的验收标准');
  await page.getByRole('checkbox', { name: source, exact: true }).check();
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel('练习回答')).toBeVisible({ timeout: 30_000 });
  const sessionId = page.url().split('/session/')[1]!;
  await page
    .getByLabel('练习回答')
    .fill('验收标准必须可观察：点击保存后 2 秒内出现成功结果，这是使用者能直接验证的行为。');
  await page.getByText('补充自评', { exact: true }).click();
  await page.getByLabel('我对这一步的理解').selectOption('understood');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  const getSession = async () => {
    const response = await request.get('/api/v2/sessions/' + sessionId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  await expect.poll(async () => (await getSession()).session.state, { timeout: 30_000 }).toBe('completed');
  const detail = await getSession();
  expect(detail.attempts.at(-1)).toMatchObject({ verdict: 'pass', source: 'user_report' });
  expect(detail.session.citations.length).toBeGreaterThan(0);
  await page.getByRole('link', { name: '‹ 返回目标', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习路径' })).toBeVisible();
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  await page.getByRole('button', { name: '我已完成这个目标', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await request.get('/api/v2/goals/' + detail.session.goalId, {
        headers: { Authorization: 'Bearer ' + token },
      });
      return (await response.json()).goal.status;
    })
    .toBe('completed');
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'yeux_session')?.httpOnly).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('real-completed.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  // Updating a source changes future retrieval, never the already delivered exercise.
  await page.goto('/#/source/' + encodeURIComponent(sourceId));
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  const updatedTitle = source + ' 修订',
    updatedContent = originalContent + '\n补充：验收还需要明确失败后的反馈。';
  await page.getByRole('textbox', { name: '资料标题', exact: true }).fill(updatedTitle);
  await page.getByRole('textbox', { name: '资料正文', exact: true }).fill(updatedContent);
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('heading', { name: updatedTitle, exact: true })).toBeVisible();
  await page.getByText('版本历史（2）', { exact: true }).click();
  await page.getByRole('link', { name: '第 1 版 · ' + source, exact: false }).click();
  await expect(page.getByRole('heading', { name: source, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看最新版', exact: true })).toBeVisible();
  const historic = await request.get('/api/v2/sources/' + sourceId + '?version=1', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(await historic.json()).toMatchObject({
    title: source,
    content: originalContent,
    version: 1,
    current_version: 2,
  });
  await page.getByRole('link', { name: '查看最新版', exact: true }).click();
  await page.getByRole('button', { name: '归档资料', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复使用', exact: true })).toBeVisible();
  const archivedList = await request.get('/api/v2/sources?archived=true', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect((await archivedList.json()).some((item: any) => item.id === sourceId)).toBe(true);
  const activeList = await request.get('/api/v2/sources', { headers: { Authorization: 'Bearer ' + token } });
  expect((await activeList.json()).some((item: any) => item.id === sourceId)).toBe(false);
  expect((await getSession()).session.citations).toEqual(detail.session.citations);
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档资料', exact: true })).toBeVisible();
  const restoredSource = await request.get('/api/v2/sources/' + sourceId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(await restoredSource.json()).toMatchObject({
    title: updatedTitle,
    content: updatedContent,
    version: 2,
    revision: 4,
    archivedAt: null,
  });
  await page.screenshot({ path: testInfo.outputPath('real-source-restored.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await openMore(page);
  await page.getByRole('link', { name: '历史', exact: true }).click();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await openMore(page);
  await page.getByRole('link', { name: '定时计划', exact: true }).click();
  await page.getByRole('button', { name: '添加计划', exact: true }).click();
  await page.getByLabel('计划名称').fill('暂停的验收计划 ' + suffix);
  await page.getByRole('textbox', { name: '任务内容', exact: true }).fill('复习验收标准。');
  await page.getByRole('checkbox', { name: '启用计划' }).uncheck();
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByText('暂停的验收计划 ' + suffix + ' · 已暂停', { exact: true })).toBeVisible();
  const lampName = '验收台灯 ' + suffix;
  const added = await request.post('/api/v2/devices/simulated', {
    headers: { Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() },
    data: { name: lampName },
  });
  expect(added.ok()).toBe(true);
  const deviceId = (await added.json()).deviceId;
  await openMore(page);
  await page.getByRole('link', { name: '设备', exact: true }).click();
  const lamp = page.getByRole('article').filter({ has: page.getByRole('heading', { name: lampName, exact: true }) });
  await lamp.getByRole('button', { name: '开灯', exact: true }).click();
  const operation = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '演示 · ' + lampName + ' · 开灯', exact: true }) });
  await expect(operation.getByRole('button', { name: '确认开灯', exact: true })).toBeVisible();
  const deviceResponse = await request.get('/api/v2/devices', { headers: { Authorization: 'Bearer ' + token } });
  expect((await deviceResponse.json()).devices.find((row: any) => row.id === deviceId).observedState).toEqual({
    power: false,
  });
  await page.reload();
  await operation.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(operation.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible({ timeout: 30_000 });
  const commands = await request.get('/api/v2/device-commands', { headers: { Authorization: 'Bearer ' + token } });
  expect((await commands.json()).find((row: any) => row.deviceId === deviceId)).toMatchObject({
    state: 'succeeded',
    mode: 'simulation',
    receipt: { source: 'simulation', before: { power: false }, after: { power: true }, outcome: 'verified' },
  });
  await page.screenshot({ path: testInfo.outputPath('real-device-verified.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await openMore(page);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
});
