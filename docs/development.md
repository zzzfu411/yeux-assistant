# 开发与验证

## 目录

```text
apps/web/           React、Vite、TanStack Query、CSS Modules
apps/api/           Fastify、认证、Zod、HTTP/SSE
apps/device-bridge/  手动本地执行器与固定设备驱动
apps/worker/        队列消费者与独立执行进程
packages/contracts/ 共享类型与运行时校验
packages/core/      学习流程、资料、调度、模型、邮件与设备
packages/storage/   Drizzle、SQL 迁移
scripts/            启停、备份、资料准备与迁移
tests/              单元、数据库、进程恢复与浏览器测试
```

业务表位于 PostgreSQL `app` schema，pg-boss 使用 `queue`，LangGraph 使用 `checkpoints`。默认两路学习执行，同目标串行，普通学习单次最多 5 次模型调用、180 秒；研究任务按 `research.effort` 使用 1/4/8 次、150/420/840 秒预算；评阅可走可选的独立评阅模型（`llm.review`）。自动重试共享原预算。同一目标最多一个待反馈步骤。

## 执行内核

四类任务各有一个执行器，由 `packages/core/src/executors.ts` 按会话类型选择：学习（`learning.ts`）、深入研究（`research/service.ts`）、邮件回复（`mail/reply.ts`）、办理通知（`errands/service.ts`）。它们共用同一套运行规则（`runtime-state.ts`）：

- **围栏**：`fence` 在每个事务里核对 run 的代际、状态与截止时间，取消或被替代的旧执行写不进新状态。
- **步骤回执**：`step(identity, name, { input }, compute, commit)` 在事务外执行 `compute`（模型调用放这里），再把结果、`commit` 的业务写入和 `app.run_steps` 回执放进同一个事务。同一 run 的后台重试直接重放回执；本人“重新准备”产生的新 run 带 `input.resumeFrom`，只有同名且输入摘要（`input_digest`）不变的步骤才沿用上一轮结果，并记下 `reused_from`。有新补充或资料变化时摘要不同，会重新调用。
- **瞬时错误**：`transient` 判断 5xx、流中断与结构不合格；研究在预算允许时在本轮内重做这一步，其他流程交给 Worker 的整轮重试（最多 3 代，预算不重置）。
- **调用记录**：每次模型请求在预算事务里写一行 `app.model_calls`（所属步骤、profile、模型、是否用结构化输出），结束后补首字节时间、总耗时、输入 / 输出 / 推理 token 与结果。记录不经围栏，迟到或被取消的调用也会留下。任务页“运行记录”与 `GET /api/v2/sessions/:id/trace` 读取最近 5 轮。

只有学习流程使用 LangGraph：它需要在图中途停下等本人作答，再从检查点恢复（`interrupt` / `Command`）。研究、邮件和办事都是“几步顺序调用 + 业务表”，用步骤回执即可恢复，不需要第二套检查点。学习节点的回执同样存放在 `app.run_steps`（`commitNode`），因此恢复规则只有一处。

### 模型调用配置

每次调用声明一个 profile（`packages/core/src/model-profiles.ts`）：`extract`、`plan`、`draft`、`solve`、`explore`、`review`、`assess`、`lesson`、`default`。默认输出上限仍为 4096，只在温度上区分：抽取与评阅为 0，研究另辟方向为 0.8。`config.llm.profiles.<名称>` 可以覆盖 `model`、`max_tokens`、`temperature`、`reasoning_effort`；地址和密钥始终沿用主模型（独立评阅模型除外），密钥不会随 profile 换地址。设置页的“快速步骤模型”只写 `extract` 与 `draft` 两项的 `model`。

