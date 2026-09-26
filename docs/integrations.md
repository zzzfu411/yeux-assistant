# 接入说明

## 模型

在“更多 → 设置”保存模型服务地址、模型名称和 API 密钥，再点击“测试已保存的连接”。地址通常以 `/v1` 结尾；接口需要兼容 `/chat/completions`。模型须能按提示返回符合契约的 JSON。

密钥保存在 `private/config.json`，页面不回显；更新配置时密钥留空表示保留原值。调用会传送当前任务、相关资料片段及已保存偏好到你配置的服务。未配置模型时使用本地摘录和自评。

## 资料

浏览器直接添加 UTF-8 Markdown/文本，每份最多 2 MB。目标通过 `sourceIds` 明确关联资料；空数组表示不关联资料，独立任务可检索全库。

已有离线提取器支持特定课程目录的 HTML、PDF、旧 PPT 和 DOC。仓库不包含这些课程原件。将可使用的原件保存在自己的资料目录，按需修改 `scripts/prepare-courses.py` 的 `COURSE_FILES` 和 `COURSE_NAMES` 白名单，然后执行：

```bash
python3 scripts/prepare-courses.py --repo-root /path/to/course-materials
pnpm courses:import -- --bundle private/course-import/bundle.json --dry-run
```

默认目录结构是资料根目录下的 `gse/official/`、`database/slides/`、`se/slides/lixuandong-classic/`。准备脚本只读取白名单原件，输出到本项目 `private/course-import/`。退出码 2 表示有跳过项，先检查原因。

正式导入运行中的 Compose 实例：

```bash
pnpm backup
docker compose --env-file private/runtime.env run --rm --no-deps api \
  node dist/scripts/import-courses.js --bundle /app/private/course-import/bundle.json --apply
```

相同批次重放不重复写入；内容或提取元数据变化建立新版本。原件按 SHA256 保存在 `private/source-assets/`。资料更新后需重新准备、导入；不自动获取其他课程或官网文件。PDF/PPT 的图片和公式并不等于完整提取，DOC 不伪造原始分页。

## 邮箱

仅在本人决定接入时，在 `private/config.json` 中合并邮箱配置，保留已有 `llm` 等字段。字段示例见根目录 `config.example.json`。开启 `poll_mail` 后，Worker 定期检查邮箱；首次读取最近 20 封，之后按保存水位增量处理。

已有功能包括 UID/Message-ID 去重、草稿编辑、确切版本审批、发送回执和不确定结果核实。纯 HTML 邮件、超限邮件会隔离保留。尚无完整历史会话关联；真实 smail 账户需要单独验收。不要使用个人账号运行自动化测试。

## HTTP 示例

```bash
export YEUX_TOKEN="$(cat private/access-token)"
curl -H "Authorization: Bearer $YEUX_TOKEN" \
  http://127.0.0.1:8765/api/v2/today
```

创建目标：

```bash
curl -X POST http://127.0.0.1:8765/api/v2/goals \
  -H "Authorization: Bearer $YEUX_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-goal-001' \
  -d '{"title":"理解关系代数","outcome":"能解释选择与投影的区别","sourceIds":[]}'
```

该示例没有关联资料。实际使用时，将 `GET /api/v2/sources` 返回的资料 ID 填入 `sourceIds`。同一幂等键重复提交相同请求会返回原结果；不同请求必须使用不同键。版本冲突返回 409，重新读取后再确认修改。
