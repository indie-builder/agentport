# 文档索引

> `docs/` 下所有文档的入口。找文档先看这里，不必猜文件名。

## 核心规范

| 文档 | 用途 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | 根规则与模块规则入口（各包专属规则见其「模块规则」表） |
| [DEV-WORKFLOW.md](DEV-WORKFLOW.md) | **研发流程规范**：文档体系、任务生命周期、任务跟踪与按需恢复、踩坑流程、门禁策略 |
| [PITFALLS.md](PITFALLS.md) | 跨任务踩坑汇总（现象 → 原因 → 规避），开工前/报错时读 |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) | 工程规约：布局契约、组件交互与无障碍、异步状态、信息表达、动效、技术栈、禁止项（视觉数值以 `packages/web/DESIGN.md` 为准） |
| [`../packages/web/DESIGN.md`](../packages/web/DESIGN.md) | 视觉与组件外观权威（impeccable，frontmatter tokens）；sidecar 为 [`../packages/web/.impeccable/design.json`](../packages/web/.impeccable/design.json) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术栈、目录结构、数据流、官方文件能力与接入状态 |
| [VALIDATION.md](VALIDATION.md) | oRPC 契约与原生 HTTP 边界的校验约定、错误返回形状 |
| [ERRORS.md](ERRORS.md) | 异常分层设计：业务异常 / Problem JSON / RunFailure / 进程守卫 |
| [SECURITY.md](SECURITY.md) | 安全模型与已知风险（含 Docker socket、M- 编号事项） |
| [DECISIONS-PENDING.md](DECISIONS-PENDING.md) | 待决策与已决策事项（D- 编号） |
| [OPERATIONS.md](OPERATIONS.md) | 部署、备份恢复、维护任务、故障排查、观测入口、压测 |
| [RUNBOOK.md](RUNBOOK.md) | 故障处置手册 |
| [FIRST-RUN.md](FIRST-RUN.md) | 历史首次部署实测记录（pnpm 时代；现行步骤见 [README](../README.md) / [OPERATIONS](OPERATIONS.md)） |
| [SKILLS.md](SKILLS.md) | 项目适配、技能与插件更新 SOP |
| [OPENUI-UPGRADE.md](OPENUI-UPGRADE.md) | OpenUI 组件契约、官方 spec 生成与升级行为回归 |
| [OPENUI-UI-ADAPTATION.md](OPENUI-UI-ADAPTATION.md) | 官方 shadcn UI 来源、Base UI 适配边界与项目令牌映射 |

## 仓库根文档

| 文档 | 用途 |
|---|---|
| [`../README.md`](../README.md) | 项目说明与快速开始 |
| [`../PRODUCT.md`](../PRODUCT.md) | 产品定义 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本与变更记录 |
| [`../DELIVERY.md`](../DELIVERY.md) | 交付说明 |
| [`../MIGRATION.md`](../MIGRATION.md) | 迁移说明 |

## 规划与历史

| 文档 | 用途 |
|---|---|
| [PROJECT-BRIEF.md](PROJECT-BRIEF.md) | 项目全景：目标、需求、技术栈、里程碑 |
| [USER-STORIES.md](USER-STORIES.md) | 用户故事与验收 |
| [REMAINING-TODOS.md](REMAINING-TODOS.md) | 当前项目级待办（唯一待办来源） |
| [CAPABILITY-GAP.md](CAPABILITY-GAP.md) | 能力差距分析 |
| [research/channel-architecture-review-2026-11-08.md](research/channel-architecture-review-2026-11-08.md) | 频道实现、Claude Agent SDK 基座与多智能体协作模式的只读调研与交接清单 |
| [HANDOFF.md](HANDOFF.md) | 某时间点的状态快照 |
| [CHANGELOG.md](CHANGELOG.md) | 转指仓库根 `../CHANGELOG.md` |

## 历史评审（只读参考，非当前契约）

> 下列文档保留当时的评审与约定，不再约束当前代码；当前结构与契约以 [ARCHITECTURE.md](ARCHITECTURE.md) 和现有代码为准，`tasks/` 下文档仅作历史参考。

[IMPL-CONTRACTS.md](IMPL-CONTRACTS.md)、[EFFECT.md](EFFECT.md)、[BASE-FIRST.md](BASE-FIRST.md)、[BASE-UI-REVIEW.md](BASE-UI-REVIEW.md)、[STACK-COMPLIANCE-LOOP.md](STACK-COMPLIANCE-LOOP.md)、[UI-REDESIGN.md](UI-REDESIGN.md)、[UI-UX-REVIEW.md](UI-UX-REVIEW.md)、[UI-LAYOUT-REVIEW.md](UI-LAYOUT-REVIEW.md)、[SUBAGENTS-VERIFICATION.md](SUBAGENTS-VERIFICATION.md)
