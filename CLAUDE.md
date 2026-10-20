# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。

## 前端

- **组件库统一使用 shadcn/ui。** 新增 UI 一律从 shadcn/ui 的组件出发（复制到 `packages/web/src/components/ui/`，按项目设计语言调整 token），不要另起一套控件、不要重复手写同类组件。
- **先复用，再新增。** 写新界面前先看 `components/ui/` 与 `components/` 是否已有可用的组件；能组合就不新建。
- **样式遵循 `docs/DESIGN-SYSTEM.md` 的项目设计语言。** 组件结构、无障碍行为、交互约定沿用组件库；颜色、间距、字体、圆角只通过 `packages/web/src/styles.css` 的 `@theme` token 取值，禁止在组件里硬编码十六进制色值。
- **CSS 统一用 Tailwind CSS 4**，不自造 CSS 文件、不引入第二套样式方案。
- 新增 shadcn 组件时保持其原始结构与可访问性属性（`aria-*`、焦点管理、键盘交互），只改外观 token。

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
