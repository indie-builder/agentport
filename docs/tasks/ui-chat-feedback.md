# 对话消息操作与输入/错误反馈（ui-chat-feedback）

## 目标

第四轮界面巡检：处理**对话消息上的操作**与**输入停止、错误恢复**过程中的反馈。

验收方向：
- 消息操作与输入/错误反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11、对话态 §6）。
- 停止、失败、重试、恢复各阶段都有可见且可访问的表现，不出现无反馈的静默失败。
- 不新增依赖、不改后端契约与设计令牌；不破坏既有会话、流式、读数与自动滚动行为。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-chat-feedback`（分支 `worktree-ui-chat-feedback`）。
- 起点 HEAD `69329f1b3e268d040d909f76097cfa322aee78ac`，与 `origin/main` 一致；初始工作区干净。
- 主 checkout 的 `.vitest` 未提交差异非本任务产出：不提交、不还原、不覆盖。
- 前三轮 PR #83/#84/#85 已合并并清理 worktree，本记录不重复其范围。
- **最终改动白名单**：`packages/web/src/lib/use-chat-stream.ts`、`packages/web/src/pages/chat.tsx`、与这两处改动真实相关的既有测试、本记录。不改后端、依赖、设计令牌，不扩展到其它组件或做范围外重构。

### 执行分工

- 代理 A（已完成）：`use-chat-stream.ts`、`packages/web/test/chat-stream.test.ts`。
- 代理 B（实施中）：`chat.tsx` 的契约 2、3 与对应真实测试；本记录只写已发生的结果。
- 本记录由主会话维护。

## 已确认契约（最终 3 项）

1. **发送失败读最新 store。** `send()` 的 `catch` 分支通过 `useChatStore.getState()` 读等待期间的最新草稿；仅当调用方未显式传正文（`text === undefined`）且最新 `input === ''` 时，才把原消息回填输入框。等待期间用户已输入（含纯空格）则原样保留；显式动作发送失败不回填动作正文。实现与定向测试已完成。
2. **历史 run metrics 去 `visibility: hidden`。** `chat.tsx` 历史运行读数容器保持常驻占位，移除 `invisible`（不再把「查看详情」移出 Tab 序），默认 `opacity-0`，`transition-opacity duration-150 ease-out-soft`；`group-focus-within/turn` 与 `group-hover/turn` 显影，保留 `pointer-coarse` 常显与 `motion-reduce` 无过渡。键盘 Tab 可到达读数内入口。
3. **首发焦点交接。** 仅首次发送、欢迎态切换为对话态且输入框重挂载时生效：切换前焦点在原 textarea 上，则切换后把焦点交给新 textarea；焦点在其它控件时不抢焦点。不抽象通用焦点管理器。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权；git 交付由主会话执行。
2. 范围以上述 3 项契约为限，探索已完成，不再新增候选缺口。
3. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场/装饰位移。
4. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段。
5. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。

## 已替代项及原因

无。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目。
- [x] 核对基线：HEAD、`origin/main`、worktree 状态与主 checkout 既有差异归属。
- [x] 创建本任务记录。
- [x] 只读探索对话消息操作、输入停止与错误恢复现状，候选缺口收敛为上述 3 项。
- [x] 主会话固定最终契约与改动白名单。
- [x] 代理 A 实现契约 1，补行为测试并做定向验证。
- [x] 代理 B 实现契约 2、3，补真实相关测试并做定向验证。
- [x] 独立 review：第 1 轮发现 1 个 blocker（焦点交班标志只置不清），本轮已修复并补回归用例。
- [ ] 按改动范围整体验证，更新本记录「验证」与「下一步」。
- [ ] 主会话按既有授权 commit / push / PR / merge，并清理该轮 worktree。

## 改动文件

- `packages/web/src/lib/use-chat-stream.ts`（A，已完成）：失败分支读最新 store；仅空输入时恢复原消息；`setRun(null)` 同步走最新 store。
- `packages/web/test/chat-stream.test.ts`（A，已完成）：新增/补充 4 条用例（新草稿保留、纯空格草稿保留、无新草稿恢复原消息、动作失败不回填）。
- `packages/web/src/pages/chat.tsx`（B，已完成）：契约 2 的读数容器类名与相邻注释；契约 3 的首发焦点交接；review 修复为每次提交都覆盖交班标志。
- `packages/web/test/chat-ux.test.ts`（B，已完成）：真实 `ChatPage` 挂载下的首发 Enter 交班、外部控件提交不抢焦点、空 Enter 后外部提交不继承旧标志、历史读数链接保留在 Tab 序。
- `docs/tasks/ui-chat-feedback.md`：本文件。

## 验证

### 代理 A：契约 1（真实结果）

- **缺陷**：`send()` 先清空输入框再请求；等待期间用户输入 B，请求失败时 `catch` 无条件用原消息覆盖 B。
- **修复**：`catch` 内读 `useChatStore.getState()`；仅 `text === undefined && latest.input === ''` 时回填原消息，动作发送失败不碰草稿。
- **先红**：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-stream.test.ts -t '请求失败'` → 2 failed | 2 passed，失败正是 `expected 'original message' to be 'B'` / `' '`。
- **后绿**：同文件全量 → **41 passed**（1 文件）。
- `pnpm --filter @agentport/web typecheck` → exit 0。
- `./node_modules/.bin/biome check packages/web/src/lib/use-chat-stream.ts packages/web/test/chat-stream.test.ts` → 2 files checked，0 错误。
  - 备注：`pnpm exec biome check` 在 RTK 包装下会误报 `Lint: 1 errors` 且无细节，以直接调用仓库内二进制的真实结果为准。
