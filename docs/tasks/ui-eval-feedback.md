# 评估跑批/停止/结果查看异步反馈（ui-eval-feedback）

## 目标

第九轮界面巡检：处理**评估页**跑批启动、停止、运行历史与结果查看过程中的异步反馈。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与桌面端约定。
- 启动跑批、停止后续用例、组合运行详情与结果导出，用户在点击/轮询期间能看出「正在发生什么、是否已有旧结果、结果是否还会更新」，不出现静默失败或无解释的禁用/空态。
- 不新增依赖、不改后端契约与数据模型、不改设计令牌；不破坏既有跑批、取消、轮询、比较与导出语义。

具体缺陷由 Opus 探索后确定；本轮只处理以下两项已确认缺陷，不凭截图或记忆猜测、不为凑数扩大改动。

## 方案

本轮确认两项缺陷，契约固定如下（白名单：`packages/web/src/pages/eval.tsx`、`packages/web/test/eval-feedback.test.ts`（新增）、本记录；不改 API / backend / 依赖 / 设计令牌 / `lib/queries.ts`）。

### 契约 1：运行详情有缓存时后台刷新失败不得卸载结果

- 根因：`EvalRunResults` 用 `detail.isError` 直接 `return` 整块 `ErrorState`；TanStack Query 的 `isError` 在「已有 data 的轮询/手动刷新失败」时同样为 true（data 保留），于是已展示的结果、失败原因、导出入口与展开的输出一起被卸载。
- 契约：整块 `ErrorState` 只用于**没有 data** 的失败（实现用 `!detail.data` 判断，TypeScript 据同一判断诚实收窄，不用非空断言）。有 data 时保持同一结果树、导出按钮、失败原因 `PageNote` 与 `CodeBlock` 展开状态；在其上方追加共享 `ErrorState`，标题固定为「刷新失败，内容仍是上次结果」，沿用其 `refetch` 重试入口。
- 重试 pending 期间旧的错误条与旧结果都保留；成功刷新后结果内容与终态（`running`→`succeeded`、导出由禁用变可用）更新，错误条消失。首次 pending 显示 `LoadingState`、无 data 的初始失败显示默认标题「内容没有加载出来」、空结果文案不变。

### 契约 2：已有运行中的批次时禁止再次启动

