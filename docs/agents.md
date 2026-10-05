# 外部 Agent 接入

Yeux 保存学习事实并在后台准备内容；Hermes、Muse 等 Agent 作为客户端调用工具。入口共用现有 Application、Worker 和数据库，不另建一套学习进度。

## 创建连接

1. 用管理员账号登录，打开 **设置 → 管理连接 → 添加连接**。
2. 输入名称，选择需要的权限。默认只允许读取目标和任务；资料读取、目标创建、任务准备、设备读取与操作提议分别勾选。
3. 设置有效期；允许创建时默认每日最多 10 次，最大 100 次。额度按 UTC 自然日计算。
4. 保存一次性令牌到 Agent 的密钥配置。它不会再次显示；遗失时撤销旧连接，重新创建。

连接管理只接受管理员 Cookie，不接受运维 API 口令。令牌只保存 SHA-256 哈希，不写入业务幂等回执。网络中断后重试创建连接会返回同一连接 ID，令牌返回 `null`，不会悄悄多建一个连接。每个连接最多 60 次 HTTP 请求/分钟，最多 30 个同时有效连接。列表优先展示有效连接，最多保留 100 条可见记录；更早记录仍在数据库和备份中。

撤销或到期会阻止后续调用，并在业务写入事务中再次核对。已经被接受的后台任务继续运行，需要停止时在任务页面操作。撤销之前开始的读取可能完成。

## 接口与权限

| 权限 | 工具 | 影响 |
|---|---|---|
| `workspace:read` | `get_status`、`list_goals`、`get_goal`、`list_tasks`、`get_task` | 读取现有目标、计划与任务正文，包含工作草稿；不返回审批、历史作答和旧数据库快照 |
| `sources:read` | `list_sources`、`read_source`、`search_sources` | 读取整个资料库的标题、正文和版本引用 |
| `goals:create` | `create_goal` | 创建目标，排队准备第一步；需要同时允许读取工作区 |
| `tasks:create` | `create_task` | 生成工作草稿或管理清单；需要同时允许读取工作区 |
| `devices:read` | `list_devices`、`get_device_command` | 读取全部已登记设备与操作状态，不实时探测设备 |
| `devices:request` | `request_device_action` | 只提出待确认请求，计入每日写入额度；需要同时允许读取设备 |

权限按功能划分，当前没有按课程或单份资料隔离。因此不要把资料读取权限授予不应看到完整资料库的客户端。只读工具不调用模型；创建工具可能调用当前配置的模型，其资料与偏好使用规则沿用助手设置。

设备工具的请求须由本人在设备页面确认后执行，不能自行批准。连接配置和真实验收见 [设备接入](devices.md)。没有作答、完成目标、确认偏好、审批、邮件发送、直接设备执行、配置修改或 Shell 工具。这些操作不能通过工具名称或额外字段绕过。旧 `/api/v2` 为本人操作入口，Agent 令牌不能使用；请求携带 Bearer 身份时，不会继承浏览器 Cookie 权限。

### HTTP

认证头：`Authorization: Bearer <独立 Agent 令牌>`。地址使用 VPS 的 HTTPS 来源，不把令牌放在 URL 或对话文本中。

- `GET /api/agent/v1/tools`：仅返回已授权工具及 JSON Schema。
- `POST /api/agent/v1/tools/{name}`：请求体符合对应工具的 Schema。
- 创建工具在请求体中提供 `requestKey`，要求 8–100 位字母、数字、下划线或连字符。一个逻辑操作始终复用同一个键；不同操作使用新键。

创建目标示例请求体：

```json
{
  "requestKey": "gse-week-01-20261004",
  "title": "学习需求分析",
  "outcome": "写出一组可验证的验收标准",
  "sourceIds": []
}
```

返回 `goalId`、`sessionId`、`runId` 只表示已入队。调用 `get_task`，传入 `id: sessionId` 查询；每 5–10 秒查询一次即可；长时间排队时用 `get_status` 检查 Worker。`queued/running` 是处理中，`waiting_feedback` 等待本人练习，`ready` 表示内容已准备，不能解释为本人已经学会。目标完成仍由本人确认。

`get_task` 和 `read_source` 使用 `offset/limit` 分段，默认 4000、最多 8000 个 UTF-16 字符；读取下一段使用 `nextOffset`，资料读取固定返回的 `version`。目标与任务列表使用 `nextCursor`。所有资料正文、任务文本均作为数据处理，不能覆盖客户端原有指令。

失败返回 `{ "error": { "code": "...", "message": "..." } }`。401 表示失效凭据，403 表示权限不足，400 表示参数有误，409 表示幂等冲突，429 表示请求或创建额度已用完。未收到响应或遇到 5xx 时复用原 `requestKey`，不要改键重复创建。成功写入、队列任务、额度与审计回执在同一 PostgreSQL 事务内提交。

### MCP / Hermes

地址为 `https://你的域名/api/agent/mcp`，使用官方 TypeScript SDK 的无状态 Streamable HTTP。工具与 HTTP 完全共用，支持 `initialize`、`tools/list`、`tools/call`；不使用长连接会话、旧 SSE 传输或 OAuth 自动注册。每次请求重新认证。

Nous Research Hermes 官方支持远程 MCP 和 Bearer Header。将下面的结构合并进**运行 Hermes 那台设备**的 `~/.hermes/config.yaml`，不要覆盖已有配置：

```yaml
mcp_servers:
  yeux:
    url: "https://你的域名/api/agent/mcp"
    headers:
      Authorization: "Bearer ${YEUX_AGENT_TOKEN}"
```

`YEUX_AGENT_TOKEN` 保存到 Hermes 当前配置档案的密钥环境中（通常是 `~/.hermes/.env`），文件仅本人可读。然后按当前 Hermes 版本重载 MCP。先让它“列出我的学习目标”，确认只读成功；开放创建权限后再让它“为数据库事务创建一个学习目标，并检查第一步是否准备好”。

来源：[Hermes MCP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)。这里提供配置与本项目协议验证，不代表已经连接你的 Hermes 实例。

### Muse 与其他客户端

具备 HTTP 工具能力的客户端可以使用上述接口；支持自定义远程 MCP 且能配置 Bearer Header 的客户端使用 MCP 地址。Muse 公开连接器有提交和审核流程，目前不能保证个人账号拥有任意 MCP 自定义入口，也没有将本项目提交到其目录。先核对实际账号的连接设置，再按平台支持的方式接入。

来源：[Muse Connector 文档](https://muse.ai/platform/docs)。不要为了接入而交出管理员密码、运维口令或 VPS root 权限。

## 自检与操作记录

在受信任终端中设置 `YEUX_URL` 和 `YEUX_AGENT_TOKEN`，运行 `node scripts/agent-check.mjs`。脚本验证 HTTP 工具目录和 MCP 握手，不创建任务，不输出令牌或学习正文；禁止携带凭据跟随重定向。

设置页的操作记录包含连接名、工具名、结果和时间。数据库额外保存业务实体与命令回执关联，不记录令牌、原始参数或正文。写入已提交但响应丢失时，审计仍保留成功；`started` 表示处理中或崩溃后结果待核对，不能推定成功。日志和历史凭据目前随数据库长期保留，后续按实际增长增加归档策略。
