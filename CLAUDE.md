# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。
>
> 对本仓库的所有回复、总结、提交说明都用中文；代码、命令、标识符、路径保持原样。
>
> 文档入口见 [docs/README.md](docs/README.md)；研发流程规范见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)；跨任务踩坑见 [docs/PITFALLS.md](docs/PITFALLS.md)，开工前或报错时先读。各包专属规则见「模块规则」。

## 0. 第一性原则：文件系统即智能体定义（最高约束）

**智能体平台的全部定义，都用 Claude Agent SDK / Claude Code 官方那套文件系统来表达。** 一个智能体 = 一个 `.claude/` 目录（`.mcp.json`、`CLAUDE.md`、`.claude/skills/<name>/SKILL.md`、`.claude/agents/*.md`、`.claude/settings.json`、hooks、以及官方支持的其他文件）下的文件集合；平台只负责**把这些文件渲染到工作区、只读挂载进沙盒、交给 SDK 加载**，不再另造一套 JSON 定义格式或数据库专属结构去替代它。

由此派生（必须遵守）：

1. **文件是唯一投影，DB 是编辑来源。** 界面上的一切编辑都最终落成官方文件；判断"平台是否支持某能力"以"能否生成并加载对应官方文件、并被 SDK 真正加载/调用"为准，而非界面上是否有个开关。
2. **只用官方文件约定。** 目录名、文件名、frontmatter 字段（`SKILL.md` 大小写、`.claude/agents/*.md`、`.claude/settings.json` 的 hooks/permissions/env、`.claude/agent-memory/`、插件根 `.claude-plugin/plugin.json` 等）一律照官方文档，不自创目录或字段。范围见 `docs/ARCHITECTURE.md`「官方文件能力与接入状态」。
3. **能力扩展 = 补齐文件能力。** 新增功能优先想"这是官方文件系统的哪个文件/目录能力"，把它做成"可编辑 + 可渲染 + 可加载 + 可导出"的闭环，而不是新增一张表配一套私有语义。
4. **可移植。** 一个智能体目录能原样导出、导入、跨平台复用（`.claude/` 目录本身就是交付物）。

> 依据：用户明确该项目基本原则——「用 Claude Agent SDK，通过文件系统的方式来构建智能体；每个智能体就是把定义好的 `.claude` 目录下所有文件，用 Claude Code 官方那套文件系统定义方式来做」。

## 优先级（冲突时自上而下裁决）

0. **官方最佳实践优先。** 项目引用的每个技术栈（shadcn/ui、Base UI、Tailwind、TanStack、Drizzle、Fastify、Vitest…）如果官方文档给出了做法，**以官方为准**。用户的口头偏好、我的判断、项目历史习惯，都不高于官方文档。用户明确说过「我可能说的也不对」——遇到分歧先去查官方文档，再决定；涉及 Claude Agent SDK / Claude Code 时同时核对已安装的 `sdk.d.ts`（见「智能体运行底座」）。
1. **并行优先。** 任何可拆的工作都必须并行；串行只在存在真实依赖时允许，并且必须说明依赖是什么。
2. **UI 基准优先。** 视觉外观（配色、控件外观与状态）以 Qoder CN 桌面浅色界面为准；布局几何、颜色数值与信息表达以 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) 当前规范为准（含 2026-10-30 用户批准的布局契约），OpenUI 桌面基准仅保留为历史参考；任何技术选型、库默认样式、动效偏好都不得改动这套视觉数值。前端实现细节见 [packages/web/CLAUDE.md](packages/web/CLAUDE.md)。
3. **技术栈优先。** 功能实现必须走项目已选定的库与官方原生能力（shadcn/ui、Base UI、Tailwind、TanStack、Drizzle、Fastify、Vitest 等），不允许手写等价实现；具体栈、包职责与用法见各模块规则与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
4. **零死代码。** 无人引用的组件、导出、样式、依赖、注释掉的代码块一律删除；不保留「以后可能用」的占位实现。删之前用 grep 确认引用，删之后跑 typecheck / 构建确认没断。注释只解释「代码看不出来的原因」，不写复述代码的废话。**但用户明确要求保留的元素/入口不属于死代码，不得删除；受保护清单见各模块 `CLAUDE.md` 与 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)。**
5. 其余按本文件后续条款执行。

## 决策标准

