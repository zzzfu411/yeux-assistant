import { test, expect, type Page } from '@playwright/test';
import type { SourceDetail, SourceMetadata } from '../../packages/contracts/src/index';

const timestamp = '2026-10-03T03:00:00.000Z';
const originalText = '需求描述使用者希望完成的事情，测试检验具体行为是否符合需求。';
type Version = { version: number; title: string; content: string; metadata: SourceMetadata | null; createdAt: string };
type Source = { id: string; revision: number; archivedAt: string | null; managed: boolean; versions: Version[] };
function source(id = 'source-1', title = '软件工程笔记', content = originalText): Source {
  return {
    id,
    revision: 1,
    archivedAt: null,
    managed: true,
    versions: [{ version: 1, title, content, metadata: null, createdAt: timestamp }],
  };
}
function fixture() {
  return {
    sources: [source()],
    posts: [] as Array<{ path: string; body: any; key: string | undefined }>,
    gets: [] as string[],
    conflict: false,
    holdUpdate: false,
    releaseUpdate: null as null | (() => void),
    holdImport: false,
    releaseImport: null as null | (() => void),
  };
}
type State = ReturnType<typeof fixture>;
function detail(item: Source, version?: number): SourceDetail {
  const current = item.versions.at(-1)!,
    selected = item.versions.find((row) => row.version === (version || current.version))!;
  return {
    id: item.id,
    title: selected.title,
    content: selected.content,
    metadata: selected.metadata,
    version: selected.version,
    current_version: current.version,
    digest: 'd'.repeat(64),
    revision: item.revision,
    archivedAt: item.archivedAt,
    managed: item.managed,
    editableText: item.managed && current.metadata === null,
    versions: item.versions
      .slice()
      .reverse()
      .map(({ version, title, createdAt }) => ({ version, title, createdAt })),
  };
}
function revise(item: Source, title: string, content: string) {
  const old = item.versions.at(-1)!;
  if (old.title !== title || old.content !== content) {
    item.versions.push({ ...old, version: old.version + 1, title, content });
    item.revision++;
  }
  return { id: item.id, version: item.versions.at(-1)!.version, revision: item.revision };
}
async function setup(page: Page, state = fixture()) {
  let signedIn = false;
  const receipts = new Map<string, unknown>();
  await page.route('**/api/v2/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace('/api/v2', '');
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/login') {
      signedIn = true;
      return json({ username: 'tester' });
    }
    if (!signedIn) return json({ error: { code: 'unauthorized', message: '请登录管理员账号。' } }, 401);
    if (path === '/auth/session') return json({ username: 'tester' });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (request.method() === 'GET') {
      state.gets.push(path + url.search);
      if (path === '/today' || path === '/today/overview')
        return json({
          goalTotal: 0,
          activeGoalTotal: 0,
          pendingTotal: 0,
          goals: [],
          sessions: [],
          unread: 0,
          modelConfigured: true,
          workerOnline: true,
        });
      if (path === '/sources')
        return json(
          state.sources
            .filter((row) => Boolean(row.archivedAt) === (url.searchParams.get('archived') === 'true'))
            .map((item) => {
              const current = item.versions.at(-1)!;
              return {
                id: item.id,
                title: current.title,
                version: current.version,
                revision: item.revision,
                digest: 'd'.repeat(64),
                updatedAt: timestamp,
                metadata: current.metadata,
                archivedAt: item.archivedAt,
                managed: item.managed,
              };
            }),
        );
      if (path.startsWith('/sources/')) {
        const item = state.sources.find((item) => item.id === path.split('/')[2]);
        return item
          ? json(detail(item, Number(url.searchParams.get('version')) || undefined))
          : json({ error: { code: 'not_found', message: '资料不存在。' } }, 404);
      }
      return json({ error: { code: 'not_found', message: '不存在。' } }, 404);
    }
    const body = request.postDataJSON(),
      key = request.headers()['idempotency-key'];
    state.posts.push({ path, body, key });
    if (key && receipts.has(key)) return json(receipts.get(key));
    const saved = (value: unknown) => {
      if (key) receipts.set(key, structuredClone(value));
      return json(value);
    };
    if (path === '/sources') {
      const duplicate = state.sources.find((item) => item.versions.at(-1)!.content === body.content);
      const item =
        duplicate && !body.allowDuplicate
          ? duplicate
          : source('source-' + (state.sources.length + 1), body.title, body.content);
      if (item !== duplicate) state.sources.push(item);
      const result = {
        id: item.id,
        version: item.versions.at(-1)!.version,
        revision: item.revision,
        duplicate: item === duplicate && !body.allowDuplicate,
        archivedAt: item.archivedAt,
      };
      if (state.holdImport)
        await new Promise<void>((resolve) => {
          state.releaseImport = resolve;
        });
      return saved(result);
    }
    const item = state.sources.find((item) => item.id === path.split('/')[2]);
    if (!item) return json({ error: { code: 'not_found', message: '资料不存在。' } }, 404);
    if (state.conflict && !path.endsWith('/archive')) {
      state.conflict = false;
      revise(item, '另一窗口的新标题', '另一窗口已经补充的最新正文。');
      return json(
        { error: { code: 'version_conflict', message: '内容已更新，请载入最新版本；当前输入会保留。' } },
        409,
      );
    }
    if (item.revision !== body.revision)
      return json({ error: { code: 'version_conflict', message: '内容已更新，请载入最新版本。' } }, 409);
    if (path.endsWith('/archive')) {
      item.archivedAt = body.archived ? timestamp : null;
      item.revision++;
      return saved({ id: item.id, revision: item.revision, archivedAt: item.archivedAt });
    }
    if (item.archivedAt)
      return json({ error: { code: 'source_archived', message: '请先恢复这份资料，再修改内容。' } }, 409);
    const previous = item.versions.at(-1)!;
    if (
      body.content !== undefined &&
      body.content !== previous.content &&
      (!item.managed || previous.metadata !== null)
    )
      return json({ error: { code: 'source_read_only', message: '请通过原导入流程更新正文。' } }, 409);
    const result = revise(item, body.title ?? previous.title, body.content ?? previous.content);
    if (state.holdUpdate)
      await new Promise<void>((resolve) => {
        state.releaseUpdate = resolve;
      });
    return saved(result);
  });
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('tester');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '学习工作台' })).toBeVisible();
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  return state;
}
async function add(page: Page, title: string, content: string) {
  await page.getByRole('button', { name: '添加资料', exact: true }).click();
  await page.getByRole('textbox', { name: '标题', exact: true }).fill(title);
  await page.getByRole('textbox', { name: '原文', exact: true }).fill(content);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
}
async function edit(page: Page, title = '软件工程笔记') {
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await expect(page.getByRole('form', { name: '编辑资料', exact: true })).toBeVisible();
}
const editor = (page: Page) => page.getByRole('form', { name: '编辑资料', exact: true });

