# 子智能体委派：真实验证（2026-10-20）

用真实模型 + 真实沙盒跑通「父智能体把查询任务委派给子智能体」，记录修复前后的观察、最终消息序列和遗留风险。

## 测试配置

全部通过 API 创建，测试结束已删除（名字唯一，可按名字搜索审计表 `agent.created` / `server.created`）。

| 资源 | 配置 |
|---|---|
| MCP Server | `subverify-jsonplaceholder`，`kind=generated`，`baseUrl=https://jsonplaceholder.typicode.com`，工具 `get-user`：`GET /users/{id}`，参数 `id`（integer，query） |
| 子智能体 | slug `subverify-child`，绑定上面的 server，`maxTurns=6`，`maxBudgetUsd=0.5`，提示词「调用 `mcp__subverify-jsonplaceholder__get-user` 查询 id 为 1 的用户，原样输出 JSON」 |
| 父智能体 | slug `subverify-parent`，同样绑定该 server，`subAgentIds=[子]`，`maxTurns=8`，`maxBudgetUsd=0.5`，提示词「必须把查询任务委派给 `subverify-child`，不要自己直接调用 MCP 工具」 |

运行方式：本机 `node --env-file-if-exists=../../.env --import tsx src/index.ts` 启动 api/worker（compose 的 api/worker 已停），沙盒镜像 `agentport/sandbox:dev`。模型 `claude-sonnet-5-5`。

复现命令（登录后）：

```bash
curl -b cookies -H 'content-type: application/json' \
  -d '{"kind":"generated","name":"subverify-jsonplaceholder","baseUrl":"https://jsonplaceholder.typicode.com"}' \
  http://127.0.0.1:3000/api/servers
curl -b cookies -H 'content-type: application/json' \
  -d '{"name":"get-user","description":"fetch a user by numeric id","method":"GET","pathTemplate":"/users/{id}","paramsIn":"query","inputSchema":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}}' \
  http://127.0.0.1:3000/api/servers/<serverId>/tools
curl -b cookies -H 'content-type: application/json' \
  -d '{"slug":"subverify-child","name":"Subverify Child","description":"查询 jsonplaceholder 用户的子智能体","systemPrompt":"调用 mcp__subverify-jsonplaceholder__get-user ...","serverIds":["<serverId>"]}' \
  http://127.0.0.1:3000/api/agents
curl -b cookies -H 'content-type: application/json' \
  -d '{"slug":"subverify-parent","name":"Subverify Parent","description":"委派查询任务给子智能体","systemPrompt":"必须委派给 subverify-child ...","serverIds":["<serverId>"],"subAgentIds":["<childId>"]}' \
  http://127.0.0.1:3000/api/agents
curl -b cookies -H 'content-type: application/json' \
  -d '{"agentId":"<parentId>","message":"请查询 id 为 1 的用户，这个任务交给子智能体完成。"}' \
  http://127.0.0.1:3000/api/chat
curl -N -b cookies http://127.0.0.1:3000/api/chat/<runId>/events
```

## 工作区实况

运行中从 worker 的数据目录抓取的快照（`packages/worker/data/workspaces/subverify-parent/<runId>/`，run 结束后会被清理）：

```
/.mcp.json                                          # 真实 Authorization 只在运行期存在
/CLAUDE.md                                          # systemPrompt + 工具/子智能体说明
/.claude/agents/subverify-child.md                  # 只有子智能体文件
```

子智能体文件 frontmatter（**没有** `tools`）：

```yaml
---
name: "subverify-child"
description: "查询 jsonplaceholder 用户的子智能体"
model: "claude-sonnet-5-5"
disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "TaskStop"]
maxTurns: 6
---
```

父智能体自己的 md 不再写入 `.claude/agents/`（只通过 `GET /api/agents/:id/files` 提供预览）。

SDK 侧确认：`initializationResult().agents` 在沙盒里能看到 `subverify-child`（说明 `.claude/agents/*.md` 被 `settingSources: ['project']` 正常发现）。

