# 在隔离实例中恢复备份

恢复先创建新的 Compose 项目、数据库卷和私密目录。旧实例和备份保持完整；新实例只启动 API，核对完成后再决定是否启用 Worker。以下命令在项目根目录的 macOS/Linux 终端执行，每一步成功后再继续。

需要 Node.js 24、pnpm 9、已手动启动的 Docker/Colima 和本地 `postgres:18-bookworm` 镜像。使用与备份对应、或已验证可以升级该备份的代码版本。代码回退不等于数据库回退。

## 1. 检查备份

将下面的路径换成包含 `manifest.json` 和 `database.dump` 的完整备份目录；不要使用备份根目录。

```bash
export TASK_REPO="$PWD"
export TASK_BACKUP="/absolute/path/to/postgres-backup-directory"
pnpm backup:check "$TASK_BACKUP" --docker --json
```

退出码 **0** 才能继续：全部文件清单、大小、SHA-256 与 dump 完整解码均通过。**1** 表示失败；**2** 表示文件校验通过但归档解码未完成，不能当作可恢复。Ctrl-C 退出为 130，终止信号退出为 143。终端退出码可用 `echo $?` 查看。

`--docker` 使用已经存在的 PostgreSQL 18 镜像，通过 stdin 解码归档并丢弃 SQL；不连接数据库、不挂载备份目录、不启动 Docker 引擎，也不拉镜像。解码最多 30 秒，随后移除专属临时容器和它创建的匿名卷；清理未确认时会报告容器名。省略 `--docker` 则使用宿主机的 `pg_restore`。

## 2. 准备全新的私密目录和启动参数

选择一个空闲端口，避免旧实例的 8765/8766。以下随机标识保证本次恢复使用独立项目；记录这些 `TASK_*` 变量，后续命令在同一终端运行。

