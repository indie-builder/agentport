# 健康状态与审计刷新/筛选/详情反馈（ui-ops-feedback）

## 目标

第十轮界面巡检：处理**健康状态页**与**审计页**在后台刷新、筛选与详情查看过程中的异步反馈。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与桌面端约定。
- 刷新失败、筛选切换、分页加载与导出等操作中，用户能看出「正在发生什么、当前显示的是哪次结果、失败后还能做什么」，不出现静默失败、无解释的禁用或状态回退。
- 不新增依赖、不改后端契约与数据模型、不改设计令牌；不破坏既有健康探测、指标轮询、审计筛选/分页/导出语义。

具体缺陷由 Opus 探索后确定，本轮不预设问题与方案，不凭截图或记忆猜测、不为凑数扩大改动。

## 方案

- 由 Opus 子代理只读探索健康状态页（`packages/web/src/pages/status.tsx`）与审计页（`packages/web/src/pages/audit.tsx`）的刷新、筛选、详情与导出反馈，给出可复现缺陷与根因；主会话据此固定契约与改动白名单后，再交 Sonnet 子代理执行。
- 复用现有实现（`components/states.tsx` 的 `LoadingState`/`ErrorState`、`components/page.tsx` 骨架、`components/data-table.tsx`、`lib/toast.ts`、既有 TanStack Query 配置），不新造等价组件或第二套数据流。
- 最小完整改动；范围之外的重构不做。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-ops-feedback`（分支 `worktree-ui-ops-feedback`）。
- 起点 HEAD `cc1070eb5952a1ebbcb870c24fb44b1ae6cddec0`（PR #90 合并后）；`origin/main` 同为 `cc1070eb5952a1ebbcb870c24fb44b1ae6cddec0`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖；本会话隔离在 worktree，不读取或操作主 checkout 状态。
- 前九轮界面巡检 PR #83–#90 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- 本轮候选改动面（探索起点，非最终白名单）：`packages/web/src/pages/status.tsx`、`packages/web/src/pages/audit.tsx`、相关既有测试、本记录。最终白名单待 Opus 探索后由主会话固定。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权，该授权持续有效；git 交付由主会话执行。
2. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码，只定契约、派发、审查、合并与验证。执行代理不 commit、不再向下派代理，这只是分工限制，不是用户撤销授权。
3. 本轮范围仅健康状态与审计页的刷新、筛选、详情异步反馈；Opus 探索已固定 A（健康指标）、B（审计明细）两项，均已完成。
4. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
5. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段；对齐/间距类改动不靠改类名试错。
6. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。

## 本轮契约（主会话固定）

1. **健康指标（A，执行代理）**：`packages/web/src/pages/status.tsx` 使用自己的 `queryFn`，经 `api.healthMetrics()` 适配器取值；适配器返回 `null`（网络失败或非 200）时抛出明确 `Error`，让查询进入失败态。查询键仍为共享的 `['health-metrics']`，轮询间隔 10 秒。`api.healthMetrics()` 的 `null` 语义保留给冒烟检查与概览页，不改 `api.ts` / `queries.ts`。初始无数据的失败显示「未知」，不得显示零值或编造 Redis/队列具体故障；已有旧数据时网络失败保留旧读数，提示刷新失败并可重试。TanStack Query 在已有数据时失败仍置 `status='error'` 且保留 `data`（`isRefetchError = isError && hasData`），因此页面只需认 `isError`，再以 `data` 是否存在区分「首次读取失败」与「刷新失败」。测试必须经真实 `api` 适配器与受控 `fetch`，不得 mock `healthMetrics` 的返回值掩盖 `null`。
2. **审计明细（B，执行代理）**：`packages/web/src/pages/audit.tsx` 的表格为每行提供 `renderExpanded`，展开内容包含 `actor`、记录 `id` 与 `inputDigest`；`inputDigest` 服务端只返回摘要前缀，页面不得暗示存在原文。审计测试同样以真实页面行为验证，不另造判定逻辑。

## 已替代项及原因

无（本记录初建，尚无被覆盖的决定）。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §2–§3 模板与 `docs/PITFALLS.md` 相关条目（worktree 起点、任务记录位置、文案与 e2e 定位器、几何实测、ego-browser 用法、合并不等 CI），确认记录格式与验证要求。
- [x] 核对基线：HEAD 与 `origin/main` 同为 `cc1070e`，worktree 干净，并记录主 checkout 既有差异归属。
- [x] 创建本任务记录，固定目标、候选范围与执行分工。
- [x] Opus 只读探索健康状态页与审计页的刷新/筛选/详情反馈，给出可复现缺陷与根因。
- [x] 主会话固定契约与白名单，写入本记录。
- [x] Sonnet 实现与真实行为测试（先红后绿），按白名单交付。
- [x] Opus 独立 review 通过，修复发现并复核。
- [x] 按改动范围验证（定向测试、typecheck、Biome，必要时全量 web 套件与 build），更新本记录。
- [ ] 主会话按授权 commit / push / PR / merge，并清理本轮 worktree。

## 改动文件

- `packages/web/src/pages/status.tsx`（A）。
- `packages/web/test/status-feedback.test.ts`（A，新增）。
- `packages/web/src/pages/audit.tsx`（B）。
- `packages/web/test/audit-details.test.ts`（B，新增）。
- `docs/tasks/ui-ops-feedback.md`（本记录）。

## 下一步

主会话按已获完整授权执行 commit / push / PR / merge，并清理本轮 worktree。用户未撤销授权，主会话未亲自改源码；合并与清理结果待执行后回填。

## 验证

基线（2026-10-28，真实输出）：
- `git rev-parse HEAD` → `cc1070eb5952a1ebbcb870c24fb44b1ae6cddec0`
- `git rev-parse origin/main` → `cc1070eb5952a1ebbcb870c24fb44b1ae6cddec0`
- `git status --short` → 无输出（工作区干净）

### A：健康指标（2026-10-28）

根因：`api.healthMetrics()` 把「网络失败」与「非 200」都折成 `null`；`StatusPage` 直接复用
`healthMetricsQuery`，于是 `status` 恒为 `success`。后果有两个：共享缓存里成功时的 `null` 覆盖已
有读数、读数被清空；`metrics.isError` 永不成立，`isRefetchError` 分支的「指标刷新失败」提示
从未出现。四个指标区块的兜底文案还把「整个端点不可达」写成 BullMQ/Redis 具体故障。

改法（`packages/web/src/pages/status.tsx`，未动 `api.ts` / `queries.ts` / 后端）：
- 状态页自带 `queryFn`：`await api.healthMetrics()`，为 `null` 时抛
  `Error('指标端点不可达或返回非 200')`。查询键与 10 秒 `refetchInterval` 仍取自
  `healthMetricsQuery`，概览页与冒烟检查继续使用适配器的 `null` 语义。
- `CheckState` 新增 `unknown`（文案「未知」，沿用既有失败色样式，非新增视觉规范）；四个区块在 `!data` 时
  显示未知而不是「不可用」+ 具体依赖故障推断。
- `PageNote` 按 `data` 区分：无数据为标题「指标读取失败」+「指标端点不可达或返回非 200，各区块
  显示为未知。」；有旧数据为「指标刷新失败」+「以下保留上次成功读取的指标。」。重试按钮
  `disabled={metrics.isFetching}` 保持不变。
- 队列/数据库/Redis 区块的「BullMQ 失败」「读不到连接池指标」「Ping 失败」只在 `data` 存在
  （即端点整体成功、单项为 `null`）时出现，避免把端点失败误报成单个依赖故障。

测试（`packages/web/test/status-feedback.test.ts`，先红后绿）：
首次运行 2 条全红，失败原因符合预期——首次断网时页面显示「不可用」+「BullMQ 查询失败…」
「Ping 失败…」，且没有「指标读取失败」提示。改后：
- `npx vitest run --config packages/web/vitest.config.ts packages/web/test/status-feedback.test.ts`
  → 2 passed / 2。用例经真实 `api.healthMetrics()` + 受控 `fetch`：① 首次断网不出现零值、
  「正常」、BullMQ/Ping 具体故障；② 成功读数 → 网络失败保留旧值并提示刷新失败 → 重试在途
  按钮禁用且旧值保留 → 恢复后清除提示。
- 关联回归：`admin-pages.test.ts` / `overview-health.test.ts` / `run-history-visibility.test.ts`
  → 3 files、32 passed。
- `packages/web` 类型检查 `npx tsc -p packages/web/tsconfig.json --noEmit` → 无输出。
- `./node_modules/.bin/biome check` 两个改动文件 → 无诊断（`pnpm exec biome` 在本树会以
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` 退出且不打印诊断，改用本地二进制）。

