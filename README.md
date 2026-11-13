# yeux-assistant

A self-hosted personal learning and workflow assistant built with React, Fastify, LangGraph.js, and PostgreSQL—organizing versioned study materials, checkpointed practice and review, iterative deep research, notice errands, and human-confirmed email drafting across desktop and mobile browsers.

English · [简体中文](README.zh-CN.md)

## Capabilities

- **Goal-driven study loop** — Index course notes with hybrid `GIN + BM25` lexical search, build background study plans via `LangGraph.js` checkpoints, submit practice answers, and schedule reviews while keeping source quotes, model feedback, and learner self-assessment strictly separate.
- **Iterative deep research** — Run parallel multi-branch investigations (`direct / standard / deep` budgets) with blind pairwise A/B critique, source-grounded verification, and exportable search trees ([docs/research.md](docs/research.md)).
- **Notice errands & mail threads** — Extract deadlines and required materials (with verbatim quotes) from announcements, cross-check personal records, ask clarifying questions when facts are missing, and draft threaded email replies gated behind explicit human send confirmation.
- **Transactional kernel & private Git rules** — Shared `step()` kernel commits business writes, `app.run_steps` receipts, and per-call token/latency traces (`app.model_calls`) in one PostgreSQL transaction so retries replay unchanged inputs; user-approved preferences and workflows are versioned in a local `0700` Git repository.
- **Mobile PWA, MCP bridge & device gates** — Responsive notebook UI with `pg_notify` SSE live updates, Web Push alerts, scoped external agent credentials (`MCP` + HTTP tools), and human-approved local device actions.

## Quick Start

Requires **Node.js 24 LTS**, **pnpm 9**, and **Docker Compose** (e.g., Colima or Docker Desktop on macOS).

```bash
git clone https://github.com/zzzfu411/yeux-assistant.git
cd yeux-assistant
pnpm install --frozen-lockfile
pnpm start
docker compose --env-file private/runtime.env exec api node dist/scripts/setup-admin.js
```

Open `http://127.0.0.1:8765` (override with `ASSISTANT_PORT=8766 pnpm start` if occupied), sign in with the admin account you just set, and configure an OpenAI Chat Completions-compatible model under **More → Settings**. To try a full study cycle, import [examples/learning-note.md](examples/learning-note.md) under **Sources** and create a study plan from **Today**.

## Operations & Verification

```bash
pnpm run doctor   # read-only check of config, admin setup, Docker engine, and port
pnpm status       # inspect running containers and worker heartbeat (`pnpm stop` to halt)
pnpm backup       # pause writes, snapshot PostgreSQL + runtime state, and resume
pnpm verify       # ephemeral PostgreSQL 18 + format/arch/typecheck + build + Vitest suite
pnpm test:e2e     # Playwright desktop & mobile UI regression (`pnpm verify:e2e` for full stack)
```

## Project Structure

```text
apps/
├── web/            React 19 + Vite + TanStack Query desktop/mobile client
├── api/            Fastify 5 HTTP/SSE server, auth, Zod schemas, and MCP/agent endpoints
├── worker/         pg-boss background consumer running LangGraph, research, mail, and errand jobs
└── device-bridge/  Opt-in local executor and simulated device adapters
packages/
├── contracts/      Shared TypeScript & Zod API contracts
├── core/           Execution kernel, LangGraph study loop, BM25 search, research, mail, and Git rules
└── storage/        Drizzle ORM schema and SQL migrations (PostgreSQL 18)
```

## Documentation

- [docs/usage.md](docs/usage.md) & [docs/integrations.md](docs/integrations.md) — Daily walkthrough, model setup, offline PDF/PPT import, and mail configuration
- [docs/api.md](docs/api.md) & [docs/development.md](docs/development.md) — `/api/v2` endpoint reference, runtime topology, kernel design, and test suites
- [docs/research.md](docs/research.md), [docs/agents.md](docs/agents.md), & [docs/devices.md](docs/devices.md) — Deep research workflow, MCP/HTTP agent tokens, and device approval boundaries
- [docs/server.md](docs/server.md) & [docs/restore.md](docs/restore.md) — Self-managed HTTPS VPS deployment and backup recovery

---

Built as an independent implementation for Nanjing University's Generative Software Engineering course ([Lab 1](https://jyywiki.cn/GSE/2026/lab1.md) & Lab 2).
