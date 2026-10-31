# 模块规则分层（module-rules）

## 目标

把根 `CLAUDE.md` 中跨包共用的硬约束留在根，把各包专属规则下沉到 `packages/<pkg>/CLAUDE.md`，让 Claude Code 进入具体包工作时按官方机制按需加载；同时补上各包「具体复用职责」，减少重复实现。

验收标准：现有每条硬约束仍可追溯、无重复冲突、链接有效；改动仅为 Markdown 规则文件，不改业务源码、配置、依赖或 hook；纯文档任务，不新增业务测试或门禁。

## 方案基线

**官方加载模型（2026-10-31 核对 https://code.claude.com/docs/en/memory）**

- 启动时加载 CWD 及所有祖先目录的 `CLAUDE.md` / `CLAUDE.local.md`；根到 CWD 顺序拼接，**不互相覆盖**。
- CWD 下子目录的 `CLAUDE.md` 不在启动时加载，Claude 读取、写入或编辑该子目录文件时才按需加载。
- `@import` 会递归展开并随引用文件一起进上下文，最多 4 跳；**普通条件链接不加 `@` 不会加载正文**。
- 官方建议单文件少于 200 行；指令冲突时 Claude 可能任选其一，因此必须去重。

**目标结构**

- **根 `CLAUDE.md`（始终加载）**：§0 文件系统第一性原则、优先级、决策标准、能力选型、复用与职责边界、模块规则表、协作方式、智能体运行底座、测试、技能与插件维护、交付，以及所有跨包硬约束与跨包流程指针。
- **七个包局部 `packages/{web,api,worker,core,db,shared,sandbox}/CLAUDE.md`**：只放该包的专属规则与复用职责，不复制根原则。
- 根不加 `@import` 模块规则，只放普通链接与触发条件；包规则在进入对应包文件时按需加载。
- 迁移顺序：Opus 分配归属 → Sonnet 按文件边界分区并行写入 → Opus 独立 review → 链接/规则保留检查与 diff。

**基线与范围**

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/module-rules`；分支 `docs/module-rules`；起点 `HEAD = origin/main = 68241bab58ad8ec59727d70677bec790af2a5ae2`。
- 只改根与流程文档、本记录、七个包 `CLAUDE.md`；不改业务源码、测试、配置、依赖、hook、数据库或运行时。
- 旧 `stack-framework-adoption` 树不进入、不读取、不复制、不作为基线；本任务以 `origin/main` 为准。

## 当前有效决定

- 采用「根共用原则 + 七个包局部 `CLAUDE.md`」分层，不拆技能、不新增规则引擎。
- 迁移是拆迁去重，不是删减：硬约束必须全部保留并可追溯到根或目标包；去重只处理真正重复，冲突先定权威来源。
- 模块范围已定：根 + `web`、`api`、`worker`、`core`、`db`、`shared`、`sandbox` 七个包；`sandbox` 是否单列已批准，七份包规则均已写入。
- 包职责候选已按实际代码修正：
  - `core`：不碰 DB、不启动进程；纯函数模块不做宿主 I/O，显式 I/O 只在 `outputs.ts`（成果草稿/快照）与 `attachments.ts`（会话输入附件），按调用方传入的根工作。
  - `api`：不承担每轮专家定义渲染和沙盒启动；文件操作经既有入口，个人偏好、记忆与会话附件可读写，成果只读。
  - `worker`：不承业务 REST；每轮定义渲染、工作区落盘与沙盒生命周期在 worker，唯一 HTTP 监听是模型凭证代理。
  - `shared`、`db`、`web` 候选与代码一致，无需改边界。
- ID 例外（关联表、认证载体、幂等派生标识、外部资源、UI 行标识）沿用 `docs/PROJECT-BRIEF.md#162-id-约定`，不是本轮新发现或新行为。
- 模块规则只作上下文，不换成 hook 或阻塞门禁；纯文档改动不加业务测试。
- 用户已授权 commit / push / PR 合并收尾；PR #136 已合入 `main`。

## 旧根规则归属映射（已实现）