- **三赢：UX / DX / AX 同时提升。** 任何设计或技术决策，都要选能同时提升**用户体验（UX）、开发者体验（DX）、智能体体验（AX）**且不牺牲其一换另一个的最优解，并且**不破坏任何现有功能**（"Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything."）。逐条问「这对 UX / DX / AX 各是加分还是减分」，若某方案提升一个却伤害另一个，继续找更优解。
- **个人项目不考虑向后兼容。** 永远按当前最佳实践设计，不为旧数据、旧格式、旧接口保留兼容层、迁移分支或双写路径；字段、表结构、接口可以直接改到最干净的样子，旧数据不迁移、不做兜底。需要重置时直接重建库或用脚本一次性重灌。判断「要不要兼容」的答案默认是否。
- **不为理论风险加防护。** 加代码防假设性的竞态条件或安全边界之前，先用「10 岁小孩能听懂」的话说明三件事并**等用户明确同意**：① 到底会出什么问题；② 这有多大概率发生；③ 多加的代码带来多少复杂度。不得悄悄扩大范围去防只存在于理论中的问题（"Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness."）。真实可发生的边界（信任边界校验、防数据丢失、安全、无障碍）不在其列，照常做。
- **入口校验一次。** 外部数据在入口信任边界完成校验，内部使用校验后确定的类型，不逐层重复校验或判断。后端入口按 [packages/api/CLAUDE.md](packages/api/CLAUDE.md) 的 Fastify schema 规则执行。
- **单次逻辑就地写。** 仅使用一次的逻辑直接写在使用处；只有会复用或封装真正复杂逻辑时才提取抽象。
- **保持直接控制流。** 能用一个清晰函数完成就不拆分；仅在需要恢复、清理或转换错误时使用 `try/catch`，其余错误交由现有统一机制处理。保留必要错误处理，不吞错。

## 能力选型（硬性：先看现有 → 原生/已装依赖 → 主流开源 → 最后才自研）

新增或改进任何能力前，先说明要解决的实际问题与缺口；没有真实问题不加能力、不换栈。调研顺序：

0. **先看现有项目有没有，先找同类入口。** 新增能力前先 grep / 读代码，定位本仓库已有的同类入口、组件、服务或封装；有 → 优先复用、整合或在其上扩展；即使不整合，也要**针对现有这块功能按最佳实践改造**，而不是并排再造一份。只有确认不存在时才新增。
1. **再看平台原生能力与已装依赖。** Claude Agent SDK / Claude Code、已选技术栈或其他已装依赖官方是否已提供？满足诉求时一律用原生，以**最小代价**实现，不自造平台侧等价实现、不引入第二套。
2. **原生不适配，才找主流开源方案。** 选持续维护、近期有实质稳定发布、生态采用度足够、与现有栈兼容且许可合规的实现，记录查证日期、证据与取舍理由；不单凭 star / 下载量 / 旧版本号判断，也不为追新换栈。
3. **只有以上都不行，才自研**，并在 PR/文档说明为什么现有、原生、开源都不适用。

选型还要过成本与替换检查：默认只用进程内库或开发依赖，不新增独立部署服务、容器、托管 SaaS 或外部账号，既有业务基础设施不受影响；综合直接与传递依赖、生产 bundle、内存、启动、构建与升级维护开销，总收益必须大于成本。引入即替代，删除无人使用的旧实现，同一职责只留一处，并保留原有行为、权限、错误处理与无障碍。性能候选先做有代表性的基准再决定；不新增理论防护（按「决策标准」执行）。

> 依据：用户明确要求——功能探索时先看现有项目有没有、有就整合或按最佳实践改造；没有再看原生能力、以最小代价实现；最后才考虑引入开源或自研。

## 复用与职责边界

- **通用机制归库/封装。** 表单、缓存、数据访问、SDK 循环等通用机制由库或共享封装承担；业务模块只保留字段约束、权限、状态转换与冲突规则。
- **不因业务差异重造机制。** 业务差异用配置、数据或模块内规则表达，不另造一套 form / cache / SDK 循环；单个简单字段不引入框架或抽象。

## 模块规则

根规则始终加载；下列包规则在进入对应包、读取/编辑其文件时按需加载。跨包改动先读所有相关模块规则。

