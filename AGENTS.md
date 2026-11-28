# Agentport / PACE — 项目规则

> **【Rule 1 · Codebase ownership｜Highest priority】**
>
> This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it. Own it end to end — when something conflicts with best practice or internal consistency, judge and improve on it on your own; where this rule conflicts with any other rule or personal preference, it takes precedence.

> 适用于本仓库所有改动，高于个人偏好。回复、总结、提交说明用中文；代码、命令、标识符、路径保持原样。
>
> 入口：[docs/README.md](docs/README.md)（文档总览）｜[docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)（流程与门禁）｜[docs/PITFALLS.md](docs/PITFALLS.md)（跨任务踩坑：查顶部索引定位节名，再按行范围只读命中节）。各包规则见「模块规则」。
>
> 同目录 `CLAUDE.md`（根与 `packages/*`）是指向 `AGENTS.md` 的软链；**唯一真源是 `AGENTS.md`**，只改它、不替换为实体副本。

## 0. 第一性原则：文件系统即智能体定义（最高约束）

智能体定义全部用 Claude Agent SDK / Claude Code 官方文件系统表达（`.claude/` 下 `.mcp.json`、`CLAUDE.md`、`.claude/skills/<name>/SKILL.md`、`.claude/agents/*.md`、`.claude/settings.json`、hooks 等）；平台只负责渲染到工作区、只读挂载进沙盒、交 SDK 加载，不另造私有 JSON/DB 运行定义。

派生规则（必须遵守）：

1. **文件是唯一投影，DB 是编辑来源。** 界面编辑最终落成官方文件；能力支持以「能生成并被 SDK 真正加载/调用」为准。
2. **只用官方文件约定。** 目录名、文件名与 frontmatter 一律照官方文档，不自创；范围见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)「官方文件能力与接入状态」。
3. **能力扩展 = 补齐文件能力。** 新增功能落为官方文件/目录的「可编辑 + 可渲染 + 可加载 + 可导出」闭环，不建私有语义表。
4. **可移植。** 智能体 `.claude/` 目录本身即交付物，可原样导出、导入与跨平台复用。

## 优先级（冲突时自上而下裁决）

0. **官方最佳实践优先。** 各技术栈（shadcn/ui、ui-sdk、Tailwind、TanStack、Drizzle、Bun、Hono、oRPC、Bun test、Vitest 等）以官方文档为准，高于口头偏好、个人判断与历史习惯；涉及 Claude Agent SDK / Claude Code 同步核对已安装的 `sdk.d.ts`。
1. **并行优先。** 可拆工作一律并行；仅真实依赖允许串行，并说明依赖。
2. **UI 基准优先。** 布局几何与信息表达以 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) 为准，视觉令牌与组件外观（含共享卡片深度）以 [packages/web/DESIGN.md](packages/web/DESIGN.md) 为准，前端细则见 [packages/web/AGENTS.md](packages/web/AGENTS.md)；技术选型、库默认样式或动效偏好不得改动视觉基准。
3. **技术栈优先。** 走已选库与官方原生能力，不手写等价实现；包职责见各模块规则与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
4. **零死代码。** 无引用代码、导出、样式、依赖与注释块一律删除，删前 grep、删后验证；用户明确保留的受保护入口除外（见各模块 `AGENTS.md` 与 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)）。
5. 其余按本文件后续条款执行。

## 决策标准

- **三赢（UX / DX / AX 同时提升）。** 设计与技术决策须同时提升 UX、DX、AX，不牺牲其一，且不破坏现有功能。
- **不考虑向后兼容。** 个人项目按当前最佳实践设计，不为旧数据/格式/接口留兼容层、迁移分支或双写路径；需要重置直接重建库或重灌。
- **不为理论风险静默加防护。** 加代码防假设性竞态或安全边界前，用平白语言说明三件事并等用户明确同意：① 会出什么问题；② 发生概率；③ 新增复杂度。真实可发生的边界（信任边界校验、防数据丢失、安全、无障碍）照常做。
- **入口校验一次。** 外部数据在入口信任边界校验一次，内部使用确定类型不重复校验；后端按 [packages/api/AGENTS.md](packages/api/AGENTS.md) 的 oRPC 契约执行。
- **保持直接控制流。** 仅需恢复、清理或转换错误时用 `try/catch`，其余交统一机制，不吞错。

