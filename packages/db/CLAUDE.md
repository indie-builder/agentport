# db 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；运维与测试隔离见 [OPERATIONS](../../docs/OPERATIONS.md)。本文件只写 db 的专属约束。

## 边界

- 只做 Drizzle schema、迁移、repo 与 TypeID 生成；不放 HTTP/Fastify、队列、SSE、沙盒、SDK 或业务编排。
- 共享查询与写入放 `src/repo/`，api/worker 直接复用，不复制同一 SQL；不为单个调用方预造抽象。
- 事务内不做 HTTP、队列、文件或 SDK 调用，保持短小。

## Schema 与迁移

- 表定义只在 `src/schema.ts` 改；迁移用 `pnpm db:generate` 生成到 `migrations/` 并提交，再执行 `pnpm db:migrate`。生成后检查 SQL，已应用的迁移不回改；不为旧数据保留兼容层。
- DB schema 变更后同步 docs 中对应的表/字段说明（如 [ARCHITECTURE](../../docs/ARCHITECTURE.md)、[PROJECT-BRIEF](../../docs/PROJECT-BRIEF.md)）。这里指数据库 schema，不是 HTTP 路由 schema。
- 新表/列明确 nullable、默认值与约束，不靠隐式行为；再跑迁移。

## ID、主体与事务

- 常规业务实体主键用 `newId(entity)`；前缀只在 `src/id.ts` 定义，不在调用方拼前缀或改用随机 UUID。关联表、认证载体、幂等派生标识、外部资源及 UI 行标识按 [PROJECT-BRIEF §16.2](../../docs/PROJECT-BRIEF.md#162-id-约定) 的例外处理。
- 含用户内容的列表/读取 repo 方法接收 `AccessFilter` 或主体参数，在 SQL 中按 `businessId` 与 scopes 过滤；私有正文只对创建者或平台开放。范围不符由调用方按对象不存在处理。
- 多步状态转换（run、question、版本、绑定）用 `db.transaction`；并发冲突用条件更新/CAS 或 `FOR UPDATE`，必要时 `repeatable read`。事务内每条读写仍带主体与范围条件，不用事务放大权限。

## 验证

schema/repo 改动跑 `pnpm --filter @agentport/db typecheck` 与相关 backend 套件。需要数据库的用例使用根 backend globalSetup 创建的隔离库，不写开发库；隔离方式与跳过条件见 [OPERATIONS](../../docs/OPERATIONS.md)。