| 模块 | 规则文件 | 进入条件 |
|---|---|---|
| 根（始终加载） | `CLAUDE.md` | 所有任务 |
| `web` | [packages/web/CLAUDE.md](packages/web/CLAUDE.md) | 页面、组件、样式、路由、前端状态与 DESIGN-SYSTEM 实现 |
| `api` | [packages/api/CLAUDE.md](packages/api/CLAUDE.md) | 路由、校验、鉴权、错误、SSE、队列生产 |
| `worker` | [packages/worker/CLAUDE.md](packages/worker/CLAUDE.md) | 队列消费、会话工作区渲染、沙盒生命周期、事件回传 |
| `core` | [packages/core/CLAUDE.md](packages/core/CLAUDE.md) | 工作区渲染、密钥加解密、MCP 条目、领域纯函数 |
| `db` | [packages/db/CLAUDE.md](packages/db/CLAUDE.md) | Drizzle schema、repo、迁移、TypeID 生成 |
| `shared` | [packages/shared/CLAUDE.md](packages/shared/CLAUDE.md) | zod 契约、共享类型、事件与任务 payload |
| `sandbox` | [packages/sandbox/CLAUDE.md](packages/sandbox/CLAUDE.md) | 容器内 supervisor、runner、沙盒镜像边界 |

- Claude Code 启动时加载根与祖先目录规则；进入子目录读取、写入或编辑文件时才按需加载该目录 `CLAUDE.md`。多份规则顺序拼接、不互相覆盖；子规则不重述或覆盖根约束。
- 根用普通链接指向模块规则，不加 `@import`，避免每次会话把所有包规则整体载入；每个规则文件目标少于 200 行。
- 改根目录 `scripts/`、`tests/`、`Dockerfile`、compose、根 `package.json` 等文件，先读它所服务模块的规则。
- 派子代理时在任务里写明目标模块规则路径；review 检查改动是否遵循对应模块规则，规则放错层时先调整归属再改代码。

## 协作方式

- **工程纪律走 ub-mode。** 写改代码前主动加载 `ub-mode` 技能，不需要用户每次输入 `/ub-mode`；阶段划分与要求见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §2-4。`pstack` 只负责模型/任务/并行/独立 review 编排，工程行为按 ub。与其它通用工程技能（含 ponytail、TDD）在同一工程行为上冲突时，以本项目采用的 ub 纪律为准；TDD 技能即使 description 命中或正文已加载，也只作红/绿操作参考：不要求例外逐次审批、不因已有实现而机械删除重来、不默认固定全套测试。能写诚实的行为测试就先红后绿，否则用能证明目标的证据并记录原因与限制。
- **项目专属约束照旧高于通用技能。** 本文件的文件系统第一性（§0）、官方最佳实践、技术栈与视觉基准、安全、worktree 与授权规则不因 ub/pstack 或其它技能而改变。
- **默认执行模式：按任务性质分配模型，每次派发显式指定模型与 effort（用户当轮明确指定优先）**（不需要用户每次交代）。Sonnet 负责常规探索、事实检索与解释、常规审计、按需的初审与风格一致性 review、方案已明确的机械重构，以及方案确定后的源码、测试、配置、脚本执行；Opus 负责设计、规划与关键契约、复杂重构、架构/安全/并发/权限/数据丢失判断，以及提交前的独立最终 review。常规事实检索用 `medium` effort，其余用 `high`；Sonnet 执行中遇到需要上述判断的问题，先交 Opus 确定方案再继续，不得把判断伪装成执行；主会话模型不变，只定共享契约、派发、合并、按改动范围验证与提交。
- **主会话永远不写代码（硬性）**：任何代码变更动作——新增/修改/删除源码、测试、配置、脚本、迁移文件——都必须派给 Subagent 执行，主会话不亲自编辑。主会话只做：读代码、定契约、派发任务、审查产出、合并、运行验证命令与提交。唯一例外是用户在本轮明确要求主会话直接改，或单行配置修正（如版本号、路径拼写）且用户已同意；这两种情况要在回复里说明为什么没有派发。
- **提交前保留独立 Opus 终审**：Sonnet 初审按需，不固定多加一轮；Opus 终审按固定 diff、契约与验证证据聚焦判断，必要时扩读关联代码，不全量重复探索；后续只复核修复与新增影响。review 未过不提交。
- 能拆成互不依赖的子任务就并行，不要串行做完一个再下一个；每个子代理要有明确产出边界（改哪些文件、不改哪些文件）与验收方式。
- **上述分工优先于个人 `pstack-models.md` 的 per-role 配置与技能默认值；未被上述分工覆盖的角色按 `pstack-models.md` 执行**，不再要求所有判断类任务一律用 Opus；派发时显式指定模型，不为并行而降低判断质量。
- **完整研发流程（含建树、配置与启动规则）、review 轮次做法、验证与撤销规则统一见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)**；每个任务首次写入前、续做同一未完成任务恢复时必读 §2，流程细节不在此复制；开工前读 [docs/PITFALLS.md](docs/PITFALLS.md)，踩坑记入该文件不散落。产出只落在 worktree，主 checkout 保持干净。
- **「收尾工作区」按 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §2-7 执行**：清理本任务已交付的 worktree、退出回主 checkout 并快进更新 main；清理判据与例外都在 §2-7，此处不复制。

