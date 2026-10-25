# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。
>
> 对本仓库的所有回复、总结、提交说明都用中文；代码、命令、标识符、路径保持原样。
>
> 文档入口见 [docs/README.md](docs/README.md)；研发流程规范见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)；跨任务踩坑见 [docs/PITFALLS.md](docs/PITFALLS.md)，开工前或报错时先读。

## 0. 第一性原则：文件系统即智能体定义（最高约束）

**智能体平台的全部定义，都用 Claude Agent SDK / Claude Code 官方那套文件系统来表达。** 一个智能体 = 一个 `.claude/` 目录（`.mcp.json`、`CLAUDE.md`、`.claude/skills/<name>/SKILL.md`、`.claude/agents/*.md`、`.claude/settings.json`、hooks、以及官方支持的其他文件）下的文件集合；平台只负责**把这些文件渲染到工作区、只读挂载进沙盒、交给 SDK 加载**，不再另造一套 JSON 定义格式或数据库专属结构去替代它。

由此派生（必须遵守）：

1. **文件是唯一投影，DB 是编辑来源。** 界面上的一切编辑都最终落成官方文件；判断"平台是否支持某能力"以"能否生成并加载对应官方文件、并被 SDK 真正加载/调用"为准，而非界面上是否有个开关。
2. **只用官方文件约定。** 目录名、文件名、frontmatter 字段（`SKILL.md` 大小写、`.claude/agents/*.md`、`.claude/settings.json` 的 hooks/permissions/env、`.claude/agent-memory/`、插件根 `.claude-plugin/plugin.json` 等）一律照官方文档，不自创目录或字段。范围见 `docs/ARCHITECTURE.md`「官方文件能力与接入状态」。
3. **能力扩展 = 补齐文件能力。** 新增功能优先想"这是官方文件系统的哪个文件/目录能力"，把它做成"可编辑 + 可渲染 + 可加载 + 可导出"的闭环，而不是新增一张表配一套私有语义。
4. **可移植。** 一个智能体目录能原样导出、导入、跨平台复用（`.claude/` 目录本身就是交付物）。

> 依据：用户明确该项目基本原则——「用 Claude Agent SDK，通过文件系统的方式来构建智能体；每个智能体就是把定义好的 `.claude` 目录下所有文件，用 Claude Code 官方那套文件系统定义方式来做」。

## 优先级（冲突时自上而下裁决）

0. **官方最佳实践优先。** 项目引用的每个技术栈（shadcn/ui、Base UI、Tailwind、TanStack、Drizzle、Fastify、Vitest…）如果官方文档给出了做法，**以官方为准**。用户的口头偏好、我的判断、项目历史习惯，都不高于官方文档。用户明确说过「我可能说的也不对」——遇到分歧先去查官方文档，再决定。
1. **并行优先。** 任何可拆的工作都必须并行；串行只在存在真实依赖时允许，并且必须说明依赖是什么。
2. **UI 基准优先。** 视觉一律以 https://www.openui.com/chat?form_factor=desktop 与 `docs/DESIGN-SYSTEM.md` 为准；任何技术选型、库默认样式、动效偏好都不得改动这套视觉数值。
3. **技术栈优先。** 功能实现必须走项目已选定的库（shadcn/ui、lucide、Motion、react-resizable-panels、dnd-kit、Zustand、TanStack Query/Router、Base UI），不允许手写等价实现。
4. **零死代码。** 无人引用的组件、导出、样式、依赖、注释掉的代码块一律删除；不保留「以后可能用」的占位实现。删之前用 grep 确认引用，删之后跑 typecheck / 构建确认没断。注释只解释「代码看不出来的原因」，不写复述代码的废话。
5. 其余按本文件后续条款执行。

## 决策标准

