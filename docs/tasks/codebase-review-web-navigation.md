# Web 编辑器阻塞导航 resolver 生命周期修复

## 目标

保存请求进行中用户按浏览器后退/前进（POP）时，`useBlocker` 会产生 `blocked` resolver。此前保存成功回调直接 `onClose()`，父级卸载编辑器或切换表单 key，resolver 既不 `reset` 也不 `proceed`，导航 Promise 永久挂起，确认框也可能残留。本任务让四个编辑器在真正关闭/卸载前结算最新 resolver，并保持「保存成功留在当前页、不替用户继续导航」的语义。

验收：

- 保存中触发 POP 后，保存成功关闭弹层时 blocker Promise 被结算（取消导航），确认框消失；再次导航正常。
- 技能支持文件保存后弹层仍保留时**不**结算仍有效的拦截。
- 放弃路径（确认放弃并关闭/离开）同样结算。
- 保留现有错误处理、dirty 保护与可访问交互。

## 方案

沿用 `knowledge-detail.tsx` / `ops.tsx` 已验证的 `blockerRef` + `finish` 模式：

- 用 `useRef` 保存最新 blocker，避免成功回调闭包读到旧的 idle blocker。
- 所有真正关闭弹层的路径（保存成功关闭、无脏关闭、确认放弃关闭）先 `blockerRef.current.reset?.()` 再 `onClose()`；`reset` 语义是取消那次被拦下的导航，用户仍停在当前页。
- 弹层保留（技能主表单保存但仍有支持文件草稿、支持文件保存成功）时不 reset。
- `ToolForm` 有基于 `blocker.status === 'blocked'` 的确认框（`servers.tsx`）；切换工具 key / 放弃编辑时仍由父级卸载，卸载不会自动结算 blocker：成功回调先结算；卸载清理再兜底结算最新 resolver。新建工具成功后表单仍保留，显式结算。

## 基线与范围

- 基线：`e060e3a`（worktree `codebase-review-loop`）。
- 初始未提交差异：本仓库中 API/shared/worker/docs 等改动由其它并行任务持有，与本任务无关；本任务不改动它们。
- 允许改动：
  - `packages/web/src/pages/plugins.tsx`
  - `packages/web/src/pages/skills.tsx`
  - `packages/web/src/pages/servers.tsx`
  - `packages/web/src/pages/eval.tsx`
  - `packages/web/test/plugin-editor.test.ts`
  - `packages/web/test/skill-editor.test.ts`
  - `packages/web/test/server-tool-editor.test.ts`
  - `packages/web/test/eval-feedback.test.ts`
  - 新增这几域的导航行为测试
  - 本记录
- 不改：chat/knowledge/agents/共享 `lib/form.ts`、主任务记录。

## 当前有效决定

- 按用户本轮指令：只在拥有弹层生命周期处修复 resolver 结算，不新造通用弹窗框架，不改共享 blocker 工具。
- 保存成功语义：取消被拦下的导航（`reset`），不自动 `proceed`。
- 测试必须使用真实 Router/history 与 deferred save，在保存中触发 POP，断言 blocker Promise 结算、确认框消失、再次导航正常；不得使用 idle blocker mock。

## 已替代项及原因

无。

## 步骤

- [x] 读 DEV-WORKFLOW / PITFALLS / DESIGN-SYSTEM，加载 ub-mode、react-router、vitest，核对已安装 `useBlocker`（1.170.46：`blocked` 提供 `proceed/reset`，unmount 不会自动结算）。
- [x] 先写真实 Router + deferred save 的行为测试，在保存中 POP，确认当前实现失败。
- [x] 四个编辑器加 `blockerRef` + 关闭前结算；ToolForm 成功与卸载结算。
- [x] 运行四域 web 测试、web typecheck、biome，记录真实结果。
- [x] 交 Opus review 并通过；主会话复跑见「验证」

## 改动文件