test('重复正文提示已有资料，不自动创建副本或清空输入', async ({ page }) => {
  const state = await setup(page);
  await add(page, '另一个标题', originalText);
  await expect(page.getByRole('status').filter({ hasText: '已有相同正文的资料' })).toContainText('已有相同正文的资料');
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('另一个标题');
  await expect(page.getByRole('textbox', { name: '原文', exact: true })).toHaveValue(originalText);
  expect(state.sources).toHaveLength(1);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.body.allowDuplicate).toBe(false);
  await page.getByRole('link', { name: '查看已有资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '软件工程笔记', exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});
test('只有明确点击仍保存副本才创建独立资料', async ({ page }) => {
  const state = await setup(page);
  await add(page, '我的独立副本', originalText);
  await page.getByRole('button', { name: '仍保存副本', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的独立副本', exact: true })).toBeVisible();
  expect(state.sources).toHaveLength(2);
  expect(state.posts.map((row) => row.body.allowDuplicate)).toEqual([false, true]);
  expect(state.posts.every((row) => Boolean(row.key))).toBe(true);
  expect(state.sources[0]!.versions).toEqual([
    expect.objectContaining({ version: 1, title: '软件工程笔记', content: originalText }),
  ]);
});
test('编辑生成新版本，历史链接保留原标题和正文', async ({ page }, info) => {
  const state = await setup(page);
  await edit(page);
  await editor(page).getByRole('textbox', { name: '资料标题', exact: true }).fill('需求与测试笔记');
  await editor(page)
    .getByRole('textbox', { name: '资料正文', exact: true })
    .fill('新版正文：每个需求都配一个可验证的验收例子。');
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('heading', { name: '需求与测试笔记', exact: true })).toBeVisible();
  await page.getByText('版本历史（2）', { exact: true }).click();
  await page.getByRole('link', { name: /第 1 版 · 软件工程笔记/ }).click();
  await expect(page.getByRole('heading', { name: '软件工程笔记', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看最新版', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑资料', exact: true })).toHaveCount(0);
  await expect(page.getByText(originalText, { exact: true }).first()).toBeVisible();
  expect(state.sources[0]!.versions[0]).toMatchObject({ version: 1, title: '软件工程笔记', content: originalText });
  await page.screenshot({ path: info.outputPath('source-history.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('归档后从使用中移出，旧链接仍可阅读并恢复使用', async ({ page }) => {
  const state = fixture();
  revise(state.sources[0]!, '软件工程笔记新版', '当前版本正文。');
  await setup(page, state);
  await page.getByRole('link', { name: /软件工程笔记新版/ }).click();
  await page.getByRole('button', { name: '归档资料', exact: true }).click();
  await expect(
    page.getByText('已归档，不参与新检索。历史引用与已出题的资料依据继续保留。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '‹ 全部资料', exact: true }).click();
  await expect(page.getByRole('link', { name: /软件工程笔记新版/ })).toHaveCount(0);
  await page.getByRole('combobox', { name: '资料范围', exact: true }).selectOption('true');
  await page.getByRole('link', { name: /软件工程笔记新版/ }).click();
  await page.getByText('版本历史（2）', { exact: true }).click();
  await page.getByRole('link', { name: /第 1 版 · 软件工程笔记/ }).click();
  await expect(page.getByRole('heading', { name: '软件工程笔记', exact: true })).toBeVisible();
  await expect(page.getByText(originalText, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '恢复使用', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档资料', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '‹ 全部资料', exact: true }).click();
  await expect(page.getByRole('link', { name: /软件工程笔记新版/ })).toBeVisible();
  expect(state.posts.filter((row) => row.path.endsWith('/archive')).map((row) => row.body)).toEqual([
    { revision: 2, archived: true },
    { revision: 3, archived: false },
  ]);
  expect(state.sources[0]!.versions).toHaveLength(2);
});
test('资料编辑草稿关闭、重新打开和刷新后都保留', async ({ page }) => {
  const state = await setup(page);
  await edit(page);
  await editor(page).getByRole('textbox', { name: '资料标题', exact: true }).fill('尚未提交的标题');
  await editor(page).getByRole('textbox', { name: '资料正文', exact: true }).fill('尚未提交的草稿正文。');
  await editor(page).getByRole('button', { name: '关闭编辑', exact: true }).click();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '尚未提交的草稿正文。',
  );
  await page.reload();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '资料标题', exact: true })).toHaveValue('尚未提交的标题');
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '尚未提交的草稿正文。',
  );
  expect(state.posts).toHaveLength(0);
});
test('冲突先展示最新正文，选择保留输入后才可覆盖新版本', async ({ page }, info) => {
  const state = fixture();
  state.conflict = true;
  await setup(page, state);
  await edit(page);
  await editor(page).getByRole('textbox', { name: '资料正文', exact: true }).fill('本人尚未保存的改写。');
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('内容已更新');
  await editor(page).getByRole('button', { name: '载入最新版本，保留输入', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: '保存新版本', exact: true })).toBeDisabled();
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '本人尚未保存的改写。',
  );
  await editor(page).getByText('查看最新内容', { exact: true }).click();
  await expect(editor(page).getByText('另一窗口已经补充的最新正文。', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('source-conflict.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor(page).getByRole('button', { name: '保留输入继续编辑', exact: true }).click();
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.posts[1]!.body).toMatchObject({ revision: 2, content: '本人尚未保存的改写。' });
  expect(state.sources[0]!.versions[1]!.content).toBe('另一窗口已经补充的最新正文。');
});
test('冲突时也可明确采用最新内容，读取本身不丢弃草稿', async ({ page }) => {
  const state = fixture();
  state.conflict = true;
  await setup(page, state);
  await edit(page);
  await editor(page).getByRole('textbox', { name: '资料正文', exact: true }).fill('准备放弃的本地改写。');
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await editor(page).getByRole('button', { name: '载入最新版本，保留输入', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '准备放弃的本地改写。',
  );
  await editor(page).getByRole('button', { name: '使用最新内容', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '资料标题', exact: true })).toHaveValue('另一窗口的新标题');
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '另一窗口已经补充的最新正文。',
  );
  expect(state.posts).toHaveLength(1);
});
test('保存回应较晚时保留继续输入，并携带成功保存后的版本', async ({ page }) => {
  const state = fixture();
  state.holdUpdate = true;
  await setup(page, state);
  await edit(page);
  await editor(page).getByRole('textbox', { name: '资料正文', exact: true }).fill('第一批提交内容。');
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseUpdate)).toBe(true);
  await editor(page).getByRole('textbox', { name: '资料正文', exact: true }).fill('等待期间继续输入的第二批内容。');
  state.holdUpdate = false;
  state.releaseUpdate!();
  await expect(editor(page).getByRole('status')).toContainText('继续输入的内容仍在');
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    '等待期间继续输入的第二批内容。',
  );
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.posts[1]!.body).toMatchObject({ revision: 2, content: '等待期间继续输入的第二批内容。' });
  expect(state.sources[0]!.versions[1]!.content).toBe('第一批提交内容。');
});
for (const duplicate of [false, true])
  test(`添加回应较晚时保留新输入${duplicate ? '且不展示过期重复提示' : '且不强行跳转'}`, async ({ page }) => {
    const state = fixture();
    state.holdImport = true;
    await setup(page, state);
    await add(page, '第一份输入', duplicate ? originalText : '独立的第一份正文。');
    await expect.poll(() => Boolean(state.releaseImport)).toBe(true);
    await page.getByRole('textbox', { name: '标题', exact: true }).fill('等待期间的新标题');
    await page.getByRole('textbox', { name: '原文', exact: true }).fill('等待期间的新正文。');
    state.holdImport = false;
    state.releaseImport!();
    await expect(page.getByRole('status').filter({ hasText: '保留' })).toContainText('保留');
    await expect(page.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('等待期间的新标题');
    await expect(page.getByRole('textbox', { name: '原文', exact: true })).toHaveValue('等待期间的新正文。');
    await expect(page.getByRole('button', { name: '仍保存副本', exact: true })).toHaveCount(0);
    expect(state.sources).toHaveLength(duplicate ? 1 : 2);
  });
test('提取资料仅修改标题，保留来源、页码与提取正文', async ({ page }) => {
  const state = fixture(),
    item = state.sources[0]!;
  item.managed = false;
  item.versions[0]!.metadata = {
    course: 'se',
    courseName: '软件工程',
    format: 'pdf',
    originPath: 'se/lecture-one.pdf',
    originHash: 'e'.repeat(64),
    extraction: 'Synthetic text extraction',
    pages: [{ number: 1, start: 0, end: originalText.length }],
    warnings: [],
  };
  await setup(page, state);
  await edit(page);
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveCount(0);
  await expect(
    editor(page).getByText('这里可修改标题。提取文本请通过原导入流程更新，保留原件与页码。', { exact: true }),
  ).toBeVisible();
  await editor(page).getByRole('textbox', { name: '资料标题', exact: true }).fill('第一讲课程原件');
  await editor(page).getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第一讲课程原件', exact: true })).toBeVisible();
  expect(state.posts[0]!.body).toEqual({ revision: 1, title: '第一讲课程原件' });
  expect(item.versions[1]).toMatchObject({ content: originalText, metadata: item.versions[0]!.metadata });
  await page.getByText('来源与提取说明', { exact: true }).click();
  await expect(page.getByText('se/lecture-one.pdf', { exact: true })).toBeVisible();
});
test('长标题、长原文和版本历史在手机宽度下无横向溢出', async ({ page }, info) => {
  const state = fixture(),
    item = state.sources[0]!;
  item.versions[0]!.title = '软件工程课程讲义标题'.repeat(15);
  item.versions[0]!.content = '长段落'.repeat(300) + '\n\n' + 'long_identifier_'.repeat(80);
  revise(item, '新版'.repeat(70), item.versions[0]!.content + '\n增加的内容。');
  await setup(page, state);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: new RegExp(item.versions[1]!.title) }).click();
  await page.getByText('版本历史（2）', { exact: true }).click();
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByText('原文', { exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: '资料正文', exact: true })).toHaveValue(
    item.versions[1]!.content,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('source-long-content.png'), fullPage: true, scale: 'css' });
});
