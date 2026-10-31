# 系统架构现代化 A：响应边界与共享类型证据

> 契约：`docs/tasks/system-architecture-modernization-contract.md` §3 / §6。基线 `68241ba`，日期 2026-10-31。
> 本文只记录 A 分区（API/client 契约）的真实执行证据，不替代任务主记录。

## 改动文件

- `packages/shared/src/chat.ts`：提取 `publicConversationSchema`（详情/改名复用），新增 `conversationBranchSchema`、`PublicConversation`、`ConversationBranch`。
- `packages/shared/src/schemas.ts`：由现有 Zod schema 推导 `RunStatus`、`RunList`、`RunStep`、`RunDetail`、`RecentRun`、`Overview`、`OverviewAgentRow`；`RunListItem` 保持原样复用。
- `packages/api/src/features/chat/routes.ts`
  - GET 详情：注册 `conversationDetailSchema`；conversation 显式投影四字段，消息显式投影公开字段并把 `createdAt` 转 ISO；SDK uuid / `senderBusinessId` 不上 wire；content 与 UI 快照原样保留。
  - GET search：注册 `conversationSearchResponseSchema`。
  - GET list：注册 `z.array(conversationSummarySchema)`。
  - PATCH：注册 `publicConversationSchema`，`createdAt` 转 ISO。
  - POST branch：注册 `conversationBranchSchema`（201），只回四字段 + `parentId` / `branchOfMessageId`，`createdAt` 转 ISO；分支事务/文件复制/回滚未改。
- `packages/api/src/features/chat/outputs.ts`：三个 JSON 端点分别注册 `outputListSchema`、`z.object({ file: outputFileSchema })`、`outputContentSchema`；删除基线遗留的未使用函数 `conversationNotFound`。下载、SSE 不套 JSON schema。
- `packages/web/src/lib/api.ts`：删除重复 Run/Overview 声明，改为导入并重新导出 shared 类型；`branchConversation` 返回 `ConversationBranch`。
- 测试：`packages/api/test/conversations.test.ts`、`chat.test.ts`、`conversation-search.test.ts`、`outputs-routes.test.ts`。

未缩减 `repo.chat.getConversation`，未改 DB/worker/SDK，未新增依赖、客户端生成、codec 或重复 parse，未改全局 serializer。

## 红：基线失败原因

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/conversations.test.ts packages/api/test/chat.test.ts \
  packages/api/test/conversation-search.test.ts packages/api/test/outputs-routes.test.ts \
  packages/api/test/route-access.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-A-red.json
```

结果（JSON 实际计数）：`67 total / 64 passed / 3 failed / 0 skipped`。3 条失败全部来自新增/收紧的边界断言：

- `branches a conversation up to the given message`：分支响应有 10 个键（整行含 SDK/归属列），不等于公开 6 键。
- `renames with a trimmed Unicode title and leaves messages, run and timestamps intact`：消息仍带 `senderBusinessId`（10 键 vs 公开 9 键）。
- `returns only public fields with ISO dates, preserving content, UI snapshots and pagination`：详情 conversation 仍为整行，多出内部列。

搜索/列表/成果端点的 schema 接线断言在基线即通过（既有行为正确），按契约只作接线与形状证据，不伪造成红。

## 绿与相关回归

```sh
pnpm --filter @agentport/shared build
pnpm exec vitest run --project backend \
  packages/api/test/conversations.test.ts packages/api/test/chat.test.ts \
  packages/api/test/conversation-search.test.ts packages/api/test/outputs-routes.test.ts \
  packages/api/test/route-access.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-A-final.json
```

结果：`67 total / 67 passed / 0 failed / 0 skipped`。

同一批路由的其他调用方回归：

```sh
pnpm exec vitest run --project backend \
  packages/api/test/chat-history-pages.test.ts packages/api/test/chat-attachments.test.ts \
  packages/api/test/output-retention.test.ts packages/api/test/output-shares.test.ts \
  packages/api/test/rbac-scope.test.ts packages/api/test/chat-enqueue-failure.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-A-related-final.json
```

结果：`52 total / 52 passed / 0 failed / 0 skipped`。

## 静态验证

```sh
pnpm --filter @agentport/api typecheck   # 通过
pnpm --filter @agentport/web typecheck   # 通过
pnpm --filter @agentport/api build       # 通过（tsc -b）
pnpm lint:contract                       # project contract OK
pnpm lint:focus                          # 通过
pnpm exec biome check <9 个改动文件>      # 通过
```

## 契约覆盖点

- 详情/分支：带非空 `sdkSessionId`、`forkFromSdkMessageUuid`、消息 `sdkMessageUuid` 的会话中，内部字段均不可见；分支保留 `parentId` / `branchOfMessageId`。
- content 对象与数组、`uiState` 嵌套未知键 JSON 等价；`uiFormat` / `uiProgram` / `uiState` / 消息 id / `runId` / `runMetrics` / `nextBefore` 完整。
- 详情日期与改名/分支日期为 ISO；空消息、最后一页、有效游标分页均通过。
- 搜索/列表包装、游标、空 `lastMessage` 与既有 400/401/403/404 Problem 未变。
- 成果三个 JSON 端点按 shared schema 解析通过；下载字节、响应头与二进制行为、401/404、1MiB/类型/UTF-8 校验均保持。
- `senderBusinessId` 旧整行断言改为不存在，未扩展 shared 保留该字段。

## 限制与未覆盖

- 未运行 web 测试：共享类型未使现有 web fixture 失配（web typecheck 通过），按契约不重复跑 B/C 测试。
- 未运行 web build / 联合终审：属于 A/B/C 合并阶段；B/C 文件未由 A 修改。
- 未 commit/push/merge；未改 `.loopx/`、主记录、DB/worker/SDK 或其他契约文档。
- 工作区 `M .vitest/json/output.json` 为开工前已存在的差异，本任务测试均显式 `--outputFile` 到 `/tmp`，未写入该文件。
