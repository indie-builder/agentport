# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。

## 协作方式

- **任务执行尽量使用多智能体并行。** 只要工作可以拆成互不依赖的子任务（多个页面、多个包、多个独立调研），就派多个子代理并行执行，而不是串行做完一个再做下一个。
- 分工原则：先由主会话确定共享契约（类型、schema、接口签名、设计令牌），再让子代理在各自范围内实现；子代理不互相等待。
- 每个子代理必须有明确的产出边界（改哪些文件、不改哪些文件）与验收方式；主会话负责合并、跑全量校验（typecheck / test / lint / e2e）。
- 只有强依赖或需要连续判断的工作留在主会话；不要把能并行的活串起来做。
- 模型选择遵循 `pstack-models.md` 的 per-role 配置，不为并行而降低判断质量。

## 前端

- **设计基准固定为 https://www.openui.com/chat?form_factor=desktop。** 所有页面、组件、间距、圆角、字号、图标都以它为准，详见 `docs/DESIGN-SYSTEM.md`。改动前先读该文件；不要凭感觉发明视觉。
- **无彩度体系**：黑白灰承担层级，没有品牌色。强调靠实底黑与透明度，不靠色相。
- **结构靠 1px 线与留白，不靠卡片盒子**；圆角随尺寸递增（16 外壳 / 16 chip / 12 卡片 / 9 行 / 7 图标 / 6 标签）。
- **图标统一 lucide，`strokeWidth={1.75}`，16px。**
- **组件库统一使用 shadcn/ui。** `components.json` 已配置，新增组件用 `pnpm dlx shadcn@latest add <name>` 生成，再改为本项目令牌；不要手写近似实现。 新增 UI 一律从 shadcn/ui 的组件出发（复制到 `packages/web/src/components/ui/`，按项目设计语言调整 token），不要另起一套控件、不要重复手写同类组件。
- **先复用，再新增。** 写新界面前先看 `components/ui/` 与 `components/` 是否已有可用的组件；能组合就不新建。
- **样式遵循 `docs/DESIGN-SYSTEM.md` 的项目设计语言。** 组件结构、无障碍行为、交互约定沿用组件库；颜色、间距、字体、圆角只通过 `packages/web/src/styles.css` 的 `@theme` token 取值，禁止在组件里硬编码十六进制色值。
- **CSS 统一用 Tailwind CSS 4**，不自造 CSS 文件、不引入第二套样式方案。
- 新增 shadcn 组件时保持其原始结构与可访问性属性（`aria-*`、焦点管理、键盘交互），只改外观 token。
- **交互原语用 Radix，不自研。** Dialog / Tabs / Select / Popover 等必须基于 `radix-ui`；
  焦点陷阱、portal、aria 关联由 Radix 负责。手写版本出现过浮层被祖先 `overflow` 裁切的问题。
- **页面骨架统一用 `components/page.tsx`**（`Page` / `PageHeader` / `PageToolbar` / `PageSection`）。
  页面里不要写 `mb-*` / `mt-*` 这类页面级外边距，一个页面只有一个 `h1`。

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
