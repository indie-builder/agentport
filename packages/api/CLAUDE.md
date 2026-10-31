# api 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；校验细节见 [VALIDATION](../../docs/VALIDATION.md)。本文件只写 api 的专属约束。

## 入口与校验

- 每个 feature 从 `registerXRoutes(rawApp)` 开始，首行 `const app = typed(rawApp)`；路由按实际输入用 `schema: { body, params, querystring }` 声明（没有的项不写），handler 直接读 `request.body/params/querystring`；`response` 为可选声明。
- 不在 handler 里为路由输入写 `safeParse`。开放 JSON（ZIP manifest、MCP 工具参数、已落库 JSON）可在 handler 内用 schema 收窄成已知类型，见 [VALIDATION](../../docs/VALIDATION.md)。
- 声明 `response` 后 Fastify 按 schema 序列化：漏字段会被丢弃，类型不符返回 500 `RESPONSE_INVALID`。
- 校验失败、响应序列化失败与框架错误统一由 `plugins/errors.ts` 渲染成 shared 的 `Problem`；业务规则冲突在 handler 内显式返回 409/404，或调用 `reject()`。
- 请求/响应/事件 schema 从 `@agentport/shared` 取，不复制错误码、事件类型或入队契约。

## 认证与授权

- 每条 `/api` 路由必须声明 `config.access`：`public`（写明 reason）、`authenticated`、`permission` 或 `service`。`plugins/access.ts` 的 onRoute 会自动挂 `requireAuth` / `requirePermission`，不要重复手挂。
- 非 `/api` 路由（如 `/health/metrics`）不会被 onRoute 接线，需显式挂认证与权限。
- `requireAuth` 校验 better-auth 会话与停用账户，并写入 `request.principal`；用户路由的权限与对象校验拒绝 service principal。
- `requirePermission` 只确认权限叶存在；读到对象后必须调用 `authorize` / `authorizeObject` 校验对象范围。列表查询传 `accessFilter`（当前 businessId + scopes）。不能因 schema 没写对象 ID 就省略范围。
- 范围不符统一按对象不存在处理，不泄露存在性；平台管理员跨用户读取走统一审计。私人正文只对创建者或平台开放。
- `/mcp`、run token、share token 等 `service` 边界用自己的 token 校验，不借用用户会话。

## 运行边界

- API 只做路由、入队、SSE 订阅与评估跑批；不启动容器、不执行 SDK、不消费队列。
- 取消 queued run 由 API 用 CAS 写终态并发布事件；取消 running run 只发信号，容器、消息与产出由 worker 收尾。
- 每轮工作区渲染与沙盒执行属于 worker；API 预览复用 core 的 `renderWorkspace`，不另写渲染。
- 宿主文件读写沿用现有 core/feature 存储入口（inputs、outputs、记忆文件），不新增平行目录布局。
- DB 访问走 `@agentport/db` 的 repo 与 schema；数据库 schema 变更按 [db 规则](../db/CLAUDE.md) 执行。

## 验证

`pnpm --filter @agentport/api typecheck`；涉及权限、错误或路由时跑 `packages/api/test` 对应套件。后端测试使用隔离库与临时 Redis，细节见 [OPERATIONS](../../docs/OPERATIONS.md)。
