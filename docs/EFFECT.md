# Effect v4 集成

> 2026-10-20。记录为什么引入 Effect、边界划在哪、以及不做什么。

## 决定

**Effect 只负责「一个任务内部的副作用」，不接管框架生命周期。**

```
┌──────────────────────────────────────────────┐
│ Fastify（HTTP 边界）                          │  请求生命周期、鉴权、校验
│   handler → await program()                   │
└───────────────────┬──────────────────────────┘
┌───────────────────▼──────────────────────────┐
│ Effect 层（packages/core/src/effect-runtime） │  资源、取消、超时、错误分类
│   Clock │ Db │ Redis │ Sandbox                │
└───────────────────┬──────────────────────────┘
┌───────────────────▼──────────────────────────┐
│ 适配器：Drizzle / ioredis / docker / SDK      │  只包一层，不重写
└──────────────────────────────────────────────┘
```

BullMQ 仍然负责任务分发与重试；Effect 负责单个任务内部。

## 为什么

普通 `async/await` 能表达「顺序」，但五个维度只能靠约定：

| 维度 | 手写方式 | Effect |
|---|---|---|
| 资源释放 | `try/finally`，每条路径都要记得 | `acquireRelease` + Scope |
| 取消 | `AbortController` 手动穿层 | Fiber 中断，自动向下传播 |
| 超时 | `setTimeout` + `clearTimeout` | `Effect.timeout`，与取消同一机制 |
| 重试 | 手写循环 | `Schedule`，是可组合值 |
| 错误分类 | 字符串匹配 / 自定义字段 | `E` 在类型里 |

实测确认（`packages/core/test/effect-runtime.test.ts`）：

- 失败、超时、中断三条路径上 finalizer 都执行且**只执行一次**。
- 超时不会泄漏 `TimeoutError`，统一映射为 `RunFailure('timeout')`。

## 边界规则

1. **对外签名不变。** `runInSandbox` 等仍是 `Promise<T>`；Effect 类型不泄漏到调用方。
2. **不在 Fastify 路由内组织 Effect**。路由只做一件事：`await program()`。
3. **不复刻框架能力。** 不用 `effect/http` 替代 Fastify，不用 Layer 管连接池。
4. **不替换 zod。** 校验链路（zod → Fastify schema → 前端）保持不变。

## 运行时契约

`packages/core/src/effect-runtime.ts`：

| 服务 | 用途 | 为什么需要服务化 |
|---|---|---|
| `Clock` | `sleep` / `now` | 测试里注入假时钟，超时与退避无需真实等待 |
| `Db` | 包一层 Drizzle 调用 | 统一 `DbError`，避免 Drizzle 类型外泄 |
| `Redis` | publish / xadd / get / del | 统一 `RedisError` |
| `Sandbox` | `acquire`（Scope 内自动销毁） | 容器释放由作用域保证 |

错误类型 `RunFailure.reason`：

| reason | 含义 | 可重试 |
|---|---|---|
| `infra` | 网络、Docker、Redis 等基础设施 | ✅ |
| `sandbox` | 容器启动/运行失败 | ❌ |
| `agent` | 模型或工具返回错误 | ❌ |
| `timeout` | 超过 `timeoutMs` | ❌ |
| `cancelled` | 用户取消 | ❌ |

`isRetryableFailure` 只对 `infra` 返回 true。保留正则兜底：`stderr` 中的 `ECONNREFUSED` 等仍判为 `infra`。

## 本次迁移的范围

| 模块 | 改动 |
|---|---|
| `packages/core/src/effect-runtime.ts` | 新增：四个服务 + `runProgram` + `withTimeout`（2026-10-25：无消费者的服务层与 `withTimeout` 已删除，仅保留错误分类与 `runProgram`） |
| `packages/worker/src/runner-client.ts` | 重写：容器生命周期、取消、超时、事件发布 |
| `packages/worker/src/eval-runner.ts` | 重写：批量执行用 `Effect.forEach` + `Effect.result`（v4 已无 `either`） |
| `packages/worker/src/reconcile.ts` | 重写：DB 调用加重试 |
| `packages/api/src/features/servers/test-connection.ts` | 重写：连接与关闭由 Scope 保证 |
| 测试 | `effect-runtime.test.ts`、`effect-semantics.test.ts` |

## 实测记录（2026-10-20）

单元与集成：`pnpm vitest run` 122 项通过；`pnpm -r typecheck` 干净；`biome check .` 无 error。

真实容器（宿主进程 + 真模型凭证）：

| 场景 | 结果 |
|---|---|
| 正常 run | `succeeded`，1 turn，1926 input / 51 output tokens |
| 用户取消 | `cancelled`，容器已清理 |
| 超时（agent.timeoutMs=8000） | `timeout`，错误为 `sandbox timed out after 8000ms`，容器已清理 |

三条路径都是 `Effect.raceAll` 的同一套结构：谁先到谁赢，容器销毁由 `acquireRelease` 兜底，不依赖每条分支各自记得清理。

注意：`docker compose` 里的 worker 只有在 `.env` 填了模型凭证时才能真跑；宿主机 shell 已有 `ANTHROPIC_AUTH_TOKEN` 时，`source .env` 会用空值覆盖它——这是验证时踩到的坑，不是代码问题。

## 明确不做

- **不改 Fastify 路由结构**：请求生命周期框架已经管好，Effect 在这里是重复抽象。
- **不用 `effect/http`**：Fastify 的 zod type provider、静态托管、SSE hijack 已工作良好。
- **不用 Effect Schema 替换 zod**：会同时改动前后端契约，且 `toJsonSchemaDocument` 的收益不足以抵消迁移成本。
- **不引入 `@effect/sql-drizzle`**：它当前 peer 依赖 effect ^3.22，与 v4 不兼容。

## 版本事实

- `effect@4.0.5`（4.0.0 发布于 2026-10-01，v4 生态仍在早期）
- 官方 SQL/平台集成适配的是 effect 3.22，项目按「只用核心包」的方式使用 v4。
- 因此本项目的 Effect 使用限定在：`Effect`、`Scope`、`Layer`、`Schedule`、`Clock`、测试工具。不依赖 Effect 的 SQL/HTTP 生态。