- `packages/web/src/pages/plugins.tsx`
- `packages/web/src/pages/skills.tsx`
- `packages/web/src/pages/servers.tsx`
- `packages/web/src/pages/eval.tsx`
- `packages/web/test/navigation-blocker.ts`（新增测试辅助：真实 `history.block` Promise 捕获）
- `packages/web/test/plugin-editor-navigation.test.ts`
- `packages/web/test/skill-editor-navigation.test.ts`
- `packages/web/test/server-tool-editor-navigation.test.ts`
- `packages/web/test/eval-editor-navigation.test.ts`
- `docs/tasks/codebase-review-web-navigation.md`

## 下一步

无待办。独立评审通过，主会话 8 files / 50 tests 与 `skills.tsx` 共享 schema 整合 4 files / 45 tests 均通过；ToolFormUI 记录误述已修正并复核。

## 验证

先红：四个新增导航测试在未修复时均因 `settled()` 返回 `'timeout'` 失败（被 POP 拦下的 blocker Promise 未结算）；技能「支持文件保存后弹层保留」用例在修复前也失败于关闭路径。

修复后真实命令与结果：

- `pnpm exec vitest run --project web` + 全部 16 个引用四个页面的测试文件（含既有与新增）：
  `16 passed (16) / Tests 129 passed (129)`，0 skip。
  其中新增：plugin 1、skill 2、server/tool 3、eval 1。
- `pnpm --filter @agentport/web typecheck`：`tsc -b` 通过，无错误。
- `pnpm exec biome check` 覆盖 9 个改动文件：通过，无 fix。

主会话复核（独立评审后）：

- 导航相关 8 files / 50 tests 通过；基线 `e060e3a`，范围为本任务源码、新增测试与测试辅助。
- `skills.tsx` 共享 schema 整合 4 files / 45 tests 通过。
- 独立评审结论通过；记录中 ToolFormUI「没有 blocker 确认 UI」的误述已修正并复核。

测试方式与限制：

- 使用真实 `createBrowserHistory` + TanStack Router 挂载，真实 `window.history.back()` 触发 POP；用测试辅助包装真实 `history.block` 捕获 `blockerFn` 返回的 Promise，断言它在保存完成后结算（`true` = 取消导航），而不是断言 reset 被调用。
- 保存使用 deferred Promise，确认 POP 发生在请求未完成期间；断言保存成功/放弃后确认框消失、history 停留原页、后续导航可达目标页。
- 技能资源保存用例覆盖「弹层仍保留时不误结算」：保存完成后 blocker Promise 保持未结算（`'timeout'`），弹层仍在；随后关闭才结算。
- 未覆盖：真实浏览器弹出 popstate 的时序差异（jsdom 下 popstate 异步行为已跑通）；四个编辑器之外使用 `useFormBlocker` 的 chat/agents 页面不在本任务范围。
- 环境限制：worktree 共享依赖与 `.vitest/json/output.json` 由其它并行任务改动，本任务未触碰。

## 整合结果

- `skills.tsx` 的 `skillFileFormSchema` 删除重复的 `path` 正则实现：规范路径直接 pipe 到共享 `skillFileInputSchema.shape.path`，表单只保留中文必填/长度提示与 `content` 上限/默认值。新增与编辑同一路径都走同一套共享校验。
- 行为红绿：`skill-editor.test.ts` 新增 6 个用例——`SKILL.md`、`skill.MD`、`refs//a.md`、`./refs/a.md` 阻止写入并暴露可访问错误；空路径保留表单必填提示；`references/nested/SKILL.md` 可保存。红为 4 个非法路径用例仍调用 `writeSkillFile`；绿为整文件 22/22。
- 更正上文「ToolForm 没有 blocker 确认 UI」：`servers.tsx` 已有 `blocker.status === 'blocked'` 确认框，保留父级卸载需要结算 resolver 的原因。
- 复核：本次 `skills.tsx` schema 复用与新增测试独立 review 通过；主会话复跑 4 files / 45 tests 通过。
