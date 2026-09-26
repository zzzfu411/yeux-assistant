# 开发与验证

## 目录

```text
apps/web/           React、Vite、TanStack Query、CSS Modules
apps/api/           Fastify、认证、Zod、HTTP/SSE
apps/worker/        队列消费者与独立执行进程
packages/contracts/ 共享类型与运行时校验
packages/core/      学习流程、资料、调度、模型与邮件
packages/storage/   Drizzle、SQL 迁移
scripts/            启停、备份、资料准备与迁移
tests/              单元、数据库、进程恢复与浏览器测试
```

业务表位于 PostgreSQL `app` schema，pg-boss 使用 `queue`，LangGraph 使用 `checkpoints`。默认两路学习执行，同目标串行，单次最多 5 次模型调用、180 秒；自动重试共享预算。同一目标最多一个待反馈步骤。

## 本地开发

Node.js 24 LTS、pnpm 9。依赖版本以 lockfile 为准。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

配置开发专用 `DATABASE_URL` 和 `ASSISTANT_DATA` 后，分别运行 `pnpm dev`、`pnpm worker`、`pnpm dev:web`。`.env.example` 仅为字段示例，需要把变量显式导出到进程环境；Vite 默认代理到 8766。

## 测试

```bash
pnpm verify             # 临时 PostgreSQL + 类型检查 + 构建 + 后端测试
pnpm test:e2e           # 浏览器模拟接口测试；需安装 Chrome/Chromium
```

`pnpm verify` 需要运行中的 Docker。它创建并最终删除独立测试容器，不连接真实实例。`pnpm test` 未提供测试数据库时会跳过集成测试，不能当作完整通过。

单独运行集成测试时使用 `API_TEST_DATABASE_URL`、`RUNTIME_TEST_DATABASE_URL`、`MIGRATION_TEST_DATABASE_URL`，数据库名称必须满足测试中的 `_test` 后缀约束。测试会重建专用 schema，不能指向个人数据。

`tests/e2e/real.spec.ts` 通过 `ASSISTANT_REAL_E2E=1`、`PLAYWRIGHT_BASE_URL` 和 `ASSISTANT_E2E_TOKEN_FILE` 显式启用；仅对独立 API/Worker 实例运行。

离线提取测试：

```bash
python3 -m unittest discover -s tests -p test_prepare_courses.py
```

提取需要 `lxml`、`pypdf`、`python-pptx`，测试夹具还需要 `python-docx`。旧 Office 原件转换还需要 LibreOffice。账户相关自动化测试均使用模拟服务，不代表真实邮箱或模型已验收。

## 扩展

- 新页面：在 `apps/web` 使用共享契约与 API，不复制后台状态机。
- 新业务：在 `packages/core` 实现，添加 Zod 契约及 API 路由；变更表结构时注册新的 SQL 迁移。
- 新资料格式：扩展离线提取器或资料适配器，保留原件摘要、位置和提取限制。
- 新外部动作：显式定义输入、审批快照、执行状态与回执，不赋予模型任意 Shell 或发送权限。

## 备份与历史迁移

`pnpm backup` 保存数据库 dump、配置和课程原件。恢复时先保留现有数据，再将 dump 恢复到新库；`source-assets` 与数据库一起恢复。普通文本与个人导出目录也需单独保留。不要执行 `docker compose down -v` 删除个人数据卷。

保留了旧 SQLite → PostgreSQL 的迁移工具与合成测试：

```bash
pnpm legacy:import -- --source /path/to/assistant.sqlite3 --data private --dry-run
```

正式迁移需 `--apply` 和 `DATABASE_URL`，只允许空目标库；全部旧行与哈希核对后才导入。旧 Python 应用不包含在此独立仓库中。
