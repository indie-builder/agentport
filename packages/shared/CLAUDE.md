# shared 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；本文件只写 shared 的专属约束。跨端契约的唯一来源是 `src/` 的 zod schema，改动前先看使用方。

## 边界

- 只依赖 `zod`。不引入 React/DOM/Node 运行时、UI 组件、DB 客户端、队列、文件或网络调用。
- 不生成业务主键或 TypeID；ID 由 `@agentport/db` 的 `newId(entity)` 在应用层生成。
- 不放 UI 实现、组件草稿、dirty 状态或组件文案；错误、事件、任务与协议是跨端数据契约，保持无端侧副作用。

## 契约规则

- 跨端共享的请求/响应 schema、`ChatEvent`、`AgentRunJob` / `EvalRunJob` / `ScheduleTriggerJob`、`SandboxTask`、supervisor 的 NDJSON 输入输出都在这里定义；api/worker/sandbox/web 只 import，不各自重写。仅单端使用的路由 schema 留在 api。
- 类型用 `z.infer` 从 schema 推导，不手写同名 interface；判别联合统一用 `z.discriminatedUnion`。
- HTTP 错误唯一形状是 `src/errors.ts` 的 `Problem`：wire 字段为 `code` / `message` / `status` / `requestId` / `retryable`，校验类可带 `path` / `errors`。不要新增 `{ error: string }` 等平行信封。
- `src/run-stream.ts` 的队列名、Redis key、入队选项与取消载荷是 api/worker 的唯一来源。
- 错误码新增属兼容变更；改语义或删除属破坏性变更，先核对前端与 MCP 客户端。
- 入口统一中文校验文案（`z.config(z.locales.zhCN())`）；schema 描述可能进入错误或提示词，保持可读。

## 验证

契约改动跑 `pnpm --filter @agentport/shared typecheck`，并按受影响使用方补跑 `packages/{api,worker,sandbox}/test` 中对应套件。