限制：实现阶段未跑全量 web 套件与 build、未做浏览器实测；两项已在本轮后续补齐，见「浏览器实测」与「主会话验证」。

### B：审计明细（2026-10-28）

根因：审计表格只有行内列，缺少行级详情；`actor`、记录 `id` 与 `inputDigest` 在窄屏或长值下无法完整核对，而 `inputDigest` 服务端只返回摘要前缀，页面若直接展示或提供原文入口会误导。

改法（`packages/web/src/pages/audit.tsx`）：
- 表格每行提供 `renderExpanded`，展开面板展示 `actor`、记录 `id` 与 `inputDigest`。
- `inputDigest` 为空时显示 `—`；文案只称「输入摘要」，不提供「查看原文」等暗示。
- 复用既有表格展开能力与按钮样式，不新增组件、不改后端契约与筛选/分页/导出语义。

测试（`packages/web/test/audit-details.test.ts`，新增，先红后绿）：新增 4 例在移除 `renderExpanded` 时全红，恢复实现后全绿；审计定向 4 个测试文件、25 tests 通过。

### 浏览器实测（2026-10-28，ego-browser，一次性入口）

范围：仅审计页与健康页的浏览器行为；未改源码、测试与配置，未测读屏、真实 API/数据库与导出。

入口：本树临时 Vite 入口（端口 5199，hash 路由），挂真实 `AuditPage`/`StatusPage` + `src/styles.css`，`QueryClient` 关闭 retry，`fetch` 受控返回固定审计数据与健康阶段。未挂 `AppShell`，故不含侧栏等壳层行为。临时入口已删除、5199 已停、TaskSpace 已 finish。