- **三赢：UX / DX / AX 同时提升。** 任何设计或技术决策，都要选能同时提升**用户体验（UX）、开发者体验（DX）、智能体体验（AX）**且不牺牲其一换另一个的最优解，并且**不破坏任何现有功能**（"Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything."）。逐条问「这对 UX / DX / AX 各是加分还是减分」，若某方案提升一个却伤害另一个，继续找更优解。
- **个人项目不考虑向后兼容。** 永远按当前最佳实践设计，不为旧数据、旧格式、旧接口保留兼容层、迁移分支或双写路径；字段、表结构、接口可以直接改到最干净的样子，旧数据不迁移、不做兜底。需要重置时直接重建库或用脚本一次性重灌。判断「要不要兼容」的答案默认是否。
- **不为理论风险加防护。** 加代码防假设性的竞态条件或安全边界之前，先用「10 岁小孩能听懂」的话说明三件事并**等用户明确同意**：① 到底会出什么问题；② 这有多大概率发生；③ 多加的代码带来多少复杂度。不得悄悄扩大范围去防只存在于理论中的问题（"Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness."）。真实可发生的边界（信任边界校验、防数据丢失、安全、无障碍）不在其列，照常做。
- **入口校验一次。** 外部数据在入口信任边界完成校验，内部使用校验后确定的类型，不逐层重复校验或判断。后端入口沿用下文 Fastify schema 规则。
- **单次逻辑就地写。** 仅使用一次的逻辑直接写在使用处；只有会复用或封装真正复杂逻辑时才提取抽象。
- **保持直接控制流。** 能用一个清晰函数完成就不拆分；仅在需要恢复、清理或转换错误时使用 `try/catch`，其余错误交由现有统一机制处理。保留必要错误处理，不吞错。

## 能力选型（硬性：先看现有 → 原生 → 开源 → 最后才自研）

新增或改进任何功能/能力项前，必须按这个顺序调研，**不允许「缺什么就直接上手实现」**：

0. **先看现有项目有没有。** 先 grep / 读代码确认本仓库是否已有该功能或近似能力。有 → 优先复用或整合；即使不整合，也要**针对现有这块功能按最佳实践改造**，而不是并排再造一份。
1. **再看原生能力。** 平台底座（Claude Agent SDK / Claude Code）、已选技术栈或已装依赖，官方是否已提供该能力？有就评估它能否很好地适配现有诉求。
2. **能适配就用原生。** 官方能力满足诉求时一律用原生，以**最小代价**实现，不自造平台侧等价实现、不引入第二套。
3. **原生不适配，才找热门开源方案。** 到 GitHub 找成熟、活跃、许可合规的开源实现（看 star / 维护活跃度 / 许可证 / SDK 契合度），仍以**最小代价**落地，记录候选与取舍理由。
4. **只有以上都不行，才自研**，并在 PR/文档说明为什么现有、原生、开源都不适用。

> 依据：用户明确要求——功能探索时先看现有项目有没有、有就整合或按最佳实践改造；没有再看原生能力、以最小代价实现；最后才考虑引入开源或自研。

## 协作方式

- **默认执行模式：先 Opus 探索/设计，再拆多个 Sonnet 子代理并行执行**（不需要用户每次交代）。子代理只做执行；设计/评审/审计用 Opus；主会话只定共享契约、派发、合并、按改动范围验证与提交，不亲自写实现代码（极小共享契约片段除外）。
- **代码写完后先经 Opus 子代理 code review 再提交**；review 未过不提交。
- 能拆成互不依赖的子任务就并行，不要串行做完一个再下一个；每个子代理要有明确产出边界（改哪些文件、不改哪些文件）与验收方式。
- 模型选择遵循 `pstack-models.md` 的 per-role 配置，不为并行而降低判断质量。
- **完整研发流程（含建树、配置与启动规则）、review 轮次做法、验证与撤销规则统一见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md)**；开工前读 [docs/PITFALLS.md](docs/PITFALLS.md)，踩坑记入该文件不散落。产出只落在 worktree，主 checkout 保持干净。

## 智能体运行底座

- **Claude Agent SDK / Claude Code 相关内容，一律先查官方文档再动手（硬性规则）。** 涉及 SDK 的选项、能力、默认行为、环境变量、文件与目录约定时，不得凭记忆或猜测下结论，必须先核对 https://code.claude.com/docs 与已安装的 `@anthropic-ai/claude-agent-sdk` 类型定义（`sdk.d.ts`）；官方与本地实现不一致时以官方文档为准。能用官方原生能力（如 memory、plugins、hooks、session resume、skill 目录）解决的，不另造平台侧等价实现。
- 智能体运行统一使用官方 `@anthropic-ai/claude-agent-sdk`。新增工具、会话、子智能体和审批能力先核对 SDK 官方接口，再用项目已有栈补齐平台部分。**选型顺序见上文「能力选型（硬性）」：原生优先，其次 GitHub 热门开源，最后才自研。**
- 文件工作区是平台的核心交互契约；目录、字段及加载方式按 Claude Agent SDK/Claude Code 官方文档与已安装版本维护，完整能力与接入状态统一见 `docs/ARCHITECTURE.md`「官方文件能力与接入状态」。界面与存储围绕官方文件提供编辑、导入导出和沙盒执行，不以手列的少数目录作为能力上限，也不另造独立运行定义格式。
- AI Harness 只保留 Claude Agent SDK 一套；Dify、LangGraph、n8n 等用于产品能力对标，不引入第二套智能体执行循环或编排底座。测试工具的模型适配器不作为产品运行底座，也不扩散到业务代码。
- 有价值的功能可以引入额外技术栈：先核对现有依赖，按能力选择一种实现；更换同类技术时完成调用方迁移与旧依赖清理，避免长期并存多套等价实现。