- 根因：`startDisabledReason` 只覆盖启动中、专家/用例加载与缺失、无用例等，未覆盖 `runningRun`；「运行评估」按钮仍可点，只能等后端 `EVAL_RUN_IN_PROGRESS` 拒绝（静默的往返失败），且无就近原因。
- 契约：`runningRun` 存在时 `startDisabledReason` 追加明确原因「已有评估正在运行，请等待结束或先停止」（与后端「已有正在运行的评估」术语一致），按钮 disabled 并由现有 `eval-start-reason` 就近显示；`startRun` handler 复用同一 `startDisabledReason` 提前返回，不只靠视觉禁用。
- 停止请求 pending 或失败时启动继续禁用；停止请求成功后若列表仍报告 `running` 也继续禁用，只有 `eval-runs` 刷新确认终态才恢复。既有停止语义（只停止后续用例、不撤销已执行 run）、URL 切换专家、分页、partial results 与草稿行为不变。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-eval-feedback`（分支 `worktree-ui-eval-feedback`）。
- 起点 HEAD `998744a203361d0296abfccd677aeee40c60c100`（PR #89 合并后）；`origin/main` 同为 `998744a203361d0296abfccd677aeee40c60c100`，与声明起点一致（本地 `main` 为 `917d84c`，较旧，不作对齐依据）。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖；本会话隔离在 worktree，不读取或操作主 checkout 状态。
- 前八轮界面巡检 PR #83–#89 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- 本轮白名单：`packages/web/src/pages/eval.tsx`、`packages/web/test/eval-feedback.test.ts`（新增）、本记录；白名单外一律不改。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权，该授权持续有效；git 交付由主会话执行。
2. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话只定契约、派发、审查、合并与验证。执行代理不 commit、不再向下派代理，这只是分工限制，不是用户撤销授权。
3. 本轮范围仅为契约 1、契约 2 两项已确认缺陷；其余评估页反馈另行立项，不虚构问题。
4. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
5. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段；对齐/间距类改动不靠改类名试错。
6. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。
7. 浏览器验收由主会话另行安排并行验收，本执行会话先交代码与定向自动化验证；未测项在「验证」段如实标注，不编造。

## 已替代项及原因

无（本记录初建，尚无被覆盖的决定）。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目（worktree 起点、任务记录位置、文案与 e2e 定位器、几何实测、ego-browser 用法、合并不等 CI），确认记录格式与验证要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `998744a`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 创建本任务记录，固定目标、候选范围与执行分工。
- [x] Opus 只读探索评估页启动/停止/结果查看，给出可复现缺陷与根因（契约 1、契约 2 两项）。
- [x] 主会话固定契约与白名单，写入本记录。
- [x] 执行实现与真实行为测试：先红（5 条用例中 3 条按预期失败），后绿。
- [x] Opus 独立 review 通过、无阻断问题（`aee2`，由主会话派发）；最终补验见「补验」段。
- [ ] 主会话按授权 commit / push / PR / merge，并清理本轮 worktree（进行中，不预填结果）。

## 改动文件

- `packages/web/src/pages/eval.tsx`：详情刷新失败分支改为「无 data 才整块报错 + 有 data 追加刷新失败提示」；`startDisabledReason` 增加运行中原因，handler 复用该原因阻止启动。
- `packages/web/test/eval-feedback.test.ts`（新增）：真实 `EvalPage` + Router + 真实 `QueryClient` + 受控 `api` Promise，覆盖两条契约与无 data 初始失败。
- `docs/tasks/ui-eval-feedback.md`（本记录）。

未改 `lib/queries.ts`、API、backend、依赖、设计令牌。临时浏览器入口已删除、ego-browser space 已清理。

## 下一步

1. 主会话按已有完整授权直接 commit / push / PR / merge 并清理 worktree（尚未合并，不预填结果）。

## 验证

基线（2026-10-28，真实输出）：
- `git rev-parse HEAD` → `998744a203361d0296abfccd677aeee40c60c100`
- `git rev-parse origin/main` → `998744a203361d0296abfccd677aeee40c60c100`
- `git status --porcelain` → 仅本树原有 `.vitest/json/output.json`（测试报告运行产物）与本轮新增文件

定向测试（2026-10-28，真实输出）：
- 红阶段：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/eval-feedback.test.ts` → 5 tests / 3 failed。失败原因为：刷新失败时结果区整块变成「内容没有加载出来」并丢掉 Result One 与展开输出；运行中批次缺「已有评估正在运行」原因且按钮仍可点；停止 pending 时 `停止中…` 尚未出现（该条为测试自身时机，已在实现前改为 `waitFor`，不冒充缺陷）。

  实现前再次只回退契约 1 复验：同命令 1 failed / 4 passed，失败断言为缺少「刷新失败，内容仍是上次结果」，符合预期。
- 绿阶段：同命令 → 5 passed；连续重复 5 次均 5 passed，无抖动。
- 邻近套件：`eval-feedback` + `eval-navigation` + `eval-runs-pagination` + `admin-pages` + `admin-errors` → 5 files / 35 tests passed。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ 通过，无输出；收窄用 `!detail.data`，无非空断言。
- `pnpm exec biome check packages/web/src/pages/eval.tsx packages/web/test/eval-feedback.test.ts` → 先 `--write` 一次（实现处的三元缩进与测试换行），复核 `No fixes applied`。

未测/限定（实现阶段）：
- 实现阶段未跑完整 `pnpm test:web` 与 web build、未做浏览器实测；两项后续已由主会话与浏览器代理补做，见下方「补验」。
- 未覆盖真实登录/DB/后端：测试用受控 `api` Promise，只覆盖本次两条改动路径。
- 运行详情「失败原因 `PageNote`」在刷新失败时仍在同一结果树内（与结果、导出相同分支），未单独写断言。
- 本树 `.vitest/json/output.json` 为测试运行自动产物；如需还原由主会话确认归属后处理，本轮未提交。

## 补验（实现阶段后）

以下为主会话与浏览器代理的真实最终补验，替代上方「实现阶段未跑」的限定：

