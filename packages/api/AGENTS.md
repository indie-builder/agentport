# api 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../AGENTS.md)；校验细节见 [VALIDATION](../../docs/VALIDATION.md)。本文件只写 api 的专属约束。

## 业务组织与 oRPC 适配

- 业务代码按 **HTTP 领域**归到 `src/modules/<业务域>/`，例如 `agents`、`chat`、`servers`、`knowledge`。领域只表示代码归属，不引入 DDD 分层、聚合根、仓储接口、`DomainError` 或通用状态机。
- `router.ts` 是 oRPC 的薄适配：用 `implement(<domain>Contract).$context<RequestContext>()` 绑定路由，在 handler 内完成授权、对象范围、状态转换与冲突处理。通用机制留在 `@agentport/db`、`@agentport/core` 或已有封装，不在每个领域重造。
- 只有真实的多步编排才建 `use-cases.ts`；单步读写直接留在 `router.ts`。不要求每个领域固定 router、http、use-cases 文件组合。
- 原生 HTTP 能力放同领域的 `http.ts`（认证沿用 `routes.ts`），直接注册到 Hono 并读写原始 `Request`/`Response`：better-auth、`/mcp`、SSE、文件与 ZIP 下载。静态资源由 API 根入口挂载。不经过 oRPC 的边界不复制契约 input schema。
- 业务代码统一在 `src/modules/<domain>/`；`src/features/` 已清空，不再新增平行入口。入口是 `src/index.ts` 的 `Bun.serve`，把请求交给 `buildApp()` 构造的 Hono app。

## 契约与校验

- HTTP 契约在 `@agentport/contract/<业务域>`：声明 method、path、input/output 与 `access` 元数据。契约路径不带 `/api`，由 `src/routes/index.ts` 统一挂到 `/api`。
- 请求校验只在契约的 input schema 完成。契约使用 oRPC 原生 `detailed` 输入，handler 直接读 `input.params`、`input.query`、`input.body`；不为路由输入再写 `safeParse`。
- 开放 JSON（ZIP manifest、MCP 工具参数、已落库 JSON）可在 handler 内用 schema 收窄成已知类型，见 [VALIDATION](../../docs/VALIDATION.md)。
- 声明 output schema 后，oRPC 校验响应；不符返回 500 `RESPONSE_INVALID`。
- 请求/响应/事件 schema 从 `@agentport/shared` 或 `@agentport/contract` 取，不复制错误码、事件类型或入队契约。

## 错误

- 唯一 wire 错误形状是 shared 的 `Problem`；`src/http/errors.ts` 把 zod、oRPC 与 Hono 错误统一转换，`AppError` 与 `fail()` 仍来自 `@agentport/core`。
- 业务规则冲突在 handler 内显式抛 `AppError` 或返回 404/409；不把业务错误降级成通用 500。
- 不新增平行错误信封，也不为旧响应保留 shim。

## 认证与授权

- 每条契约 procedure 必须声明 `access`：`public`（写明 reason）、`authenticated`、`permission` 或 `service`（写明 boundary 与 reason）。`src/http/middleware.ts` 的 `enforceAccess` 负责执行，不重复手挂。
- 需要限流的入口在契约元数据声明 `rateLimit`，由请求上下文统一计数；底层是 `http/security.ts` 的 `hono-rate-limiter` RedisStore，`/api/*` 另有 600/min 全局配额，静态资源与 `/health/*` 不计入。
- 非 `/api` 的原生路由（如 `/health/metrics`、`/mcp`）用 `access()` 显式挂载，不走 oRPC 元数据。
- `requireUser` 校验 better-auth 会话与停用账户，并拒绝 service principal；`requirePermission` 只确认权限叶存在，读到对象后必须调用 `authorize` / `authorizeObject` 校验对象范围。列表查询传 `accessFilter`（当前 businessId + scopes）。
- 范围不符统一按对象不存在处理，不泄露存在性；平台管理员跨用户读取走统一审计。私人正文只对创建者或平台开放。
- `/mcp`、run token、share token 等 `service` 边界用自己的 token 校验，不借用用户会话。

## 运行时与模块边界

- API 只做路由、入队、SSE 订阅与评估跑批；不启动容器、不执行 SDK、不消费队列。
- 取消 queued run 由 API 用 CAS 写终态并发布事件；取消 running run 只发信号，容器、消息与产出由 worker 收尾。
- 每轮工作区渲染与沙盒执行属于 worker；API 预览复用 core 的 `renderWorkspace`，不另写渲染。
- 宿主文件读写沿用现有 core 与模块内的存储入口（inputs、outputs、记忆文件），不新增平行目录布局。
- DB 访问走 `@agentport/db` 的 repo 与 schema；数据库 schema 变更按 [db 规则](../db/AGENTS.md) 执行。repo 的 SQL、事务、CAS 与 `AccessFilter` 继续由 db 共享，不搬回 API。

## Effect 边界

- 请求内确有类型化错误、超时或成对资源（连接/清理）时用 Effect，退出用 `Effect.runPromiseExit`，Effect 类型留在业务模块内部、不进入契约或路由签名；参考 `modules/servers/test-connection.ts` 的 `acquireRelease` / `scoped`。
- Hono 与 oRPC 负责请求生命周期、鉴权、校验与错误渲染，不在路由层重组 Effect 程序；不用 `effect/http` 或 Effect Schema 替代 oRPC 与 zod。
- 队列分发与重试归 BullMQ，业务重试不写进 API 的 Effect 流程。公共错误分类用 core 的 `RunFailure` / `isRetryableFailure`，不另建一套。

## 验证

`bun run --filter @agentport/api typecheck`；涉及权限、错误或路由时用 `bun run test -- packages/api/test/<file>` 跑对应套件（`bun:test`），并用实际 HTTP 请求核对路径、状态码与 `Problem` 形状。后端测试使用隔离库与临时 Redis，细节见 [OPERATIONS](../../docs/OPERATIONS.md)。
