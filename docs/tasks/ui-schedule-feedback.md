# 定时任务列表/创建编辑校验/启停删除反馈（ui-schedule-feedback）

## 目标

第十一轮界面巡检：处理**定时任务页**（`/schedules`）在列表浏览、创建/编辑校验、启停与删除过程中的反馈问题。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与桌面端约定。
- 列表加载/刷新失败、表单校验失败、保存/启停/删除在途与失败，用户能看出「正在发生什么、哪条失败、失败后还能做什么」，不出现静默失败、无解释禁用或状态回退。
- 不新增依赖、不改后端契约与数据模型、不改设计令牌；不破坏既有 cron 解析、启停、删除与乐观/失效刷新语义。

具体缺陷由 Opus 探索后确定，本轮不预设问题与方案；不凭截图或记忆猜测，不为凑数扩大改动。

## 方案

- 由 Opus 子代理只读探索定时任务页（`packages/web/src/pages/ops.tsx` 的 `SchedulesPage` / `ScheduleDialog`）与相关路由、查询、共享 schema 的现有反馈路径，给出可复现缺陷与根因；主会话据此固定契约与改动白名单后，再交 Sonnet 子代理执行。
- 复用现有实现（`components/states.tsx` 的 `LoadingState`/`ErrorState`、`components/page.tsx` 骨架、`ConfirmDialog`、`useZodForm`/`fieldErrors`、`lib/toast.ts`、既有 TanStack Query 配置），不新造等价组件或第二套数据流。
- 最小完整改动；范围之外的重构不做。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-schedule-feedback`（分支 `worktree-ui-schedule-feedback`）。
- 起点 HEAD `6db7a98d21a9cfd788f24acd1c43b9c495ff103e`（PR #91 合并后）；`origin/main` 同为 `6db7a98d21a9cfd788f24acd1c43b9c495ff103e`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --porcelain` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖；本会话隔离在 worktree，不读取或操作主 checkout 状态。
- 前轮界面巡检 PR #83–#91 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- 本轮候选改动面（探索起点，非最终白名单）：`packages/web/src/pages/ops.tsx`（定时任务相关部分）、`packages/web/src/routes/_shell/schedules.tsx`、相关既有测试、本记录。最终白名单待 Opus 探索后由主会话固定。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权，该授权持续有效；git 交付由主会话执行。
2. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码，只定契约、派发、审查、合并与验证。执行代理不 commit、不再向下派代理，这只是分工限制，不是用户撤销授权。
3. 本轮范围仅定时任务列表、创建/编辑校验、启停与删除反馈；其余页面反馈另行立项，不虚构问题。
4. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
5. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段；对齐/间距类改动不靠改类名试错。
6. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。
7. 已知前缀：cron 有效性由共享 `scheduleInputSchema` 与后端 `isSchedulableCron` 判定；前端校验文案需与后端术语一致，主会话定契约时不得单方面放宽或另造判定。

## 实施契约（主会话固定，探索后）

