# Impeccable 技能全局适用性盘点与问题修复

## 目标

用户已明确授权：**针对 Impeccable 各技能，看现有项目全局哪些可以用，并把使用中发现的问题修掉。**

验收标准：

- 对已安装 Impeccable 插件的 24 个技能逐一给出结论，并附证据来源。
- 对实际使用中暴露的问题形成修复，修复行为有可执行验证。
- 不破坏现有功能，也不改动已确定的视觉基准、布局契约与技术栈。

用户已授权审查和修复；A 已确认问题与 B 新增问题已合并为九类实质根因（B2/B3/B7 分别并入 A4/A2/A3，不重复计数），实施契约、writer 边界与验收方式已固定。六个包源码均已落地并有测试结果，Opus review **全部通过**：Roles、Accounts、Ops、Memory/Runtime（runtime 草稿基线定向复核）此前已过；Agents/Chat 最后一项 delete resolver P2 由 Sonnet 补修后，Opus 定向复核明确「通过」。补修要点：子层登记最新 reset，父层删除 success effect 先结算被拦下的导航再 `navigate`，从而结算旧 blockerFn Promise，不依赖卸载清理；新增用例直接记录 `history.block` 的 blockerFn Promise，先红（false）后绿。新增两个测试文件 15 pass，`agents-lifecycle.test.ts` 65 pass；Opus 定向复核 1 pass / 7 filter 跳过。主会话补修后最终 `pnpm test:web` 为 126 files / 1520 passed / 0 failed（日志 key bkh51p4b4），相对基线 121 files / 1473 passed 新增 47；web typecheck / build、lint focus / contract 均 exit 0（日志 key bgxco5vci），18 个改动 TS/TSX 经 `rtk bypass pnpm exec biome check` clean（主会话已复核），`git diff --check` 通过；shared typecheck 补修前已过且 metadata 未再变，沿用该结果。本轮另追加 2 处 review 生命周期/测试真实性修正（runtime 草稿基线、delete resolver 测试直取 blockerFn Promise），不是新产品功能。修复后 8 页 detect 结果为空是在 runtime 基线与 delete 补修前执行，时点明确，未再重扫。其余所有包 review 已过，整任务无待修代码项。浏览器已 `task.finish keep[]`，本任务临时 API/web 已停止，4394 无监听；3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务。数据库/Redis 未清，ego-browser 更新提示未处理。未 commit / push / merge，worktree 保留成果，主 checkout 未写入。

## 24 技能适用性契约

主会话已由 Opus 完成适用性盘点，结论如下；本轮按表执行，不重新调研、不扫描源码重做判断。

| # | 技能 | 归类 | 确定结论 / 触发条件 | 本轮动作 |
|---|------|------|--------------------|----------|
| 1 | critique | 本次执行 | A 已确认项 + B 新增四类已合并为九类根因，调用链与实施契约见下文 | 已完成 |
| 2 | audit | 本次执行 | B 已完成并并入契约；detector 真实新增问题 0，浏览器仅登录页证据 | 已完成（不重跑 detector） |
| 3 | polish | 本次执行 | 审查结论确定后的修复落地入口 | 已按 harden/onboard/clarify 完成本轮修复，并完成复审；当前无待修代码项 |
| 4 | document | 问题驱动 | 只同步快照，不改规范；已有漂移按流程处理 | 本轮无新增具体问题，不强行执行 |
| 5 | extract | 问题驱动 | 同一意图出现 3 处以上且现有实现不足才抽取 | 本轮无新增具体问题，不强行执行 |
| 6 | quieter | 问题驱动 | 实证冗余或过重装饰；保留功能、风险提示、标签 | 本轮无新增具体问题，不强行执行 |
| 7 | distill | 问题驱动 | 同 quieter：实证冗余或过重装饰，保留功能/风险/标签 | 本轮无新增具体问题，不强行执行 |
| 8 | harden | 问题驱动 | 真实长内容、错误、权限、保存、草稿边界 | 本轮实际问题已应用 |
| 9 | onboard | 问题驱动 | 现有空态的首次操作缺口 | 本轮实际问题已应用 |
| 10 | animate | 问题驱动 | 已有动效的状态问题；保持项目时长与减弱动效 | 本轮无新增具体问题，不强行执行 |
| 11 | typeset | 问题驱动 | 统一既有字号角色，不换字体 | 本轮无新增具体问题，不强行执行 |
| 12 | layout | 问题驱动 | 修实际分组/对齐违例，遵守既有几何 | 本轮无新增具体问题，不强行执行 |
| 13 | clarify | 问题驱动 | 真实文案、错误恢复、术语问题 | 本轮实际问题已应用 |
| 14 | adapt | 问题驱动 | 仅桌面窗口/容器/短视口/200% 缩放 | 本轮无新增具体问题，不强行执行 |
| 15 | optimize | 问题驱动 | 需实测瓶颈并有前后对比才能优化 | 本轮无新增具体问题，不强行执行 |
| 16 | shape | 需新设计目标 | 当前无具体新设计目标，不启动 | 暂不执行 |
| 17 | bolder | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 18 | colorize | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 19 | delight | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 20 | overdrive | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 21 | live | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 22 | generate | 需新设计目标 | 需明确的新设计目标才启动 | 暂不执行 |
| 23 | craft | 当前无需 | 已弃用 | 不执行 |
| 24 | init | 当前无需 | 项目已有 PRODUCT | 不执行 |

维护入口：hooks、pin、unpin、插件升级本轮不执行；doctor 仅在发现实际 artifact 问题时使用，不顺带改配置。

## 方案

- **先审查、后修复**：A、B 均已确认，合并为九类实质根因；B 只采用 `/tmp/agentport-ui-audit-20261031-B.md` 的问题段，不重新调研源码。证据来自当前树源码；产品后台行为未实测。B 报告共 7 项（P1 3 / P2 4，P0/P3 0），健康评分 14/20 为有限证据下的静态暂定。
- **固定契约再落地**：A/B 返回后已由 Opus 固定修复契约（问题清单、文件边界、不变量、验证命令）；六个 Sonnet 子代理已按文件边界完成源码落地，结果见「实施结果（按包）」；Agents/Chat 的 delete resolver P2 已补修完成并通过 Opus 定向复核。
- **独立 review**：按包交 Opus 独立 review，状态分开记录；未通过不标完成。
- **按改动范围验证**：typecheck / test / build / lint 按实际改动面选择，最终由主会话全量复跑，不用局部通过冒充全套。
- **协作边界**：主会话只做读取、定契约、派发、审查、运行验证与汇报，不亲自写代码；全部产出只在当前 worktree。