## 最终消息序列（修复后，成功）

一次真实 run（`run_finished status=succeeded, turns=2`，约 $0.028），SSE 事件先后顺序：

| # | 事件 | 摘要 |
|---|---|---|
| 1 | `run_started` | — |
| 2 | `assistant_text` | 「我将委派给子智能体。」 |
| 3 | `tool_start` `Agent` | `{"subagent_type":"subverify-child","prompt":"请查询 jsonplaceholder 中 id 为 3 的用户…"}` |
| 4 | `tool_input` | 同上 |
| 5 | `tool_start` `mcp__subverify-jsonplaceholder__get-user` | 子智能体内部的工具调用，`{"id":3}` |
| 6 | `tool_input` | `{"id":3}` |
| 7 | `tool_result`（子智能体侧） | `{"id":3,"name":"Clementine Bauch",…}` |
| 8 | `tool_result`（父侧 Agent 返回） | `[Subagent hand-back] …` 包裹子智能体的最终报告 |
| 9 | `assistant_text` | 「查询结果如下，用户 id 为 3：\`\`\`json …\`\`\`」 |
| 10 | `run_finished` | `succeeded`，turns=2，cost≈$0.028 |

落库的消息顺序（`GET /api/conversations/:id`）：`user(text)` → `tool(tool_use Agent)` → `tool(tool_use get-user)` → `tool(tool_result get-user)` → `tool(tool_result Agent)` → `assistant(text)`。修复前同一次对话还会多出一条重复的 `tool_use/tool_result` 对。

## 修复前观察（问题）

1. **委派完全不可用**：父智能体只拿到 `ListAgents`/`SendMessage`（SDK 0.3.303 的会话间消息工具），没有 `Agent`；`ListAgents` 显示无可达智能体，`SendMessage` 返回 `No agent named 'subverify-child' is reachable`。父智能体最终拒绝自己查。
2. **沙盒镜像过期**：`agentport/sandbox:dev` 构建于 `src/runner.ts` 加入 `allowSubAgents` 之前（`packages/sandbox/dist/runner.js` 是新的，但镜像里没有）。`pnpm run up` 在镜像已存在时默认跳过构建，所以「代码已经好了」也可能运行旧 runner。重建后 `Agent` 才被放行。
3. **子智能体被 SDK 拒绝派生**：修复问题 2 后，`Agent` 调用返回 `Agent 'subverify-child' would be spawned with zero tools — refusing. Its tools list resolved to nothing: […] [mcp__subverify-jsonplaceholder__*]`。根因是子智能体 md 的 `tools: ["mcp__<server>__*"]`：SDK 在派生时先按**父会话**解析这些名字，此时 MCP 工具还没注册（同一次 `query()` 里 MCP 握手异步完成），通配符解析为空集即拒绝。移除 `tools` 后子智能体继承父会话工具集，成功。
4. **SSE 事件重复**：同一次 run 里 `tool_start`/`tool_input` 各出现两次，`text_delta` 按固定周期重复（一次回复 1447 个 delta，实际只有约 230 个）。根因在 `packages/api/src/queue/producer.ts` 的 `subscribeRun`：每次唤醒都并发 `XRANGE`，多次读共享同一个 `lastId`，同一批事件被回调多次；并发唤醒还会互相覆盖，最后一批事件可能等不到新唤醒。改为串行 drain + 2s 轮询兜底后，一次 run 的事件数等于 Redis Stream 的 `XLEN`。

## 父子校验（API）

`validateSubAgents` 的行为与文档一致：拒绝自引用、重复 id、不存在的 id、已有父级的智能体、以及自己已有子智能体的候选（保证单层）。PATCH 时若当前智能体已是子智能体，再设置 `subAgentIds` 会返回 400。

**已知缺口**：`POST /api/agents` 传 `subAgentIds` 时会直接把候选的 `parentId` 指向新智能体；`validateSubAgents` 的 `row.parentId !== null && row.parentId !== selfId` 在创建路径（`selfId=null`）能拦住已有父级的候选，但**不会**检查候选是否正被另一个父级使用后又被移走的历史残留（当前模型没有独立关联表，只有 `parentId` 单值，因此不存在多父问题）。「候选已有自己的子智能体」在创建路径同样被拦住，符合单层设计。

## 结论：**可用（修复后）**

依据：

- SDK 真实识别了子智能体：`Agent` 工具调用携带 `subagent_type: "subverify-child"`，子智能体内部调用了 MCP 工具并拿到真实 jsonplaceholder 数据，父智能体收到了 `[Subagent hand-back]` 结果并原样转述。
- 连续 3 次真实 run（id=1/2/3）均成功，事件序列稳定。
- 单元/集成测试：`pnpm vitest run` 16 个文件、83 个用例通过；新增的 SSE 去重用例与子智能体 md 断言通过。

## 已修复

| 文件 | 改动 |
|---|---|
| `packages/core/src/workspace.ts` | 子智能体 md 不再写 `tools`（主智能体 md 保留），并加注释说明原因 |
| `packages/worker/src/index.ts` | 主智能体自己的 md 不再写入 `.claude/agents/`，只保留子智能体文件 |
| `packages/api/src/queue/producer.ts` | `subscribeRun` 串行化 drain，避免并发 XRANGE 重复回调；加 2s 轮询兜底 |
| `packages/core/test/workspace-input.test.ts` | 断言子智能体 md 不含 `tools:` |
| `packages/api/test/agents.test.ts` | 同步断言 |
| `packages/api/test/sse-subscribers.test.ts` | 新增并发发布去重用例 |
| `docs/ARCHITECTURE.md`、`docs/IMPL-CONTRACTS.md` | 更新工作区文件语义 |

**部署提醒**：修改 `packages/sandbox/src` 后必须重建镜像。`pnpm run up` 只在镜像不存在时构建，已存在的机器要 `pnpm run up --rebuild` 或手动 `pnpm --filter @agentport/sandbox build && docker build -t agentport/sandbox:dev packages/sandbox`。

## 遗留问题与下一步

1. **自我递归风险（已评估，已消除一部分）**：修复前父智能体自己的 md 也会写进 `.claude/agents/<父slug>.md`，实测父智能体可以 `Agent(subagent_type="subverify-parent")` 成功派生一个同名智能体（返回 `parent-ok`），即自我递归。现在主智能体 md 不落盘，直接消除。**残余风险**：手工把同名 md 放回该目录仍可复现；单层约束目前只靠「子智能体 md 的 `disallowedTools` 含 `Agent`」和 API 的父子校验，SDK 本身没有深度限制。
2. **子智能体的 server 绑定仍被忽略**（HANDOFF 已知限制 2）：子智能体 md 继承父会话的 MCP 工具集。测试里父子绑定同一 server 所以看不出来；如果父没有绑定而子绑定了，子将拿不到工具。下一步可以在 `renderWorkspace` 里明确报错或把父的 server 集合并集传给子。
3. **子智能体内部的工具调用是单条事件**：父侧只看到 `Agent` 的 `tool_input`/`tool_result`，子智能体的 `get-user` 调用也以 `tool_start` 形式出现在同一条流里（见上表 #5–#7），落库后前端会把它显示成父对话里的工具卡片，没有缩进/归属标识。若需要区分，可在事件里加 `agentId`/`parentToolUseId`。
4. **轮询兜底是 2s 延迟**：正常 run 的 `run_finished` 由 pub/sub 唤醒即时送达，轮询只兜住极端竞态。下一步可改成 `XREAD BLOCK`，同时删掉轮询。
5. **`permissionMode: dontAsk` 下子智能体继承父会话的权限**：本次配置可用；若以后给子智能体单独配 `permissionMode`，需要重新验证。
