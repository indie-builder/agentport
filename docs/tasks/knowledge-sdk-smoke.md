# Claude Agent SDK Wiki 真实运行 smoke

> 2026-10-25。目标：验证 worker 的 Wiki 生成链路能用**已安装的 SDK 0.3.310 真实 spawn Claude Code CLI** 跑通，
> 且模型侧完全由**本地 `node:http` mock** 承担。不调用付费或真实上游，不改产品代码，不 commit。

## 边界

- 只新增 `.tmp/knowledge-sdk-smoke/**`（`out-*.json` 为运行输出），未改 `packages/**`。
- 模型响应全部来自本地 mock：按请求里的 `stream` 标志回 SSE（`message_start` → `content_block_*` → `message_delta` 带 `stop_reason` → `message_stop`），
  或回普通 JSON；首个请求返回 `tool_use`、带 `tool_result` 的后续请求返回 `end_turn` 文本。
  **没有任何真实模型推理**，只证明协议与调用链，不代表生成质量。
- 不读取 `.env`；子进程 env 由 `sdkOptions` 白名单构造：
  `PATH`、`HOME=cwd`、`CLAUDE_CONFIG_DIR=cwd`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、
  `ANTHROPIC_AUTH_TOKEN=dummy`、`ANTHROPIC_BASE_URL=http://127.0.0.1:<随机端口>`。
- 隔离数据库：`postgres://…@127.0.0.1:55432/pace_knowledge`；fixture 行跑完即删，已核对残留为 0。
- 阶段 1 用 dummy MCP 工具（`smoke_save`/`smoke_read`），不碰产品库；阶段 2 用**真实** `runWikiGenerate`、真实 `createSdkMcpServer`
  工具、真实 DB 写入，只把上游替换成本地 mock，未注入 `queryFn`。

## 阶段 1：直接 query + dummy MCP 工具

```bash
node .tmp/knowledge-sdk-smoke/direct.mjs
```

输出见 `.tmp/knowledge-sdk-smoke/out-direct.json`，关键结果：

| 断言 | 结果 |
|---|---|
| init 里出现 MCP 工具 | `["mcp__smoke__smoke_read","mcp__smoke__smoke_save"]`，server `status: connected`, `source: sdk` |
| init 里无内置工具 | 无 `Read`/`Bash`/`Edit`/`Write`/`Glob`/`Grep`/`WebFetch`/`WebSearch` |
| 模型返回 tool_use 后 CLI 真实调用 | `savedCalls: ["fixture-note","fixture-note"]`（两次运行各一次） |
| 事件流 | 收到 `assistant.tool_use` 与 `user.tool_result`，`result.subtype = success`, `num_turns = 2` |
| cwd 隔离 | init 的 `cwd` = `realpath(临时目录)`；两次运行 cwd 不同 |
| 信号取消 | `abort()` 后迭代抛 `Error: Claude Code process aborted by user`，约 2.05s 结束 |

mock 记到的三次 `/v1/messages` 请求（均 `stream: true`）：
1. 预热请求：`tools: []`，无工具（CLI 自身会话摘要调用）；
2. 正式请求：`tools` 含 `mcp__smoke__smoke_read` / `DeferredToolPlaceholder` / `mcp__smoke__smoke_save`；
3. 带 `tool_result` 的续轮请求，仍带同一组工具。

`DeferredToolPlaceholder` 是 CLI 发到上游的工具占位名，不是内置工具泄漏；`builtinLeaks: []`。

CLI 进程环境（用 `ps eww` 读取真实子进程，探针已随清理删除）：
`ANTHROPIC_BASE_URL=http://127.0.0.1:51872`（mock 端口）、`ANTHROPIC_AUTH_TOKEN=smoke-dummy-token`、
`HOME`/`CLAUDE_CONFIG_DIR` 指向临时 cwd，无 `DATABASE_URL`/`APP_SECRET_KEY`/`REDIS_URL`。

## 阶段 2：真实 runWikiGenerate + 隔离库

```bash
cd .tmp/knowledge-sdk-smoke
../../packages/worker/node_modules/.bin/tsx wiki-generate.ts
```

输出见 `out-wiki.json`，`ok: true`：

- `runError: null`（约 0.9–1.4s）；页面变 `draft`，`currentVersionMatches: true`，版本 `generatedBy: "sdk"`；
- 草稿 markdown 来自 mock 的 `tool_use` 参数，`sourceChunkIds` 是 fixture chunk，`knowledge_wiki_sources` 真实落了对应行；
- 会话目录 `KNOWLEDGE_DIR/wiki-sdk/<jobId>` 在正常运行结束后已删除；
- 子进程 env 同样只含白名单（`hasDatabaseUrl/hasAppSecret/hasRedisUrl` 全 false）；
- mock 请求里工具列表为 `mcp__knowledge__{wiki_search,wiki_read,wiki_save_draft}`，`builtinLeaks: []`；
- 取消场景（上游挂起、`abort()`）：抛 `KnowledgeCancelled`（`isKnowledgeCancelled: true`），版本数 0，页面未写入。

### 发现（未改产品）

1. **已修复并复测：取消会话目录残留**。`runWikiGenerate` 现持有官方Query句柄，在finally中abort并等待`return()`收尾后清理，同时设置`persistSession:false`。真实SDK取消/模型失败探针确认目录立即及等待8秒后均不存在，子进程退出；取消收尾约2–7秒取决于SDK退出宽限。原发现保留作为回归原因，不再视为未修问题。
2. 首个上游请求 `tools: []`：CLI 在正式对话前有一次内部请求（当前 fixture 回文本即可，不影响后续）。
3. mock 的 tool_use 名必须是完整 `mcp__<server>__<tool>`，否则 CLI 不会分发到 MCP 工具（这正是第一次运行
   `cliCalledTool: false` 的原因，指出后修复；CLI 未报 unknown 规则错误）。

## 边界与结论

- 验证的是 **SDK → 真实 CLI → 本地 mock 上游 → MCP 工具 → 产品保存路径** 的协议与装配正确性；
  模型输出是 fixture，不代表真实模型质量、检索效果或 prompt 调优结果。
- 未触碰付费 API、真实凭证、真实用户资料；未 commit，工作树产品文件无本次改动。

## 文件

- `.tmp/knowledge-sdk-smoke/mock-anthropic.mjs`：本地 `/v1/messages` mock（随机端口）
- `.tmp/knowledge-sdk-smoke/direct.mjs`：阶段 1
- `.tmp/knowledge-sdk-smoke/wiki-generate.ts`：阶段 2（含取消）
- `.tmp/knowledge-sdk-smoke/out-direct.json`、`out-wiki.json`：运行输出
