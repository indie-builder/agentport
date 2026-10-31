# core 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；工作区与官方文件约定见 [ARCHITECTURE](../../docs/ARCHITECTURE.md)。本文件只写 core 的专属约束。

## 职责与边界

- core 是 api/worker/web 共用的纯机制层：官方文件渲染与解析、路径/名称校验、MCP 条目、密钥加解密、知识模型 HTTP 客户端。不碰数据库，不放 HTTP 路由、队列、沙盒编排或业务状态机。
- 纯函数模块不读写宿主文件、不启动进程。显式 I/O 只集中在 `outputs.ts`（会话产出草稿/快照）与 `attachments.ts`（会话输入附件）；它们按调用方传入的根工作，不读环境变量或 CWD 猜目录。
- `knowledge-models.ts` 只发 HTTP；失败分类是 worker 重试策略的依据，不在这里写队列或 DB。

## 唯一实现

- 官方文件投影只走 `renderWorkspace()` / `toWorkspaceInput()` 及现有解析器（`official-files.ts`、`agent-md.ts`、`skill-md.ts`、`skill-draft.ts`、`plugin-render.ts`、`plugin-display.ts`、`mcp-json.ts`）。API 预览与 worker 落盘共用同一份，不另写生成器或第二套目录格式。
- 产出统一用 `prepareOutputDraft` / `captureOutputDraft` / `publishOutputSnapshot` / `listOutputFiles` / `readOutputFile`；不得在 core 外新增平行存储布局或发布规则。
- 密钥统一用 `encryptSecrets()` / `decryptSecrets()`（`APP_SECRET_KEY` 派生）；明文不写日志、不落盘，存储与轮换由调用方负责。

## 文件安全

- `outputs.ts` / `attachments.ts` 的路径校验必须保留：只接受安全相对路径，拒绝绝对路径、`..`、符号链接逃逸、硬链接和非普通文件；校验以调用方传入的物理根为信任起点。
- 写入先落到临时目录再原子改名；失败时只回收自己创建的内容，不删除可能由别处创建的数据。

## 浏览器子路径

- 根入口包含 `node:crypto` / `node:fs` 等模块，web 不得 import `@agentport/core` 根入口；web 实际只使用 `workspace`、`tools`、`plugin-display` 三个子路径。
- 新增浏览器可达的子路径前，先确认它与传递依赖都不含 Node 内建；不要把 fs、DB 或路由代码塞进这些子路径。

## 验证

纯函数与存储改动跑 `pnpm --filter @agentport/core typecheck` 与 `packages/core/test` 对应套件；路径/产出规则变更要覆盖拒绝逃逸与原子发布行为。