## 基线与运行源

- worktree 绝对路径：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/impeccable-ui-audit`
- 开工 HEAD：`522182f65a82f64eff34006b76650e5484ba55c0`，与 `origin/main` 一致。
- 开工 `git status --porcelain` 为空；此后新增本任务记录，源码/测试差异见「改动文件」。
- 配置：主 checkout 绝对路径 `/Users/xbjt/Documents/myself/agentport/.env`；worktree 副本一致，已核对且未输出 secret。
- 运行源（历史）：曾在本树临时启动 API 3000 / web 4394 做登录页验证，预览 `https://worktree-impeccable-ui-audit.impeccable-ui-audit.agentport.localhost`；本任务服务现已全部停止，4394 无监听；3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务。
- 登录态：A/B 审查阶段产品页不可达，结论仅来自源码；其后主会话曾在本树启动 API 3000 / web 4394，浏览器只到登录页（p3 无 session）。实际验证仅 1480×840 与 1024×600 两档：1024 档 `scrollWidth=1024` 无横向溢出，表单宽 320，用户名 Tab→密码。不得写成后台实测通过。未改账户密码/数据/配置，未启动 worker。
- 临时进程：本任务临时 API 3000 / web 4394 已 `TaskStop`，浏览器 `task.finish keep[]`；4394 无监听，3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务。未清数据库/Redis，未动主 checkout。
- 真实基线：`pnpm test:web` 121 files / 1473 passed（Vitest/jsdom 的 scrollTo、navigation 提示不算真实浏览器）；`pnpm --filter @agentport/web typecheck`、`build` 通过；`pnpm lint:focus`、`pnpm lint:contract` 通过。
- detector：完整 JSON `/tmp/agentport-ui-audit-20261031-detector.json`；唯一告警 `styles.css:235` 的 15px 经规范核对为误报（保留 `md` 15/26 档），detector 真实新增问题 0。
- 健康评分：源码暂评 design 25/40、tech 14/20；这是有限证据下的暂定分，不是修复后分数，也不构成 WCAG AA 证明。
- 允许改动：本任务记录；后续源码/配置范围由 Opus 修复契约确定，只落当前 worktree；主 checkout 保持干净、不写入。

## 当前有效决定

1. 用户已授权「盘点各技能适用性 + 修掉使用中发现的问题」；2026-10-31 另行明确授权本轮 commit / push / PR / merge，操作结果以 GitHub 真实状态为准。
2. 视觉与控件外观以官方 Qoder CN 浅色界面为准；布局几何以 `docs/DESIGN-SYSTEM.md` 当前规范为准。本轮不改变这套基准。
3. 技术栈保持现有选择（shadcn/ui、Base UI、Tailwind 4、TanStack、Motion 等），不因技能建议更换。
4. 仅面向桌面端，保留窗口缩放与容器伸缩；不扩展移动端适配，不新增深色模式。
5. 输入框低对比度属于**已接受现状**，本轮不修改。
6. `packages/web/.impeccable/design.json` sidecar 已知 stale，属于未授权维护；本轮不刷新，不改 `packages/web/DESIGN.md` 或设计规范。
7. A 已确认项与 B 新增四类合并为九类实质根因，仅按下文固定契约实施；B 不重跑 detector、不全站扫描；浏览器仅有登录页两档证据，不作为后台实测。
8. 修复契约已由 Opus 固定；六个包源码已完成并各自验证，Opus review 全部通过（Roles/Accounts/Ops、Memory/Runtime 定向复核、Agents/Chat delete resolver 定向复核）。agents/chat 机械修正已完成，18 个改动 TS/TSX 的 Biome check 通过。
9. 主会话不写代码；全部变更只在此 worktree。
10. `PRODUCT.md`、`docs/OPERATIONS.md` 的 RBAC 合入状态修正已完成（文档项）；只写“已合入 main（ae8407d）”，不写成生产部署。验证代理已确认 diff 仅这两个文档，不扩其它文档。
11. 健康手册在产物内不可点击的限制保留：需要新增正文服务；现有 `/api/docs` 是鉴权 API reference，不能替代 RUNBOOK/OPERATIONS 的处置正文。
12. `packages/web/.impeccable/design.json` sidecar stale 仅记录，维护不变、不刷新；共享表格半透明 hover 是既有登记差异，不当新问题。
13. 健康评分是源码暂评 design 25/40、tech 14/20，不是修复后分数，也不是 WCAG AA 证明。

## 已替代项及原因

- 旧表述「本轮只建立任务记录并启动独立审查」已被替代：用户已授权审查和修复，本轮已完成 A+B 合并契约修复、全部包 review 与最终验证。
- 旧四包边界（C/R/G/O）及其测试名（`accounts-form-guards.test.ts`、`restricted-agent-guards.test.ts`、`expert-empty-access.test.ts`、`schedules-utc.test.ts`）已被下文六个 writer 边界替代；记录中不再存在这些不存在的测试文件。
- 旧表述「B 结果由主会话接收、本轮不重复运行」已被替代：B 已完成，仅问题段并入契约，detector 不再重跑。
- 旧最终结论「126 files / 1519 passed」（delete resolver 补修前时点，日志 key 为当时旧值）已被补修后 126 files / 1520 passed 替代；1519 仅在本文作为补修前历史，不再作为最终结果。

## 步骤