- 独立评审：Opus `aee2` 独立评审 → 通过，无阻断问题。
- 完整前端测试：`pnpm test:web` → 79 files / 788 tests 全部通过（2026-10-28 06:51:46）。
- `pnpm --filter @agentport/web typecheck` 与 web build → 均成功。
- `pnpm exec biome check`（2 个改动文件）与 focus / 契约检查 → 均通过。
- 浏览器验收见下节；测试用临时入口进程与 ego-browser space 均已清理。

## 浏览器实测（browser）

环境（2026-10-28，真实 ego-browser 输出）：一次性真实 `EvalPage` + `styles.css` + 真实 Router/QueryClient，`window.fetch` 按 `test/eval-feedback.test.ts` 的响应 fixture 受控模拟 `/api/agents`、`/api/eval/cases`、`/api/eval/runs`、`/api/eval/runs/:id`、`cancel`；端口 5199，无真实登录 / DB / 后端，未改依赖或配置；ego-browser space `ui-eval-feedback`（id 108），视口 1024×800。临时入口与原样删除后 `git status` 仅剩本任务既有的 `eval.tsx`、测试与记录三处改动。

路径 1（展开 running 批次 → 详情刷新失败 → 重试恢复终态）：
- 展开后出现 `role="status" aria-busy="true" aria-label="加载中"`；加载完成显示 `Result One`，`导出结果` `disabled=true`、`title="运行结束后可导出"`、`aria-busy="false"`。展开「内容过大，点击查看」后 `<pre>` 文本 65537 字符，按钮变「收起内容」。
- 详情刷新失败：`role="alert"` 首行「刷新失败，内容仍是上次结果」，次要行为统一错误文案；`Result One`、`收起内容`、65537 字符 `<pre>` 仍在同一结果树内，`导出结果` 仍 `disabled=true`，「重试」可聚焦（`tabIndex=0`）。上方元素均为 19 个按钮中的既有控件，未新增禁用或空态。
- 点「重试」进行中：旧错误条与 `Result One`、65537 字符 `<pre>` 均保留；焦点仍在「重试」。成功刷新后错误条消失，出现 `Result Two`/「新输出」，`导出结果` `disabled=false`，「收起内容」保留。此时列表行仍显示「运行中」徽标（列表查询未被详情刷新触发，真实环境靠 3s 轮询收敛），不作为缺陷结论。
- 焦点：展开按钮由 `aria-expanded="false"` 变 `aria-expanded="true"`、标签变「收起 evalRun_running」，焦点留在该按钮；重试成功后「重试」按钮卸载，焦点回落到 `BODY`。重试期间「重试」按钮无 `aria-busy`/`disabled` 变化，仅作事实记录。

路径 2（running 有 cases 时禁止启动 / 停止 pending 与失败 / 终态恢复）：
- 初始：`运行评估` `disabled=true`、`aria-busy="false"`、`aria-describedby="eval-start-reason"`，`#eval-start-reason` 文本「已有评估正在运行，请等待结束或先停止」；停止按钮为「停止后续用例」`disabled=false`。对 disabled 按钮执行脚本 `.click()` 后 `posts` 仍为空，未发出 `POST /api/eval/runs`。
- 点停止（pending，响应延迟 3s）：按钮变「停止中…」`disabled=true` `aria-busy="true"`，启动继续 `disabled=true` 且原因可见；仅发出 1 次 `POST /api/eval/runs/evalRun_running/cancel`。
- 停止请求失败：按钮恢复「停止后续用例」，启动仍 `disabled=true`、原因仍在；随后第二次停止成功但列表仍报告 running，启动仍 `disabled=true`、原因仍在；列表刷新出现终态后启动 `disabled=false`、`aria-describedby` 与 `#eval-start-reason` 同时消失、停止按钮消失，全程 `posts` 只有 2 条 cancel，无启动 POST。
- 1024 桌面：初始与失败态 `documentElement.scrollWidth === clientWidth === 1024`，无页面级横向溢出；唯一超宽元素是 `overflow-auto` 代码区内的单行 `<span>`（right≈471884），属既有横向滚动容器内部，不计为页面溢出。未做全站缩放与动画帧检查。

未测/限制：`Page.captureScreenshot` 连续两次 CDP 超时，未取得截图，视觉结论仅基于 DOM 文本、`disabled`/`aria-busy` 与几何数值；未覆盖首次加载失败（无 data）分支、空结果分支与真实 stop-during-run 后端语义；临时入口与脚本已全部删除，未改业务源码或现有测试。
