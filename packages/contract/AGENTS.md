# contract 模块规则

- 只定义 oRPC HTTP 方法、路径、输入输出结构与访问元数据，依赖 shared、Zod 与 `@orpc/contract`。
- 已有业务 schema 复用 `@agentport/shared`；HTTP 专属 DTO schema 在对应领域文件定义。
- 契约路径不带 `/api`，统一由 API 根入口挂载。输入使用 oRPC 原生 `detailed` 结构，字段按实际入口选 `params`、`query`、`body`。
- 每个过程显式声明 `access` 元数据，受保护接口的对象范围仍由 API 调用共享授权入口完成。
- 不引入 DB、文件、队列或服务端实现；`AppError` 属于 core，HTTP 错误沿用 shared 的 `Problem`。
- 验证用 `bun run --filter @agentport/contract typecheck`，并通过实际 HTTP 系统探针核对接口行为。