- [x] 读取 `CLAUDE.md`、`docs/DEV-WORKFLOW.md` §2-3、`docs/PITFALLS.md`、`ub-mode` 技能；记录 worktree、HEAD 与初始 status。
- [x] 建立本任务记录。
- [x] 完成 24 技能适用性盘点（Opus 契约，见上表）。
- [x] A 已确认项；核对指定问题的调用链、现有保护与相关测试（未扩展全站审查）。
- [x] 接收 B 问题段（B1–B7），B2/B3/B7 并入 A4/A2/A3，合并为九类根因；固定六个 writer 边界与验收命令。
- [x] 修正 `PRODUCT.md`、`docs/OPERATIONS.md` 的 RBAC 合入状态（文档项，未写生产部署）。
- [x] 六个 writer 源码落地并有测试结果：Roles、Accounts、Memory/Runtime、Ops/Shared、Agents/Chat 逐包结果见「实施结果（按包）」。
- [x] Roles、Accounts、Ops 已过 Opus review。
- [x] Memory/Runtime 首次 Opus review 未过 runtime baseline；补修后定向复核明确通过（定向 2 tests pass，29 因 filter 跳过）；Memory 其余已过范围不重审。
- [x] Agents/Chat delete resolver 补修完成：子层登记最新 reset，父层删除 success effect 先结算被拦下的导航再 `navigate`，结算旧 blockerFn Promise；新增用例直接记录 `history.block` 的 blockerFn Promise，先红（false）后绿。
- [x] Agents/Chat Opus 定向复核明确「通过」：定向 1 pass / 7 filter 跳过；新增两个测试文件 15 pass，`agents-lifecycle.test.ts` 65 pass。
- [x] agents/chat 机械修正完成：删除 2 个 unused、import 格式化、3 处 label `htmlFor`/`id` 关联；最终 18 个改动 TS/TSX 的 `rtk bypass pnpm exec biome check` 为 Checked 18、No fixes applied、exit 0。
- [x] 主会话补修后最终完整验证：`pnpm test:web` 126 files / 1520 passed / 0 failed（日志 key bkh51p4b4），相对基线 121/1473 新增 47；web typecheck/build、lint focus/contract exit 0（日志 key bgxco5vci）；18 个改动 TS/TSX Biome clean；`git diff --check` 通过；shared typecheck 沿用补修前结果。修复后 8 页 detect 为空执行于 runtime 基线与 delete 补修前，未重扫。
- [x] 临时服务/浏览器清理完成：浏览器 `task.finish keep[]`，本任务临时 API/web 已 `TaskStop`；4394 无监听，3000 当前由另一 worktree 占用，非本任务服务；其余跟踪差异保持未提交。
- [x] delete resolver 补修后定向测试与 Opus 定向复核通过；最终完整验证已完成；`.vitest/json/output.json` 已在无其它 writer 后精确恢复 HEAD 且无 diff。
- [x] 更新本记录：结论、改动文件、真实验证结果、下一步。
- [x] 未授权不提交：无 commit / push / merge，worktree 保留成果。

## 改动文件

- `docs/tasks/impeccable-ui-audit.md`（本记录；记录更新代理仅编辑此文件）。
- 文档项：`PRODUCT.md`、`docs/OPERATIONS.md`（RBAC 合入状态修正，已合入 main `ae8407d`；验证代理确认仅此两个文档）。
- 源码（均已落地，review 状态见「实施结果（按包）」）：`packages/shared/src/access.ts`、`packages/web/src/pages/accounts.tsx`、`roles.tsx`、`memory-panel.tsx`、`memory.tsx`、`runtime-environment-detail.tsx`、`ops.tsx`、`agents.tsx`、`chat.tsx`。
- 新测试：`packages/web/test/accounts-ui-hardening.test.ts`、`roles-ui-hardening.test.ts`、`schedule-timezone.test.ts`、`restricted-agent-navigation.test.ts`、`expert-permission-empty.test.ts`。
- 修改测试：`packages/web/test/account-rbac.test.ts`、`memory-editor.test.ts`、`personal-memory-page.test.ts`、`runtime-environments.test.ts`。
- 实际改动共 21 个文件（含本记录；按 `git status` 排除 `.vitest/json/output.json` 计）：上述 2 个文档 + 9 个源码 + 5 个新测试 + 4 个修改测试 + 本记录。
- `.vitest/json/output.json` 是测试运行生成的 tracked 产物，不是交付源码；已在所有测试/review 结束后精确恢复为 HEAD（`git diff` 为空），不计入 21 个交付文件。
- 未 commit / push / merge；工作树保留全部成果。

## 已确认问题：精确实施契约（A + B 合并，Opus，基线 522182f）

本节固定 A 已确认项与 B 新增四类（B1、B4、B5、B6；B2/B3/B7 已分别并入 A4/A2/A3），不是新一轮审计；B 只取问题段，不重新调研源码。九类实质根因 = A 五核心（账户弹窗关闭/字段错误、角色搜索父级批量、受限专家页签导航、权限空态、UTC 显示）+ B 新增四类；其余 A 项为小修或文档限制，不另计。已读项目规则、`DEV-WORKFLOW.md` §2、`PITFALLS.md`、`ub-mode` 和 Impeccable 4.8.0 `reference/craft-floor.md`。保留全部既有视觉令牌、布局、权限 ID、保存 API、成功/冲突/错误处理；不写公共保存框架、不改 `lib/form.ts`、不改公共 Dialog/ConfirmDialog、无新增依赖。

### 六个 writer 的独占边界

六个 writer 共享当前任务树并行写入（契约时态），不建嵌套 worktree；所有未列文件只读。`account-rbac.test.ts` 仅 testwriter 可写；`roles.tsx` 仅 Roles UI writer，`accounts.tsx` 仅 Accounts writer；其他包新测试独占命名。测试共用 fixture/helper 可读不可改。每包先写诚实行为测试并记录预期失败，再最小实现并绿；简单文案、尺寸、文档修正不为凑红绿造源码字符串测试。writer 之间可能观察到对方未完成的变更，不能把并发中间态误报为最终回归，主会话最终统一复跑。

