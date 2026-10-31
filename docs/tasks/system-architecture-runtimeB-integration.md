# 系统架构现代化 R5：B 线接线说明

> 2026-10-31 修订：本文的事务内 `beforeDelete` 回调与无界 `sessionCleanup.close()` 接线已被
> `system-architecture-runtimeB-revision.md` 取代；新实现与真实证据见
> `system-architecture-runtimeB-shorttx-evidence.md`。下文只保留为历史接线记录。

状态（2026-10-31）：已接线。`packages/api/src/features/chat/routes.ts`、`packages/api/src/features/agents/routes.ts`
的 DELETE handler 与 `packages/worker/src/index.ts` 的启动/关停已按本文件完成；路由级 HTTP 证据见
`system-architecture-runtimeB-evidence.md`。下文保留可用签名、接线位置与边界，作为实现与复核参考。

基础模块已实现并通过测试；`packages/shared/src/sandbox-session.ts`、`packages/db/src/repo/{agents,chat}.ts`、
`packages/worker/src/sandbox/{sessions,session-cleanup}.ts`、`packages/api/src/queue/session-cleanup.ts`
已就绪，接线方不要再复制 schema 或另建第二套关闭通道。

## 1. 可用函数签名

```ts
// packages/db/src/repo/chat.ts
export interface ConversationSandboxTarget {
  conversationId: string;
  sandboxIds: string[];
}
export type BeforeDeleteSandboxes = (targets: ConversationSandboxTarget[]) => Promise<void>;

deleteConversation(
  db: Database,
  conversationId: string,
  beforeDelete?: BeforeDeleteSandboxes,
): Promise<boolean>;

// packages/db/src/repo/agents.ts
deleteAgent(
  db: Database,
  id: string,
  beforeDelete?: BeforeDeleteSandboxes,
): Promise<boolean>;

// packages/api/src/queue/session-cleanup.ts
closeSessionSandboxes(input: {
  targets: readonly SessionCleanupTarget[]; // { conversationId, sandboxIds }
  redisUrl: string;
  timeoutMs?: number;      // 默认 SESSION_CLEANUP_TIMEOUT_MS = 10_000
  requestChannel?: string; // 仅测试隔离用；生产不要传
}): Promise<void>;

// packages/worker/src/sandbox/session-cleanup.ts
startSessionCleanupChannel(input: {
  redisUrl: string;
  logger: Logger;
  sessions: Pick<SessionSandboxes, 'closeIdle'>;
  requestChannel?: string; // 仅测试隔离用；生产不要传
}): Promise<{ close(): Promise<void> }>;

// packages/worker/src/sandbox/sessions.ts
SessionSandboxes.closeIdle(
  conversationId: string,
  sandboxIds: readonly string[],
): Promise<void>;
```

`closeSessionSandboxes` 失败/超时抛 `AppError('SERVICE_UNAVAILABLE', ..., { retryable: true })`；
repo 已有的 queued/running 保护仍抛 `CONFLICT`。回调在事务内抛错即回滚，现有 Fastify
错误处理会输出统一 Problem，不需要在路由里手写 catch 或 204 假成功。

## 2. `packages/api/src/features/chat/routes.ts`（A 文件，接线者改）

位置：`app.delete('/api/conversations/:id', ...)`，当前 `packages/api/src/features/chat/routes.ts:804`。

```ts
import { closeSessionSandboxes } from '../../queue/session-cleanup.js';

// ...
const conversation = await loadConversation(app, request, request.params.id);
const ok = await chatRepo.deleteConversation(app.db, request.params.id, (targets) =>
  closeSessionSandboxes({ redisUrl: app.config.REDIS_URL, targets }),
);
if (!ok) {
  return reject(reply, 'CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
}
```

要求：

- 关闭确认必须发生在 DB 删除之前（repo 已保证），现有随后的 `sdk-sessions` /
  `session-sandboxes` / outputs / inputs 清理保持在 `ok === true` 之后。
- 不要在路由里先查 sandboxIds 或再发一次请求；repo 在锁内查询并去重。
- 失败时不要删目录、不要返回 204；让 503 抛出。

## 3. `packages/api/src/features/agents/routes.ts`（接线者改）

位置：`app.delete('/api/agents/:id', ...)`，当前 `packages/api/src/features/agents/routes.ts:734`。

```ts
import { closeSessionSandboxes } from '../../queue/session-cleanup.js';

// ...
const ok = await repo.deleteAgent(app.db, current.id, (targets) =>
  closeSessionSandboxes({ redisUrl: app.config.REDIS_URL, targets }),
);
if (!ok) return notFound(reply);
```

