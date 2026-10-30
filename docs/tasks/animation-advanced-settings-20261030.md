# 新建专家高级设置折叠动效

## 目标

给 `CreateAgentDialog` 的「高级设置」折叠内容补上开合过渡，使展开/收起与全站其它折叠面板一致（150ms、height + opacity、`ease-out-soft`），同时保持现有 `keepMounted` 语义：收起后草稿仍在、面板不可见且不可 Tab、错误展开与焦点回收不受影响。

验收：

1. 展开/收起过程中面板有 150ms 的 height/opacity 过渡，动画结束后状态稳定；快速连续开合不回弹、不残留中间高度。
2. 收起后面板 `hidden="until-found"` 且 `inert`，内部模型/标识字段不可见、不可 Tab。
3. 在模型/标识输入草稿后收起再展开，草稿不丢；再次提交仍携带该草稿。
4. Esc / 取消在 dirty 时仍弹放弃确认，确认后清理或取消本表单；关闭后焦点回到「新建专家」按钮。
5. `prefers-reduced-motion: reduce` 下过渡时长被全局归零规则收敛（浏览器计算值 0.01ms）。
6. 不改共享组件、token 或其它折叠面板。

## 方案

仅在 `packages/web/src/pages/agents.tsx` 的 `CreateAgentDialog` 高级设置节点上给 `CollapsibleContent` 增加 `animated`。复用 `components/motion-collapsible.tsx` 已有的 `ANIMATED_PANEL`（Base UI 测量高度变量 + `transition-[height,opacity] duration-150 ease-out-soft`），继续保留 `keepMounted`，由组件现有逻辑同时提供 `hidden="until-found"`、`inert` 与关闭态隐藏。不新增 CSS、不改 token、不动其它折叠。

## 基线与范围

- 基线：`main` 合入提交 `aa8142c`（当前分支 `loop-scheduler-start-20261030`，HEAD 与基线一致）。
- 初始未提交差异：`docs/tasks/platform-improvement-loop.md`（由 loop scheduler 维护的调度启动记录，归 scheduler，本任务不覆盖、不提交其内容）。
- 允许改动：`packages/web/src/pages/agents.tsx`（仅该节点）、`packages/web/test/agents-lifecycle.test.ts`（新增一条 keepMounted 草稿保持行为用例）、本任务记录。

## 当前有效决定

- 用户 2026-10-30 授权本轮实现、验证、评审、提交与合并；主线程持有统一 loop 锁，本车道只写上述范围。
- 采用 Opus 固定契约：只加 `animated` 属性，不做组件层或全局动画改造。
- 2026-10-30 独立 Opus review `af6e2975d28243568` 复核通过，无 mustfix；源码仅保留 `animated` 属性，测试草稿保持未改。

## 已替代项及原因

无。

## 步骤

- [x] 读 CLAUDE.md、DEV-WORKFLOW、PITFALLS、ub-mode、animate 及其折叠 recipe、DESIGN-SYSTEM §11。
- [x] 记录基线、范围与验收（本文件）。
- [x] 在高级设置 `CollapsibleContent` 上增加 `animated`。
- [x] 在 `agents-lifecycle.test.ts` 增加收起/展开草稿保持与关闭态 inert 行为用例。
- [x] 跑 `agents-ui`、`agents-lifecycle`、web typecheck、lint:focus。
- [x] 浏览器验收：普通模式读过渡属性/时长、快速反转、草稿保持、收起不可见不可 Tab、Esc 放弃确认与焦点回收；reduce 模式时长归零。
- [x] 主线程复测：`agents-ui`、`agents-lifecycle` 2 个文件、102 条用例 9.50s 通过。
- [x] 独立 Opus review 复核通过（`af6e2975d28243568`）：3 个文件、105 条用例，web typecheck、`lint:focus`、`git diff --check` 均通过，无 mustfix。

## 改动文件

- `docs/tasks/animation-advanced-settings-20261030.md`（本记录）
- `packages/web/src/pages/agents.tsx`
- `packages/web/test/agents-lifecycle.test.ts`

## 下一步

独立 Opus review 已通过、无 mustfix；源码与测试仍为未提交差异（仅 `animated` 属性与新增用例）。提交与合并由主线程执行，尚未 merge。

## 验证

- `pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/agents-ui.test.ts packages/web/test/agents-lifecycle.test.ts`：2 个文件、102 条用例通过（含新增用例）。
- `pnpm --filter @agentport/web typecheck`：退出码 0。
- `pnpm lint:focus`：焦点/边框规约校验通过。
- 浏览器（ego，TaskSpace `pace-loop-animation-implementation-01`，代码根为当前 checkout 的 `packages/web`）：
  - 代码根说明：`https://agentport.localhost` 实际由 `qoder-ui-integration` 旧 worktree（4426）提供，不是本分支；本分支 Vite 在 `http://localhost:5173`，因此实际验收用后者。
  - 展开时计算样式 `transition-property: height, opacity`、`transition-duration: 0.15s`、`timing-function: cubic-bezier(0.22, 1, 0.36, 1)`；运行时 `document.getAnimations()` 捕获 height 与 opacity 各 150ms running。
  - 展开后 panel 高 174px、无 `hidden`/`inert`，模型输入可聚焦；收起后 `hidden="until-found"`、`inert`、高 0，模型输入无法聚焦。
  - 填写 `gateway/custom-model` / `draft-check` 后收起再展开、以及 3 次 90ms 间隔快速开合后，panel 稳定在 174px 且草稿保留。
  - dirty 状态 Esc 弹出「放弃未保存的更改？」；点「放弃并关闭」后新建表单消失，焦点回到「新建专家」按钮。
  - `prefers-reduced-motion: reduce`：匹配为 true，计算 `transition-duration: 1e-05s`，展开直接到 174px，无运行中过渡；验收后已恢复媒体模拟。
  - 截图：`/tmp/agentport-animation-20261030/advanced-open.png`、`/tmp/agentport-animation-20261030/advanced-reduced.png`。
- 主线程复测：`pnpm vitest run --config packages/web/vitest.config.ts packages/web/test/agents-ui.test.ts packages/web/test/agents-lifecycle.test.ts`：2 个文件、102 条用例通过，9.50s。
- 独立 Opus review `af6e2975d28243568`：3 个文件、105 条用例，`pnpm --filter @agentport/web typecheck`、`pnpm lint:focus`、`git diff --check` 全部通过，无 mustfix。
- 复核说明：浏览器证据沿用作者本 checkout（`http://localhost:5173`；`agentport.localhost` 指向旧 worktree，不是本分支），评审未重新测帧率，如实保留；截图仍在 `/tmp/agentport-animation-20261030/`。
- `review-animations` 工具在本环境被禁用，未执行其流程，不以该技能流程名义声称评审已完成。