| 包 | 唯一可写文件（均相对当前 worktree） | 覆盖 | 局部验收命令 |
|---|---|---|---|
| Accounts | `packages/web/src/pages/accounts.tsx`；新 `packages/web/test/accounts-ui-hardening.test.ts` | A2、A3、B3、B4、B7 | `pnpm test:web packages/web/test/accounts-ui-hardening.test.ts packages/web/test/account-rbac.test.ts packages/web/test/dialog-validation.test.ts` |
| Roles UI | `packages/web/src/pages/roles.tsx`；新 `packages/web/test/roles-ui-hardening.test.ts` | A1、B6 | `pnpm test:web packages/web/test/roles-ui-hardening.test.ts packages/web/test/account-rbac.test.ts` |
| RBAC 旧用例 testwriter | `packages/web/test/account-rbac.test.ts` 中旧父级搜索用例（独占，其他包不得写） | A1 测试契约更新 | `pnpm test:web packages/web/test/account-rbac.test.ts` |
| Agents/Chat | `packages/web/src/pages/agents.tsx`、`packages/web/src/pages/chat.tsx`；新 `packages/web/test/restricted-agent-navigation.test.ts`、新 `packages/web/test/expert-permission-empty.test.ts` | A4、A6、A7、B2 | `pnpm test:web packages/web/test/restricted-agent-navigation.test.ts packages/web/test/expert-permission-empty.test.ts packages/web/test/agents-lifecycle.test.ts packages/web/test/agents-ui.test.ts packages/web/test/chat-lifecycle.test.ts packages/web/test/chat-ux.test.ts` |
| Memory/Runtime | `packages/web/src/pages/memory-panel.tsx`、`packages/web/src/pages/memory.tsx`、`packages/web/src/pages/runtime-environment-detail.tsx`；既有 `packages/web/test/memory-editor.test.ts`、`personal-memory-page.test.ts`、`runtime-environments.test.ts`、`expert-panel-controls.test.ts`（必要才改） | B1、B5 | `pnpm test:web packages/web/test/memory-editor.test.ts packages/web/test/personal-memory-page.test.ts packages/web/test/runtime-environments.test.ts packages/web/test/expert-panel-controls.test.ts` |
| Ops/Shared | `packages/web/src/pages/ops.tsx`、`packages/shared/src/access.ts`；新 `packages/web/test/schedule-timezone.test.ts`，必要时 `schedule-feedback.test.ts`；`PRODUCT.md`、`docs/OPERATIONS.md` 已由文档修正项完成，不再扩其它文档 | A5、A8、A9 | `pnpm --filter @agentport/shared build` 后 `pnpm test:web packages/web/test/schedule-timezone.test.ts packages/web/test/schedule-feedback.test.ts packages/web/test/status-feedback.test.ts` |

`docs/tasks/impeccable-ui-audit.md` 由契约 Opus 写入后交回主会话更新；本轮仅更新本记录，六个实施 writer 均不得写。Accounts 与 Roles 局部命令会读到 testwriter 的并发变更，避免把中间态误报为最终回归，主会话最终统一复跑。

### Accounts：账户表单保护、字段错误与角色目录状态（A2/A3 + B3/B4/B7）

- 调用链：`AccountsPage` 条件挂载四个 Dialog；当前 `onOpenChange(false)` 和取消均直达父 `onClose`，`DialogShell.closeDisabled` 只锁 X，不能保护 Esc/外部关闭。`DialogShell` 51–56 行已在 submit capture 后 RAF 聚焦首个 `[aria-invalid="true"]`，因此无需新增聚焦 hook。
- 四表单各自用已有 `useFormBlocker(dirty, mutation.isPending)`，沿用 `memory-review.tsx` 的 `requestClose + discardOpen || blocker.status === 'blocked' + ConfirmDialog` 模式。关闭请求（取消/X/Esc/外部点击）统一先判 pending，pending 不关；dirty 弹同一放弃确认，干净直接关。路由离开和 beforeunload 由 blocker 管，放弃确认在 pending 时禁用并在 handler 再检查。点击确认后只有对应 route proceed 或原 onClose，不触发保存。
- dirty 基准：create 的 businessId/username/name/password 任一非空或 roleIds 非空；edit 的 username/name 与初始 account 原值比较；reset 的 password/confirm 任一非空；assign 的 selected 与 account.roles 的 ID **集合**比较（不看排序；选中再取消恢复干净）。`restore`/错误显示不是新的草稿持久化体系。保存按钮保留既有 pending 语义；edit 未修改和 assign 未修改可禁用提交以免发送空变更。
- 成功仍走原 onClose，不被 dirty 再拦；失败和恢复身份 409 保留输入/角色选择。沿用 memory-review 的 latest blocker ref：若成功时尚有 blocked 导航，先 reset 当前 blocker，再卸载表单，避免成功后继续旧的离开意图或导航 Promise 悬挂。恢复身份确认流程与权限分支不删、不改 payload。
- create 保留现有逐字段错误；补每项 FieldError 稳定 id 与 Input 的 `aria-describedby`。edit 改为 username/name 各自提交后校验（username 非空、name.trim 非空）；reset 改为 password 至少 8 位、confirm 两次相同的逐字段错误。三个表单 Field `data-invalid`、Input `aria-invalid`、`aria-describedby` 与实际 FieldError 一致。API 错误仍留表单级 FieldError；不将服务端错误猜配字段、不改共享 schema 或校验规则。首错顺序遵从 DOM。
- B4：把角色矩阵查询的 loading/error/refetch 状态传入新建与分配弹窗；已有缓存时保留目录内容，加载中用 LoadingState，失败用 ErrorState + 重试；目录未就绪时禁用依赖目录的提交/分配；只有成功且结果为空才显示“没有可分配的角色”。失败不得被伪装成真实空目录，已有选中 roleIds 不因失败自动清空。
- B3 由上述 Dialog.Root 关闭保护覆盖；B7 由字段 id/aria-describedby/aria-invalid 与编辑/重置逐字段校验覆盖，不另造字段框架或共享保存框架。
- 红：参数化覆盖四弹窗 dirty 取消/X/Esc/路由离开保留草稿、确认丢弃、干净关闭；编辑/角色改回初值不提示；deferred mutation 在途时关闭及放弃确认都不能卸载/导航。编辑空 username/name 与 reset 短密码/不一致无请求、字段错误及关联存在、RAF 后焦点在首错，纠正后可提交；角色目录查询加载中/失败不出空态、可重试、未就绪时依赖操作禁用；API 失败保留草稿；成功关闭并取消旧 blocked 导航。复用真实路由 + QueryClient + fetch 受控的现有测试模式，不 mock 掉被验 blocker。

### Roles UI：搜索父级批量与角色名就近错误（A1 + B6）

