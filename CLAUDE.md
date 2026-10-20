# Agentport / PACE — 项目规则

> 这些规则对本仓库的所有改动生效。与个人偏好冲突时，以本文件为准。

## 前端

- **组件库统一使用 shadcn/ui。** 新增 UI 一律从 shadcn/ui 的组件出发（复制到 `packages/web/src/components/ui/`，按项目设计语言调整 token），不要另起一套控件、不要重复手写同类组件。
- **先复用，再新增。** 写新界面前先看 `components/ui/` 与 `components/` 是否已有可用的组件；能组合就不新建。
- **样式遵循 `docs/DESIGN-SYSTEM.md` 的项目设计语言。** 组件结构、无障碍行为、交互约定沿用组件库；颜色、间距、字体、圆角只通过 `packages/web/src/styles.css` 的 `@theme` token 取值，禁止在组件里硬编码十六进制色值。
- **CSS 统一用 Tailwind CSS 4**，不自造 CSS 文件、不引入第二套样式方案。
- 新增 shadcn 组件时保持其原始结构与可访问性属性（`aria-*`、焦点管理、键盘交互），只改外观 token。

## 后端

- Fastify + zod 校验；路由 schema 即类型来源，不重复定义。
- 所有 `/api/*` 路由除明确公开项外必须挂 `requireAuth`。
- schema 变更后必须 `pnpm db:generate` + `pnpm db:migrate`，并同步 `docs/` 中的相关说明。

## 测试

- E2E 统一使用 `e2e`（`e2e@0.21.2` + `@e2e-dev/web`）。Playwright 已退役，不再新增其用例。
- 登录等共享前置用 `test.setup` + session，不要在每条用例里重复登录。
- 单元/集成测试用 Vitest；涉及队列的用例需先停掉本地 worker（见 `docs/OPERATIONS.md`）。

## 交付

- 每个能力都要有可执行的验证命令与真实结果，不以「应该能跑」代替。
- 并发/安全相关改动必须附测试或实测记录。
- 文档与代码不一致时，以代码为准并修正文档；待决策项记录在 `docs/DECISIONS-PENDING.md`。