1. **ScheduleDialog 路由/刷新保护**：复用 `useFormBlocker(dirty, pending)` 与现有 `ConfirmDialog`；弹层自身关闭（关闭按钮、遮罩、Esc、取消）继续走既有 `confirmDiscard` 流程，不删不改。路由离开由 `blocker.status === 'blocked'` 弹出同一个「放弃未保存的更改？」标题；取消 `blocker.reset?.()` 保留草稿与当前路由，确认 `blocker.proceed()` 真正离开。`pending` 时禁止离开与关闭（确认按钮 disabled、`close()` 早退）。`enableBeforeUnload` 由 blocker 自动覆盖刷新。未修改不弹路由确认。
2. **成功关闭不留悬挂 resolver**：保存成功在 `onClose` 前用 `blockerRef.current.reset?.()` 取消期间被拦下的导航（延迟到下一次渲染的闭包读不到新 blocker），再卸载弹层；`blockerRef` 每次渲染同步。
3. **删除成功焦点**：页头「新建定时任务」按钮加 ref；行删除按钮 `onClick` 先把删除成功标记重置为 false；`ConfirmDialog.onConfirm` 在 `remove.mutateAsync` 成功后置 true；`finalFocus` 仅在成功时返回页头创建按钮，失败/取消返回 `null` 交回默认行为。不以 `isConnected` 判断，因为列表缓存里的行按钮可能仍在 DOM。保留既有 pending、错误 toast 与取消语义。
4. **测试**：新增 `packages/web/test/schedule-feedback.test.ts`，真实 `SchedulesPage` + Router + QueryClient + 受控 `api` spy，不 mock query state；恰好两个 describe（草稿导航、删除焦点）。先红后绿，红因必须是草稿静默丢失/`activeElement` 为 body。
5. **白名单**：只改 `packages/web/src/pages/ops.tsx`、新增 `packages/web/test/schedule-feedback.test.ts`、更新本记录。不改后端 API、依赖、令牌、e2e 定位器；不引入临时 visual 检查。

## 已替代项及原因

无（本记录初建，尚无被覆盖的决定）。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目（worktree 起点、任务记录位置、文案与 e2e 定位器、几何实测、ego-browser 用法、合并不等 CI），确认记录格式与验证要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `6db7a98`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 创建本任务记录，固定目标、候选范围与执行分工。
- [x] Opus 只读探索定时任务列表、创建/编辑校验、启停/删除反馈，给出可复现缺陷与根因：① `ScheduleDialog` 只对弹层自身关闭做 dirty 确认，路由离开/刷新直接丢草稿；② 删除成功后没有 `finalFocus`，确认框卸载时原行按钮已随列表刷新移除，焦点落到 `body`。
- [x] 主会话固定契约与白名单，写入下方「实施契约」。
- [x] Sonnet 实现与真实行为测试（先红后绿），按白名单交付。
- [x] Opus 独立 review 通过（`a466` 未发现功能 blocker，指出测试缺口；补强后 `a76` 最终通过）。
- [x] 按改动范围验证（定向测试、typecheck、Biome、焦点与契约检查），更新本记录；全量 build/web 套件已由主会话补齐。
- [ ] 主会话按授权 commit / push / PR / merge，并清理本轮 worktree（交付 pending；已无冲突合并 `origin/main` 的 PR #92 至 `6eaecce`，新依赖验证通过且集成 Opus review 已通过，见「并发集成已验证」；主会话立即 push / PR / merge / 清理）。

## 改动文件

- `packages/web/src/pages/ops.tsx`（`SchedulesPage` 删除焦点、`ScheduleDialog` 路由/刷新保护）。
- `packages/web/test/schedule-feedback.test.ts`（新增行为测试，2 个 describe）。
- `docs/tasks/ui-schedule-feedback.md`（本记录）。

## 下一步

1. 集成后的 Opus review `ad1dc` 已通过：任务源码与测试 hash 不变，Query / Router / resolver / Base UI 相关 API 语义未回归。
2. 主会话立即在本 worktree 推送、开 PR、合并并清理 worktree；完整授权持续有效。

## 并发集成已验证

- 本任务起点固定为 `6db7a98`（PR #91 合并后）；`07:57` 起记录的验证均在旧依赖上完成。该轮全套首跑为知识管理 1 例失败、798 通过，随后定向 68 例与全套 799 例均通过；失败原因未确认，按偶发/环境待观察保留，不作「已修」声明。
- 期间 `origin/main` 前进到 PR #92 技术升级（`6b41754`）。已在该提交上无冲突合并，集成提交 `6eaecce`；任务源码与测试的 hash 未变，集成未改动本任务产出。
- 新锁安装成功。`08:03:35` 主会话在新依赖下 `test:web` → `82 files / 799 passed`；`web` typecheck、build 均通过；两个改动文件的 Biome 检查、`lint:focus`、`lint:contract` 全部通过。即新依赖下全套与按改动范围验证均通过。
- 因此旧依赖上的偶发失败不代表新依赖，新依赖结果是全套通过；但未在该失败用例上单独复现或归因。
- 集成后的 Opus review `ad1dc` 通过：任务源码与测试 hash 不变，Query / Router / resolver / Base UI 相关 API 语义未回归。
- 下方「浏览器验证（browser）」是升级前、旧依赖上的结果；新依赖只做了上述自动化重验，未重跑浏览器。

