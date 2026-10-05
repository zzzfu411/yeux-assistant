import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Citation, SourceMetadata, SourceSummary } from '../../packages/contracts/src/index';

const timestamp = '2026-09-19T02:00:00.000Z';
function fixture() {
  const goal = {
    id: 'goal-1',
    title: '理解软件工程的需求分析',
    outcome: '能写出可验证的验收标准',
    status: 'active',
    revision: 1,
    sourceIds: ['source-1'],
    intervals: [86400, 259200, 604800],
    reviewStage: 0,
    nextReview: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const session = {
    id: 'session-1',
    goalId: 'goal-1' as string | null,
    title: goal.title,
    kind: 'study',
    prompt: '需求分析应该从哪里开始？',
    state: 'waiting_feedback',
    revision: 1,
    currentRunId: 'run-1',
    content: '## 从使用者开始\n\n写出一个可验证的验收标准，再解释它解决了谁的问题。',
    citations: [
      {
        sourceId: 'source-1',
        version: 1,
        title: '第一讲：软件工程',
        start: 0,
        end: 16,
        quote: '需求从使用者的具体问题开始。',
        digest: 'a'.repeat(64),
      },
    ] as Citation[],
    error: '',
    recipient: 'student@example.com',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    runtimeError: false,
    modelConfigured: true,
    workerOnline: true,
    sourcesFailed: false,
    goal,
    session,
    additionalGoals: [] as Array<typeof goal>,
    additionalSessions: [] as Array<typeof session>,
    collectionCalls: [] as string[],
    todayReads: [] as string[],
    artifacts: [] as Array<Record<string, unknown>>,
    legacy: null as Record<string, unknown> | null,
    attempts: [] as Array<Record<string, unknown>>,
    posts: [] as Array<{ path: string; body: Record<string, unknown>; key: string | undefined }>,
    abortCreate: false,
    delayCreate: 0,
    delayDraft: 0,
    conflictFeedback: false,
    events: [] as string[],
    searches: [] as string[],
    completedSearches: [] as string[],
    searchDelays: {} as Record<string, number>,
    originals: [] as string[],
    originalDelay: 0,
    completedOriginals: [] as string[],
    sourceVersions: {} as Record<string, { metadata: SourceMetadata | null; content?: string }>,
    settings: {
      base_url: 'https://model.example/v1',
      model: 'test-model',
      has_api_key: false,
      tools: true,
      revision: 'a'.repeat(64),
      mail_configured: true,
    },
    approvals: [] as Array<Record<string, unknown>>,
    sources: [
      { id: 'source-1', title: '第一讲：软件工程', version: 1, digest: 'a'.repeat(64), updatedAt: timestamp },
    ] as SourceSummary[],
    memories: [
      {
        key: 'legacy-preference',
        scope: 'all',
        content: '每天学习 20 分钟',
        version: 2,
        confirmed: true,
        enabled: true,
        updated_at: timestamp,
      },
    ],
    schedules: [] as Array<Record<string, unknown>>,
  };
}
type State = ReturnType<typeof fixture>;
async function setup(page: Page, state = fixture(), login = true) {
  let signedIn = false;
  const snapshots = new Map<string, string[]>();
  let sequence = 0;
  function paged(items: any[], url: URL, map: (item: any) => any = (item: any) => item) {
    const token = url.searchParams.get('cursor'),
      [saved, position] = token?.split(':') || [],
      offset = Number(position || 0),
      limit = Number(url.searchParams.get('limit') || 30);
    const key = saved || String(++sequence);
    if (!saved)
      snapshots.set(
        key,
        items.map((item) => item.id),
      );
    const ids = snapshots.get(key) || [],
      current = ids.map((id) => items.find((item) => item.id === id)).filter(Boolean);
    return {
      items: current.slice(offset, offset + limit).map(map),
      total: current.length,
      pageCursor: key + ':' + offset,
      nextCursor: offset + limit < current.length ? key + ':' + (offset + limit) : null,
    };
  }
  const summary = (item: any) => ({
    id: item.id,
    goalId: item.goalId,
    title: item.title,
    kind: item.kind,
    state: item.state,
    promptPreview: item.prompt.slice(0, 160),
    errorPreview: item.error.slice(0, 240),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  await page.route('**/api/v2/**', async (route: Route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace('/api/v2', ''),
      method = request.method();
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/auth/login') {
      const body = request.postDataJSON();
      if (body.username !== 'tester' || body.password !== 'test-password')
        return json({ error: { code: 'invalid_credentials', message: '账号或密码不正确。' } }, 401);
      signedIn = true;
      return json({ username: 'tester' });
    }
    if (!signedIn) return json({ error: { code: 'unauthorized', message: '请登录管理员账号。' } }, 401);
    if (path === '/auth/session') return json({ username: 'tester' });
    if (path === '/auth/logout') {
      signedIn = false;
      return json({ ok: true });
    }
    if (path === '/events') {
      state.events.push(url.searchParams.get('after') || '0');
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          'id: 7\ndata: ' +
          JSON.stringify({ id: '7', kind: 'session.updated', entityId: 'session-1', data: {}, createdAt: timestamp }) +
          '\n\n: heartbeat\n\n',
      });
    }
    if (method !== 'GET') {
      const body = request.postDataJSON() || {};
      state.posts.push({ path, body, key: request.headers()['idempotency-key'] });
      if (path === '/goals') {
        if (state.abortCreate) {
          state.abortCreate = false;
          return route.abort('connectionreset');
        }
        if (state.delayCreate) await new Promise((resolve) => setTimeout(resolve, state.delayCreate));
        state.goal.title = body.title;
        state.session.title = body.title;
        return json({ goalId: 'goal-1', sessionId: 'session-1', runId: 'run-1' }, 202);
      }
      if (path === '/sessions') {
        if (state.delayCreate) await new Promise((resolve) => setTimeout(resolve, state.delayCreate));
        state.session.title = body.prompt;
        state.session.prompt = body.prompt;
        state.session.kind = body.kind;
        state.session.goalId = null;
        return json({ sessionId: 'session-1', runId: 'run-1' }, 202);
      }
      if (path === '/sessions/session-1/draft') {
        if (state.delayDraft) await new Promise((resolve) => setTimeout(resolve, state.delayDraft));
        state.session.content = body.content;
        state.session.revision = Number(body.revision) + 1;
        return json({ sessionId: 'session-1', revision: state.session.revision });
      }
      if (path === '/sessions/session-1/feedback') {
        if (state.conflictFeedback) {
          state.conflictFeedback = false;
          state.session.revision = 2;
          return json({ error: { code: 'version_conflict', message: '内容已更新，请载入最新版本。' } }, 409);
        }
        state.session.state = 'queued';
        state.session.revision = Number(body.revision) + 1;
        return json(
          { sessionId: 'session-1', runId: 'run-2', attemptId: 'attempt-1', revision: state.session.revision },
          202,
        );
      }
      if (path === '/settings/model') {
        state.settings = {
          ...state.settings,
          ...body,
          revision: 'b'.repeat(64),
          has_api_key: Boolean(body.api_key) || state.settings.has_api_key,
        };
        return json(state.settings);
      }
      if (path === '/settings/model/test') return json({ ok: true, message: '连接成功。' });
      if (path === '/sources') {
        state.sources.push({
          id: 'source-2',
          title: body.title,
          version: 1,
          digest: 'b'.repeat(64),
          updatedAt: timestamp,
        });
        return json({ id: 'source-2', version: 1 });
      }
      if (path === '/memories') {
        state.memories = [{ ...state.memories[0]!, ...body, version: Number(body.revision) + 1 }];
        return json({ key: body.key, version: Number(body.revision) + 1 });
      }
      if (path === '/schedules') {
        state.schedules.push({
          ...body,
          id: 'schedule-1',
          interval_seconds: body.intervalSeconds,
          next_run: body.nextRun,
          version: 1,
        });
        return json({ id: 'schedule-1', version: 1 });
      }
      if (path === '/approvals/approval-1/decision') {
        state.approvals[0]!.state = 'approved';
        return json({ approvalId: 'approval-1', state: 'approved' });
      }
      return json({ sessionId: 'session-1', revision: 2 });
    }
    if (path === '/today' || path === '/today/overview') state.todayReads.push(path);
    if (path === '/today/overview') {
      const all = [state.session, ...state.additionalSessions],
        pending = all.filter((item) => ['queued', 'running', 'waiting_feedback', 'failed'].includes(item.state));
      return json({
        goalTotal: 1 + state.additionalGoals.length,
        activeGoalTotal: [state.goal, ...state.additionalGoals].filter((item) => item.status === 'active').length,
        pendingTotal: pending.length,
        sessions: pending.slice(0, 3).map(summary),
        unread: 1,
        modelConfigured: state.modelConfigured,
        workerOnline: state.workerOnline,
        backgroundIssues: state.runtimeError ? 1 : 0,
      });
    }
    if (path === '/goals/list') {
      state.collectionCalls.push(path + url.search);
      return json(
        paged(
          [state.goal, ...state.additionalGoals].filter(
            (item) =>
              (!url.searchParams.get('q') || item.title.includes(url.searchParams.get('q')!)) &&
              (!url.searchParams.get('status') ||
                url.searchParams.get('status') === 'all' ||
                item.status === url.searchParams.get('status')),
          ),
          url,
        ),
      );
    }
    if (path === '/sessions/list') {
      state.collectionCalls.push(path + url.search);
      return json(
        paged(
          [state.session, ...state.additionalSessions].filter(
            (item) =>
              (!url.searchParams.get('goalId') || item.goalId === url.searchParams.get('goalId')) &&
              (!url.searchParams.get('q') || item.title.includes(url.searchParams.get('q')!)) &&
              (!url.searchParams.get('kind') ||
                url.searchParams.get('kind') === 'all' ||
                item.kind === url.searchParams.get('kind')) &&
              (!url.searchParams.get('state') ||
                url.searchParams.get('state') === 'all' ||
                item.state === url.searchParams.get('state') ||
                (url.searchParams.get('state') === 'pending' &&
                  ['queued', 'running', 'waiting_feedback', 'failed'].includes(item.state))),
          ),
          url,
          summary,
        ),
      );
    }
    if (path === '/goals/goal-1/attempts/list') return json(paged(state.attempts, url));
    if (path === '/today')
      return json({
        goals: [state.goal],
        sessions: [state.session],
        unread: 1,
        modelConfigured: state.modelConfigured,
        workerOnline: state.workerOnline,
        backgroundIssues: state.runtimeError ? 1 : 0,
      });
    if (path === '/goals') return json([state.goal]);
    if (path === '/goals/goal-1' || path === '/goals/goal-1/overview')
      return json({
        goal: state.goal,
        sessionTotal: 1 + state.additionalSessions.filter((item) => item.goalId === state.goal.id).length,
        attemptTotal: state.attempts.length,
        plan: {
          id: 'plan-1',
          goalId: 'goal-1',
          version: 1,
          steps: [
            { id: 'step-1', title: '写出一个验收标准', objective: '从具体使用场景描述需求', state: 'practicing' },
          ],
          rationale: '先把问题描述清楚，再考虑技术。',
          createdAt: timestamp,
        },
        sessions: [state.session],
        attempts: state.attempts,
      });
    if (path === '/sessions') return json({ items: [state.session], total: 1 });
    if (path === '/sessions/session-1')
      return json({
        session: state.session,
        attempts: state.attempts,
        artifacts: state.artifacts,
        approvals: state.approvals,
        legacy: state.legacy,
      });
    if (path === '/sources')
      return state.sourcesFailed ? json({ error: { message: '资料载入失败' } }, 503) : json(state.sources);
    if (path.startsWith('/sources/') && path.endsWith('/original')) {
      state.originals.push(path + url.search);
      if (state.originalDelay) await new Promise((resolve) => setTimeout(resolve, state.originalDelay));
      state.completedOriginals.push(path + url.search);
      return route
        .fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.7\ncourse original fixture\n') })
        .catch(() => {});
    }
    if (path.startsWith('/sources/')) {
      const source = state.sources.find((source) => source.id === path.split('/').at(-1));
      const version = Number(url.searchParams.get('version')) || source?.version || 1;
      return json({
        ...source,
        version,
        current_version: source?.version || 1,
        content:
          '需求从使用者的具体问题开始。\n\n[不安全链接](javascript:alert(1))\n<script>window.__unsafe=true</script>',
        ...state.sourceVersions[(source?.id || '') + '@' + version],
      });
    }
    if (path === '/search') {
      const course = url.searchParams.get('course') || '';
      state.searches.push(path + url.search);
      if (state.searchDelays[course]) await new Promise((resolve) => setTimeout(resolve, state.searchDelays[course]));
      state.completedSearches.push(course);
      return json(
        state.session.citations.filter((citation) => !course || (citation.course || 'unclassified') === course),
      ).catch(() => {});
    }
    if (path === '/memories') return json(state.memories);
    if (path.endsWith('/history'))
      return json([
        { key: 'legacy-preference', version: 1, snapshot: { content: '先提问再解释' }, created_at: timestamp },
      ]);
    if (path === '/schedules') return json(state.schedules);
    if (path === '/settings/model') return json(state.settings);
    if (path === '/status')
      return json({
        checkedAt: timestamp,
        state: state.runtimeError ? 'degraded' : 'ok',
        issueCount: state.runtimeError ? 1 : 0,
        components: [
          {
            name: 'knowledge',
            label: '资料同步',
            state: state.runtimeError ? 'error' : 'ok',
            checkedAt: timestamp,
            message: state.runtimeError ? '部分本地资料未能同步，请检查文件格式、大小和读取权限。' : '最近检查正常。',
          },
        ],
      });
    if (path === '/notifications')
      return json({
        items: [
          {
            id: 'notice-1',
            session_id: 'session-1',
            title: '练习准备好了',
            body: '现在可以开始。',
            read_at: null,
            created_at: timestamp,
          },
        ],
        total: 1,
      });
    return json({ error: { code: 'not_found', message: '不存在' } }, 404);
  });
  await page.goto('/');
  if (login) {
    await page.getByLabel('账号', { exact: true }).fill('tester');
    await page.getByLabel('密码', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
  }
  return state;
}
async function secondary(page: Page, name: string) {
  await page.getByLabel('更多', { exact: true }).click();
  await page.getByRole('link', { name, exact: true }).click();
}

test('今天、目标、资料可用，手机不横向溢出', async ({ page }, testInfo) => {
  await setup(page);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('today.png'), fullPage: true, scale: 'css' });
  await page.getByRole('link', { name: '目标', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('goals.png'), fullPage: true, scale: 'css' });
  await page.getByRole('link', { name: /理解软件工程的需求分析/ }).click();
  await expect(page.getByRole('heading', { name: '学习路径' })).toBeVisible();
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await expect(page.getByRole('link', { name: /第一讲：软件工程/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
test('输入刷新与切页可恢复，退出清除会话草稿', async ({ page }) => {
  await setup(page);
  await page.getByLabel('学习目标').fill('每天学一点 TypeScript');
  await page.reload();
  await expect(page.getByLabel('学习目标')).toHaveValue('每天学一点 TypeScript');
  await page.getByRole('link', { name: '目标', exact: true }).click();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await expect(page.getByLabel('学习目标')).toHaveValue('每天学一点 TypeScript');
  await page.getByLabel('更多', { exact: true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('assistant.v2.'))),
  ).toEqual([]);
});
test('创建目标携带资料与幂等键，并进入学习步骤', async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel('学习目标').fill('一周学会需求分析');
  await page.getByText('学习设置', { exact: true }).click();
  await page.getByLabel('预期成果').fill('写出可验证的验收标准');
  await page.getByRole('checkbox', { name: '第一讲：软件工程' }).check();
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '一周学会需求分析', exact: true })).toBeVisible();
  expect(state.posts[0]!.body).toMatchObject({ title: '一周学会需求分析', sourceIds: ['source-1'] });
  expect(state.posts[0]!.key).toMatch(/^[a-f0-9]{32}$/);
});
test('连接断开后保留输入，重试复用原请求键', async ({ page }) => {
  const state = fixture();
  state.abortCreate = true;
  await setup(page, state);
  await page.getByLabel('学习目标').fill('学习幂等请求');
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('输入已保留');
  await expect(page.getByLabel('学习目标')).toHaveValue('学习幂等请求');
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习幂等请求', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]!.key).toBe(state.posts[1]!.key);
});
test('版本冲突保留回答，显式载入后用新版本提交', async ({ page }) => {
  const state = fixture();
  state.conflictFeedback = true;
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByLabel('练习回答').fill('用户提交后 2 秒内看到保存结果。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('内容已更新');
  await expect(page.getByLabel('练习回答')).toHaveValue('用户提交后 2 秒内看到保存结果。');
  await page.getByRole('button', { name: '载入最新版本，保留输入' }).click();
  await expect(page.getByRole('status')).toContainText('最新版本已载入');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body).toMatchObject({ revision: 2, answer: '用户提交后 2 秒内看到保存结果。' });
});
test('中文检索能打开原文，Markdown 不执行脚本', async ({ page }) => {
  await setup(page);
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByText('检索正文片段', { exact: true }).click();
  await page.getByLabel('正文关键词', { exact: true }).fill('需求');
  await page.getByRole('button', { name: '检索正文', exact: true }).click();
  await expect(page.getByRole('heading', { name: '正文片段' })).toBeVisible();
  await page.getByRole('link', { name: '第一讲：软件工程', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第一讲：软件工程' })).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as unknown as { __unsafe?: boolean }).__unsafe))).toBe(false);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
});
test('设置密钥不进入草稿，保存与连接测试分开', async ({ page }) => {
  const state = await setup(page);
  await secondary(page, '设置');
  await page.getByLabel('API 密钥', { exact: true }).fill('private-example-key');
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('private-example-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
  expect(state.posts.at(-1)!.body.api_key).toBe('private-example-key');
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '测试已保存的连接' }).click();
  await expect(page.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible();
});
test('旧偏好 scope 保留，独立计划可创建', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('tab', { name: '记忆与偏好' }).click();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByLabel('用途')).toHaveValue('all');
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('先给练习，再给解释。');
  await page.getByRole('button', { name: '保存偏好' }).click();
  await expect(page.getByText('先给练习，再给解释。', { exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body.scope).toBe('all');
  await secondary(page, '定时计划');
  await page.getByRole('button', { name: '添加计划' }).click();
  await page.getByLabel('计划名称').fill('晚间复盘');
  await page.getByLabel('任务内容').fill('整理今天的错题。');
  await page.getByRole('button', { name: '保存计划' }).click();
  await expect(page.getByText('晚间复盘', { exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body.intervalSeconds).toBe(86400);
});
test('发送前显示确切邮件，发送中禁止改写', async ({ page }) => {
  const state = fixture();
  state.approvals = [
    {
      id: 'approval-1',
      state: 'pending',
      digest: 'd'.repeat(64),
      payload: {
        action: 'mail.send',
        sessionId: 'session-1',
        revision: 1,
        subject: '学习反馈',
        recipient: 'teacher@example.com',
        sender: 'student@example.com',
        draft: '这是经本人核对的回复。',
      },
      error: '',
    },
  ];
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await expect(page.getByText('teacher@example.com', { exact: true })).toBeVisible();
  await expect(page.getByText('这是经本人核对的回复。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认发送这封邮件' }).click();
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  await page.getByText('更多操作', { exact: true }).click();
  await expect(page.getByRole('button', { name: '修改内容', exact: true })).toBeDisabled();
  expect(state.posts.at(-1)!.body).toEqual({ digest: 'd'.repeat(64), approve: true });
});
test('提交过程中新增的目标输入仍然保留', async ({ page }) => {
  const state = fixture();
  state.delayCreate = 1200;
  await setup(page, state);
  await page.getByLabel('学习目标').fill('先提交的目标');
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(
    page.getByRole('group', { name: '选择功能' }).getByRole('button', { name: '学习答疑', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('学习目标').fill('提交过程中想到的另一个目标');
  await expect(page.getByRole('heading', { name: '先提交的目标', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await expect(page.getByLabel('学习目标')).toHaveValue('提交过程中想到的另一个目标');
});
test('保存期间继续改写保留新文字，并推进自己的版本', async ({ page }) => {
  const state = fixture();
  state.delayDraft = 800;
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByText('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '修改内容', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '修改内容', exact: true });
  await editor.fill('先保存的文字');
  await page.getByRole('button', { name: '保存内容', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await editor.fill('保存期间继续补充的文字');
  await expect(page.getByRole('status')).toContainText('已保存');
  await expect(editor).toHaveValue('保存期间继续补充的文字');
  await page.getByRole('button', { name: '保存内容', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]!.body).toMatchObject({ revision: 2, content: '保存期间继续补充的文字' });
});
test('账号会话刷新后保留，浏览器不保存密码或访问令牌', async ({ page }) => {
  const state = await setup(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('assistant.v2.token'))).toBe(null);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('test-password');
  await expect.poll(() => state.events.includes('7')).toBe(true);
  await page.getByLabel('更多', { exact: true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
});
test('管理员登录错误可恢复，密码可查看，Logo 与手机布局正常', async ({ page }, testInfo) => {
  await setup(page, fixture(), false);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByRole('img', { name: '戴着圆眼镜、拿着记事本和笔的沙丁鱼秘书' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true, scale: 'css' });
  await page.getByLabel('账号', { exact: true }).fill('tester');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号或密码不正确');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('未评阅的回答不会标为模型估计', async ({ page }) => {
  const state = fixture();
  state.attempts = [
    {
      id: 'attempt-1',
      sessionId: 'session-1',
      answer: '我先写下自己的理解。',
      verdict: 'unclear',
      feedback: '回答已保存，尚未评阅。',
      evidence: '',
      source: 'ungraded',
      createdAt: timestamp,
    },
  ];
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await expect(page.getByText('未评阅', { exact: true })).toBeVisible();
  await expect(page.getByText('模型估计', { exact: false })).toHaveCount(0);
  await page.getByRole('link', { name: '‹ 返回目标', exact: true }).click();
  await page.getByText('练习与反馈（1）', { exact: true }).click();
  await expect(page.getByText(/^未评阅 ·/)).toBeVisible();
  await expect(page.getByText('模型估计', { exact: false })).toHaveCount(0);
});

test('迁移前记录默认折叠，历史引用安全展示且可完整下载', async ({ page }) => {
  const state = fixture();
  state.legacy = {
    id: 'session-1',
    packet: '## 旧材料\n请携带学生证。',
    sources: JSON.stringify([
      { path: 'old/notice.md', text: '<img src=x onerror="window.__legacyUnsafe=true">原始历史摘录' },
    ]),
    custom: '需要完整保留的字段',
  };
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByText('更多操作', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '旧整理内容' })).toBeHidden();
  await page.getByText('迁移前记录', { exact: true }).click();
  await expect(page.getByText('历史引用未全部核验', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: '旧材料', exact: true })).toBeVisible();
  await expect(page.getByText('old/notice.md', { exact: true })).toBeVisible();
  await expect(
    page.getByText('<img src=x onerror="window.__legacyUnsafe=true">原始历史摘录', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as unknown as { __legacyUnsafe?: boolean }).__legacyUnsafe))).toBe(
    false,
  );
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整旧记录（JSON）', exact: true }).click();
  const downloaded = await downloading;
  expect(JSON.parse(await readFile((await downloaded.path())!, 'utf8'))).toEqual(state.legacy);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
for (const [label, sources] of [
  ['缺失', undefined],
  ['畸形', '{broken'],
  ['混合', [null, 12, { path: 'old/valid.md', text: '保留有效引用。' }, { path: 7, text: false }]],
] as const) {
  test(`迁移前记录稳健处理${label}历史引用`, async ({ page }) => {
    const state = fixture();
    state.legacy = { id: 'session-1', packet: null, ...(sources === undefined ? {} : { sources }) };
    await setup(page, state);
    await page
      .getByRole('link', { name: /理解软件工程的需求分析/ })
      .first()
      .click();
    await page.getByText('更多操作', { exact: true }).click();
    await page.getByText('迁移前记录', { exact: true }).click();
    await expect(
      page.getByText(label === '缺失' ? '没有保存历史引用。' : '部分历史引用格式无法展开，可下载完整记录核对。', {
        exact: true,
      }),
    ).toBeVisible();
    if (label === '混合') await expect(page.getByText('保留有效引用。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下载完整旧记录（JSON）', exact: true })).toBeVisible();
  });
}

function courseFixture() {
  const state = fixture();
  const metadata = (course: string, courseName: string, originPath: string, format: string): SourceMetadata => ({
    course,
    courseName,
    originPath,
    format,
    originHash: 'c'.repeat(64),
    extraction: format === 'md' ? 'Markdown原文' : '可检索文字提取',
    warnings: [],
    pages: [],
  });
  const original = metadata('database', '数据库', 'database/slides/关系模型.pdf', 'pdf');
  original.assetKey = 'c'.repeat(64) + '.pdf';
  original.extraction = 'PDF文字层提取';
  original.warnings = ['图片和公式可能缺失，请核对原文件。', '第 2 页未提取到可检索文字。'];
  original.pages = [
    { number: 1, start: 0, end: 20 },
    { number: 2, start: 20, end: 36 },
  ];
  state.sources.push(
    {
      id: 'gse-1',
      title: 'GSE第一讲',
      version: 1,
      digest: 'g'.repeat(64),
      updatedAt: timestamp,
      metadata: metadata('gse', 'GSE', 'gse/official/lect01.md', 'md'),
    },
    {
      id: 'gse-2',
      title: 'GSE实验说明',
      version: 1,
      digest: 'g'.repeat(64),
      updatedAt: timestamp,
      metadata: metadata('gse', 'GSE', 'gse/official/lab1.md', 'md'),
    },
    {
      id: 'database-1',
      title: '数据库关系模型',
      version: 3,
      digest: 'd'.repeat(64),
      updatedAt: timestamp,
      metadata: { ...original, originPath: 'database/slides/关系模型新版.pdf' },
    },
    {
      id: 'se-1',
      title: '软件工程需求分析',
      version: 1,
      digest: 's'.repeat(64),
      updatedAt: timestamp,
      metadata: {
        ...metadata('se', '软件工程', 'se/slides/requirements.ppt', 'ppt'),
        pages: [{ number: 1, start: 0, end: 40 }],
      },
    },
  );
  state.sourceVersions['database-1@2'] = { metadata: original };
  state.session.citations.push(
    ...state.sources.slice(1).map((source) => ({
      sourceId: source.id,
      title: source.title,
      version: source.id === 'database-1' ? 2 : 1,
      start: 0,
      end: 20,
      quote: '可验证的课程资料摘录。',
      digest: source.digest,
      course: source.metadata!.course,
      courseName: source.metadata!.courseName,
      originPath: source.metadata!.originPath,
      location: source.id === 'database-1' ? '第 2 页' : source.id === 'se-1' ? '幻灯片 1' : undefined,
    })),
  );
  return state;
}

test('课程资料按课程筛选，检索传课程范围并保留未分类资料', async ({ page }) => {
  const state = await setup(page, courseFixture());
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByLabel('筛选课程').selectOption('database');
  await expect(page.getByRole('link', { name: /数据库关系模型/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /GSE第一讲/ })).toHaveCount(0);
  await expect(page.getByText('数据库 · PDF · 第 3 版', { exact: true })).toBeVisible();
  await page.getByText('检索正文片段', { exact: true }).click();
  await page.getByLabel('正文关键词', { exact: true }).fill('可验证');
  await page.getByRole('button', { name: '检索正文', exact: true }).click();
  await expect(page.getByRole('link', { name: '数据库关系模型', exact: true })).toBeVisible();
  expect(state.searches.at(-1)).toContain('course=database');
  await page.getByLabel('筛选课程').selectOption('gse');
  await expect(page.getByRole('link', { name: 'GSE第一讲', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '数据库关系模型', exact: true })).toHaveCount(0);
  expect(state.searches.at(-1)).toContain('course=gse');
  await page.getByLabel('筛选课程').selectOption('unclassified');
  await expect(page.getByRole('link', { name: '第一讲：软件工程', exact: true })).toBeVisible();
  expect(state.searches.at(-1)).toContain('course=unclassified');
  await page.getByRole('button', { name: '清除检索' }).click();
  await expect(page.getByText('未分类 · 文本 · 第 1 版', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /第一讲：软件工程/ }).click();
  await expect(page.getByRole('heading', { name: '第一讲：软件工程', exact: true })).toBeVisible();
  await expect(page.getByText('来源与提取说明', { exact: false })).toHaveCount(0);
});

test('课程筛选不改已有勾选，明确关联本页后跨课程保持选择', async ({ page }) => {
  const state = await setup(page, courseFixture());
  await page.getByLabel('学习目标').fill('学习GSE课程');
  await page.getByText('学习设置', { exact: true }).click();
  await page.getByLabel('筛选课程').selectOption('gse');
  await expect(page.getByRole('checkbox', { name: 'GSE第一讲', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'GSE实验说明', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '关联本页', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'GSE第一讲', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'GSE实验说明', exact: true }).uncheck();
  await page.getByLabel('筛选课程').selectOption('database');
  await expect(page.getByRole('checkbox', { name: '数据库关系模型', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '数据库关系模型', exact: true }).check();
  await page.getByLabel('筛选课程').selectOption('gse');
  await expect(page.getByRole('checkbox', { name: 'GSE第一讲', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'GSE实验说明', exact: true })).not.toBeChecked();
  await page.getByLabel('筛选课程').selectOption('');
  await expect(page.getByRole('checkbox', { name: '数据库关系模型', exact: true })).toBeChecked();
  await expect(page.getByText('已关联 2 份资料。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习GSE课程', exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body.sourceIds).toEqual(['gse-1', 'database-1']);
});

test('课程引用展示页码，来源说明和原文件下载绑定引用版本', async ({ page }, testInfo) => {
  const state = await setup(page, courseFixture());
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByText('参考资料 · 5', { exact: true }).click();
  await expect(page.getByText('数据库 · 第 2 页 · 第 2 版', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '数据库关系模型', exact: true }).click();
  await expect(page.getByText('database/slides/关系模型.pdf', { exact: true })).toBeHidden();
  await page.getByText('来源与提取说明', { exact: false }).click();
  await expect(page.getByText('database/slides/关系模型.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('PDF文字层提取', { exact: true })).toBeVisible();
  await expect(page.getByText('1–2（沿用原文件页序）', { exact: true })).toBeVisible();
  await expect(page.getByText('图片和公式可能缺失，请核对原文件。', { exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载原文件', exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe('关系模型.pdf');
  expect((await readFile((await file.path())!)).toString()).toContain('%PDF-1.7');
  expect(state.originals).toEqual(['/sources/database-1/original?version=2']);
  expect(page.url()).not.toContain('test-token');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('course-source.png'), fullPage: true, scale: 'css' });
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('link', { name: /软件工程需求分析/ }).click();
  await page.getByText('来源与提取说明', { exact: false }).click();
  await expect(page.locator('dt').filter({ hasText: /^幻灯片$/ })).toBeVisible();
  await expect(page.getByText('1（沿用原文件页序）', { exact: true })).toBeVisible();
});

test('课程检索切换不会被旧课程的迟到响应覆盖', async ({ page }) => {
  const state = courseFixture();
  state.searchDelays.gse = 800;
  await setup(page, state);
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByLabel('筛选课程').selectOption('gse');
  await page.getByText('检索正文片段', { exact: true }).click();
  await page.getByLabel('正文关键词', { exact: true }).fill('可验证');
  await page.getByRole('button', { name: '检索正文', exact: true }).click();
  await expect.poll(() => state.searches.some((url) => url.includes('course=gse'))).toBe(true);
  await page.getByLabel('筛选课程').selectOption('database');
  await expect(page.getByRole('link', { name: '数据库关系模型', exact: true })).toBeVisible();
  await expect.poll(() => state.completedSearches.includes('gse')).toBe(true);
  await expect(page.getByRole('link', { name: 'GSE第一讲', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '数据库关系模型', exact: true })).toBeVisible();
});

test('课程原文件下载退出后中止，不产生迟到下载', async ({ page }) => {
  const state = courseFixture();
  state.originalDelay = 900;
  await setup(page, state);
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('link', { name: /数据库关系模型/ }).click();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: '下载原文件', exact: true }).click();
  await expect.poll(() => state.originals.length).toBe(1);
  await page.getByLabel('更多', { exact: true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect.poll(() => state.completedOriginals.length).toBe(1);
  expect(downloads).toBe(0);
});

test('旧草稿超过目标上限时保留原关联并提示本人减少，不静默裁剪', async ({ page }) => {
  const state = courseFixture(),
    template = state.sources.find((source) => source.id === 'gse-1')!;
  state.sources = Array.from({ length: 101 }, (_, index) => ({
    ...template,
    id: 'gse-many-' + index,
    title: 'GSE资料 ' + index,
  }));
  await setup(page, state);
  await page.evaluate(
    (ids) =>
      sessionStorage.setItem(
        'assistant.v2.draft.new-goal',
        JSON.stringify({ title: '学习全部GSE资料', outcome: '', sourceIds: ids, mode: 'goal' }),
      ),
    state.sources.map((source) => source.id),
  );
  await page.reload();
  await page.getByText('学习设置', { exact: true }).click();
  await page.getByLabel('筛选课程').selectOption('gse');
  await expect(page.getByRole('alert')).toContainText('已关联 101 份资料，单个目标最多关联 100 份');
  await expect(page.getByRole('button', { name: '创建学习计划', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'GSE资料 0', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '创建学习计划', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(0);
});

test('课程资料取消全部后保持空绑定，不扩大到其他课程', async ({ page }) => {
  const state = await setup(page, courseFixture());
  await page.getByLabel('学习目标').fill('暂不关联资料的学习目标');
  await page.getByText('学习设置', { exact: true }).click();
  await page.getByLabel('筛选课程').selectOption('gse');
  await page.getByRole('button', { name: '关联本页', exact: true }).click();
  await page.getByRole('checkbox', { name: 'GSE第一讲', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'GSE实验说明', exact: true }).uncheck();
  await expect(page.getByText('未关联资料，可在下方选择。', { exact: true })).toBeVisible();
  await page.getByLabel('筛选课程').selectOption('');
  await expect(page.getByRole('checkbox', { name: '数据库关系模型', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '暂不关联资料的学习目标', exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body.sourceIds).toEqual([]);
});

test('首次使用同时提示模型与后台状态，资料关联可直接发现', async ({ page }) => {
  const state = fixture();
  state.modelConfigured = false;
  state.workerOnline = false;
  await setup(page, state);
  await expect(page.getByText('未连接模型，当前只提供资料摘录与自评练习。')).toBeVisible();
  await expect(page.getByText(/后台尚未运行，任务暂时不会开始/)).toBeVisible();
  await page.getByRole('button', { name: '选择资料（当前未关联）' }).click();
  await page.getByRole('checkbox', { name: '第一讲：软件工程' }).check();
  await expect(page.getByRole('button', { name: '已关联 1 份资料' })).toBeVisible();
});
test('资料请求失败可以重试，不冒充空资料库', async ({ page }) => {
  const state = fixture();
  state.sourcesFailed = true;
  await setup(page, state);
  await page.getByRole('button', { name: '选择资料（当前未关联）' }).click();
  await expect(page.getByRole('alert')).toContainText('资料载入失败');
  await expect(page.getByText('可先到「资料」添加学习材料。')).toHaveCount(0);
  state.sourcesFailed = false;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程' })).toBeVisible();
});
test('归档资料的旧目标草稿保留关联，显式移除后可以创建目标', async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel('学习目标', { exact: true }).fill('继续学习需求分析');
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true }).check();
  state.sources = [];
  await page.reload();
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await expect(page.getByText('有 1 份关联资料已归档或不可用。原关联仍保留。', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('assistant.v2.draft.new-goal')!).sourceIds),
  ).toEqual(['source-1']);
  expect(state.posts).toHaveLength(0);
  await page.getByRole('button', { name: '移除不可用关联', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除不可用关联', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('assistant.v2.draft.new-goal')!).sourceIds),
  ).toEqual([]);
  await page.getByRole('button', { name: '创建学习计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '继续学习需求分析', exact: true })).toBeVisible();
  expect(state.posts[0]!.body.sourceIds).toEqual([]);
});
test('资料载入失败时不会把旧关联误判为不可用', async ({ page }) => {
  const state = await setup(page),
    originalSources = [...state.sources];
  await page.getByLabel('学习目标', { exact: true }).fill('保留资料关联');
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true }).check();
  state.sources = [];
  await page.reload();
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除不可用关联', exact: true })).toBeVisible();
  state.sourcesFailed = true;
  await page.getByRole('button', { name: '刷新资料', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('资料载入失败');
  await expect(page.getByRole('button', { name: '移除不可用关联', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('assistant.v2.draft.new-goal')!).sourceIds),
  ).toEqual(['source-1']);
  state.sourcesFailed = false;
  state.sources = originalSources;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true })).toBeChecked();
  expect(state.posts).toHaveLength(0);
});
test('学习中明确保存纠正，资料分类支持键盘切换', async ({ page }) => {
  const state = await setup(page);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByText('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '记住一条纠正' }).click();
  expect(state.posts.filter((p) => p.path === '/memories')).toHaveLength(0);
  await page.getByLabel('内容', { exact: true }).fill('解释数据库概念时先给一个反例。');
  await page.getByRole('button', { name: '保存偏好' }).click();
  await expect(page.getByText('已记住，下次准备内容时会使用。')).toBeVisible();
  expect(state.posts.at(-1)?.body).toMatchObject({
    scope: 'correction',
    confirmed: true,
    enabled: true,
    content: '解释数据库概念时先给一个反例。',
  });
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('tab', { name: '学习材料' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '记忆与偏好' })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('解释数据库概念时先给一个反例。');
});

test('文件编码错误可理解，迟到的文件读取不会覆盖新输入', async ({ page }) => {
  await setup(page);
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('button', { name: '添加资料', exact: true }).click();
  await page
    .getByLabel('选择文件')
    .setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe]) });
  await expect(page.getByRole('alert')).toContainText('请另存为 UTF-8 文本');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return original.call(this);
    };
  });
  await page
    .getByLabel('选择文件')
    .setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('文件原文') });
  await page.getByLabel('标题', { exact: true }).fill('继续编辑的标题');
  await page.getByRole('textbox', { name: '原文', exact: true }).fill('继续编辑的文字');
  await expect(page.getByRole('alert')).toContainText('保留了你的输入');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('继续编辑的标题');
  await expect(page.getByRole('textbox', { name: '原文', exact: true })).toHaveValue('继续编辑的文字');
});

for (const [mode, label, field, action, prompt] of [
  ['study', '学习答疑', '学习问题', '开始答疑', '解释数据库左连接并给出练习。'],
  ['work', '整理材料', '材料与整理要求', '整理材料', '把这段材料提炼为要点：课程实验需先写验收标准。'],
  ['manage', '安排复盘', '安排或复盘内容', '生成清单', '把明天的一小时分配给数据库复习和软件工程阅读。'],
] as const) {
  test(`首页直接进入${label}，确认填写后才创建对应任务`, async ({ page }, testInfo) => {
    const state = await setup(page),
      features = page.getByRole('group', { name: '选择功能' });
    await expect(features.getByRole('button')).toHaveCount(4);
    await features.getByRole('button', { name: label, exact: true }).click();
    await expect(features.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    const form = page.getByRole('form', { name: label + '填写区', exact: true });
    await expect(form.getByRole('button', { name: action, exact: true })).toBeDisabled();
    await expect(page.getByLabel(field, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(mode + '.png'), fullPage: true, scale: 'css' });
    expect(state.posts).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByLabel(field, { exact: true }).fill(prompt);
    await form.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toMatchObject({ path: '/sessions', body: { prompt, kind: mode } });
    expect(state.posts[0]!.key).toMatch(/^[a-f0-9]{32}$/);
    await expect(page.getByLabel(mode === 'study' ? '练习回答' : '修改意见', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '今天', exact: true }).click();
    await expect(page.getByLabel(field, { exact: true })).toHaveValue('');
  });
}

test('功能草稿独立保存，刷新保留长材料和目标的资料选择', async ({ page }) => {
  await setup(page);
  const features = page.getByRole('group', { name: '选择功能' }),
    longText = '需要整理的材料。'.repeat(90);
  await page.getByLabel('学习目标', { exact: true }).fill('原来的学习目标');
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByLabel('预期成果', { exact: true }).fill('能独立解释概念');
  await page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true }).check();
  await features.getByRole('button', { name: '整理材料', exact: true }).click();
  await expect(page.getByLabel('材料与整理要求')).toHaveValue('');
  await page.getByLabel('材料与整理要求').fill(longText);
  await features.getByRole('button', { name: '学习计划', exact: true }).click();
  await expect(page.getByLabel('学习目标', { exact: true })).toHaveValue('原来的学习目标');
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await expect(page.getByLabel('预期成果', { exact: true })).toHaveValue('能独立解释概念');
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true })).toBeChecked();
  await features.getByRole('button', { name: '整理材料', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('材料与整理要求')).toHaveValue(longText);
  await expect(features.getByRole('button', { name: '整理材料', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('旧版草稿可继续，示例不覆盖输入也不自动提交', async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(() =>
    sessionStorage.setItem(
      'assistant.v2.draft.new-goal',
      JSON.stringify({ title: '升级前未完成的目标', outcome: '保留已有内容', sourceIds: ['source-1'], mode: 'goal' }),
    ),
  );
  await page.reload();
  await expect(page.getByLabel('学习目标', { exact: true })).toHaveValue('升级前未完成的目标');
  await expect(page.getByRole('button', { name: '填入示例', exact: true })).toBeDisabled();
  await page.getByRole('group', { name: '选择功能' }).getByRole('button', { name: '学习答疑', exact: true }).click();
  await page.getByRole('button', { name: '填入示例', exact: true }).click();
  await expect(page.getByLabel('学习问题', { exact: true })).toHaveValue(
    '用一个例子解释数据库的左连接，再出一道练习题。',
  );
  await expect(page.getByRole('button', { name: '填入示例', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  await page.getByRole('group', { name: '选择功能' }).getByRole('button', { name: '学习计划', exact: true }).click();
  await expect(page.getByLabel('学习目标', { exact: true })).toHaveValue('升级前未完成的目标');
});

test('目标页添加目标打开学习计划，不误入上次的整理材料', async ({ page }) => {
  await setup(page);
  await page.getByRole('group', { name: '选择功能' }).getByRole('button', { name: '整理材料', exact: true }).click();
  await page.getByLabel('材料与整理要求').fill('仍需保留的工作草稿');
  await page.getByRole('link', { name: '目标', exact: true }).click();
  await page.getByRole('link', { name: '添加目标', exact: true }).click();
  await expect(page.getByLabel('学习目标', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: '选择功能' }).getByRole('button', { name: '整理材料', exact: true }).click();
  await expect(page.getByLabel('材料与整理要求')).toHaveValue('仍需保留的工作草稿');
});

test('首页待办按状态提供动作，常用入口可直接使用', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole('link', { name: /继续练习/ })).toBeVisible();
  state.session.state = 'running';
  await page.reload();
  await page.getByRole('link', { name: /查看进度/ }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await page.getByRole('link', { name: /资料管理/ }).click();
  await expect(page.getByRole('button', { name: '添加资料', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await page.getByRole('link', { name: /定时计划 按时准备/ }).click();
  await expect(page.getByRole('button', { name: '添加计划', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '今天', exact: true }).click();
  await page.getByRole('link', { name: /历史记录/ }).click();
  await expect(page.getByRole('heading', { name: '历史', exact: true })).toBeVisible();
});

test('第201个目标可翻页发现，筛选重置分页且总数准确', async ({ page }) => {
  const state = fixture();
  state.additionalGoals = Array.from({ length: 200 }, (_, index) => ({
    ...state.goal,
    id: 'goal-extra-' + index,
    title: index === 199 ? '第201个学习目标' : '分页目标 ' + index,
    status: index === 199 ? 'paused' : 'active',
  }));
  await setup(page, state);
  await page.getByRole('link', { name: '目标', exact: true }).click();
  await expect(page.getByText('第 1 页 · 共 201 条', { exact: true })).toBeVisible();
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('link', { name: /第201个学习目标/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByLabel('目标状态', { exact: true }).selectOption('paused');
  await expect(page.getByText('共 1 条', { exact: true })).toBeVisible();
  await page.getByLabel('目标状态', { exact: true }).selectOption('all');
  await expect(page.getByText('第 1 页 · 共 201 条', { exact: true })).toBeVisible();
  await page.getByLabel('查找目标', { exact: true }).fill('不存在的标题');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByText('没有符合条件的目标。', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('目标第51条会话及第101次练习均可访问', async ({ page }) => {
  const state = fixture();
  state.additionalSessions = Array.from({ length: 50 }, (_, index) => ({
    ...state.session,
    id: 'older-session-' + index,
    title: index === 49 ? '第51条学习记录' : '较早学习 ' + index,
    state: 'completed',
  }));
  state.attempts = Array.from({ length: 101 }, (_, index) => ({
    id: 'older-attempt-' + index,
    sessionId: 'session-1',
    answer: index === 100 ? '第101次回答' : '回答 ' + index,
    verdict: 'unclear',
    feedback: '反馈',
    evidence: '',
    source: 'ungraded',
    createdAt: timestamp,
  }));
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await page.getByRole('link', { name: '‹ 返回目标', exact: true }).click();
  const records = page.getByRole('region', { name: '目标学习记录' });
  await expect(records.getByText('第 1 页 · 共 51 条', { exact: true })).toBeVisible();
  await records.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(records.getByRole('link', { name: /第51条学习记录/ })).toBeVisible();
  await page.getByText('练习与反馈（101）', { exact: true }).click();
  const attempts = page.locator('[aria-label="目标练习记录"]');
  for (let i = 0; i < 3; i++) await attempts.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(attempts.getByText('第101次回答', { exact: true })).toBeVisible();
  await expect(attempts.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
});
test('历史翻页在新任务插入和事件刷新后保留范围，主动刷新才纳入新任务', async ({ page }, testInfo) => {
  const state = fixture();
  state.additionalSessions = Array.from({ length: 34 }, (_, index) => ({
    ...state.session,
    id: 'history-' + index,
    title: '历史分页 ' + index,
    kind: index % 2 ? 'work' : 'study',
    state: 'completed',
  }));
  await setup(page, state);
  await page.getByRole('link', { name: /历史记录 查看/ }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('a[href^="#/session/"]')).toHaveCount(5);
  const before = await page.locator('a[href^="#/session/"]').allTextContents(),
    eventsBefore = state.events.length,
    callsBefore = state.collectionCalls.length;
  state.additionalSessions.unshift({
    ...state.session,
    id: 'newly-created',
    title: '新插入历史记录',
    kind: 'work',
    state: 'ready',
  });
  await expect.poll(() => state.events.length).toBeGreaterThan(eventsBefore);
  await expect.poll(() => state.collectionCalls.length).toBeGreaterThan(callsBefore);
  await expect(page.getByRole('link', { name: /新插入历史记录/ })).toHaveCount(0);
  expect(await page.locator('a[href^="#/session/"]').allTextContents()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('history-page-2.png'), fullPage: true, scale: 'css' });
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByRole('link', { name: /新插入历史记录/ })).toHaveCount(0);
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByRole('link', { name: /新插入历史记录/ })).toBeVisible();
  await page.getByLabel('任务类型', { exact: true }).selectOption('work');
  await page.getByLabel('查找历史', { exact: true }).fill('新插入');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByText('共 1 条', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
});
test('首页显示真实目标与待办总数，只展示3项并按需挂载资料选择', async ({ page }) => {
  const state = fixture();
  state.additionalGoals = Array.from({ length: 205 }, (_, index) => ({
    ...state.goal,
    id: 'count-goal-' + index,
    status: 'completed',
  }));
  state.additionalSessions = Array.from({ length: 6 }, (_, index) => ({
    ...state.session,
    id: 'pending-' + index,
    title: '待办 ' + index,
    goalId: null,
    state: 'failed',
  }));
  await setup(page, state);
  await expect(page.getByRole('link', { name: /查看全部目标（206）/ })).toBeVisible();
  await expect(page.getByText('7 项', { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="#/session/"]')).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true }).check();
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '学习设置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '第一讲：软件工程', exact: true })).toBeChecked();
  await page.getByRole('link', { name: '查看全部待办', exact: true }).click();
  await expect(page.getByLabel('任务状态', { exact: true })).toHaveValue('pending');
  await expect(page.getByText('共 7 条', { exact: true })).toBeVisible();
  expect(state.todayReads).toContain('/today/overview');
  expect(state.todayReads).not.toContain('/today');
});

test('评阅核对记录需展开查看，原始JSON不渲染成学习正文', async ({ page }) => {
  const state = fixture(),
    audit = JSON.stringify(
      {
        protocolVersion: 1,
        feedback: '## 审计字段不能变成标题\n<script>window.__unsafe=true</script>',
        status: 'accepted',
      },
      null,
      2,
    );
  state.artifacts = [
    {
      id: 'audit-1',
      sessionId: 'session-1',
      kind: 'assessment_audit',
      version: 1,
      content: audit,
      provenance: 'model',
      createdAt: timestamp,
    },
  ];
  state.attempts = [
    {
      id: 'attempt-1',
      sessionId: 'session-1',
      answer: '我的练习回答',
      verdict: 'pass',
      feedback: '本人完成练习',
      evidence: '',
      source: 'user_report',
      createdAt: timestamp,
    },
  ];
  await setup(page, state);
  await page
    .getByRole('link', { name: /理解软件工程的需求分析/ })
    .first()
    .click();
  await expect(page.getByText(/本人标记已理解 · 含本人反馈/)).toBeVisible();
  const record = page.locator('pre').filter({ hasText: 'protocolVersion' });
  await expect(record).toBeHidden();
  await page.getByText('更多操作', { exact: true }).click();
  await page.getByText('内容版本（1）', { exact: true }).click();
  await expect(record).toBeHidden();
  await page.getByText(/评阅核对记录 ·/).click();
  await expect(record).toHaveText(audit);
  await expect(record).toBeVisible();
  await expect(page.getByRole('heading', { name: '从使用者开始', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '审计字段不能变成标题', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as unknown as { __unsafe?: boolean }).__unsafe))).toBe(false);
  expect(state.todayReads).not.toContain('/today');
});

for (const stateName of ['completed', 'ready'])
  test('已结束学习记录不再接收新答案：' + stateName, async ({ page }) => {
    const state = fixture();
    state.session.state = stateName;
    await setup(page, state);
    await page.goto('/#/session/session-1');
    await expect(page.getByRole('heading', { name: state.session.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '提交回答', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('练习回答', { exact: true })).toHaveCount(0);
    if (stateName === 'completed') {
      await expect(page.getByText('本轮练习已完成。下一次复习会按目标安排准备。', { exact: true })).toBeVisible();
      await page.getByRole('link', { name: '查看目标与复习安排', exact: true }).click();
      await expect(page.getByRole('heading', { name: '学习路径', exact: true })).toBeVisible();
    }
    expect(state.posts).toHaveLength(0);
  });
test('完成独立答疑后可返回工作台，原记录不会新建回答', async ({ page }) => {
  const state = fixture();
  state.session.state = 'completed';
  state.session.goalId = null;
  await setup(page, state);
  await page.goto('/#/session/session-1');
  await expect(page.getByText('本轮练习已完成。新的问题可从学习答疑开始。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回学习工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习工作台', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
});
for (const stateName of ['completed', 'ready'])
  test('非学习任务仍可提交修改意见：' + stateName, async ({ page }) => {
    const state = fixture();
    state.session.state = stateName;
    state.session.kind = 'work';
    state.session.goalId = null;
    await setup(page, state);
    await page.goto('/#/session/session-1');
    await page.getByLabel('修改意见', { exact: true }).fill('补充时间安排');
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    expect(state.posts.at(-1)?.body.answer).toBe('补充时间安排');
  });

for (const appearance of ['light', 'dark'] as const)
  test(`系统${appearance}外观：可读对比、菜单与手机布局`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: appearance });
    await setup(page, fixture(), false);
    await page.screenshot({ path: testInfo.outputPath(`login-${appearance}.png`), fullPage: true, scale: 'css' });
    await page.getByLabel('账号', { exact: true }).fill('tester');
    await page.getByLabel('密码', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
    await page.getByLabel('学习目标', { exact: true }).fill('理解关系模型，完成一次练习。');
    // Measure rendered text over its actual ancestor surfaces, including alpha.
    await expect(async () => {
      const contrast = await page.getByRole('main').evaluate((main) => {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
        const blend = (front: number[], back: number[]) =>
          front.slice(0, 3).map((v, i) => v * (front[3] ?? 1) + back[i]! * (1 - (front[3] ?? 1)));
        const luminance = (color: number[]) =>
          color
            .slice(0, 3)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        return [...main.querySelectorAll<HTMLElement>('h1,h2,p,button,textarea,[class*="featureDescription"]')]
          .filter((element) => element.getClientRects().length && !element.matches(':disabled'))
          .map((element) => {
            const ancestors: Element[] = [];
            for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
            const background = ancestors.reduce(
              (back, node) => blend(rgb(getComputedStyle(node).backgroundColor), back),
              [255, 255, 255],
            );
            const foreground = blend(rgb(getComputedStyle(element).color), background);
            const l = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
            return {
              text: (element.textContent || element.getAttribute('aria-label') || element.tagName).slice(0, 45),
              ratio: (l[0]! + 0.05) / (l[1]! + 0.05),
            };
          });
      });
      for (const item of contrast) expect(item.ratio, `${appearance}: ${item.text}`).toBeGreaterThanOrEqual(4.5);
    }).toPass({ timeout: 2000 }); // Allow the enabled-button transition to finish.
    for (const link of await page.getByRole('navigation', { name: '主导航' }).getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`today-${appearance}.png`), fullPage: true, scale: 'css' });
    await page.getByLabel('更多', { exact: true }).click();
    await expect(page.getByRole('link', { name: '设置', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`menu-${appearance}.png`), fullPage: true, scale: 'css' });
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-${appearance}.png`), fullPage: true, scale: 'css' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole('link', { name: '资料', exact: true }).click();
    await expect(page.getByRole('link', { name: /第一讲：软件工程/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`library-${appearance}.png`), fullPage: true, scale: 'css' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });

test('高对比与减少动态模式保留选中状态和键盘操作', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await setup(page);
  const selected = page.getByRole('button', { name: '学习计划', exact: true });
  await selected.focus();
  await expect(selected).toBeFocused();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  expect(await selected.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  expect(await selected.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s');
  const mode = page.getByRole('button', { name: '学习答疑', exact: true });
  await mode.focus();
  await mode.press('Enter');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('学习问题', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('后台异常可见并有处理入口，刷新后显示恢复状态', async ({ page }, testInfo) => {
  const state = fixture();
  state.runtimeError = true;
  await setup(page, state);
  await expect(page.getByText('后台有 1 项检查需要处理。')).toBeVisible();
  await page.getByRole('link', { name: '查看运行状态', exact: true }).click();
  const panel = page.getByRole('region', { name: '运行状态' });
  await expect(panel.getByText('资料同步 · 需要处理')).toBeVisible();
  await expect(panel.getByText(/文件格式、大小和读取权限/)).toBeVisible();
  await expect(panel.getByRole('link', { name: '查看', exact: true })).toHaveAttribute('href', '#/library');
  await page.screenshot({ path: testInfo.outputPath('runtime-status.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  state.runtimeError = false;
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(panel.getByText('资料同步 · 正常')).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('后台检查正常。');
});

test('今天会刷新后台状态，持续保存正在输入的草稿', async ({ page }) => {
  await page.clock.install();
  const state = await setup(page);
  await page.getByLabel('学习目标').fill('保留输入的学习目标');
  state.runtimeError = true;
  state.workerOnline = false;
  await page.clock.fastForward(20_001);
  await expect(page.getByText('后台有 1 项检查需要处理。')).toHaveCount(0);
  await expect(page.getByText(/后台尚未运行/)).toBeVisible();
  await expect(page.getByLabel('学习目标')).toHaveValue('保留输入的学习目标');
});
