import { test, expect, type Page } from '@playwright/test';
import type { Device, DeviceCommand, DeviceOverview } from '../../packages/contracts/src/devices';

async function openMore(page: Page) {
  // Desktop lists secondary pages in the sidebar; phones open them from the tab bar.
  const more = page.getByLabel('更多', { exact: true });
  if (await more.isVisible()) await more.click();
}

function fixture() {
  return {
    control: { enabled: true, revision: 1 },
    devices: [] as Device[],
    commands: [] as DeviceCommand[],
    hiddenCommands: new Set<string>(),
    posts: [] as Array<{ path: string; body: any; key: string | undefined }>,
    gets: [] as string[],
    conflict: false,
    workerOnline: true,
    serverOffset: 0,
    historyFailure: false,
    overviewFailure: false,
    commandFailure: false,
    resolveFailure: false,
    losePreview: false,
    decisionResponseLoss: '' as '' | 'immediate' | 'late',
    releaseDecisionResponse: null as null | (() => void),
    queueOnly: false,
    notifications: [] as Array<Record<string, unknown>>,
  };
}
type State = ReturnType<typeof fixture>;
const stamp = '2026-10-02T02:00:00.000Z';
function lamp(state: State, name = '演示台灯') {
  const id = '00000000-0000-4000-8000-' + String(state.devices.length + 1).padStart(12, '0');
  const device: Device = {
    id,
    name,
    adapter: 'simulation.lamp',
    mode: 'simulation',
    enabled: true,
    revision: 1,
    available: true,
    observedState: { power: false },
    observedAt: stamp,
    capabilities: [
      {
        id: 'power.set',
        label: '电源',
        choices: [
          { label: '开灯', arguments: { power: true } },
          { label: '关灯', arguments: { power: false } },
        ],
      },
    ],
  };
  state.devices.push(device);
  return device;
}
function command(state: State, device: Device, args = { power: true }, status: DeviceCommand['state'] = 'pending') {
  const result: DeviceCommand = {
    id: '10000000-0000-4000-8000-' + String(state.commands.length + 1).padStart(12, '0'),
    deviceId: device.id,
    deviceName: device.name,
    mode: device.mode,
    capability: 'power.set',
    arguments: args,
    summary: args.power ? '开灯' : '关灯',
    digest: 'a'.repeat(64),
    state: status,
    revision: 1,
    expiresAt: new Date(Date.now() + state.serverOffset + 300000).toISOString(),
    createdAt: stamp,
    updatedAt: stamp,
    error: '',
    receipt: null,
  };
  state.commands.unshift(result);
  return result;
}
async function setup(page: Page, state = fixture()) {
  let signedIn = false;
  const responses = new Map<string, unknown>();
  await page.route('**/api/v2/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/v2', '');
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/auth/login') {
      signedIn = true;
      return json({ username: 'tester' });
    }
    if (!signedIn) return json({ error: { code: 'unauthorized', message: '请登录管理员账号。' } }, 401);
    if (path === '/auth/session') return json({ username: 'tester' });
    if (path === '/events') return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
    if (req.method() === 'GET') {
      state.gets.push(path);
      if (path === '/today' || path === '/today/overview')
        return json({
          goalTotal: 0,
          activeGoalTotal: 0,
          pendingTotal: 0,
          goals: [],
          sessions: [],
          unread: state.notifications.length,
          modelConfigured: true,
          workerOnline: state.workerOnline,
        });
      if (path === '/sources') return json([]);
      if (path === '/devices')
        return state.overviewFailure
          ? json({ error: { message: '设备状态暂时无法读取。' } }, 503)
          : json({
              control: state.control,
              devices: state.devices,
              workerOnline: state.workerOnline,
              serverTime: new Date(Date.now() + state.serverOffset).toISOString(),
            } satisfies DeviceOverview);
      if (path === '/device-commands')
        return state.historyFailure
          ? json({ error: { message: '操作记录暂时无法读取。' } }, 503)
          : json(state.commands.filter((row) => !state.hiddenCommands.has(row.id)));
      if (path.startsWith('/device-commands/')) {
        if (state.commandFailure) return json({ error: { message: '指定操作暂时无法读取。' } }, 503);
        const row = state.commands.find((row) => row.id === path.split('/')[2]);
        return row ? json(row) : json({ error: { message: '操作记录不存在。' } }, 404);
      }
      if (path === '/notifications') return json({ items: state.notifications, total: state.notifications.length });
      return json({ error: { message: '不存在' } }, 404);
    }
    const body = req.postDataJSON(),
      key = req.headers()['idempotency-key'];
    state.posts.push({ path, body, key });
    if (key && responses.has(key)) return json(responses.get(key));
    const saved = (value: unknown) => {
      if (key) responses.set(key, structuredClone(value));
      return json(value);
    };
    if (path === '/devices/simulated') {
      const device = lamp(state, body.name);
      return saved({ deviceId: device.id });
    }
    if (path === '/device-control') {
      state.control = { enabled: body.enabled, revision: state.control.revision + 1 };
      for (const cmd of state.commands)
        if (['pending', 'approved'].includes(cmd.state)) {
          cmd.state = 'cancelled';
          cmd.revision++;
        }
      return saved(state.control);
    }
    if (path.endsWith('/commands')) {
      const device = state.devices.find((row) => row.id === path.split('/')[2])!;
      const cmd = command(state, device, body.arguments);
      if (state.losePreview) {
        state.losePreview = false;
        if (key) responses.set(key, structuredClone(cmd));
        return route.abort('connectionreset');
      }
      return saved(cmd);
    }
    if (path.startsWith('/devices/') && req.method() === 'PATCH') {
      const device = state.devices.find((row) => row.id === path.split('/')[2])!;
      device.enabled = body.enabled;
      device.revision++;
      return saved({ deviceId: device.id, revision: device.revision });
    }
    const cmd = state.commands.find((row) => row.id === path.split('/')[2]);
    if (path.endsWith('/decision') && cmd) {
      if (state.conflict) {
        state.conflict = false;
        cmd.state = 'expired';
        cmd.revision++;
        return json({ error: { code: 'version_conflict', message: '操作已更新，请载入最新版本。' } }, 409);
      }
      cmd.revision++;
      if (Date.parse(cmd.expiresAt) <= Date.now() + state.serverOffset && body.approve) {
        cmd.state = 'expired';
        return saved(cmd);
      }
      if (body.approve) {
        cmd.state = state.queueOnly ? 'approved' : 'succeeded';
        if (!state.queueOnly) {
          const device = state.devices.find((row) => row.id === cmd.deviceId)!;
          cmd.receipt = {
            source: 'simulation',
            before: device.observedState || {},
            after: cmd.arguments,
            outcome: 'verified',
            checkedAt: stamp,
          };
          device.observedState = cmd.arguments;
        }
      } else cmd.state = 'rejected';
      if (state.decisionResponseLoss) {
        if (key) responses.set(key, structuredClone(cmd));
        if (state.decisionResponseLoss === 'late')
          await new Promise<void>((resolve) => {
            state.releaseDecisionResponse = resolve;
          });
        state.decisionResponseLoss = '';
        return route.abort('connectionreset');
      }
      return saved(cmd);
    }
    if (path.endsWith('/cancel') && cmd) {
      cmd.state = cmd.state === 'executing' ? 'uncertain' : 'cancelled';
      cmd.revision++;
      return saved(cmd);
    }
    if (path.endsWith('/resolve') && cmd) {
      if (state.resolveFailure) return json({ error: { message: '核实记录暂未保存，请重试。' } }, 503);
      cmd.state = 'resolved';
      cmd.revision++;
      cmd.receipt = { source: 'user_report', outcome: body.outcome, note: body.note, checkedAt: stamp };
      return saved(cmd);
    }
    if (path.endsWith('/read')) return saved({});
    return json({ error: { message: '未实现的测试请求' } }, 404);
  });
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('tester');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^今天/, level: 1 })).toBeVisible();
  // Secondary features live in the sidebar on a computer and under "更多" on a phone.
  const more = page.getByLabel('更多', { exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: '设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设备', exact: true })).toBeVisible();
  return state;
}
async function preview(page: Page) {
  await page.getByRole('button', { name: '添加演示台灯', exact: true }).click();
  await page.getByRole('button', { name: '开灯', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeVisible();
}
const card = (page: Page, device: Device) =>
  page.getByRole('article', { name: device.name + ' · ' + device.id.replace(/-/g, '').slice(-8), exact: true });
const record = (page: Page, cmd: DeviceCommand) => page.locator('#device-command-' + cmd.id);

test('演示设备明确标记，预览与确认分开，刷新后可继续', async ({ page }, info) => {
  const state = await setup(page);
  await expect(
    page.getByText('真实设备需要先完成接入；演示台灯不会控制你的电脑或电器。', { exact: true }),
  ).toBeVisible();
  await preview(page);
  expect(state.devices[0]!.observedState).toEqual({ power: false });
  expect(state.posts.filter((row) => row.path.endsWith('/decision'))).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('device-confirmation.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(page.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible();
  expect(state.posts.at(-1)).toMatchObject({ body: { revision: 1, digest: 'a'.repeat(64), approve: true } });
  expect(state.posts.every((row) => Boolean(row.key))).toBe(true);
});
test('设备可命名，默认名称递增，同名设备通过编号区分', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByLabel('设备名称', { exact: true })).toHaveValue('演示台灯');
  await page.getByRole('button', { name: '添加演示台灯', exact: true }).click();
  await expect(page.getByLabel('设备名称', { exact: true })).toHaveValue('演示台灯 2');
  await page.getByLabel('设备名称', { exact: true }).fill('书桌灯');
  await page.getByRole('button', { name: '添加演示台灯', exact: true }).click();
  await expect(page.getByRole('heading', { name: '书桌灯', exact: true })).toBeVisible();
  await page.getByLabel('设备名称', { exact: true }).fill('书桌灯');
  await page.getByRole('button', { name: '添加演示台灯', exact: true }).click();
  await expect(page.getByRole('heading', { name: '书桌灯', exact: true })).toHaveCount(2);
  const chosen = state.devices[2]!;
  await card(page, chosen).getByRole('button', { name: '开灯', exact: true }).click();
  await page.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(page.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible();
  expect(state.devices.map((row) => row.observedState)).toEqual([{ power: false }, { power: false }, { power: true }]);
  expect(state.commands[0]!.deviceId).toBe(chosen.id);
});
test('多个设备中选择操作后聚焦确认区，直接入口可重新定位', async ({ page }) => {
  const state = fixture();
  for (let i = 0; i < 8; i++) lamp(state, '台灯 ' + (i + 1));
  await setup(page, state);
  await card(page, state.devices[0]!).getByRole('button', { name: '开灯', exact: true }).click();
  const confirmation = page.getByRole('button', { name: '确认开灯', exact: true });
  await expect(confirmation).toBeInViewport();
  await expect(record(page, state.commands[0]!)).toBeFocused();
  expect(state.posts.filter((row) => row.path.endsWith('/decision'))).toHaveLength(0);
  await card(page, state.devices[0]!).getByRole('button', { name: '查看操作', exact: true }).click();
  await expect(confirmation).toBeInViewport();
  await expect(record(page, state.commands[0]!)).toBeFocused();
});
test('暂停使旧预览失效，恢复后需要重新选择操作', async ({ page }) => {
  const state = await setup(page);
  await preview(page);
  await page.getByRole('button', { name: '暂停全部设备', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '恢复设备操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toHaveCount(0);
  expect(state.commands[0]!.state).toBe('cancelled');
  expect(state.devices[0]!.observedState).toEqual({ power: false });
});
test('放弃操作保留记录且不改变设备状态', async ({ page }) => {
  const state = await setup(page);
  await preview(page);
  await page.getByRole('button', { name: '放弃操作', exact: true }).click();
  await expect(page.getByText('已放弃', { exact: true })).toBeVisible();
  expect(state.devices[0]!.observedState).toEqual({ power: false });
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeEnabled();
});
test('结果未知时不展示旧状态，人工核实不伪造设备观测', async ({ page }, info) => {
  const state = await setup(page);
  await preview(page);
  Object.assign(state.commands[0]!, {
    state: 'uncertain',
    revision: 3,
    error: '执行结果待核实，请检查设备；系统不会自动重发。',
  });
  state.devices[0]!.observedState = null;
  state.devices[0]!.observedAt = null;
  await page.reload();
  await expect(card(page, state.devices[0]!).getByText('状态待核实', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '确认未执行', exact: true })).toBeDisabled();
  await page.getByLabel('核实记录', { exact: true }).fill('检查演示状态，台灯仍为关闭。');
  await page.reload();
  await expect(page.getByLabel('核实记录', { exact: true })).toHaveValue('检查演示状态，台灯仍为关闭。');
  await page.screenshot({ path: info.outputPath('device-uncertain.png'), fullPage: true, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: '确认未执行', exact: true }).click();
  await expect(page.getByText('本人核实：未执行', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开灯', exact: true })).toBeEnabled();
  await expect(card(page, state.devices[0]!).getByText('尚未核验', { exact: true })).toBeVisible();
  expect(state.posts.at(-1)!.body).toEqual({
    revision: 3,
    outcome: 'not_executed',
    note: '检查演示状态，台灯仍为关闭。',
  });
});
test('核实保存失败保留输入，同一请求重试只保存一次', async ({ page }) => {
  const state = fixture(),
    device = lamp(state),
    cmd = command(state, device, { power: true }, 'uncertain');
  state.resolveFailure = true;
  await setup(page, state);
  await page.getByLabel('核实记录', { exact: true }).fill('实机状态尚未改变。');
  await page.getByRole('button', { name: '确认未执行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('核实记录暂未保存');
  await expect(page.getByLabel('核实记录', { exact: true })).toHaveValue('实机状态尚未改变。');
  state.resolveFailure = false;
  await page.getByRole('button', { name: '确认未执行', exact: true }).click();
  await expect(page.getByText('本人核实：未执行', { exact: true })).toBeVisible();
  const writes = state.posts.filter((row) => row.path.endsWith('/resolve'));
  expect(writes).toHaveLength(2);
  expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(cmd.revision).toBe(2);
});
test('冲突提示允许载入最新版本，不重复确认旧动作', async ({ page }) => {
  const state = await setup(page);
  await preview(page);
  state.conflict = true;
  await page.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作已更新');
  await page.getByRole('button', { name: '载入最新版本，保留输入', exact: true }).click();
  await expect(page.getByText('已过期', { exact: true })).toBeVisible();
  expect(state.posts.filter((row) => row.path.endsWith('/decision'))).toHaveLength(1);
});
test('后台离线说明排队与截止，已批准操作仍可取消', async ({ page }) => {
  const state = fixture();
  state.workerOnline = false;
  state.queueOnly = true;
  await setup(page, state);
  await expect(
    page.getByText('后台离线。确认后的操作会排队，仅在有效期内开始执行。恢复后台前可取消操作。', { exact: true }),
  ).toBeVisible();
  await preview(page);
  await page.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(record(page, state.commands[0]!).getByText('等待执行', { exact: true })).toBeVisible();
  await expect(page.getByText(/^执行截止：/)).toBeVisible();
  await page.getByRole('button', { name: '取消操作', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  expect(state.devices[0]!.observedState).toEqual({ power: false });
});
test('按服务器时间禁用过期确认，不依赖浏览器时间', async ({ page }) => {
  const state = fixture();
  state.workerOnline = false;
  state.serverOffset = 2 * 3600000;
  const device = lamp(state),
    cmd = command(state, device);
  cmd.expiresAt = new Date(Date.now() + 3600000).toISOString();
  await setup(page, state);
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeDisabled();
  await expect(page.getByText('有效期已结束，请重新选择操作。', { exact: true })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await expect(card(page, device).getByRole('button', { name: '开灯', exact: true })).toBeEnabled();
});
test('等待中到期会自行禁用确认，页面不会自动提交', async ({ page }) => {
  const state = fixture(),
    cmd = command(state, lamp(state));
  await setup(page, state);
  const confirm = page.getByRole('button', { name: '确认开灯', exact: true });
  await expect(confirm).toBeEnabled();
  cmd.expiresAt = new Date(Date.now() + 2500).toISOString();
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(confirm).toBeDisabled({ timeout: 8000 });
  expect(state.posts).toHaveLength(0);
});
test('消息链接打开超过最近50条的设备记录，保留原任务链接', async ({ page }) => {
  const state = fixture(),
    device = lamp(state),
    old = command(state, device, { power: true }, 'resolved');
  old.receipt = { source: 'user_report', outcome: 'not_executed', note: '旧记录已核实。', checkedAt: stamp };
  state.hiddenCommands.add(old.id);
  for (let i = 0; i < 50; i++) command(state, device, { power: false }, 'cancelled');
  state.notifications = [
    {
      id: 'notice-device',
      session_id: null,
      deviceCommandId: old.id,
      title: '旧设备操作',
      body: '查看核实记录。',
      read_at: null,
      created_at: stamp,
    },
    {
      id: 'notice-task',
      session_id: 'session-old',
      deviceCommandId: null,
      title: '学习任务',
      body: '原学习记录。',
      read_at: stamp,
      created_at: stamp,
    },
  ];
  await setup(page, state);
  await expect(page.getByText('旧记录已核实。', { exact: true })).toHaveCount(0);
  await openMore(page);
  await page.getByRole('link', { name: '消息（2）', exact: true }).click();
  await expect(page.getByRole('link', { name: '查看任务', exact: true })).toHaveAttribute(
    'href',
    '#/session/session-old',
  );
  await page.getByRole('link', { name: '查看操作', exact: true }).click();
  await expect(page.getByText('旧记录已核实。', { exact: true })).toBeVisible();
  await expect(record(page, old)).toBeFocused();
  await expect(record(page, old)).toBeInViewport();
  expect(state.gets).toContain('/device-commands/' + old.id);
  expect(state.posts).toHaveLength(0);
  await page.reload();
  await expect(page.getByText('旧记录已核实。', { exact: true })).toBeVisible();
});
test('读取操作记录失败时禁止新动作，恢复读取后可继续', async ({ page }) => {
  const state = fixture(),
    device = lamp(state);
  state.historyFailure = true;
  await setup(page, state);
  await expect(page.getByRole('alert')).toContainText('操作记录暂时无法读取');
  await expect(card(page, device).getByRole('button', { name: '开灯', exact: true })).toBeDisabled();
  state.historyFailure = false;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(card(page, device).getByRole('button', { name: '开灯', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(0);
});
test('单条深链读取失败可重试，不会误显示其他记录', async ({ page }) => {
  const state = fixture(),
    cmd = command(state, lamp(state), { power: true }, 'uncertain');
  state.hiddenCommands.add(cmd.id);
  state.commandFailure = true;
  await setup(page, state);
  await page.goto('/#/devices?command=' + cmd.id);
  await expect(page.getByRole('alert')).toContainText('指定操作暂时无法读取');
  await expect(page.getByLabel('核实记录', { exact: true })).toHaveCount(0);
  state.commandFailure = false;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.getByLabel('核实记录', { exact: true })).toBeVisible();
  await expect(record(page, cmd)).toBeFocused();
  expect(state.posts).toHaveLength(0);
});
test('预览响应丢失后从已保存记录继续，不重复创建或自动确认', async ({ page }) => {
  const state = fixture(),
    device = lamp(state);
  state.losePreview = true;
  await setup(page, state);
  await card(page, device).getByRole('button', { name: '开灯', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂未收到结果');
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await card(page, device).getByRole('button', { name: '查看操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeInViewport();
  expect(state.commands).toHaveLength(1);
  expect(state.posts.filter((row) => row.path.endsWith('/commands'))).toHaveLength(1);
  expect(state.posts.filter((row) => row.path.endsWith('/decision'))).toHaveLength(0);
  expect(state.posts[0]!.key).toBeTruthy();
  await page.getByRole('button', { name: '确认开灯', exact: true }).click();
  await expect(page.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(1);
});

test('设备总览初次读取失败可恢复，未核对状态时禁止确认', async ({ page }) => {
  const state = fixture(),
    device = lamp(state);
  command(state, device);
  state.overviewFailure = true;
  await setup(page, state);
  await expect(page.getByRole('alert')).toContainText('设备状态暂时无法读取');
  await expect(page.getByRole('button', { name: '添加演示台灯', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeDisabled();
  state.overviewFailure = false;
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加演示台灯', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(0);
});
test('设备总览刷新失败保留记录并禁用确认，恢复后需要本人点击', async ({ page }) => {
  const state = fixture(),
    device = lamp(state);
  command(state, device);
  await setup(page, state);
  const confirm = page.getByRole('button', { name: '确认开灯', exact: true });
  await expect(confirm).toBeEnabled();
  state.overviewFailure = true;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('设备状态暂时无法读取');
  await expect(confirm).toBeDisabled();
  await expect(page.getByRole('heading', { name: '演示台灯', exact: true })).toBeVisible();
  state.overviewFailure = false;
  // The page's own five-second poll may recover before this click; either way nothing is confirmed for the owner.
  const reload = page.getByRole('button', { name: '重新载入', exact: true });
  await reload.click({ timeout: 4000 }).catch(() => expect(reload).toHaveCount(0));
  await expect(confirm).toBeEnabled();
  expect(state.posts).toHaveLength(0);
});
for (const timing of ['immediate', 'late'] as const)
  test(
    '确认已成功但响应丢失后清除旧错误：' + (timing === 'late' ? '轮询先收到成功' : '网络错误先返回'),
    async ({ page }) => {
      const state = fixture(),
        device = lamp(state),
        cmd = command(state, device);
      state.decisionResponseLoss = timing;
      await setup(page, state);
      const failed = page.waitForEvent('requestfailed', (request) =>
        request.url().includes('/device-commands/' + cmd.id + '/decision'),
      );
      await page.getByRole('button', { name: '确认开灯', exact: true }).click();
      if (timing === 'late') {
        await expect(page.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible();
        expect(state.releaseDecisionResponse).not.toBeNull();
        state.releaseDecisionResponse!();
      }
      await failed;
      await expect(page.getByText('模拟状态已核验：开启', { exact: true })).toBeVisible();
      // Let the failed fetch and React's passive error-clearing effect both finish before checking the settled UI.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await expect(record(page, cmd).getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '确认开灯', exact: true })).toHaveCount(0);
      expect(state.posts.filter((row) => row.path.endsWith('/decision'))).toHaveLength(1);
      expect(state.commands).toHaveLength(1);
      expect(device.observedState).toEqual({ power: true });
    },
  );