- 调用链：`filterPermissionTree`（`lib/access.ts`195）仅保留命中叶；`GroupRows`528 的三态来自过滤子树，但 `toggleGroup`202–219 经 `findGroup(tree, key)` 对原始全子树操作。当前可将隐藏叶一并改掉。
- 确定最小方案：`searching` 为真时**所有层级父分组 checkbox disabled**；叶 checkbox 和已授权的 scope ToggleGroup 继续遵从原权限/pending 规则可编辑。清空搜索恢复原父级全子树批量行为和三态。父级 disabled 可用 title 明示“清除搜索后可批量勾选”；无需新提示条、不改 lib/access 公共机制。
- 保留原权限范围、管理员不可修改、冲突处理与完整草稿保存。更新 `findGroup`/toggleGroup 中“搜索时仍批量改全树”的过时注释；如删无必要原树查找，须确认引用且保持非搜索批量同一集合，不引入额外抽象。
- **必须更新旧测试（仅 testwriter 写 `account-rbac.test.ts`）**：`account-rbac.test.ts`624“搜索时点击父级仍勾选完整子树”与新契约相反。先改为：搜索下各层父级禁用，点击不改隐藏叶；可见叶与 scope 可编辑；清空后隐藏叶授权/原 scope 未变化、父级三态正确，重新启用的父级可全选。保留现有“父级全选保留已有 scope”用例。
- B6：复用 `roles.tsx` 现有空名/重复名 invalid 计算，在对应角色名 Input 上设置 `aria-invalid` 并就近显示“名称不能为空”/“与角色 X 重复”，用稳定 id + `aria-describedby` 关联；不能只靠 disabled 保存按钮把唯一错误藏在不可达 submit 分支。若保留 disabled，错误必须在输入变化时即可见。不引入新表单库或共享校验框架。
- 红：搜索下父级禁用且不改隐藏叶、清空后恢复批量；空白名与重复名在对应列出现可见且关联的错误，修正后错误消失并可保存。Roles UI 新用例写入 `roles-ui-hardening.test.ts`，不写 `account-rbac.test.ts`。

### Agents/Chat：受限专家导航、权限空态、卡片主操作（A4/A6/A7 + B2）

- 受限调用链：`AgentDetailPage`1072 在没有 config.read 但有子任务读取权时渲染 `RestrictedAgentTabs`；当前本地 `setTab`1133/1138 直接卸载面板，三个子面板未传 DraftCallbacks。`memory-panel.tsx` 已汇报 dirty/pending 并在卸载清零；`AgentEditor`1647–1807 与3504–3559 已具备 URL + blocker + callbacks 的完整模式。
- B2 与 A4 是同一根因：受限分支没有接入子面板 dirty/pending 与 URL 导航保护，编辑中切任务或离开会卸载草稿。按本节统一修复，不另设第二套保护；相关用例写入 `restricted-agent-navigation.test.ts`、`expert-permission-empty.test.ts`，不使用旧命名。
- `RestrictedAgentTabs` 改为与主编辑器相同的 URL `search.tab` 单一来源（已有 `agents.$agentId.tsx` validateSearch，**无需改路由或 schema**）；只允许 available 任务，无效/无权 tab 回落首项，不请求配置正文。URL schema 现只有 `tab`/`file`，内部 memory/rules/styles 选择保持各自既有 guard，不新增私有 search 字段。`navigate` 用 replace、保留其它 search。传三个子面板 `onDirtyChange`/`onPendingChange`，状态留在此组件；`useBlocker` 同 pathname 同 tab 放行，同路径换 tab 或跨页面在 dirty/pending 时拦截，`enableBeforeUnload` 同步。页签点击 pending 时直接不切；被外部路由/history 触发的切换确认也不能在 pending 时放行。dirty 确认前不变 URL、不卸载，取消保留草稿，确认后再导航。ConfirmDialog 文案沿用主编辑器“放弃并切换/离开”，不新建保存体系、不让子面板借用配置保存。
- 父级接线：给受限组件 `key={agentId}` 防止跨专家复用旧状态；`onPendingChange={setEditorPending}` 使页头/删除动作与主编辑器一致。若需父操作锁，传 `remove.isPending || toggleEnable.isPending` 原始外部 pending，**不得传合并 editorPending 后的 pending 再回报，避免自锁**。子组件自身 callback 在卸载清零。`MemoryPanel/RulesPanel/OutputStylesPanel` 公共源码本包不改。
- 空态按已有 `can(me.data, 'agents.create')`：有创建权沿用创建引导；无创建权两个页面统一标题“暂无可用专家”、说明“当前账户尚未分配可用专家，请联系管理员。”，不声称全平台没有专家、不造申请功能。ChatPage 加现有 meQuery（文件已导入），权限未知时不得短暂显示创建引导；“前往专家”仅在 `can(me.data, 'agents.read')` 时显示，避免导向无权页面。AgentsPage 保留既有创建按钮与筛选空结果分支。
- 卡片671的可用 Link 改用默认 `buttonVariants()`（32px），同卡片禁用 Button679也移除 size sm，保留 outline、disabled/title/aria-label/路由与布局；不改共享 Button、全站按钮或设计规范。尺寸为静态契约，沿用现有 lifecycle 断言/源码对照说明，无浏览器实际测量不称已量出32px。
- 红：真实路由挂载**无 config.read、有 memory/rules/styles.read/write**用户；编辑三种子面板后切任务和跨页均确认、取消草稿保留、确认后 URL/面板切换；deferred 保存/创建请求期间页签和路由不能丢输入；保存失败保留，成功可切；URL 深链与同 pathname history.back 覆盖；断言不发完整配置 GET。另在两个空页面分别覆盖有/无 agents.create、无 agents.read 的 Chat 不出现前往链接。既有 full editor 主路径 regression 必须通过。

### Ops/Shared：UTC、术语来源、已合入状态（A5/A8/A9）