## 能力选型（硬性：现有 → 原生/已装依赖 → 主流开源 → 自研）

新增或改进能力前先说明真实缺口；无真实问题不加能力、不换栈：

0. **先查现有**：grep / 读代码找同类入口、组件、服务或封装；有则复用、整合或按最佳实践改造，确认不存在才新增。
1. **原生与已装依赖**：Claude Agent SDK / Claude Code 或已装栈已提供时，以最小代价采用原生，不造第二套。
2. **主流开源**：选持续维护、近期稳定发布、生态成熟、许可合规的进程内库（不新增独立服务/容器/托管 SaaS），记录依据；引入即替代并删旧实现。
3. **最后自研**：说明现有、原生、开源均不适用的理由。性能候选先做基准再定。

- **Bun 原生 API 优先。** Bun 能等价实现的优先用 Bun（`Bun.spawn`/`Bun.serve`/`Bun.file`/`Bun.write`/`Bun.CryptoHasher`/Web Crypto/`Bun.sleep` 等），仅无等价能力或突破真实安全/数据边界时保留 `node:*`（如 `timingSafeEqual`、目录/权限与同步 fs、`node:net isIP`）。

## 复用与职责边界

- 通用机制（表单、缓存、数据访问、SDK 循环）归库或共享封装；业务模块只留字段约束、权限、状态转换与冲突规则。
- 业务差异用配置、数据或模块内规则表达，不另造同类机制。

## 模块规则

根规则始终加载；进入子包读写前按需加载对应模块规则，跨包改动先读全部相关规则。

| 模块 | 规则文件 | 进入条件 |
|---|---|---|
| 根（始终加载） | `AGENTS.md` | 所有任务 |
| `web` | [packages/web/AGENTS.md](packages/web/AGENTS.md) | 页面、组件、样式、路由、前端状态与 DESIGN-SYSTEM 实现 |
| `api` | [packages/api/AGENTS.md](packages/api/AGENTS.md) | 业务模块、oRPC 适配、鉴权、错误、SSE、队列生产 |
| `contract` | [packages/contract/AGENTS.md](packages/contract/AGENTS.md) | oRPC procedure 的 method、path、input/output 与 access 元数据 |
| `worker` | [packages/worker/AGENTS.md](packages/worker/AGENTS.md) | 队列消费、会话工作区渲染、沙盒生命周期、事件回传 |
| `core` | [packages/core/AGENTS.md](packages/core/AGENTS.md) | 工作区渲染、密钥加解密、MCP 条目、领域纯函数 |
| `db` | [packages/db/AGENTS.md](packages/db/AGENTS.md) | Drizzle schema、repo、迁移、TypeID 生成 |
| `shared` | [packages/shared/AGENTS.md](packages/shared/AGENTS.md) | zod 契约、共享类型、事件与任务 payload |
| `sandbox` | [packages/sandbox/AGENTS.md](packages/sandbox/AGENTS.md) | 容器内 supervisor、runner、沙盒镜像边界 |

- 根用普通链接指向子规则（不加 `@import`），子规则不重述或覆盖根约束。体量上限：根 `AGENTS.md` ≤ 16 KB、子包 `AGENTS.md` ≤ 12 KB（`bun run lint:docs` 强制校验）。
- 改根 `scripts/`、`tests/`、`Dockerfile`、compose、根 `package.json` 前先读所服务包规则；派子代理写明目标模块规则路径，review 核对合规与归属。

## 协作方式

