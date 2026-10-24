# 文档索引

> `docs/` 下所有文档的入口。找文档先看这里，不必猜文件名。

## 核心规范

| 文档 | 用途 |
|---|---|
| [DEV-WORKFLOW.md](DEV-WORKFLOW.md) | **研发流程规范**：文档体系、任务生命周期、任务记录模板、踩坑流程、门禁策略 |
| [PITFALLS.md](PITFALLS.md) | 跨任务踩坑汇总（现象 → 原因 → 规避），开工前/报错时读 |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) | 设计系统：颜色、字号、间距、组件、焦点与边框、信息表达规约 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术栈、目录结构、数据流、官方文件能力与接入状态 |
| [VALIDATION.md](VALIDATION.md) | Fastify × Zod 校验约定、错误返回形状 |
| [ERRORS.md](ERRORS.md) | 异常分层设计：业务异常 / Problem JSON / RunFailure / 进程守卫 |
| [SECURITY.md](SECURITY.md) | 安全模型与已知风险（含 Docker socket、M- 编号事项） |
| [DECISIONS-PENDING.md](DECISIONS-PENDING.md) | 待决策与已决策事项（D- 编号） |
| [OPERATIONS.md](OPERATIONS.md) | 部署、备份恢复、维护任务、故障排查、观测入口、压测 |
| [RUNBOOK.md](RUNBOOK.md) | 故障处置手册 |
| [FIRST-RUN.md](FIRST-RUN.md) | 首次跑起来的步骤 |
| [SKILLS.md](SKILLS.md) | 已装技能清单与用途 |
| `tasks/<slug>.md` | 单个任务的执行记录（按 `DEV-WORKFLOW.md` 模板创建，目前无任务时为空的约定目录） |

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

[IMPL-CONTRACTS.md](IMPL-CONTRACTS.md)、[EFFECT.md](EFFECT.md)、[BASE-FIRST.md](BASE-FIRST.md)、[BASE-UI-REVIEW.md](BASE-UI-REVIEW.md)、[STACK-COMPLIANCE-LOOP.md](STACK-COMPLIANCE-LOOP.md)、[UI-REDESIGN.md](UI-REDESIGN.md)、[UI-UX-REVIEW.md](UI-UX-REVIEW.md)、[UI-LAYOUT-REVIEW.md](UI-LAYOUT-REVIEW.md)、[SUBAGENTS-VERIFICATION.md](SUBAGENTS-VERIFICATION.md)