审计页（首测 1512×838，另测 1024×900）：
- 键盘 Tab 顺序：导出审计 → 刷新 → 按动作前缀过滤 → 按目标精确筛选 → 按状态过滤 → 列设置 → 时间排序 → 耗时排序 → 展开 e0 → 展开 e1 → 展开 audit_xxx（长 ID 行），均为原生 `button`。
- `e0` 按钮 Enter 展开：`aria-expanded` false→true，名称「展开 e0」→「收起 e0」，焦点留在按钮；面板读出 操作者=admin、事件 ID=e0、输入摘要=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6，面板 96px 高。
- 同按钮 Space：`aria-expanded` 回 false、名称回「展开 e0」，焦点仍在按钮。
- `inputDigest` 为 null 的行：输入摘要显示 `—`。
- 筛选隔离：展开 e0 后输入 `auth.`，列表变 2 行且展开态清空；键盘展开 `audit_aaa` 得 bob / audit_aaa / feed…，`audit_zzz` 仍收起。
- 追加分页：键盘聚焦「加载更多」回车，100 → 101 行；e0 详情保持 admin；再展开 `new_row` 得 new-user / new_row / feed…，同时只有该行展开。
- 1024×900：`documentElement.scrollWidth=clientWidth=1014`（无页面横向溢出），表格 scrollWidth=clientWidth=1014、minWidth=824px；206 字符 ID 换行 2 行（926×32，右边界 1002），216 字符 actor 3 行，32 字符摘要 1 行，`overflow-wrap: anywhere`，均未截断。

健康页（同受控 fetch，`/health/metrics` 503→200→503）：
- 首次失败：显示「指标读取失败 / 指标端点不可达或返回非 200，各区块显示为未知。」，进程、队列、数据库连接池、Redis 四区块均为「未知」（4 处），无零值或 Redis/队列故障推断。
- 点「重试」转成功：显示运行时长 1 小时 2 分、内存 RSS 100 MB、Node v24.0.0，队列 等待 2/运行中 1/失败 0，失败提示消失。
- 再刷新失败：显示「指标刷新失败 / 以下保留上次成功读取的指标。」，旧读数全部保留，各区块转「注意」；再点「重试」恢复成功且提示消失。

### 独立 review（2026-10-28，Opus）

- 审计改动独立 review `ae6`：通过，无阻断项。
- 健康改动独立 review `a3e`：通过，无阻断项。
- review 复跑：健康 + 概览 2 个测试文件，8 项全部通过。

### 主会话验证（2026-10-28，真实输出）

- 全量测试：81 files / 794 tests 全部通过（07:24:28 结束）。
- `packages/web` typecheck 通过；`packages/web` build 通过。
- 4 个改动文件 Biome 检查、focus 检查、契约检查均通过。
- 审计定向 4 文件 25 tests 通过；新 4 例移除 `renderExpanded` 时全红，恢复后全绿。
