# 运行详情/审批操作反馈（ui-run-approval-feedback）

## 目标

第七轮界面巡检：处理**运行详情页与审批操作**的反馈。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与桌面端约定。
- 运行详情中每个可见状态（运行中、等待审批、完成、失败、取消等）都有可见且可访问的表现；审批操作用户能看出「点了会发生什么、正在发生什么、结果是什么」。
- 不新增依赖、不改后端契约与数据模型、不改设计令牌；不破坏既有运行状态、审批语义与权限。

两项缺陷与改动契约已由 Opus 探索确定，见「方案」。

## 方案

本轮确认两项缺陷，契约固定如下（白名单：`packages/web/src/pages/run-detail.tsx`、`packages/web/test/run-detail-feedback.test.ts`、本记录；不改 API / SDK / 后端 / 依赖）。

### 契约 1：后台刷新失败不得卸载详情

- 根因：`run.isError` 在「已有 data 的后台轮询/手动刷新失败」时同样为 true（TanStack Query 的 `isError = status === 'error'`，data 保留），现有整页 `ErrorState` 分支因此把 trace、步骤检查器与审批区一起卸载。
- 契约：整页 `ErrorState` 只用于**没有 data 的失败**（`isLoadingError` 语义）；有 data 时保持同一详情树渲染，URL 中的步骤选择与 `CodeBlock`/`CollapsibleText` 的展开状态不得重置。
- 有 data 的刷新失败在页头下方追加静态提示，复用现有 `ErrorState` 但把标题区分为「刷新失败，内容仍是上次结果」，并沿用其现有重试入口；重试 pending 期间详情内容继续显示，成功后提示消失。
- TypeScript 用「无 data 才进失败分支、之后直接解构 `run.data`」的诚实收窄，不使用非空断言绕过。

### 契约 2：重跑只在终态且有用户消息时出现

- 根因：当前只要 `hasPrompt` 就显示「重跑」，queued/running 也能点，与已按 `terminal && hasPrompt` 显示的「存为技能」不一致。
- 契约：按钮显示条件改为 `terminal && hasPrompt`；handler 同样按实际状态拒绝 queued/running 触发，不能只靠隐藏按钮。
- 重跑保持原 `conversationId` 同会话重发语义：仍调用 `api.sendChat({ agentId, conversationId, message })`，不切分支、不扩后端。
- 保留既有反馈：pending 时按钮禁用并显示「提交中…」，失败 toast 且可重试，成功跳转到新 run；终态无 prompt 仍不显示按钮。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-run-approval-feedback`（分支 `worktree-ui-run-approval-feedback`）。
- 起点 HEAD：`4770bc3e6ffcd8e44c406b54d13eb560e7f0dab7`；`origin/main` 同为 `4770bc3e6ffcd8e44c406b54d13eb560e7f0dab7`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖。
- 前六轮界面巡检 PR #83/#84/#85/#86/#87 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- 本轮白名单：`packages/web/src/pages/run-detail.tsx`、`packages/web/test/run-detail-feedback.test.ts`、本记录；白名单外一律不改。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权；该授权持续有效。
2. 本轮范围仅运行详情与审批操作反馈，不扩无关页面、不改后端契约与设计令牌。
3. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码。Sonnet 执行代理不提交，提交由主会话按授权执行。
4. 问题必须来自 Opus 的探索证据；不虚构问题、不提前给方案、不为凑数扩大改动。
5. 动效沿用项目限制：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
6. 实测口径按 `docs/PITFALLS.md`：状态、间距、对齐类改动交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段。
7. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。

## 已替代项及原因

无（本记录初建，尚无被覆盖的决定）。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目，确认记录格式与验证要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `4770bc3`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 创建本任务记录，固定目标与范围。
- [x] 确认两项缺陷与契约并写入「方案」。
- [x] 实现与测试：先红（7 条用例中 3 条如预期失败：刷新失败卸载整页、queued/running 仍有重跑），后绿。
- [x] Opus 独立 review 通过（a62dda，无阻断；已独立确认运行分支、缓存树身份与测试真实性）。
- [x] 按改动范围验证并更新本记录（实现侧测试、typecheck、Biome 已过；全量 web 套件与 build 由主会话跑完，见「验证」）。
- [ ] 主会话按既有授权 commit / push / PR / merge，并清理该轮 worktree（未完成）。

## 改动文件

- `packages/web/src/pages/run-detail.tsx`：刷新失败分支与重跑可见性/守卫。
- `packages/web/test/run-detail-feedback.test.ts`（新增）：真实 `RunDetailPage` + 内存 Router + 真实 QueryClient + 受控 `api` Promise。
- `docs/tasks/ui-run-approval-feedback.md`（本记录）。

未改 API / SDK / backend / 依赖 / 设计令牌。临时 visual 入口（`packages/web/visual-run-detail.html`、`src/visual-run-detail.tsx`）与 5199 端口独立 Vite、ego space 均已删除。

## 下一步

1. 主会话按完整授权立即执行 commit / push / PR / merge，并清理该轮 worktree。

## 验证

基线（2026-10-28，真实输出）：
- `git rev-parse HEAD` → `4770bc3e6ffcd8e44c406b54d13eb560e7f0dab7`
- `git rev-parse origin/main` → `4770bc3e6ffcd8e44c406b54d13eb560e7f0dab7`
- `git status --short` → 无输出（工作区干净）

定向测试（2026-10-28，真实输出）：
- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/run-detail-feedback.test.ts` → 7 passed。红阶段先跑同一命令，3 条失败：刷新失败时整页只剩页头、queued/running 仍有「重跑」；实现后全绿。
- 邻近套件 `run-cancel` / `runs-poll` / `run-query` / `run-history-visibility` 一并跑 → 5 files / 25 tests passed。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ 通过，无输出；收窄靠 `run.data === undefined` 分支，无非空断言。
- `biome check packages/web/src/pages/run-detail.tsx packages/web/test/run-detail-feedback.test.ts` → No fixes applied（先对测试文件跑过一次 `--write` 格式化）。