- 未覆盖：全量 `pnpm test` 与浏览器实测留给整体验证；契约 1 为 store/hook 层行为，已由真实 store + fixture 的行为测试覆盖。

### 代理 B：契约 2、3（真实结果）

**测试**（真实 `ChatPage` + 内存路由/QueryClient，mock 仅 `api` 与 EventSource）：

- 新增 3 条：首发真实 Enter 后焦点落在新 textarea 且旧 textarea 已卸载；外部控件提交不抢焦点；空 Enter 后填写正文、从外部按钮提交时新 textarea 不聚焦、焦点保留在外部控件。
- 新增 1 条：3 轮历史里最旧一行的「查看详情」仍在可访问树与 Tab 序（无 `invisible`/`inert`/`aria-hidden`），`href="/runs/run-1"`，可程序聚焦。
- `./node_modules/.bin/vitest run --config packages/web/vitest.config.ts packages/web/test/chat-ux.test.ts` → **28 passed**（1 文件）。
- `pnpm --filter @agentport/web typecheck` → exit 0（`tsc -b`，Checked 2 files）。
- `./node_modules/.bin/biome check packages/web/src/pages/chat.tsx packages/web/test/chat-ux.test.ts` → exit 0，2 files checked，无改动。

**Review 第 1 轮 blocker 与修复**：

- **缺陷**：`submit` 只把 `focusHandoff.current` 置 `true`、从不清除。欢迎态空 Enter（`send` 因空正文提前 return）会把标志留在 `true`；随后填写正文、从外部控件提交，首条消息使欢迎态退出，旧标志让 ChatColumn 抢走焦点。
- **修复**：每次通过 guard 的提交都覆盖标志：
  `focusHandoff.current = welcome && Boolean(input.trim()) && document.activeElement === textareaRef.current`。
  仍保留 `historyReady`/`run` guard；未额外加“guard 前清理”分支——空 Enter 的下一次真实提交必然先覆盖，标志只在提交间存活。
- **先红**：临时退回旧实现跑 `-t 'empty-Enter handoff'` → 1 failed（`expected <button ...显示会话历史> to be activeElement`，实际焦点被新 textarea 抢走）。
- **后绿**：恢复修复后同用例通过，`chat-ux.test.ts` 全量 28 passed。

**浏览器实测**（临时 Vite 入口 `packages/web/.visual-check` 渲染真实 `ChatPage` + 真实 `styles.css`，受控 `fetch`/`EventSource`，端口 5199；ego-browser v2.1.0，space `ui-chat-feedback`）：

- 历史 3 轮纯文本：2 条历史读数容器计算样式 `opacity: 0`、`visibility: visible`、`display: block`，尺寸 728×16，无 `inert`/`aria-hidden`，链接 `tabIndex: 0`，`transition: opacity 0.15s cubic-bezier(0.22, 1, 0.36, 1)`。
- 显影：禁用过渡后聚焦「查看详情」，容器 opacity 由 `0` 变 `1`；键盘 Enter 打开 `/runs/run-1`（路由内容渲染为 run detail）。未禁用过渡时后台窗口不产帧、过渡停在 `currentTime: 0`，计算值仍为 0，这是浏览器节流而非规则未命中（规则 `.group-focus-within\/turn\:opacity-100:is(:where(.group\/turn):focus-within *)` 已匹配）。
- 焦点：欢迎态真实按 Enter 发送后，页面上仅 1 个 textarea 且 `document.activeElement` 为该输入框，欢迎态插画消失。空 Enter 不发送、仍停留欢迎态；填写正文后从「显示会话历史」按钮位提交，焦点保留在该按钮（`activeIsMessage: false`），review blocker 场景在真实组件中不再复现。
- 限制：本入口只 mock `fetch`/`EventSource`，无真实模型、登录与共享 DB；未在完整 AppShell 下复测（此前轮次已覆盖同类入口）。草稿 A 发送中输入 B 的保留已有 store 层真实测试（`chat-stream.test.ts` 41 passed），浏览器未重复构造。

## 下一步

代理 B 已完成并自测 → review blocker 已修复并红绿 → 主会话运行完整测试与构建、按授权 commit / push / PR / merge，并清理 worktree。**主会话整体结果待更新。**