```bash
export TASK_RESTORE_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export TASK_RESTORE_PROJECT="yeux-restore-$TASK_RESTORE_ID"
export TASK_RESTORE_DATA="$TASK_REPO/private/restore-$TASK_RESTORE_ID"
export TASK_RESTORE_PORT=8877

node --input-type=module <<'JS'
import { mkdir, readFile, copyFile, chmod, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateManifest } from './scripts/backup-integrity.mjs';
const backup = process.env.TASK_BACKUP, target = process.env.TASK_RESTORE_DATA;
if (!backup || !target || !process.env.TASK_RESTORE_PROJECT) throw new Error('缺少 TASK_* 参数');
const manifest = validateManifest(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')));
await mkdir(target, { mode: 0o700 }); // 已存在就停止，不合并或覆盖。
for (const entry of manifest.files) {
  if (entry.path === 'database.dump') continue;
  const savedOnly = ['runtime.env', 'compose.override.yaml'].includes(entry.path);
  const destination = join(target, savedOnly ? 'recovery-input' : '', entry.path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(join(backup, entry.path), destination);
  await chmod(destination, 0o600);
  const bytes = await readFile(destination);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('复制核对失败；保留目录排查，不启动恢复实例。');
  }
}
await writeFile(join(target, 'runtime.env'), `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
const recoveryImage = `yeux-assistant-recovery:${process.env.TASK_RESTORE_ID}`;
await writeFile(join(target, 'recovery.compose.yaml'), JSON.stringify({ services: {
  api: { image: recoveryImage }, worker: { image: recoveryImage },
} }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(join(target, 'recovery.env'), [
  `TASK_RESTORE_PROJECT=${process.env.TASK_RESTORE_PROJECT}`,
  `TASK_RESTORE_PORT=${process.env.TASK_RESTORE_PORT}`,
].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
console.log('恢复文件复制、SHA-256 核对及新数据库凭据准备完成。');
JS

task_restore_compose() {
  env -u POSTGRES_PASSWORD \
    ASSISTANT_DATA_DIR="$TASK_RESTORE_DATA" \
    ASSISTANT_BIND=127.0.0.1 ASSISTANT_PORT="$TASK_RESTORE_PORT" \
    docker compose --env-file "$TASK_RESTORE_DATA/runtime.env" \
    -f "$TASK_REPO/compose.yaml" -f "$TASK_RESTORE_DATA/recovery.compose.yaml" \
    -p "$TASK_RESTORE_PROJECT" "$@"
}
```

登录账号、密码哈希和 CLI 口令随私密文件恢复，不在终端打印。新数据库密码重新生成，仅写入新目录的 `runtime.env`。新生成的 `recovery.compose.yaml` 只指定本次恢复的独立镜像标签，构建不会覆盖旧实例的应用镜像标签。旧 `runtime.env` 和 `compose.override.yaml` 放进 `recovery-input/` 留作核对，**不加载**：它们可能指向旧端口、旧卷或旧目录。旧数据库密码不会用于新数据库。

如果备份没有管理员文件，先完成后面的数据库恢复和 API 启动，再使用第 4 步的恢复实例命令设置；不要给旧实例重置账号。不要运行 `docker compose config` 输出包含凭据的完整配置。

## 3. 创建新数据库并导入

只创建 db。`-p` 的独立项目名会创建新的 `postgres-data` 卷，不复用原项目的卷，也不公开数据库端口。

```bash
task_restore_compose up -d --pull never --wait db

task_restore_compose exec -T db psql -U assistant -d assistant -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('app', 'queue', 'checkpoints')
  ) THEN
    RAISE EXCEPTION '目标数据库不是空库，停止恢复';
  END IF;
END $$;
SQL

task_restore_compose exec -T db pg_restore \
  --exit-on-error --no-owner --no-privileges \
  --username=assistant --dbname=assistant < "$TASK_BACKUP/database.dump"
```

任何命令非零退出都停止。不要用 `--clean` 重试已有目标；保留失败实例排查，重新开始时创建另一个随机项目和目录。

## 4. 只启动 API，核对恢复结果

```bash
task_restore_compose build api
task_restore_compose up -d --no-deps api
task_restore_compose ps
curl --fail --silent --show-error "http://127.0.0.1:$TASK_RESTORE_PORT/healthz"
```

此时运行的服务应只有 `db` 和 `api`。**不要执行 `pnpm start` 或不带服务名的 `compose up`**，它们会连同 Worker 启动。

健康接口应返回 `{"ok":true,"version":2}`。仅在备份缺少 `admin-auth.json` 时，运行 `task_restore_compose exec api node dist/scripts/setup-admin.js`，按提示输入账号和不回显的密码；已有账号无需重置。

在浏览器的**无痕窗口**打开该地址，使用备份中的管理员账号登录。同一主机不同端口共享 Cookie 范围，普通窗口中登录恢复实例可能覆盖旧实例的会话 Cookie；无痕窗口可以分开验收。检查目标、计划、历史回答、本人反馈、资料版本、引用原文及原件下载。检查失败/中断任务、待发送邮件和待核实设备动作；未知结果不能按“失败”重发。核对阶段只查看，不创建任务、审批发送或执行设备动作。

如需留存业务表数量，将输出保存到新私密目录，不贴入公开日志：

```bash
task_restore_compose exec -T db psql -U assistant -d assistant -X -v ON_ERROR_STOP=1 \
  > "$TASK_RESTORE_DATA/restore-table-counts.txt" <<'SQL'
BEGIN READ ONLY;
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;',
              tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename
\gexec
ROLLBACK;
SQL
chmod 600 "$TASK_RESTORE_DATA/restore-table-counts.txt"
```

数量相等不能证明内容相等，还要核对关键学习记录、来源版本与时间关系。备份完成后旧实例新产生的记录不在该备份中；决定切换前另行保留或迁移，不能直接舍弃。

`pnpm verify:e2e` 用合成数据自动核对业务表内容哈希、私密文件和未确认审批，并验证恢复后的独立 API；它证明恢复路径经过测试，不替代本次个人数据核对。

## 5. 完成本次演练，或人工决定切换

仅做恢复演练时，停止新实例并保留新卷和目录：

```bash
task_restore_compose stop --timeout 120 api db
```

正式切换前，本人确认数据核对结果、旧实例新增记录处理方式、模型/邮箱/设备配置及待执行动作。使用旧实例原有的项目名和数据路径停止旧 API/Worker，确认它们不再运行，避免两个 Worker 同时处理外部动作。旧数据库、数据目录与备份继续保留。

确认后才在恢复实例启用 Worker：

```bash
task_restore_compose up -d --pull never --wait db
task_restore_compose up -d --no-deps api worker
task_restore_compose ps
```

这时使用新的独立端口访问。后续若改端口，先确认旧实例已停用并仅更改本次恢复参数。不要执行 `docker compose down -v`、删除旧目录或覆盖旧数据库。需要回退时先停止恢复实例的 API/Worker，并保存切换后的新增数据，再恢复旧实例的运行。
