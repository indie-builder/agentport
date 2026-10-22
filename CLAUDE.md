# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。

## 优先级（冲突时自上而下裁决）

0. **官方最佳实践优先。** 项目引用的每个技术栈（shadcn/ui、Base UI、Tailwind、TanStack、Drizzle、Fastify、Vitest…）如果官方文档给出了做法，**以官方为准**。用户的口头偏好、我的判断、项目历史习惯，都不高于官方文档。用户明确说过「我可能说的也不对」——遇到分歧先去查官方文档，再决定。
1. **并行优先。** 任何可拆的工作都必须并行；串行只在存在真实依赖时允许，并且必须说明依赖是什么。
2. **UI 基准优先。** 视觉一律以 https://www.openui.com/chat?form_factor=desktop 与 `docs/DESIGN-SYSTEM.md` 为准；任何技术选型、库默认样式、动效偏好都不得改动这套视觉数值。
3. **技术栈优先。** 功能实现必须走项目已选定的库（shadcn/ui、lucide、Motion、react-resizable-panels、dnd-kit、Zustand、TanStack Query/Router、Base UI），不允许手写等价实现。
4. **零死代码。** 无人引用的组件、导出、样式、依赖、注释掉的代码块一律删除；不保留「以后可能用」的占位实现。删之前用 grep 确认引用，删之后跑 typecheck / 构建确认没断。注释只解释「代码看不出来的原因」，不写复述代码的废话。
5. 其余按本文件后续条款执行。

## 协作方式

- **任务执行尽量使用多智能体并行。** 只要工作可以拆成互不依赖的子任务（多个页面、多个包、多个独立调研），就派多个子代理并行执行，而不是串行做完一个再做下一个。
- 分工原则：先由主会话确定共享契约（类型、schema、接口签名、设计令牌），再让子代理在各自范围内实现；子代理不互相等待。
- 每个子代理必须有明确的产出边界（改哪些文件、不改哪些文件）与验收方式；主会话负责合并、跑全量校验（typecheck / test / lint / e2e）。
- 只有强依赖或需要连续判断的工作留在主会话；不要把能并行的活串起来做。
- 模型选择遵循 `pstack-models.md` 的 per-role 配置，不为并行而降低判断质量。

## 智能体运行底座

- 智能体运行统一使用官方 `@anthropic-ai/claude-agent-sdk`。新增工具、会话、子智能体和审批能力先核对 SDK 官方接口，再用项目已有栈补齐平台部分。
- 文件工作区是平台的核心交互契约；目录、字段及加载方式按 Claude Agent SDK/Claude Code 官方文档与已安装版本维护，完整能力与接入状态统一见 `docs/ARCHITECTURE.md`「官方文件能力与接入状态」。界面与存储围绕官方文件提供编辑、导入导出和沙盒执行，不以手列的少数目录作为能力上限，也不另造独立运行定义格式。
- AI Harness 只保留 Claude Agent SDK 一套；Dify、LangGraph、n8n 等用于产品能力对标，不引入第二套智能体执行循环或编排底座。测试工具的模型适配器不作为产品运行底座，也不扩散到业务代码。
- 有价值的功能可以引入额外技术栈：先核对现有依赖，按能力选择一种实现；更换同类技术时完成调用方迁移与旧依赖清理，避免长期并存多套等价实现。

## 前端

- **设计基准固定为 https://www.openui.com/chat?form_factor=desktop。** 所有页面、组件、间距、圆角、字号、图标都以它为准，详见 `docs/DESIGN-SYSTEM.md`。改动前先读该文件；不要凭感觉发明视觉。
- **无彩度体系**：黑白灰承担层级，没有品牌色。强调靠实底黑与透明度，不靠色相。
- **结构靠 1px 线与留白。** 一般页面以行组织，资源中心允许约定的卡片网格；尺寸和例外统一查 `docs/DESIGN-SYSTEM.md`。
- **图标统一 lucide，`strokeWidth={1.75}`，16px。**
- **组件库统一使用 shadcn/ui。** `components.json` 已配置，新增组件用 `pnpm dlx shadcn@latest add <name>` 生成，再改为本项目令牌；不要手写近似实现。 新增 UI 一律从 shadcn/ui 的组件出发（复制到 `packages/web/src/components/ui/`，按项目设计语言调整 token），不要另起一套控件、不要重复手写同类组件。
- **底座先行，按官方方式自定义。** 先安装 shadcn + Base UI（`base-nova`）的官方组件，再应用项目设计系统。共享颜色、圆角和阴影优先走 `styles.css` 语义令牌；局部布局使用 `className`。
  - 定制顺序：内置 variant → 局部布局 → 源码中的语义 variant → 有实际复用需求的应用组合。shadcn 提供源码所有权，允许修改源码；保留原语的无障碍与交互契约，不把“源码必须永远原样”误称为官方要求。
  - 安装或更新组件前检查 git diff，逐组件比较官方源码；`--overwrite` 会覆盖定制，只有确认差异已处理后才使用。
  - 应用组合放在 `src/components/`，如 `ConfirmDialog`；底座组件放在 `components/ui/`。复用必须有明确行为或设计用途，不以调用次数或 JSX 长度机械决定。