同一 handler 在删除成功后补上遗漏的会话沙盒目录回收（当前只清 sdk-sessions / outputs /
inputs）：

```ts
await rm(join(app.config.WORKSPACES_DIR, slug, 'session-sandboxes'), {
  recursive: true,
  force: true,
}).catch((err: unknown) => {
  request.log.warn({ err, agentId: current.id }, 'session sandbox directory cleanup failed');
});
```

要求：

- 只删除目标 agent 的会话；`agent-memory`、子专家记忆、个人记忆、其他 agent 目录一律保留。
- rm 失败只记录日志（合同允许的 best-effort），不要把已经提交的 DB 删除说成可回滚；
  日志保留目标路径身份与 agentId。
- 不要删除 `agent-memory`、子专家记忆、个人记忆或其他持久目录。

## 4. `packages/worker/src/index.ts`（eval/接线者文件）

位置：现有 import 区（`SessionSandboxes` 约 `packages/worker/src/index.ts:78`）与
`sessionSandboxes` 创建之后（约 `:128`）。

```ts
import { startSessionCleanupChannel } from './sandbox/session-cleanup.js';

const sessionCleanup = await startSessionCleanupChannel({
  redisUrl: config.REDIS_URL,
  logger,
  sessions: sessionSandboxes,
});
```

平台启动时在 `sessionSandboxes` 创建后立即 `await` 订阅成功；订阅失败按现有启动失败处理，
不会让 API 请求发进没有监听的信道。

关停：把信道关闭放进 `provider.close`，而不是 `steps`。`steps` 有 5s 上限；信道的等待上限
显式复用 `SESSION_CLEANUP_TIMEOUT_MS`（10s，与 API 删除请求同一预算）。超时后继续关停：
API 会因 ACK 超时回滚删除，实体与目录保留，可安全重试；没有新增无界退出路径。

```ts
provider: {
  label: 'sandbox provider',
  close: async () => {
    try {
      const drained = await waitClose(sessionCleanup.close(), SESSION_CLEANUP_TIMEOUT_MS);
      if (!drained) {
        logger.warn(
          { budgetMs: SESSION_CLEANUP_TIMEOUT_MS },
          'session cleanup channel did not drain before shutdown budget',
        );
      }
      await sessionSandboxes.close();
    } finally {
      await provider.destroyAll();
    }
  },
},
```

要求：

- 启动时 `await` 订阅成功，避免 API 请求在无监听时静默丢失；启动失败按现有启动失败处理。
- 不要在 `steps` 里再放一次 close，也不要新增常驻轮询或第二个 Worker。
- `requestChannel` 生产不传，使用 shared 的默认信道。

## 5. 接线后必须补的验证（已实现）

以下用例已在 `packages/api/test/delete-lifecycle.test.ts` 落地，并通过真实 HTTP + Redis + DB 运行：

1. **HTTP 成功路径**：路由返回 204 前必须收到 ACK；目录只在 ACK 与 DB 删除之后消失。
2. **HTTP 失败回滚**：关闭失败返回 503（`retryable: true`），DB 行与目录保留；清除故障后重试成功。
3. **锁内顺序**：关闭回调延迟 ACK 时，`/api/chat` 的准入不会在关闭与删除之间落地；删除提交后返回 404。
4. **agent 删除目录**：`session-sandboxes` 被删除；`agent-memory`、子专家记忆、个人记忆与
   其他 agent/conversation 目录仍在。
5. **真实 Docker**：沿用 `packages/worker/test/session-cleanup-docker.test.ts`，确认容器停止/移除后
   才执行行删除与目录回收；停容器失败时实体与目录仍在。

新增的路由测试需要与其它 API 套件隔离：Redis Pub/Sub 不按库隔离，故障用例使用
`startRedisContainer()` 启动的独享实例，避免其它套件注册的处理器代替应答。

## 6. 边界与不要做的事

- 不要为“多 worker”扩大协议：当前合同是单 worker 进程。ACK 只表示至少一个监听者确认；
  `requestChannel` 只是测试隔离参数。
- 不要新增持久删除状态、schema 列、迁移、GC 服务或第二套 MCP/运行路由。
- 不要按容器 id 强杀 busy entry；worker 已先判 active/leaseHeld/acquirePending。
- 不要把 `closeSessionSandboxes` 放到路由锁外预检；必须在 repo 事务回调内调用。
- `agent-memory`、子专家 memory、个人 memory 不属于删除范围。