| 旧根位置 | 新归属 | 说明 |
|---|---|---|
| §0 文件系统第一性四条派生 | 根 | 原样保留 |
| 优先级 0-4 | 根 | 官方最佳实践补 SDK 类型定义入口；UI 基准改为 `DESIGN-SYSTEM` + `web` 指针；技术栈指向已选栈与模块/ARCHITECTURE；零死代码保留 |
| 决策标准 | 根 | 全部保留；后端入口校验改为 `api` 指针 |
| 能力选型 | 根 | 全部保留；新增「复用与职责边界」 |
| 协作方式 | 根 | 全部保留；ub、模型/effort、主会话不写、Opus 终审、worktree 授权、流程指针 |
| 智能体运行底座 | 根 | SDK 唯一底座、先官方文档与本地 `sdk.d.ts`、文件工作区、单一 Harness、换栈清理 |
| 前端详细段 | `web` | 根不再单列前端段，仅留「UI 基准优先」与模块表；具体前端规则、色值与实现细节单源在 `packages/web/CLAUDE.md` 与 `docs/DESIGN-SYSTEM.md` |
| 后端路由 schema、`plugins/errors.ts`、`requireAuth`、typed app | `api` | 根改为 `api` 规则与 `docs/VALIDATION.md` 指针 |
| `pnpm db:generate` + `db:migrate`、`newId(entity)` 生成位置 | `db` | 根保留 TypeID 通用规则与规范入口 |
| 测试 | 根 | 全部保留，后端基础设施细节指向 `docs/OPERATIONS.md` |
| 技能与插件维护 | 根 | 原样保留 |
| 交付 | 根 | 原样保留 |

## 本轮文档/代码冲突修复

- **间距**：`@theme` 没有 spacing 令牌，实际使用 Tailwind 默认 `gap-*` / `p-*` 尺度；`web` 规则限定在 DESIGN-SYSTEM §9 尺度内，不新增私有间距令牌。
- **core 文件 I/O**：core 并非完全不读写宿主文件；`outputs.ts` / `attachments.ts` 按调用方传入的根读写成果与附件，其他纯函数模块仍无 I/O。
- **api 文件 I/O**：API 实际会写个人偏好、记忆与会话附件并读取成果；改为「不承担每轮专家定义渲染和沙盒启动」，文件操作经既有入口。
- **worker HTTP**：worker 并非完全不暴露 HTTP；唯一监听是模型凭证代理，业务 REST 仍只在 API。
- **handler `safeParse`**：只禁止对路由输入再解析；开放 JSON（ZIP manifest、MCP 工具参数、已落库 JSON）可在 handler 内收窄成已知类型。
- **`Problem`**：真实 wire 必填 `status`、`retryable`；`path` 为 JSON Pointer（如 `/name`），校验示例已补全 `status` / `retryable` / `path` / `errors`。
- **`response` schema**：为可选声明；声明后 Fastify 按 schema 序列化，漏字段被丢弃、类型不符返回 500 `RESPONSE_INVALID`。
- **web 表单/查询**：RHF 只用于平台资源编辑表单，OpenUI 生成式表单走官方运行时；普通 JSON 经 `api` / `queries.ts`，鉴权图片 Blob、SSE 与 OpenUI 查询保留各自通道。
- **ARCHITECTURE 残留**：删除「写文件只发生在 worker」，按实际区分 worker 的每轮定义渲染/沙盒与 API 的个人偏好、记忆、附件、成果文件读写。

## 验证

- 链接：改动文档全量相对链接 119 个均存在，0 missing；主会话对 12 个文档入口链接检查 0 fail；根无 `@import`。
- 行数：8 个规则文件 22–120 行（根 120 行、各包 22–41 行），均低于 200。
- `git diff --check` 通过；改动仅约定的 Markdown 文件，七个包 `CLAUDE.md` 已随 PR #136 提交并合入 `main`。
- 无业务源码或配置改动，不运行业务测试。
- 独立 Opus 首审 4 个问题已修复，定向 review 最终通过（Opus）。

## 改动文件

- `docs/tasks/module-rules.md`（本记录，已随 PR #136 交付）
- `docs/ARCHITECTURE.md`（运行时约定残留句）
- `CLAUDE.md`
- `docs/DEV-WORKFLOW.md`
- `docs/README.md`
- `docs/VALIDATION.md`
- `packages/{web,api,worker,core,db,shared,sandbox}/CLAUDE.md`

## 下一步

- 无剩余实施；PR #136 已合入 `main`（merge `addf0fa`），本次仅同步合并事实，剩余工作区清理由主会话按 [DEV-WORKFLOW](../DEV-WORKFLOW.md) §2-7 执行。