## 智能体运行底座

- **Claude Agent SDK / Claude Code 相关内容，一律先查官方文档再动手（硬性规则）。** 涉及 SDK 的选项、能力、默认行为、环境变量、文件与目录约定时，不得凭记忆或猜测下结论，必须先核对 https://code.claude.com/docs 与已安装的 `@anthropic-ai/claude-agent-sdk` 类型定义（`sdk.d.ts`）；官方与本地实现不一致时以官方文档为准。能用官方原生能力（如 memory、plugins、hooks、session resume、skill 目录）解决的，不另造平台侧等价实现。
- 智能体运行统一使用官方 `@anthropic-ai/claude-agent-sdk`。新增工具、会话、子智能体和审批能力先核对 SDK 官方接口，再用项目已有栈补齐平台部分。**选型顺序见上文「能力选型（硬性）」：原生优先，其次 GitHub 热门开源，最后才自研。**
- 文件工作区是平台的核心交互契约；目录、字段及加载方式按 Claude Agent SDK/Claude Code 官方文档与已安装版本维护，完整能力与接入状态统一见 `docs/ARCHITECTURE.md`「官方文件能力与接入状态」。界面与存储围绕官方文件提供编辑、导入导出和沙盒执行，不以手列的少数目录作为能力上限，也不另造独立运行定义格式。
- AI Harness 只保留 Claude Agent SDK 一套；Dify、LangGraph、n8n 等用于产品能力对标，不引入第二套智能体执行循环或编排底座。测试工具的模型适配器不作为产品运行底座，也不扩散到业务代码。
- 有价值的功能可以引入额外技术栈：先核对现有依赖，按能力选择一种实现；更换同类技术时完成调用方迁移与旧依赖清理，避免长期并存多套等价实现。

## 后端

- **路由与入口规则见模块。** Fastify × Zod schema 校验、`requireAuth`、typed app、错误返回形状见 [packages/api/CLAUDE.md](packages/api/CLAUDE.md) 与 [docs/VALIDATION.md](docs/VALIDATION.md)。
- **数据库变更见模块。** Drizzle schema、`pnpm db:generate` + `pnpm db:migrate` 与同步 `docs/` 的要求见 [packages/db/CLAUDE.md](packages/db/CLAUDE.md)。
- **业务实体 ID：** 常规业务实体主键统一使用 TypeID；生成入口与命名空间规则见 [packages/db/CLAUDE.md](packages/db/CLAUDE.md)，完整约定见 [ID 约定](docs/PROJECT-BRIEF.md#162-id-约定)。其他包按该规范使用，不各自实现 ID 生成。

## 测试

- 机械检查命令与门禁策略见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §5（不装钩子、不阻塞）。
- E2E 统一使用 `e2e`（`e2e` + `@e2e-dev/web`），不新增其他 E2E 框架的用例。
- 登录等共享前置用 `test.setup` + session，不要在每条用例里重复登录。
- 单元/集成测试用 Vitest；backend 项目由 globalSetup 每轮创建已迁移的随机 PostgreSQL database 和独享临时 Redis 容器，并在测试模块导入前注入连接串，默认不需要停开发 worker。Docker/PostgreSQL 不可用时依赖对应基础设施的套件跳过，不回落共享库；watch 会话内复用本轮资源并在退出时清理，热重跑不重建（见 `docs/OPERATIONS.md`）。

## 技能与插件维护

新增、更新或删除本项目技能/插件前，先按 [docs/SKILLS.md](docs/SKILLS.md) 执行；已安装技能清单与用途见该文，版本锁定在 `skills-lock.json`。

## 交付

- 只有用户在本任务明确授权时才 commit/push/merge；未授权时以「验证完成、未提交差异」交付，并说明成果是否已合入。CI 只手动触发；按改动范围本地验证，不固定跑全套。用户要求提交/合并时不等待 CI、不自动开启 PR 监控或冷却等待；仅在用户明确要求时监控。发布工作流独立保留。
- 每个能力都要有可执行的验证命令与真实结果，不以「应该能跑」代替。
- 并发/安全相关改动必须附测试或实测记录。
- 文档与现有代码存在冲突时，遵循代码的实际实现并修正文档；在最终回复中列出本任务发现的所有冲突点。待决策项记录在 `docs/DECISIONS-PENDING.md`。