请求默认带 `response_format: json_schema` 并流式返回。服务拒绝（400 / 422）时依次去掉结构化输出、再去掉流式，被拒绝的请求没有生成内容，不计入调用次数；同一执行进程记住被拒绝的形式，之后直接用可用的形式。

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
pnpm verify:e2e         # 独立 API/Worker/PG 浏览器闭环 + 完整合成备份恢复检查
```

浏览器模拟测试默认使用端口 4173，不复用已有服务；被占用时用 `PLAYWRIGHT_MOCK_PORT=4174 pnpm test:e2e` 指定空闲端口。真实实例的浏览器输出放在该次 `private/real-e2e-*` 内，避免覆盖其他测试。

`pnpm verify` 需要运行中的 Docker。它创建并最终删除独立测试容器，不连接真实实例。`pnpm test` 未提供测试数据库时会跳过集成测试，不能当作完整通过。

单独运行集成测试时使用 `API_TEST_DATABASE_URL`、`RUNTIME_TEST_DATABASE_URL`、`MIGRATION_TEST_DATABASE_URL`，数据库名称必须满足测试中的 `_test` 后缀约束。测试会重建专用 schema，不能指向个人数据。

`pnpm verify:e2e` 自动构建并创建独立测试实例，结束后移除测试容器，合成数据和日志保留在忽略的 `private/real-e2e-*`。它不验证真实模型与邮箱质量。模型固定案例与显式真实评测见 [质量检查说明](../quality/README.md)，`pnpm quality` 默认仅预演。

需要自行指定测试实例时，`tests/e2e/real.spec.ts` 通过 `ASSISTANT_REAL_E2E=1`、`PLAYWRIGHT_BASE_URL` 、`ASSISTANT_E2E_TOKEN_FILE` 和 `ASSISTANT_E2E_CREDENTIAL_FILE` 显式启用；仅对独立 API/Worker 实例运行。

离线提取测试：

```bash
python3 -m unittest discover -s tests -p test_prepare_courses.py
```

提取需要 `lxml`、`pypdf`、`python-pptx`，测试夹具还需要 `python-docx`。旧 Office 原件转换还需要 LibreOffice。账户相关自动化测试均使用模拟服务，不代表真实邮箱或模型已验收。

## 自动化与启动诊断

`.github/workflows/verify.yml` 在 PR、main 推送或手动触发时依次运行类型/构建、隔离 PostgreSQL、桌面/手机交互和完整恢复演练；不配置真实模型或邮箱密钥，不上传 private 目录。提交前仍应运行相应本地验证。工作流文件的存在不代表 GitHub 已执行成功，发布后需核对对应 Actions 运行。

环境安装遵循 [setup-node](https://github.com/actions/setup-node/tree/v6) 与 [Playwright CI 文档](https://playwright.dev/docs/ci)。项目不依赖宿主 Chrome；Linux CI 安装与 lockfile 对应的 Chromium。

`pnpm run doctor [--json]` 只读检查 Node、配置、管理员初始化、Docker/Compose、实例归属与端口。它是独立诊断命令，不自动代替 `start`，也不安装软件、改端口或停止其他项目。服务端配置不完整会给出下一步命令，不输出密钥。

## 资料与事件一致性

`Sources` 管理导入查重、版本更新与软归档。资料摘要不携带整份提取页码；详情读取指定版本。Web 管理的文本不被磁盘扫描覆盖，归档和扫描采用相同资料锁串行化。目标编辑保留原来的归档关联，新建关联则拒绝归档资料。

检索（`knowledge.ts` 的 `retrieve`、研究的 `researchSources`）使用迁移 `0017` 的索引列 `app.chunks.lexemes`：`app.search_terms` 先做 NFKC 与小写，英文词两个字符以上整体保留，汉字连续段取两字词与单字；`packages/core/src/search.ts` 是它的 TypeScript 镜像，测试逐份核对两边一致。查询按 IDF 选词（最多 64 个，语料 20 个片段以上时去掉出现在一半以上片段的词），最稀有的几个词经 GIN 索引筛候选（合计不超过 600 个片段），再按 BM25（k1=1.2，b=0.75）排序。GIN 索引关闭 pending list，避免批量导入后检索变慢。`pnpm retrieval:eval` 用固定合成案例对比旧实现，见 [质量检查说明](../quality/README.md#检索基准)。

`events.id` 只代表分配顺序。已提交事件经独立串行发布分配 `stream_id`，SSE 使用该游标，避免长事务晚提交导致事件漏读。数据库恢复后若浏览器游标超出当前流，发送 `stream.reset` 让浏览器重新拉取状态。写入背压时保留连接待发送位置，退出登录会关闭流。

## 历史列表与评阅恢复

新界面使用 `/today/overview`、`/goals/:id/overview`、`/goals/list`、`/sessions/list` 与 `/goals/:id/attempts/list`。列表默认每页 30 条，上限 50；会话列表只返回标题、状态和短摘要，打开详情才读取正文。旧读接口保留兼容，仍有原来的数量上限。

分页游标绑定资源、筛选条件与每页条数，签名后使用 PostgreSQL 微秒创建时间和 ID 排序。每页在一致快照内读取数量和数据，首次读取时间限制后续新记录；跨 HTTP 请求并非同一个数据库快照。晚提交的旧记录或状态变化可能改变结果，点“刷新列表”重新查询。

模型评阅要求完整练习、用户回答原句、实际提供的资料版本与字符锚点。无法核对时保留回答并记为无法判断；这只验证证据可追溯，不证明模型的语义判断正确。自评继续标为本人反馈。结构有效且已应用的模型判定可在学习页的“更多操作 → 内容版本 → 评阅核对记录”查看；结构错误保留失败状态，不算已完成评阅。

学习会话仅在 waiting_feedback 接收新答案；普通工作任务保留结果后的修改反馈。待评阅回答通过交付 artifact 的同会话 prepare 回执绑定原学习步骤，缺失或步骤已移除时保留回答并停止，不能按当前复习索引猜测。每次回答的评阅回执与作答判定、计划修改同事务保存。准备后续练习失败后，手动重试使用已保存的下一步，不把旧回答再次用于新知识点。固定案例与真实模型评测见 `quality/README.md`。

## 扩展

- 新页面：在 `apps/web` 使用共享契约与 API，不复制后台状态机。
- 新业务：在 `packages/core` 实现，添加 Zod 契约及 API 路由；变更表结构时注册新的 SQL 迁移。
- 新资料格式：扩展离线提取器或资料适配器，保留原件摘要、位置和提取限制。
- 新外部动作：显式定义输入、审批快照、执行状态与回执，不赋予模型任意 Shell 或发送权限。

## 设备扩展

`packages/core/src/devices/service.ts` 是设备动作的唯一业务入口，API 和页面不复制状态机。迁移 `0004.sql` 只增加设备表；`DeviceAdapter` 声明固定能力、Zod 参数、动作摘要、执行、独立读取与后置条件。适配器与能力的显式版本也绑定到审批快照，变更实现语义时必须推进对应版本；不兼容的旧批准动作不能自动执行。队列 `device-execute` 不自动重试现实动作；Worker 重启将已领取但没有可信回执的动作转为待核实。有效期在取得业务锁后按数据库当前时钟判断，避免等待锁期间过期的动作继续执行。

新增适配器先完成 [SPEC D4](../SPEC.md) 的设备身份与权限设计，再实现协议和登记流程。`execute` 的返回只代表调用返回，不能直接判成功；`DeviceNotApplied` 仅用于明确证明尚未产生副作用的失败。参数解析、读回不匹配、连接丢失、超时、暂停及重启需有独立测试。适配器必须遵守取消信号并在期限内结束 IO；任意子进程需要额外进程隔离与终止，Promise 超时不替代进程终止。设备锁保留到旧 IO 确实结束；期间人工核实返回 `device_execution_active`，不会释放占用让后续动作抢跑。模拟器使用 SQL 超时和重新加锁校验，不能把这个实现当成通用硬件取消保证。

`tests/devices.test.ts` 验证真实 PostgreSQL 上的生命周期；`tests/e2e/devices.spec.ts` 使用模拟 API 验证界面；`tests/e2e/real.spec.ts` 在独立 API/Worker/PG 实例中执行演示台灯流程。`tests/device-runtime.test.ts` 另以真实 Worker 子进程、测试库行锁和测试专用写入计数验证终止/重启；设备仍是模拟器。以上检查均不证明真实硬件接入成功。

## 备份与历史迁移

`pnpm backup` 暂停当前项目中原本运行的 API/Worker，再保存数据库 dump、配置（含可选的 private/compose.override.yaml）、documents、source-assets、artifacts、receipts 和 mail-quarantine。完成或失败后仅恢复原本运行的服务。备份期间不要同时导入资料或手工编辑 private 文件。

成功目录包含 `manifest.json`（逐文件字节数和 SHA-256）。备份含账号和密钥，保留在私密目录。写入失败不会留下看似完整的备份；缓存、旧备份和未导入的外部课程原件不包含在内，符号链接会阻止备份。

完整操作见 [隔离恢复指南](restore.md)：先核对备份，再创建独立项目、空数据库和私密目录；只启动 API 核对，最后决定是否启用 Worker。不要在核对阶段运行 `pnpm start`，它会一并启动后台任务。

`pnpm backup:check <备份目录> --docker` 使用本地 PostgreSQL 18 镜像完整解码，无需宿主安装 `pg_restore`。不会连接数据库或启动 Docker，引擎和镜像应已准备好。退出码 0 才表示完整通过；受限验证或清理不确定不会报告成功。备份的旧启动覆盖文件只保留作核对，不直接用于新实例。

`verify:e2e` 使用独立合成库比较所有业务表和备份文件，随后只启动恢复后的 API，检查管理员登录、历史、旧版引用、原件字节与待核实审批。登录引入的认证记录单独处理，学习业务表再次核对不变。这不代替个人数据库的恢复核对，也不允许删除原卷。

保留了旧 SQLite → PostgreSQL 的迁移工具与合成测试：

```bash
pnpm legacy:import -- --source /path/to/assistant.sqlite3 --data private --dry-run
```

正式迁移需 `--apply` 和 `DATABASE_URL`，只允许空目标库；全部旧行与哈希核对后才导入。旧 Python 应用不包含在此独立仓库中。

功能边界、已修复问题与后续验收顺序见 [最新审计](audit-2026-10-04.md)。


## 浏览器认证

`POST /api/v2/auth/login` 接收账号密码；`GET /api/v2/auth/session` 恢复会话；`POST /api/v2/auth/logout` 撤销当前会话。登录返回 HttpOnly、SameSite=Strict Cookie，8 小时固定有效期；密码不存入浏览器存储。密码文件保存 scrypt 哈希（N=32768、r=8、p=1，64 字节，随机盐），会话表仅保存随机令牌的 SHA-256。凭据版本变化会使旧会话失效，SSE 也会重新检查会话。

单用户实例每分钟共允许 8 次登录尝试，限制保存在 PostgreSQL，重启不会绕过。写请求检查 Origin。现有 Bearer API 口令保留给 CLI/集成，不再用于浏览器登录。未初始化管理员时没有默认密码，运行 `pnpm admin:setup` 或容器内 `node dist/scripts/setup-admin.js` 设置。

新增迁移 `0003.sql` 只创建认证会话和限流表，不改动学习记录。备份同时包含 `admin-auth.json`。真实账号仅由操作者在本机设置，测试必须使用合成账号。

## 模块边界与运行诊断

`apps/api/src/server.ts` 只组装服务、认证范围、错误处理、探针与生命周期。业务接口在 `routes/` 按职责注册；新增接口必须注册在受认证范围内，不能重新用原始 URL 字符串判断是否跳过认证。`packages/core/src/sessions.ts` 提供 API、调度和执行共用的会话创建/加锁原语，后台不再依赖 Application 门面。

`pnpm check:architecture` 检查当前 TS 模块的层间依赖和运行时 import 环，并接入 `pnpm verify`。Web 只依赖 Web/契约；契约和存储不导入业务；core 不导入 apps 或反向导入 Application。当前有意保留同库事务和 SQL，不引入微服务调用。

`/healthz` 只表示 API 进程存活；`/readyz` 以数据库查询判断 API 就绪，失败返回 503；两者均不证明模型/Worker/外部设备可用。服务器 Compose 使用 `/readyz`。受认证 `/api/v2/status` 返回后台执行、调度、资料扫描、导出、设备维护的最近检查；Worker 超过 20 秒、维护组件超过 90 秒未更新则标为过期，尚无记录标为待检查。原始错误不出现在响应中。完整诊断放设置页，首页仅提示需要处理的状态，每 20 秒刷新。

最新架构取舍、问题清单和下一阶段验收以 [2026-10-04 审计](audit-2026-10-04.md) 为准；旧报告保留为历史记录。


### 外部 Agent 边界

`/api/agent` 使用独立哈希凭据，`/api/v2/agents` 使用管理员 Cookie 管理。工具定义集中在 `apps/api/src/agent-tools.ts`，HTTP 和 MCP 复用相同 Schema 与回调。新增工具先选择 scope、说明读写与模型调用，再写权限、幂等、撤销和失败用例；不要把任意 URL、Shell 或内部路由透传成工具。

`Application` 接受可选 `CommandBoundary`，默认业务命令不变。Agent 写入注入 `AgentAccess.boundary`：在原业务事务中锁定身份、重验权限与有效期、按主体隔离幂等键、检查每日额度、提交成功审计。接口入参不能创建这个可信执行上下文。调用开始/失败审计与业务成功回执区分；丢失 HTTP 响应不会把已提交结果改为失败。

MCP SDK 使用无状态 JSON 响应；长任务返回 ID，由已有 Worker 执行。后台不用导入 HTTP 或 MCP 代码，第三方客户端掉线不取消学习任务。

### 本地设备桥

迁移 `0008.sql` 增加设备凭据与协议调用表。`packages/core/src/devices/bridge.ts` 实现受限拉取、一次开始许可、回执和服务端适配器；`apps/device-bridge/src/` 使用共享契约处理本地协议、持久防重放与固定驱动。API 身份互斥：管理员管理配对，Agent 只提出请求，设备凭据只领取自身动作。

`tests/device-bridge.test.ts` 验证真实 HTTP/MCP、独立 PostgreSQL、三次调用核验、撤销、断线、重复和恢复，驱动为合成夹具；`tests/device-bridge-client.test.ts` 不调用真实音量。`tests/e2e/device-connection.spec.ts` 覆盖连接配置、离线状态和手机操作。Mac 实机验证必须单独记录，不能用这些测试替代。
