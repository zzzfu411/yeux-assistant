# yeux-assistant

基于 React、Fastify、LangGraph.js 与 PostgreSQL 构建的自托管个人学习与事务数字助手：围绕学习目标管理版本化资料、组织练习评阅与复习排程，并支持多分支深入研究、通知办事拆解与人工确认的邮件拟稿，可通过电脑或手机浏览器使用。

[English](README.md) · 简体中文

## 核心能力

- **目标驱动的学习闭环** — 导入并版本化管理课程讲义（`GIN + BM25` 混合词法检索），经 `LangGraph.js` 检查点在后台生成学习计划与练习；原文引句、模型评阅与本人自评严格分列记录，同一目标仅保留一个待反馈步骤。
- **多分支深入研究** — 支持 `直接 / 标准 / 深入` 三档预算与双根方向并行探索，采用两两盲评（A/B 随机顺序）迭代改写答案，并保留可导出的搜索树与查证引用（[docs/research.md](docs/research.md)）。
- **通知办事与线程化邮件** — 从通知正文抽取截止时间与所需材料（附原文引句），对照个人资料列出待办、缺信息先追问，按往来线程起草邮件并在本人核对固定内容后才发送。
- **统一事务内核与私密 Git 规则** — 四类后台任务共用 `step()` 执行内核，业务写入、`app.run_steps` 步骤回执与 `app.model_calls` 耗时/Token 记录同事务提交，重试时自动复用未变更步骤；经本人确认的偏好规则与保存的流程写入本机 `0700` 私密 Git 仓库。
- **手机端 PWA、Agent 接入与设备门禁** — 双页手账式界面（多端同步未发送草稿而不静默覆盖），基于 `pg_notify` 唤醒 SSE 实时进度与 Web Push 推送，支持发放受限 `MCP` / HTTP Agent 凭据及需人工审批的本地设备动作。

## 快速开始

环境要求：**Node.js 24 LTS**、**pnpm 9** 与 **Docker Compose**（macOS 可使用 Colima 或 Docker Desktop）。

```bash
git clone https://github.com/zzzfu411/yeux-assistant.git
cd yeux-assistant
pnpm install --frozen-lockfile
pnpm start
docker compose --env-file private/runtime.env exec api node dist/scripts/setup-admin.js
```

浏览器打开 `http://127.0.0.1:8765`（端口占用时可执行 `ASSISTANT_PORT=8766 pnpm start`），使用刚设置的管理员账号登录，在「更多 → 设置」配置兼容 OpenAI Chat Completions 的模型地址与密钥。首次体验可在「资料」导入 [examples/learning-note.md](examples/learning-note.md)，再回到「今天」关联该资料创建学习计划。

## 运维与验证

```bash
pnpm run doctor   # 只读检查配置、管理员初始化、Docker 引擎与端口占用
pnpm status       # 查看容器与 Worker 心跳状态（停止服务并保留数据用 `pnpm stop`）
pnpm backup       # 暂停写入，备份 PostgreSQL 与运行文件后自动恢复服务
pnpm verify       # 临时 PostgreSQL 18 容器 + 格式/架构/类型检查 + 构建 + Vitest 回归
pnpm test:e2e     # Playwright 桌面与手机端回归（完整独立实例闭环用 `pnpm verify:e2e`）
```

## 目录结构

```text
apps/
├── web/            React 19 + Vite + TanStack Query 桌面与移动端前端
├── api/            Fastify 5 HTTP/SSE 服务、会话鉴权、Zod 校验与 MCP/Agent 接口
├── worker/         pg-boss 后台队列执行进程（学习流程、深入研究、邮件与办事）
└── device-bridge/  手动启动的本机设备执行器与模拟事务驱动
packages/
├── contracts/      前后端共享 TypeScript 类型与运行时契约
├── core/           统一执行内核、LangGraph 学习图、BM25 检索、研究、邮件与私密 Git 规则库
└── storage/        Drizzle ORM 表结构与 PostgreSQL 18 SQL 迁移
```

## 文档导航

- [docs/usage.md](docs/usage.md) 与 [docs/integrations.md](docs/integrations.md) — 日常操作指南、模型接入、PDF/PPT 离线提取与邮箱配置
- [docs/api.md](docs/api.md) 与 [docs/development.md](docs/development.md) — `/api/v2` 接口表、运行时拓扑、执行内核机制与测试说明
- [docs/research.md](docs/research.md)、[docs/agents.md](docs/agents.md) 与 [docs/devices.md](docs/devices.md) — 深入研究机制、外部 Agent 凭据与设备审批边界
- [docs/server.md](docs/server.md) 与 [docs/restore.md](docs/restore.md) — 自有 VPS HTTPS 部署说明与备份恢复演练

---

本项目最初作为南京大学《生成式软件工程》课程实验（[Lab 1](https://jyywiki.cn/GSE/2026/lab1.md) / Lab 2）的个人实现构建并持续演进。