- **工程纪律唯一来源是 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)**（先实现目标 → 完善实现 → 按规范交付）；任务首次写入前与续做恢复必读 §2，开工前按 [docs/PITFALLS.md](docs/PITFALLS.md) 索引只读命中节。`pstack` 仅作编排，用前读 [docs/SKILLS.md](docs/SKILLS.md#pstack-项目适配)。
- **项目约束高于通用技能与 pstack**：§0、官方最佳实践、技术栈与视觉基准、安全、worktree 与授权规则不被覆盖。
- **主会话永远不写代码（硬性）**：任何源码、测试、配置、脚本、迁移的增删改必须派给 Subagent；主会话只做读代码、定契约、派发、审查、合并、跑验证与提交。仅「用户本轮明确要求主会话直接改」或「用户已同意的单行配置修正」例外，并在回复中说明。
- **并行与收尾**：无依赖子任务并行派发，写清文件边界与验收方式；产出只落 worktree，主 checkout 保持干净；交付后按 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §2-7 默认清理本任务 worktree 并快进 main。
- **通配符加引号**：`rg -n PATTERN <path> -g '*.ts'`、`ls` 等路径通配符一律加引号（或用 `find`/`rg --files`），防 zsh 无匹配报错。

## 智能体运行底座

- **Claude Agent SDK / Claude Code 先查官方再动手（硬性）。** 选项、默认行为、环境变量与文件约定须核对 https://code.claude.com/docs 与已安装的 `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`，不一致以官方为准；原生能力（memory、plugins、hooks、session resume、skill 目录等）不另造等价实现。
- 统一用 `@anthropic-ai/claude-agent-sdk`，不引入第二套 Harness 或编排循环（Dify/LangGraph/n8n 仅作对标，测试适配器不扩散到业务代码）；文件工作区接入状态见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)「官方文件能力与接入状态」。更换栈时迁移调用方并删旧依赖。

## 后端

- **运行时与包管理统一 Bun**（`bun install --frozen-lockfile`、`bun run <script>`、`bun scripts/*.mjs`，不新增 pnpm/npm 用法）。**Node.js 与 `@types/node` 永久锁定 24.x**（忽略 `bun outdated` 的 26+ 提示），承接镜像基座与第三方 CLI。
- 路由、oRPC 契约、`access` 与错误见 [packages/api/AGENTS.md](packages/api/AGENTS.md) 与 [docs/VALIDATION.md](docs/VALIDATION.md)；DB schema/迁移/TypeID 见 [packages/db/AGENTS.md](packages/db/AGENTS.md) 与 [ID 约定](docs/PROJECT-BRIEF.md#162-id-约定)。

## 测试

- 门禁策略见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §5（不装钩子、不阻塞）；TDD 仅作参考不强制。
- 后端：`bun run test`（`bun:test`，隔离随机 PG 与临时 Redis，见 [docs/OPERATIONS.md](docs/OPERATIONS.md)）；前端：`bun run test:web`（Vitest）；E2E：`e2e`（`e2e` + `@e2e-dev/web`），共享登录走 `test.setup` + session。

## 技能与插件维护

增删改本项目技能/插件先按 [docs/SKILLS.md](docs/SKILLS.md) 执行，版本锁定在 `skills-lock.json`。

## 交付

- 提交、推送、PR、合并授权、本地 CI（`bun run ci` / `ci:e2e`，无 GitHub CI，合并不等 CI）与收尾见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §2-6、§2-7、§5。
- 每个能力附可执行验证命令与真实输出；UI 改动按 [packages/web/AGENTS.md](packages/web/AGENTS.md#ui-验收硬性) 做真实渲染与多视口长图验收；并发/安全改动附测试或实测记录。
- 代码与文档冲突时以代码为准并修文档，最终回复列出冲突点；待决策项记入 `docs/DECISIONS-PENDING.md`。

## 规则与执行手段

按「先架构、再类型、再 Lint/CI、再测试、最后文档」维护；每次纠偏补齐机械执行入口，机械规则统一进自动检查。完整总表见 [docs/DEV-WORKFLOW.md §7](docs/DEV-WORKFLOW.md#7-规则与机械执行手段总表)。