- 定时调用链：ops797 输入“时间（UTC）”，表格321/329调用 `lib/format.ts` 的全局本地 Intl formatter。只在 `ops.tsx` 用本页 `Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month/day/hour/minute, hour12: false })` 格式化 nextDueAt，两处共用本页 formatter/小函数；保持 null/无效值为“—”。表头标“下次触发（UTC）”，窄行标“下次（UTC）”。cron、lastRunAt 相对时间、其它页面/全局 `lib/format.ts` 均不改。
- 红：新测试真实挂载 SchedulesPage，用 nextDueAt=`2026-10-29T09:00:00.000Z` 断言两处时间为09:00且UTC标签可见、null 为“—”；用 `TZ=America/Los_Angeles pnpm test:web packages/web/test/schedule-timezone.test.ts` 确认旧代码因本地01/02点而红，新代码绿，不以默认机器恰在UTC的通过当证据。测试不得只 mock formatter 调用。
- 权限目录115–156仅显示元数据漂移：菜单 `RESOURCE_MENU` 已为“连接器”；授权查 permissionId/scopes，`treePath` 仅构树（lib/access154–175）。把所有 `servers.*` 的 treePath 中“MCP 服务”统一为“连接器”；五个 CRUD/导入 label 改“查看/新建/修改/删除/导入连接器”，`servers.test` 改“测试连接器连接”，token两项改“查看连接器令牌”“轮换连接器令牌”，tools改“管理连接器工具”。**保留全部 servers.* ID、scopes、顺序、依赖、API 和 MCP 协议语义，不做迁移**。更改后先 build shared 再跑消费方，否则 web 仍读 dist 旧标签。（实际实现：CRUD/导入/test label 与所有 `servers.*` treePath 已改；`servers.tokens.*`、`servers.tools.manage` 的 label 保留泛称，见「矛盾与已知限制」。）
- 状态漂移只纠正已确认位置：PRODUCT15/54，OPERATIONS19/20/41及相邻43段；写“已合入 main（ae8407d）”，去掉“本工作树/尚未合入/准备发布”旧状态，不把合入写成已生产发布；保留空库迁移、部署需用户明确决定重建的限制。此项已完成，验证代理确认 diff 仅 `PRODUCT.md`、`docs/OPERATIONS.md` 两个文档；不顺带纠正 OPERATIONS 中其它任务的“未合入”或未知发布状态。
- A8 **本轮不改 status.tsx**：核对到 API 已有同源鉴权 `/api/docs`（`plugins/openapi.ts`45–50），仅提供 Scalar API reference，不能承载 RUNBOOK/OPERATIONS 的故障处置正文；健康手册要在产品内可点击需要新增正文服务，现有 `/api/docs` 不能替代。现有源码路径保留，记录“处置文档仍需仓库访问，产品内不可点击阅读”的未实施限制，不造文档服务、不用 API 文档替换处置步骤造成误导。

### Memory/Runtime：只读不伪装 pending、后台错误保留同一子树（B1/B5）

- B1 调用链：`memory-panel.tsx:461` RulesPanel 把 `!canWrite` 并入 `pending`，`:501`/`:517` 条目与 Select 被禁用；`:766` OutputStylesPanel 同样，`:806`/`:825` 被禁用；`agents.tsx:1157/1165` 按真实写权限传 `canWrite`，是可达分支。影响：有 read 无 write 的用户无法选择现有规则/输出风格，且 `onPendingChange` 把只读持续伪装成请求在途。
- B1 契约：`pending` 只包含真实 mutation 状态；用独立 `readOnly = !canWrite` 禁用创建、保存、删除和编辑输入；条目/文件选择保持可用；向父层回报的 pending 只表达请求。保存/删除仍走原权限与 API，不新增权限结构。
- B5 调用链：`memory-panel.tsx:126` 只查 `memory.isError` 就整面板换 ErrorState；`:255` 卸载原 MemoryFileEditor，草稿在其 `:321` 的 useState；`:77`/`:92`/`:329` 存在使列表失效的路径。`memory.tsx:185`、`runtime-environment-detail.tsx:166` 也无条件 error 替换，但局部 draft 有的留在父 state，影响是中断编辑/焦点，不能一概说永久丢数据。
- B5 契约：首次错误条件改为 `isError && data === undefined`；已有数据时保持同一编辑子树挂载，在旁边给真实错误与重试；先修 memory 列表这条实际丢草稿路径，再统一 `memory.tsx` / `runtime-environment-detail.tsx` 的同类入口。用受控 Query 缓存状态测试，不做真实服务故障注入。
- 红：只读用户能选择现有规则/输出风格、编辑控件禁用、父层 pending 不因只读为真；后台刷新失败时已有数据仍保留编辑器与草稿、出现错误与重试，首次无数据失败才显示 ErrorState。测试写入 `memory-editor.test.ts`、`personal-memory-page.test.ts`、`runtime-environments.test.ts`、`expert-panel-controls.test.ts`（必要才改），不扩到其它文件。

### 合并验收与证据边界

- 各包返回：准确改动文件、红失败原因/绿命令与结果、未覆盖项；均不提交。逐包结果见「实施结果（按包）」。
- 全量验证由主会话执行：shared build 后 web typecheck、`pnpm test:web`、web build、shared typecheck、lint focus/contract，并对修改文件执行 biome check。最终结果见「验证」。
- 修复后 Opus 独立 review 状态按包记录：Roles/Accounts/Ops 通过；Memory/Runtime 定向复核通过；Agents/Chat delete resolver 补修后定向复核通过。全部包 review 已过。
- 源码落地不等于 review 通过；Agents/Chat 功能 review 曾因 delete resolver 未过，补修并通过定向复核后才记为完成。
- 浏览器证据边界：A/B 审查阶段产品页不可达，结论仅来自源码；其后主会话在本树启动 API 3000 / web 4394，p3 登录页无 session。实际只验证登录页 1480×840 与 1024×600：1024 档 `scrollWidth=1024` 无横向溢出，表单宽 320，用户名 Tab→密码。不得写成后台实测通过。
- detector 只执行一次，唯一 `styles.css:235` 15px 告警已按规范确认误报（保留 `md` 15/26），真实新增 detector 问题 0；完整 JSON `/tmp/agentport-ui-audit-20261031-detector.json`。健康评分是源码暂评 design 25/40、tech 14/20，不是修复后分数，也不构成 WCAG AA 证明。
- 临时服务已清理：浏览器 `task.finish keep[]`，本任务临时 API/web 已 `TaskStop`；4394 无监听，3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务。`.vitest/json/output.json` 已精确恢复 HEAD。sidecar stale 仅记录不刷新；共享表格半透明 hover 是既有登记差异，不当新问题；无 commit/push/merge，主 checkout 未动，数据库/Redis 未清。