## 前端

- **一切视觉以 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) 为准**，设计基准是 https://www.openui.com/chat?form_factor=desktop。无彩度（黑白灰 + 透明度）、1px 线与留白、lucide 图标 `strokeWidth={1.75}` 16px、焦点/边框统一（§9）、信息表达「让布局解释结构」（§10，做 UI 前后逐条过）。
- **布局优先。** "Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout." 删掉标语、用于解释结构的辅助文案和重复的次级标签；若界面要靠这些文字才看得懂，先改分组/对齐/间距/层级，而不是加字。表单字段标签、约束提示、错误、风险与无障碍说明仍按 [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) §10 保留。
- **组件库只用 shadcn/ui**（`components.json` 已配；`pnpm dlx shadcn@latest add <name>` 后可改源码 token）；交互原语只用 Base UI（`@base-ui/react`），Radix 已移除不再引入；样式只用 Tailwind 4，颜色/间距/字体/圆角只从 `styles.css` 的 `@theme` token 取，禁止硬编码 hex。先看 `components/ui/` 有无可复用再新增。
- 页面骨架统一用 `components/page.tsx`（`Page`/`PageHeader`/`PageToolbar`/`PageSection`），每个渲染状态恰好一个 `h1`；不写页面级 `mt-*`/`mb-*`。
- 机械检查命令与门禁策略见 [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) §5（不装钩子、不阻塞）。

## 后端

- **Fastify × Zod：schema 即校验。** 每个路由用 `schema: { body, params, querystring }` 声明，
  handler 直接使用 `request.body` 等（类型由 zod 推导）；**禁止在 handler 里写 `safeParse`**。
  路由文件开头用 `const app = typed(rawApp)` 获得类型化实例。
- 校验失败由 `plugins/errors.ts` 统一返回 `{ code:'INVALID_INPUT', message, requestId, path? }`；
  业务规则冲突（409/404）仍在 handler 内显式返回。详见 `docs/VALIDATION.md`。
- 所有 `/api/*` 路由除明确公开项外必须挂 `requireAuth`。
- schema 变更后必须 `pnpm db:generate` + `pnpm db:migrate`，并同步 `docs/` 中的相关说明。
- **业务实体 ID：** 常规业务实体主键统一通过 `@agentport/db` 的 `newId(entity)` 在应用层生成 TypeID；UI 实体列表复用实体主键作为行标识，关联表、认证、幂等派生标识、外部资源及其他 UI 行标识按 [ID 约定](docs/PROJECT-BRIEF.md#162-id-约定) 处理。

## 测试

- E2E 统一使用 `e2e`（`e2e` + `@e2e-dev/web`）。Playwright 已退役，不再新增其用例。
- 登录等共享前置用 `test.setup` + session，不要在每条用例里重复登录。
- 单元/集成测试用 Vitest；测试的 Redis 固定走 db 9，与开发 worker（db 0）隔离，默认不需要停 worker（见 `docs/OPERATIONS.md`）。

## 技能与插件维护

新增、更新或删除本项目技能/插件前，先按 [docs/SKILLS.md](docs/SKILLS.md) 执行；已安装技能清单与用途见该文，版本锁定在 `skills-lock.json`。

## 交付

- 只有用户在本任务明确授权时才 commit/push/merge；未授权时以「验证完成、未提交差异」交付，并说明成果是否已合入。CI 只手动触发；按改动范围本地验证，不固定跑全套。用户要求提交/合并时不等待 CI、不自动开启 PR 监控或冷却等待；仅在用户明确要求时监控。发布工作流独立保留。
- 每个能力都要有可执行的验证命令与真实结果，不以「应该能跑」代替。
- 并发/安全相关改动必须附测试或实测记录。
- 文档与现有代码存在冲突时，遵循代码的实际实现并修正文档；在最终回复中列出本任务发现的所有冲突点。待决策项记录在 `docs/DECISIONS-PENDING.md`。