## 验证

基线（2026-10-28，真实输出）：
- `git rev-parse HEAD` → `6db7a98d21a9cfd788f24acd1c43b9c495ff103e`
- `git rev-parse origin/main` → `6db7a98d21a9cfd788f24acd1c43b9c495ff103e`
- `git status --porcelain` → 无输出（工作区干净）

实现（2026-10-28，真实输出）：
- 红：新测试对旧实现 5 例中 3 例失败，原因分别为 `unloadPrevented()` 为 false（草稿静默丢失）、`activeElement` 为 `<body>`（删除成功后焦点失落）；未修改离开与删除失败焦点本就正确，保留为回归。
- 绿：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/schedule-feedback.test.ts` → `5 passed`。
- 相关套件：`schedule-feedback`、`eval-navigation`、`dialog-validation`、`resource-navigation`、`status-feedback` → `5 files / 27 passed`。
- `pnpm --filter @agentport/web typecheck` → `tsc -b` 无错误。
- `pnpm exec biome check packages/web/src/pages/ops.tsx packages/web/test/schedule-feedback.test.ts` → `Checked 2 files … No fixes applied`（已先 `--write`）。
- `pnpm lint:focus` → 焦点/边框规约校验通过。
- `pnpm lint:contract` → project contract OK。
- 浏览器实测：初稿未做（本轮不启用临时 visual），后续已用 ego-browser 在真实浏览器补齐，见下方「浏览器验证（browser）」；该节为最终事实。

测试补强（2026-10-28，review 证据缺口；只加强用例，不改源码）：
- 原「保存中」用例先点「取消」已 reset，无法证明保存成功后由 `finish` 结算 resolver。现改为：真实 `history.block` 包装捕获 `useBlocker` 产生的 Promise → 保存 pending 时触发路由离开 → 不取消，确认「正在保存，请等待请求完成。」弹层打开且仍在 `/schedules` → 保存 resolve → 断言被拦导航 Promise 返回 `true`（取消导航）→ 仍停留当前页、弹层已关、`beforeunload` 不再阻止 → 再次导航正常到达 `/away`。
- 反事实：临时移除 `ops.tsx` `finish` 中的 `reset` 后重跑，断言失败为 `expected 'pending' to be true`（用哨兵赛跑避免挂成超时）；恢复后源码 `shasum` 不变，仍为 `01fa30116b29d20c8efc8243441d56bce47d5090`。
- 最终定向测试：`schedule-feedback.test.ts` → `5 passed`；`biome check ops.tsx + test` → `Checked 2 files … No fixes applied`（exit 0）。

未做/限制：未改后端 API、依赖、设计令牌与 e2e 定位器。

全量与复核（2026-10-28，主会话真实输出）：
- `07:57` 全套 web 套件首跑：知识管理 1 例失败、798 通过；随后定向 68 例全过、全套再跑 799 全过。失败原因未确认，不再声称「已修」——该用例与本轮改动无交集，按偶发/环境待观察记录。
- `07:58:16` 主会话全套 `82 files / 799 passed`。
- `typecheck`、`build`、`biome check`、`lint:focus`、`lint:contract` 均通过。
- Review：源码 review `a466` 未发现功能 blocker，仅指出测试缺口 → 补强「保存 pending 不取消导航」用例（真实 `history.block` 捕获 Promise，断言返回 `true`），反事实移除 `reset` 后该用例转红（`expected 'pending' to be true`），恢复源码 `shasum` 不变；Opus `a76` 最终通过。
- 临时 probe 入口全部删除，Vite 已停止，space `ui-schedule-feedback` 已 finish。

## 浏览器验证（browser）

日期 2026-10-28，ego-browser（space 固定名 `ui-schedule-feedback`，page `p1`）。**本节为升级前、旧依赖上的验证；合并 PR #92 后未重跑浏览器，新依赖只做了自动化重验（见「并发集成已验证」）。** 临时真实 `SchedulesPage` + 全局 `styles.css` + TanStack Router（BrowserHistory）+ QueryClient，受控 `window.fetch` 提供 `/api/agents`、`/api/schedules`，保存/删除可挂起（gate）或置 500；独立 Vite 5199，无真实登录/数据库/模型。本节取代上文「浏览器实测未做」的旧表述（该句已同步改写）。

实际观测（真实事件、DOM 状态、焦点；均为 `page.evaluate` 读数）：

1. 编辑「Morning report」改名 `Unsaved name` 后按浏览器后退：出现标题「放弃未保存的更改？」；`location.pathname` 已是 `/other` 但页面仍是「定时任务」、编辑弹层 `data-slot=dialog-content` 仍在、`#schedule-name` 值为 `Unsaved name`；确认层内「放弃并离开」`disabled=false`。同时 `document.querySelectorAll('h1').length === 1`。
2. 点「取消」：路径回到 `/schedules`，确认层从 DOM 移除（点击到 querySelector 为 0 的实测 ≈2006ms，含 Base UI 退场/焦点恢复），草稿值仍为 `Unsaved name`，`beforeunload` 仍 `defaultPrevented=true`；再次后退重新弹确认。
3. 点「放弃并离开」：路径 `/other`、`h1` 为「其他页面」、`dialog-content` 数量 0、`#schedule-name` 为 null、`beforeunload` `defaultPrevented=false`；草稿确实丢弃、阻断未残留。
4. 保存 pending 时后退：确认层文案「正在保存，请等待请求完成。」，「放弃并离开」`disabled=true`、`aria-busy=false`，编辑弹层「取消」「保存中…」均 `disabled=true`；点确认层「取消」保持 `/schedules` 与编辑弹层。放行保存后：编辑弹层自动关闭、路径仍在 `/schedules`，行名变为新名称（列表已失效重取），随后再后退直接离开、不再弹确认（无悬挂阻断）。
5. **Esc 观测（已澄清，非偏差）**：pending 时按 `Esc`，确认层进入 `data-ending-style` 并在约 2s 内从 DOM 移除、路径回到 `/schedules`，保存继续并在放行后完成（工具栏出现「定时任务已更新」）。`Esc` 仅取消这一次被阻断的**离开尝试**：编辑器弹层与保存请求都保留，无草稿丢失、不发取消请求，符合 close 保护目标（不关闭处于 pending 的编辑器）。因此不判为缺陷，也不改 `ConfirmDialog` 的公共语义；确认按钮禁用、离开被取消均已成立。非 pending 的 dirty 状态 Esc 行为相同（取消离开、保留草稿）。
6. 键盘删除：聚焦行「删除 Morning report」按 Enter 打开确认，Tab 两次到「删除」按 Enter；成功后 `tbody` 行数 0、焦点为 `[data-slot="page-header"] button`（「新建定时任务」），路径仍在 `/schedules`。
7. 取消/失败：取消后焦点回到原行「删除 Morning report」按钮；删除置 500 时确认框保持打开并出现错误 toast（服务端错误统一文案），点取消后焦点同样回到原行按钮，列表行保留，焦点未跳到页头新建按钮。

限制：临时入口只渲染 `SchedulesPage`（路由 `_shell` 为简化壳），未加载真实 AppShell 与登录流程；页面内可点路由链接被模态遮罩拦截（真实用户同样点不到），离开路径统一用浏览器后退；未做几何/逐帧检查（本轮只验事件、DOM 状态与焦点）。