## 实施结果（按包）

以下为主会话收到并记录的真实结果；源码已落地与 Opus review 状态分开写，不用测试通过代替 review 通过。

### Roles UI（A1 + B6）

- 源码：搜索时所有层级父分组 checkbox 仅 `disabled`，未新增说明 title（契约原写“加说明 title”，实际未加，以代码为准），隐藏叶不会被批量修改；清空搜索恢复原父级全树批量与三态；`account-rbac.test.ts` 旧“搜索时父级仍勾选完整子树”用例已按契约更新。角色名空/重复名复用现有 invalid 计算，在对应 Input 上设置 `aria-invalid`、稳定 id 与 `aria-describedby`，错误就近可见；修正后消失并可保存。
- 测试：新增 5 个用例通过；旧 `account-rbac.test.ts` 23 pass。
- Opus review：通过。

### Accounts（A2/A3 + B3/B4/B7）

- 源码：四个 Dialog 统一走 `useFormBlocker(dirty, mutation.isPending)`，取消/X/Esc/外部点击与路由离开受 dirty/pending 保护，pending 时放弃确认也不能卸载；编辑/角色选择改回初值视为干净。字段错误具备稳定 id、`aria-invalid`、`aria-describedby`，提交后逐字段校验，RAF 后焦点落到首错。角色目录区分 loading/error/refetch 与真实空目录，失败不伪装空态且不清空已有选择；目录未就绪时禁用依赖操作。
- 测试：新增 13 个用例 + `account-rbac.test.ts` 23 = 36 pass；主会话含 `dialog-validation.test.ts` 为 38 pass。
- Opus review：通过。额外 memory 探针 6 pass，属建议项，未固化，非必须。

### Memory/Runtime（B1 + B5）

- 源码：`pending` 只表达真实 mutation，`readOnly = !canWrite` 单独禁用创建/保存/删除/编辑输入，条目与文件选择保持可用；后台刷新失败时已有数据与同一编辑子树保持挂载，旁边显示真实错误与重试，首次无数据失败才显示 ErrorState；`memory.tsx`、`runtime-environment-detail.tsx` 同类入口一并处理。
- 测试：相关 4 个测试文件 60 pass；主会话独立复跑 60 pass。
- Opus review：首次未过 runtime baseline（同 entity dirty 时 `savedRef` 推进、草稿被替换）。已补修：同 entity dirty 不推进 `savedRef`、不替换草稿；场景 A→B→error→retryB→refreshC 保留 B。补修后 runtime 31 tests / 相关 4 files 84 pass。定向复核明确通过（定向 2 tests pass，29 因 filter 跳过）；Memory 其余已过范围按原通过结论，不重审。

### Ops/Shared（A5/A8/A9）

- 源码：`ops.tsx` 用本页 UTC formatter 格式化 `nextDueAt`，表头与窄行均标 UTC，null/无效值为“—”；`packages/shared/src/access.ts` 中全部 `servers.*` 的 treePath 统一为“连接器”，五个 CRUD/导入 label 与 test label 改为“连接器”；`servers.tokens.*`、`servers.tools.manage` 的 label 保留原有“服务令牌/服务工具”泛称，未重命名，保留全部 ID/scope/顺序/依赖/API；`PRODUCT.md`、`docs/OPERATIONS.md` 的合入状态修正已完成。
- 测试：新增 2 个 + schedule 33 = 35 pass。
- review 过程：先报 P2（import 前 TZ 初始化），用 `vi.hoisted` 修复；外部 `TZ=UTC` mutation 删除 timezone 时用例红，恢复后再次 35 pass。Opus review：通过。

### Agents/Chat（A4/A6/A7 + B2）

- 源码：受限专家页签改为与主编辑器一致的 URL `search.tab` 单一来源，无效/无权 tab 回落首项且不请求配置正文；三个子面板接入 dirty/pending 回报与 `useBlocker`/`enableBeforeUnload`，切任务、跨页、history 切换在 dirty/pending 时确认，pending 不放行；父级用 `key={agentId}` 隔离状态并接外部 pending，不合并回报避免自锁。空态按 `agents.create`/`agents.read` 区分创建引导与“暂无可用专家”，Chat 权限未知时不短暂显示创建引导；卡片可用 Link 改默认 `buttonVariants()`（32px），禁用 Button 移除 size sm。
- 测试：新增两个测试文件 15 pass（`restricted-agent-navigation.test.ts` 8 + `expert-permission-empty.test.ts` 7）；`agents-lifecycle.test.ts` 65 pass；Opus 定向复核 1 pass / 7 filter 跳过。
- Opus review：**通过**。补修前返回「不通过 1P2」（delete deferred → blocked navigation → 未取消直接 delete success 卸载 Restricted 时，旧 blockerFn resolver 未结算）；补修后子层登记最新 reset、父层删除 success effect 先结算被拦导航再 `navigate`，新增用例直接断言 blockerFn Promise 先 false 后 true，Opus 定向复核明确「通过」。
- 机械修正：已完成。删除 2 个 unused、import 格式化、3 处 label `htmlFor`/`id` 关联；最终 18 个改动 TS/TSX 经 `rtk bypass pnpm exec biome check` 为 Checked 18、No fixes applied、exit 0。
- URL 范围说明：受限页签只使用现有 search schema 的 `tab`（及既有 `file`），未新增私有 search 字段；memory/rules/styles 的内部选择保持各自既有 guard。

### 全局验证（主会话，2026-10-31，补修后最终）