浏览器实测（ego-browser，固定 space `ui-run-approval-feedback`；临时 Vite 5199 一次性页面 + 真实 styles/Router/QueryClient + 受控 `api.run`，未接真实登录/DB）：
- 初次成功 → 键盘聚焦第 2 步按 Enter 选中 → 展开 70KB 内容 → 触发后台刷新失败：`ol button` 仍 3 个、`aria-current` 仍在第 2 步、大内容仍展开（`pre` 文本 71697 字符）、焦点仍停在「收起内容」，同时出现「刷新失败，内容仍是上次结果 / network down / 重试」，页面仍恰好一个 `h1`。
- 步骤选择口径：内存 Router 中步骤参数保留（步骤仍选中第 2 步），浏览器地址栏 `location.search` 挂载时即为空且刷新失败后仍为空。即选中状态由 Router 内存态承载，未实测浏览器地址出现 `?step=1`，本记录不作此声称。
- 错误提示几何与计算样式：`rect {top:64,left:0,width:1512,height:71.5}`，紧贴页头下方（与 `h1` 底边距 24px，即 Page 20px 区块间距 + 边框）；`border-radius:16px`、`border-top:1px`、`font-size:13px`、危险底 `rgb(252,235,233)`、正文 `rgb(23,23,23)`；重试按钮 66×28、7px 圆角、白底，沿用共享 `ErrorState`，未新增组件。
- 重试成功：提示与重试按钮消失，步骤仍 3 个、仍选中第 2 步、仍一个 `h1`。
- 终态无 prompt：无「重跑」「存为技能」；queued 状态真实页面：只有「取消」，无「重跑」。
- 桌面收窄 1024×900：无横向溢出，错误条 1024×72，页头 980×44 且操作按钮均在视口内。

主会话最终验证（2026-10-28，真实输出）：
- `pnpm test:web` → 78 files / 773 tests 全过，结束时间 04:59:15。
- `pnpm --filter @agentport/web typecheck` → 通过。
- `pnpm --filter @agentport/web build` → 通过。
- `biome check` 两个改动文件（`run-detail.tsx`、`run-detail-feedback.test.ts`）→ 通过。
- `lint:focus` / `lint:contract` → 通过。

未测/限定：
- 未覆盖真实登录、真实 DB 与真实后端 run 数据；浏览器验证使用一次性受控 fixture，只覆盖本次两条改动路径。
- 现有 e2e `tests/regression.e2e.ts` 的「重跑」断言对象是 succeeded 且有用户消息的运行，仍成立；`tests/run-cancel.e2e.ts` 的无 prompt 断言也不变。两项 e2e 未在本轮实跑。
- 审批区（approval）在刷新失败时仍在同一详情树内（与 trace/检查器相同分支），未单独做审批交互实测。
- 临时 visual 二期截图遇到 CDP 截图超时，改用几何/计算样式读数，未留截图。
- 本树 `.vitest` 生成差异归属：本轮测试未产生被 Git 跟踪的差异，`git status` 仅有上述三处改动。
