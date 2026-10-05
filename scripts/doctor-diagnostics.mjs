import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createConnection, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const runReadOnly = (binary, args, options = {}) =>
  spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
export function probeLocalPort(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (status) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        done(status);
      }
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish('occupied'));
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'free' : 'unknown'));
  });
}
async function readPrivate(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return { invalid: true };
    return { text: await readFile(path, 'utf8') };
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { invalid: true };
  }
}
async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

// All subprocesses below inspect local metadata only. No start/stop, config write, model call or HTTP request.
export async function diagnose({
  root,
  folder,
  env = process.env,
  nodeVersion = process.versions.node,
  run = runReadOnly,
  probePort = probeLocalPort,
  localAddresses = Object.values(networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((item) => item.address),
} = {}) {
  root = resolve(root);
  folder = resolve(folder || env.ASSISTANT_DATA_DIR || join(root, 'private'));
  const checks = [],
    add = (id, status, message, action) => checks.push({ id, status, message, ...(action ? { action } : {}) });
  const major = Number(nodeVersion.split('.')[0]),
    minor = Number(nodeVersion.split('.')[1]);
  if (major >= 24) add('node', 'ok', 'Node.js 支持当前开发与运维脚本。');
  else if (major > 20 || (major === 20 && minor >= 12))
    add(
      'node',
      'warning',
      '宿主 Node.js 可运行运维脚本；开发与验证要求 Node.js 24。',
      '运行开发命令前切换到 Node.js 24；Compose 容器已固定使用 24。',
    );
  else add('node', 'error', '宿主 Node.js 不支持当前运维脚本。', '安装 Node.js 24 后重试。');

  const runtime = await readPrivate(join(folder, 'runtime.env'));
  let saved = {};
  if (runtime.missing)
    add('runtime', 'warning', '尚未初始化数据库运行配置。', '首次部署运行 pnpm start；该命令会生成私密运行配置。');
  else if (runtime.invalid)
    add('runtime', 'error', '数据库运行配置不可读取或不是普通文件。', '检查 private/runtime.env 的类型和读取权限。');
  else {
    try {
      saved = parseEnv(runtime.text);
      if (!(env.POSTGRES_PASSWORD ?? saved.POSTGRES_PASSWORD)?.trim()) throw new Error();
      add('runtime', 'ok', '数据库运行配置可读取。');
    } catch {
      add(
        'runtime',
        'error',
        '数据库运行配置缺少有效密码。',
        '从可信备份核对 runtime.env；已有数据库时不要直接更换密码。',
      );
    }
  }
  const environment = { ...saved, ...env, ASSISTANT_DATA_DIR: folder };
  const credentials = await readPrivate(join(folder, 'admin-auth.json'));
  if (credentials.missing)
    add('administrator', 'warning', '尚未设置网页登录账号。', '运行 pnpm admin:setup 后再登录。');
  else {
    let valid = false;
    try {
      const value = JSON.parse(credentials.text);
      valid =
        object(value) &&
        Object.keys(value).sort().join(',') === 'hash,salt,username' &&
        typeof value.username === 'string' &&
        value.username.length > 0 &&
        value.username.length <= 80 &&
        typeof value.salt === 'string' &&
        /^[a-f0-9]{32}$/.test(value.salt) &&
        typeof value.hash === 'string' &&
        /^[a-f0-9]{128}$/.test(value.hash);
    } catch {
      /* Do not include parsed credential values in the report. */
    }
    add(
      'administrator',
      valid ? 'ok' : 'error',
      valid ? '管理员配置格式有效。' : '管理员配置格式无效或不可读取。',
      valid ? undefined : '保留旧文件，运行 pnpm admin:setup 重新设置账号。',
    );
  }
  const token = await readPrivate(join(folder, 'access-token'));
  add(
    'access_token',
    token.missing ? 'warning' : token.invalid || !token.text?.trim() ? 'error' : 'ok',
    token.missing
      ? '首次启动将创建 CLI 访问口令。'
      : token.invalid || !token.text?.trim()
        ? 'CLI 访问口令为空或不可读取。'
        : 'CLI 访问口令可读取。',
    token.invalid || (!token.missing && !token.text?.trim())
      ? '核对 private/access-token；不要把口令写入命令输出或提交到仓库。'
      : undefined,
  );
  const config = await readPrivate(join(folder, 'config.json'));
  if (config.missing) add('model_config', 'warning', '尚未配置模型。', '启动后在设置中填写模型连接，再运行模型检查。');
  else {
    try {
      const value = JSON.parse(config.text);
      if (!object(value) || (value.llm != null && !object(value.llm))) throw new Error();
      const llm = value.llm || {};
      for (const key of ['base_url', 'model', 'api_key'])
        if (llm[key] !== undefined && typeof llm[key] !== 'string') throw new Error();
      if (llm.tools !== undefined && typeof llm.tools !== 'boolean') throw new Error();
      if (llm.base_url) {
        const url = new URL(llm.base_url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !llm.model?.trim()
        )
          throw new Error();
        add('model_config', 'ok', '模型配置格式有效；未调用模型验证连接。');
      } else add('model_config', 'warning', '模型地址尚未配置。', '启动后在设置中填写模型连接，再运行模型检查。');
    } catch {
      add(
        'model_config',
        'error',
        '模型配置不可读取或格式无效。',
        '核对 private/config.json 的 JSON 结构与模型字段；配置内容未输出。',
      );
    }
  }
  const exists = async (path) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      return error.code !== 'ENOENT';
    }
  };
  if (
    (await exists(join(folder, 'assistant.sqlite3'))) &&
    !(await exists(join(folder, 'v2-cutover.json'))) &&
    env.ASSISTANT_MIGRATION_PREVIEW !== '1'
  )
    add('legacy_data', 'error', '检测到尚未确认切换的旧版数据。', '按 docs/development.md 完成迁移核对后再启动。');

  const docker = run('docker', ['--version']);
  const dockerAvailable = !docker.error && docker.status === 0;
  add(
    'docker_client',
    dockerAvailable ? 'ok' : 'error',
    dockerAvailable ? 'Docker 客户端可用。' : 'Docker 客户端不可用。',
    dockerAvailable ? undefined : '安装 Docker CLI 与 Compose；macOS 可使用 Colima。',
  );
  let composeAvailable = false,
    engineAvailable = false,
    ownPort = false,
    ownershipConflict = false;
  const project = env.COMPOSE_PROJECT_NAME || 'yeux-assitant',
    port = Number(environment.ASSISTANT_PORT || 8765),
    bind = environment.ASSISTANT_BIND || '0.0.0.0';
  const validProject = /^[a-z0-9][a-z0-9_-]*$/.test(project);
  if (!validProject)
    add(
      'compose_project',
      'error',
      'Compose 项目名格式无效。',
      '设置小写字母或数字开头的 COMPOSE_PROJECT_NAME；仅使用字母、数字、横线和下划线。',
    );
  if (dockerAvailable) {
    const compose = run('docker', ['compose', 'version', '--short']);
    composeAvailable = !compose.error && compose.status === 0;
    add(
      'compose',
      composeAvailable ? 'ok' : 'error',
      composeAvailable ? 'Docker Compose 可用。' : 'Docker Compose 不可用。',
      composeAvailable ? undefined : '安装 Docker Compose 插件后重试。',
    );
    const engine = run('docker', ['info', '--format', '{{.ServerVersion}}']);
    engineAvailable = !engine.error && engine.status === 0;
    add(
      'docker_engine',
      engineAvailable ? 'ok' : 'error',
      engineAvailable ? 'Docker 引擎可连接。' : 'Docker 引擎未运行或当前账号无权连接。',
      engineAvailable ? undefined : '手动启动 Docker 或 Colima，然后重试 pnpm run doctor。',
    );
  }
  if (engineAvailable && validProject) {
    const listed = run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]);
    const ids = typeof listed.stdout === 'string' ? listed.stdout.trim().split(/\s+/).filter(Boolean) : [];
    if (listed.error || listed.status !== 0 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
      add('instance', 'error', '无法读取当前 Compose 实例信息。', '检查 Docker 权限后重试；本次没有修改容器。');
    else if (!ids.length) add('instance', 'ok', '当前 Compose 项目名未被现有容器使用。');
    else {
      const format =
        '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"state":{{json .State.Status}}}';
      const inspected = run('docker', ['inspect', '--format', format, ...ids]);
      try {
        if (inspected.error || inspected.status !== 0) throw new Error();
        const items = inspected.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (items.length !== ids.length) throw new Error();
        const expectedRoot = await canonical(root),
          expectedFolder = await canonical(folder);
        for (const item of items) {
          const labels = item.labels;
          if (
            !object(labels) ||
            !Array.isArray(item.mounts) ||
            typeof labels['com.docker.compose.project.working_dir'] !== 'string' ||
            typeof labels['com.docker.compose.project.config_files'] !== 'string'
          )
            throw new Error();
          const files = await Promise.all(labels['com.docker.compose.project.config_files'].split(',').map(canonical));
          if (
            (await canonical(labels['com.docker.compose.project.working_dir'])) !== expectedRoot ||
            !files.includes(await canonical(join(root, 'compose.yaml')))
          )
            ownershipConflict = true;
          for (const mount of item.mounts)
            if (
              mount.Destination === '/app/private' &&
              (mount.Type !== 'bind' ||
                typeof mount.Source !== 'string' ||
                (await canonical(mount.Source)) !== expectedFolder)
            )
              ownershipConflict = true;
          if (item.state === 'running')
            for (const mappings of Object.values(item.ports || {})) {
              if (
                Array.isArray(mappings) &&
                mappings.some(
                  (mapping) =>
                    Number(mapping.HostPort) === port &&
                    (mapping.HostIp === bind || mapping.HostIp === '0.0.0.0' || mapping.HostIp === '::'),
                )
              )
                ownPort = true;
            }
        }
        add(
          'instance',
          ownershipConflict ? 'error' : 'ok',
          ownershipConflict ? '同名 Compose 实例属于其他目录或数据目录。' : '现有 Compose 实例与本项目、数据目录一致。',
          ownershipConflict
            ? '切回原项目目录操作，或明确选择独立的 COMPOSE_PROJECT_NAME 与空数据目录；不要停止或覆盖该实例。'
            : undefined,
        );
      } catch {
        ownPort = false;
        add(
          'instance',
          'error',
          '无法确认现有 Compose 实例归属。',
          '先检查 docker compose ls 与容器标签；不要重建来源不明的同名实例。',
        );
      }
    }
  }
  if (
    composeAvailable &&
    !runtime.missing &&
    !runtime.invalid &&
    environment.POSTGRES_PASSWORD?.trim() &&
    validProject
  ) {
    const override = await readPrivate(join(folder, 'compose.override.yaml'));
    if (override.invalid)
      add(
        'compose_config',
        'error',
        'Compose 覆盖文件不是可读取的普通文件。',
        '检查 private/compose.override.yaml 后重试。',
      );
    else {
      const args = [
        'compose',
        '--env-file',
        join(folder, 'runtime.env'),
        '-f',
        join(root, 'compose.yaml'),
        ...(!override.missing ? ['-f', join(folder, 'compose.override.yaml')] : []),
        '-p',
        project,
        'config',
        '--quiet',
      ];
      const checked = run('docker', args, { env: environment });
      add(
        'compose_config',
        !checked.error && checked.status === 0 ? 'ok' : 'error',
        !checked.error && checked.status === 0 ? 'Compose 配置可解析。' : 'Compose 配置无法解析。',
        !checked.error && checked.status === 0
          ? undefined
          : '核对 compose.yaml、私密覆盖文件及 runtime.env；诊断不会输出可能含密钥的 Docker 错误。',
      );
    }
  }
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !isIP(bind) ||
    !['0.0.0.0', '::', '127.0.0.1', '::1', ...localAddresses].includes(bind)
  )
    add(
      'port',
      'error',
      '监听地址不是本机 IP，或端口格式无效。',
      'ASSISTANT_BIND 使用本机 IP，ASSISTANT_PORT 使用 1–65535 的整数；不要自动改动其他项目端口。',
    );
  else {
    const observed = await probePort(bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind, port);
    if (observed === 'free') add('port', 'ok', '所选端口当前未响应连接；启动时仍需由 Docker 最终检查。');
    else if (observed === 'occupied' && ownPort && !ownershipConflict)
      add('port', 'ok', '所选端口由本项目已运行的容器使用。');
    else if (observed === 'occupied')
      add(
        'port',
        'error',
        '所选端口已占用，无法确认由本项目使用。',
        '核对占用进程，或明确选择其他 ASSISTANT_PORT；诊断不会结束进程或自动换端口。',
      );
    else add('port', 'warning', '无法确认所选端口状态。', '核对本机监听地址与网络设置后重试。');
  }
  return { ok: !checks.some((item) => item.status === 'error'), checks };
}