- `pnpm test:web`：126 files / 1520 passed / 0 failed（日志 key bkh51p4b4）；相对基线 121 files / 1473 passed 新增 47。delete resolver 补修前的旧结果见「已替代项」，不再作为最终结果。
- web typecheck、web build exit 0；lint focus、lint contract exit 0（同批日志 key bgxco5vci）。
- 18 个改动 TS/TSX 经 `rtk bypass pnpm exec biome check` 为 Checked 18、No fixes applied、exit 0；主会话已用 rtk bypass 复核。
- shared typecheck 补修前已通过，补修仅改 web 侧，metadata 未再变，沿用该结果。
- `git diff --check` 通过。
- `.vitest/json/output.json` 已在测试/review 全部结束后精确恢复为 HEAD，`git diff` 为空。
- 修复后 8 个页面 detect 结果均为 `[]` 的执行时点在 runtime 基线与 delete 补修前，未再重扫；JSON 见 `/tmp/agentport-ui-audit-20261031-post-detect.json`。
- detector 初次的唯一 `styles.css:235` 15px 告警已按规范确认为误报（保留 `md` 15/26 档），detector 真实新增问题 0。
- 浏览器 `task.finish keep[]`；本任务临时 API/web 已停止，4394 无监听；3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务。未清数据库/Redis，未动主 checkout。

## 矛盾与已知限制（最终）

- RBAC 合入状态：`PRODUCT.md`、`docs/OPERATIONS.md` 已修正，只写“已合入 main（ae8407d）”，不写成生产部署。
- 设计规范 §9 违例已修：dirty/pending 混淆、后台错误替换编辑子树、字段错误关联、卡片 32px 操作尺寸等本轮实际项均已处理，不再作为未修项。
- 受限页签导航只使用现有 `search.tab` / `file`；memory/rules/styles 的内部选择保持各自既有 guard，未新增私有 search 字段或扩 schema。
- 共享表格半透明 hover 与契约不透明 hover 的差异是既有登记项，本轮不修，不当新问题。
- `packages/web/.impeccable/design.json` sidecar stale 属未授权维护，未刷新；`packages/web/DESIGN.md` 与设计规范未改。
- `packages/shared/src/access.ts`：CRUD/导入/test 的 label 与全部 `servers.*` 的 treePath 已改“连接器”；`servers.tokens.*`、`servers.tools.manage` 的 label 仍保留“服务令牌/服务工具”泛称，未全部 rename，以代码为准，review 已通过。
- roles 搜索态父分组只 `disabled`，未新增说明 title；契约原写“加说明 title”，实际未加，以代码为准。
- 健康手册在产品内不可点击：需新增正文服务，`/api/docs` 不能替代。
- 后台实页视觉/键盘全流程未验证（无登录态），仅登录页两档证据。
- detect 8 页为空执行于 runtime 基线与 delete 补修前，存在时点局限；detector 初次 15px 告警为规范保留 `md` 档的误报。

## 下一步与待核

- 代码交付无：六个包源码、测试与 review 全部完成，整任务无待修代码项。
- 后台实页视觉/键盘全流程未验证（无登录态）；仅登录页 1480×840 与 1024×600 两档有证据。
- 健康手册产品内链接限制保留：需要新增正文服务，现有 `/api/docs` 是鉴权 API reference，不能替代。
- `packages/web/.impeccable/design.json` sidecar stale 属未授权维护，不刷新。
- 用户已于 2026-10-31 明确授权本轮 commit / push / PR / merge；操作结果以 GitHub 真实状态为准，worktree 保留成果，主 checkout 不写入。

## 验证

开工前真实基线（主会话，契约与记录代理未重跑）：

- `pnpm install --frozen-lockfile`、shared/core/db build、web typecheck 已完成。
- `pnpm test:web`：121 files、1473 passed（Vitest/jsdom；scrollTo、navigation 提示不代表真实浏览器）。
- `pnpm --filter @agentport/web build`：通过。
- `pnpm lint:focus`、`pnpm lint:contract`：通过。
- detector：1 条 `styles.css:235` 15px advisory，核对规范后确认误报（保留 `md` 15/26），真实新增问题 0；JSON 见 `/tmp/agentport-ui-audit-20261031-detector.json`。
- 评分：源码暂评 design 25/40、tech 14/20；不是修复后分数，也不是 WCAG AA 证明。

修复后主会话最终完整验证（2026-10-31，delete resolver 补修后）：

- `pnpm test:web`：126 files、1520 passed、0 failed（日志 key bkh51p4b4；相对基线 121/1473 新增 47）。delete resolver 补修前的旧结果见「已替代项」。
- `pnpm --filter @agentport/web typecheck`：exit 0。
- `pnpm --filter @agentport/web build`：exit 0。
- `pnpm --filter @agentport/shared typecheck`：补修前已通过，metadata 未再变，沿用。
- `pnpm lint:focus`、`pnpm lint:contract`：exit 0（同批日志 key bgxco5vci）。
- Impeccable 修复后 detect：8 个页面结果均为 `[]`，执行于 runtime 基线与 delete 补修前，未重扫；JSON 见 `/tmp/agentport-ui-audit-20261031-post-detect.json`。
- Biome：18 个改动 TS/TSX 经 `rtk bypass pnpm exec biome check` 为 Checked 18、No fixes applied、exit 0。
- `git diff --check`：通过。
- `.vitest/json/output.json`：已精确恢复为 HEAD，`git diff` 为空，无生成物差异。

逐包测试证据见「实施结果（按包）」；review 状态与测试通过分开记录，全部包已通过，无未完成项。

浏览器与运行源：

- A/B 审查阶段产品页不可达，A 与 B 结论均仅来自源码，不是后台实测。
- 其后主会话曾在本树启动 API 3000、web 4394；p3 登录页无 session。
- 实际只验证登录页 1480×840 与 1024×600：1024 档 `scrollWidth=1024` 无横向溢出，表单宽 320，用户名 Tab→密码。不得写成后台实测通过，也不代表全站已逐页看过。
- 临时服务已清理：浏览器 `task.finish keep[]`，本任务临时 API/web 已 `TaskStop`；4394 无监听，3000 当前由另一 worktree `knowledge-ux-review` 的 API 占用，非本任务服务；未清数据库/Redis，未动主 checkout。

记录阶段：HEAD 仍为 522182f；本代理仅更新本记录并把 `.vitest/json/output.json` 精确恢复 HEAD，未重新调研源码、未运行测试、未改其它文件、未提交。六个包 Opus review 全部通过，代码交付无待修项；实页视觉/键盘全流程仍未验证，健康手册产品内链接与 sidecar 维护保留已知限制。