- **单一设计契约，随开发补齐。** UI 变更先核对 `docs/DESIGN-SYSTEM.md`；发现缺口就在该文件补齐规则，并同步共享组件与受影响页面。并行任务遵守主会话确定的同一契约，页面不另建同类约定；例外必须在该文件说明适用场景与原因。
- **先复用，再新增。** 写新界面前先看 `components/ui/` 与 `components/` 是否已有可用的组件；能组合就不新建。
- **样式遵循 `docs/DESIGN-SYSTEM.md` 的项目设计语言。** 组件结构、无障碍行为、交互约定沿用组件库；颜色、间距、字体、圆角只通过 `packages/web/src/styles.css` 的 `@theme` token 取值，禁止在组件里硬编码十六进制色值。
- **CSS 统一用 Tailwind CSS 4**，不自造 CSS 文件、不引入第二套样式方案。
- 新增 shadcn 组件时保持其原始结构与可访问性属性（`aria-*`、焦点管理、键盘交互），只改外观 token。
- **交互原语用 Base UI，不自研。** Dialog / Tabs / Select / Popover 等必须基于 `@base-ui/react`
  （shadcn `base-nova` 底座）；焦点陷阱、portal、aria 关联由 Base UI 负责。
  手写版本出现过浮层被祖先 `overflow` 裁切的问题。**Radix 已整体移除，不要再引入。**
- **页面骨架统一用 `components/page.tsx`**（`Page` / `PageHeader` / `PageToolbar` / `PageSection`）。
  页面里不要写 `mb-*` / `mt-*` 这类页面级外边距；每个渲染状态下恰好一个 `h1`，由 `PageHeader` 提供
  （互斥分支各写一个也算合规，同一时刻只渲染一个）。

## 后端

- **Fastify × Zod：schema 即校验。** 每个路由用 `schema: { body, params, querystring }` 声明，
  handler 直接使用 `request.body` 等（类型由 zod 推导）；**禁止在 handler 里写 `safeParse`**。
  路由文件开头用 `const app = typed(rawApp)` 获得类型化实例。
- 校验失败由 `plugins/errors.ts` 统一返回 `{ code:'INVALID_INPUT', message, requestId, path? }`；
  业务规则冲突（409/404）仍在 handler 内显式返回。详见 `docs/VALIDATION.md`。
- 所有 `/api/*` 路由除明确公开项外必须挂 `requireAuth`。
- schema 变更后必须 `pnpm db:generate` + `pnpm db:migrate`，并同步 `docs/` 中的相关说明。

## 测试

- E2E 统一使用 `e2e`（`e2e@0.21.2` + `@e2e-dev/web`）。Playwright 已退役，不再新增其用例。
- 登录等共享前置用 `test.setup` + session，不要在每条用例里重复登录。
- 单元/集成测试用 Vitest；涉及队列的用例需先停掉本地 worker（见 `docs/OPERATIONS.md`）。

## 项目技能（skills.sh）

已安装到 `.agents/skills/`（Claude Code 通过 `.claude/skills/` 符号链接读取），锁定在 `skills-lock.json`。

| 技能 | 来源 | 安装量 | 对应项目技术栈 |
|---|---|---|---|
| `frontend-design` | anthropics/skills | 1.0M | 整体 UI 方向与排版 |
| `vercel-react-best-practices` | vercel-labs/agent-skills | 818.5K | React 19 组件与性能 |
| `supabase-postgres-best-practices` | supabase/agent-skills | 451.7K | PostgreSQL 18 查询、索引、RLS |
| `test-driven-development` | obra/superpowers | 254.7K | Vitest 单元/集成测试 |
| `verification-before-completion` | obra/superpowers | 246.1K | 交付前的验证纪律 |
| `shadcn` | shadcn-ui/ui | 115.4K | 组件库（本项目唯一 UI 组件来源） |
| `tailwind-design-system` | wshobson/agents | 69.4K | Tailwind 4 token 与设计系统 |

- 新增/更新：`npx skills add <repo> --skill <name> -y`，之后把 `skills-lock.json` 一起提交。
- 不安装与本项目栈冲突的技能（例如以 Playwright 为主的 `webapp-testing`，本项目 E2E 已统一为 `e2e`）。

## 交付

- 每个能力都要有可执行的验证命令与真实结果，不以「应该能跑」代替。
- 并发/安全相关改动必须附测试或实测记录。
- 文档与代码不一致时，以代码为准并修正文档；待决策项记录在 `docs/DECISIONS-PENDING.md`。
