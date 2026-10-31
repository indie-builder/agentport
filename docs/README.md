# 文档索引

> `docs/` 下所有文档的入口。找文档先看这里，不必猜文件名。

## 核心规范

| 文档 | 用途 |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | 根规则与模块规则入口（各包专属规则见其「模块规则」表） |
| [DEV-WORKFLOW.md](DEV-WORKFLOW.md) | **研发流程规范**：文档体系、任务生命周期、任务记录模板、踩坑流程、门禁策略 |
| [PITFALLS.md](PITFALLS.md) | 跨任务踩坑汇总（现象 → 原因 → 规避），开工前/报错时读 |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) | 设计系统：颜色、字号、间距、组件、焦点与边框、信息表达规约 |
| [`../packages/web/DESIGN.md`](../packages/web/DESIGN.md) | 前端实现产物设计快照；sidecar 为 [`../packages/web/.impeccable/design.json`](../packages/web/.impeccable/design.json) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术栈、目录结构、数据流、官方文件能力与接入状态 |
| [VALIDATION.md](VALIDATION.md) | Fastify × Zod 校验约定、错误返回形状 |
| [ERRORS.md](ERRORS.md) | 异常分层设计：业务异常 / Problem JSON / RunFailure / 进程守卫 |
| [SECURITY.md](SECURITY.md) | 安全模型与已知风险（含 Docker socket、M- 编号事项） |
| [DECISIONS-PENDING.md](DECISIONS-PENDING.md) | 待决策与已决策事项（D- 编号） |
| [OPERATIONS.md](OPERATIONS.md) | 部署、备份恢复、维护任务、故障排查、观测入口、压测 |
| [RUNBOOK.md](RUNBOOK.md) | 故障处置手册 |
| [FIRST-RUN.md](FIRST-RUN.md) | 首次跑起来的步骤 |
| [SKILLS.md](SKILLS.md) | 已装技能清单、项目适配、技能与插件更新 SOP |
| [tasks/knowledge-runtime-verification.md](tasks/knowledge-runtime-verification.md) | 知识库真实运行验证记录（已操作、未验收、工具限制） |
| [tasks/knowledge-review-findings.md](tasks/knowledge-review-findings.md) | 知识实现独立审查发现与整改范围 |
| [tasks/knowledge-implementation.md](tasks/knowledge-implementation.md) | 知识实施进度、测试与部署配置记录 |
| [tasks/knowledge-implementation-contract.md](tasks/knowledge-implementation-contract.md) | 知识实现契约：表、接口、模块与执行包 |
| [tasks/memory-upgrade.md](tasks/memory-upgrade.md) | 记忆主题升级任务记录（验证及独立评审通过，本任务 PR 交付，合并状态以 GitHub 为准） |
| [tasks/memory-upgrade-contract.md](tasks/memory-upgrade-contract.md) | 记忆主题升级执行契约：目标、快照、账本与验收 |
| [tasks/memory-upgrade-research.md](tasks/memory-upgrade-research.md) | 腾讯记忆能力研究与本仓现状映射（证据报告） |
| [tasks/runtime-environment-config.md](tasks/runtime-environment-config.md) | 运行环境能力：命名环境、构建版本、线上指针与专家绑定 |
| [tasks/runtime-environment-contract.md](tasks/runtime-environment-contract.md) | 运行环境 DB/shared 共享契约与方法签名 |
| [tasks/runtime-environment-probe-contract.md](tasks/runtime-environment-probe-contract.md) | stdio 试连的环境身份、jsonb 字段与读写行为 |
| [tasks/enable-agent-bash.md](tasks/enable-agent-bash.md) | 恢复智能体 Bash 能力的调查、权限契约与验收 |
| [OPENUI-UPGRADE.md](OPENUI-UPGRADE.md) | OpenUI 组件契约、官方 spec 生成与升级行为回归 |
| [OPENUI-UI-ADAPTATION.md](OPENUI-UI-ADAPTATION.md) | 官方 shadcn UI 来源、Base UI 适配边界与项目令牌映射 |
| `tasks/<slug>.md` | 单个任务的执行记录与当轮接口契约（按 `DEV-WORKFLOW.md` 模板创建） |

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
| [HANDOFF.md](HANDOFF.md) | 某时间点的状态快照 |
| [CHANGELOG.md](CHANGELOG.md) | 转指仓库根 `../CHANGELOG.md` |

## 历史评审（只读参考，非当前契约）

> 下列文档保留当时的评审与约定，不再约束当前代码；当前结构与契约以 [ARCHITECTURE.md](ARCHITECTURE.md) 和当轮 `tasks/<slug>.md` 为准。

[IMPL-CONTRACTS.md](IMPL-CONTRACTS.md)、[EFFECT.md](EFFECT.md)、[BASE-FIRST.md](BASE-FIRST.md)、[BASE-UI-REVIEW.md](BASE-UI-REVIEW.md)、[STACK-COMPLIANCE-LOOP.md](STACK-COMPLIANCE-LOOP.md)、[UI-REDESIGN.md](UI-REDESIGN.md)、[UI-UX-REVIEW.md](UI-UX-REVIEW.md)、[UI-LAYOUT-REVIEW.md](UI-LAYOUT-REVIEW.md)、[SUBAGENTS-VERIFICATION.md](SUBAGENTS-VERIFICATION.md)
