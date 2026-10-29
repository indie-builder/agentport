# 知识库 Web 三项已证实修复

## 目标

修复代码库 review 已证实的三处知识库 Web 缺陷，每处先用真实行为测试复现再最小修复：

1. **详情页缓存刷新失败卸载编辑区**：`knowledge-detail.tsx` 只用 `base.isSuccess` 挂载 Tabs 与编辑弹层。Query 已有缓存 data、后台刷新失败时 `isSuccess` 变 false，未保存的手写/Wiki 编辑器被卸载。验收：有缓存时编辑区保持挂载；首次无 data 失败才整块替换；缓存刷新失败给出明确错误与重试，重试成功后恢复。
2. **新建库内联 profile 成功后外层 pending 不结算**：`knowledge.tsx` 的 `CreateBaseDialog` 把 `profilePending` 纳入父 `pending`，空 profiles 时渲染 `NewEmbeddingProfile`；创建成功后 profiles 刷新使子表单卸载，子组件无法再回报 pending，父层永久禁用创建/关闭。验收：deferred POST 期间确实处于 pending；POST 仍挂起时另一次真实 GET 先看到新 profile 并卸载子表单，释放 POST 后父层结算 pending/dirty、回填正确 profile，可继续创建知识库并关闭弹层。
3. **模型配置并行测试结果互相覆盖**：`knowledge-settings.tsx` 的 `test` 用 `setResults({ ...results, ... })` 闭包，两个并发测试完成顺序交错时覆盖对方结果，按钮可能永久停在「测试中…」。验收：两个 deferred 测试真实乱序完成（先发的后完成），其中一次以 HTTP 错误走 catch，另项结果保留且两个按钮都恢复。

## 方案

- 详情页：以 `base.data !== undefined` 判断是否保留内容；无 data 且 `isError` 保留现有整块 `ErrorState`，有 data 且 `isError` 在 Tabs 上方渲染带重试的 `ErrorState`（标题明确为刷新失败）。复用共享 `states.tsx`，不新建状态组件。
- 新建库：内联 profile 创建改用 `mutateAsync`，在异步延续里成功回填、失败 toast，并在 `finally` 结算父 pending；父层 `onCreated` 继续清 dirty 并设置 embedding 值。即使 profiles 刷新先卸载子表单、per-call `onSuccess` 不再触发，仍能结算。
- 模型配置：`setResults` 改为函数式更新 `(prev) => ({ ...prev, [id]: next })`，并发请求各写自己的键。
- 测试：使用真实 TanStack Query 与 MSW deferred；缓存场景通过真实 `queryClient.invalidateQueries` 触发 refetch 失败（不是静态 mock 状态），断言编辑节点存活与正文保留。建库场景在 POST 挂起时用真实 `invalidateQueries` 让 GET 看到新 profile，先断言子表单卸载，再释放 POST。

## 基线与范围

- 起始 commit：`e060e3a559633a0d94adb637516a6d577b86b1aa`（与任务声明一致）。
- 开工时本范围状态：`docs/tasks/codebase-review-loop.md` 为未跟踪文件，属主任务记录，不修改；本任务新增 `docs/tasks/codebase-review-web-knowledge.md`。
- 允许改动文件（独占）：
  - `packages/web/src/pages/knowledge.tsx`
  - `packages/web/src/pages/knowledge-detail.tsx`
  - `packages/web/src/components/knowledge-settings.tsx`
  - `packages/web/test/knowledge-management.test.ts`
  - `packages/web/test/knowledge-settings.test.ts`
  - `docs/tasks/codebase-review-web-knowledge.md`
- 不改其他源码、测试、配置、主任务记录；不提交。

## 当前有效决定

- 不派子代理、不提交（用户本轮明确要求）。
- 入口不重复校验、不新造状态/弹层框架，不改桌面视觉数值，不新增冗余文案。
- 先诚实红（确认失败原因）再最小绿；完整跑相关 web 套件与 web typecheck / biome。
- 测试已有 mock 不代表真实 Query 行为：缓存用例必须触发真实 refetch error 并检测真实编辑生命周期；建库用例必须在 POST 仍挂起时由真实 refetch 先卸载子表单，再释放 POST。
- 内联 profile 成功路径不依赖 per-call mutation 回调：改用 `mutateAsync` 异步延续回填，`finally` 结算父 pending，保留错误 toast 与 dirty 语义。

## 已替代项及原因

- 建库测试原先在 deferred POST 内 `setQueryData` 后立即返回响应，未在 POST 挂起时确认卸载：无法覆盖「真实 GET 先卸载、per-call 回调被跳过」的时序，已改为 POST 挂起时真实 `invalidateQueries` 两阶段验证。
- 建库成功结算原先只放在父层 `onCreated`（依赖子组件 per-call `onSuccess`）：卸载后回调不触发，已由子组件 `mutateAsync` 异步延续 + `finally` 结算替代。

## 步骤

- [x] 给三处各写一条会失败的行为测试并确认红的原因符合预期
- [x] 详情页以缓存 data 保留 Tabs/编辑区，刷新失败显示可重试错误
- [x] 新建库父层在 profile 创建成功后结算 pending/dirty
- [x] 模型配置测试结果改为函数式更新
- [x] 按 review 重写建库测试：POST 挂起时真实 refetch 先卸载子表单，再释放 POST
- [x] 内联 profile 创建改用 `mutateAsync` 异步延续，`finally` 结算父 pending
- [x] 并行 results 测试改为真实乱序完成且一次 HTTP 错误走 catch
- [x] 重跑相关 web 测试、web typecheck、biome 并记录真实输出
- [x] 更新本记录并通过独立 Opus 限定复核与主会话复跑

## 改动文件

- `packages/web/src/pages/knowledge-detail.tsx`
- `packages/web/src/pages/knowledge.tsx`
- `packages/web/src/components/knowledge-settings.tsx`
- `packages/web/test/knowledge-management.test.ts`
- `packages/web/test/knowledge-settings.test.ts`
- `docs/tasks/codebase-review-web-knowledge.md`

## 下一步

无待办。三项已完成，独立 Opus 限定复核通过（a4aed），主会话复跑见下。后续 knowledge 执行链审查由总记录轮换跟踪，不在本记录展开。

## 验证

### 红（修复前）

命令：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/knowledge-management.test.ts -t "settles the create form when the profile list refreshes before the create responds"`

- `knowledge-management.test.ts > knowledge UX guards > settles the create form when the profile list refreshes before the create responds`：`AssertionError: expected false to be true`，位置为释放 POST 后的 `waitFor(() => !button('关闭').disabled)`。此前已通过真实 `invalidateQueries` 断言 `profile-name` 消失，证明子表单确实在 POST 挂起时被另一次 GET 卸载；旧实现依赖 per-call `onSuccess`，卸载后不再执行，父层 pending 无人结算。
- 纠正上一轮结论：先前把 `setQueryData` 放进 deferred POST、释放后才断言外层解锁，只在 mutation 结算前强制替换缓存，没有在 POST 仍挂起时证明「另一次真实 GET 使子表单卸载」，不能称为稳定复现该时序；已改为真实 refetch 两阶段测试。
- 详情页的行为红已在上一轮确认；本轮只改测试覆盖，未回退已通过的 `knowledge-detail.tsx` / `knowledge-settings.tsx`。P2 新测试直接跑在当前函数式更新实现上为绿，未在旧闭包实现上重跑红（源码属 review 已通过且不在本轮允许改动范围）。

### 绿（修复后）

- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-settings.test.ts` → `Test Files 2 passed (2)`, `Tests 132 passed (132)`，0 failed / 0 skipped。
- P1 单测修复后：`Test Files 1 passed (1)`, `Tests 1 passed | 111 skipped (112)`。
- P2 单测：`Test Files 1 passed (1)`, `Tests 1 passed | 19 skipped (20)`；覆盖 rerank 后发先完成、embedding 以 HTTP 500 走 catch，断言 rerank 仍为「连接正常」、embedding 为服务端错误文案、两项按钮均恢复。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ 通过，`exit=0`。
- `./node_modules/.bin/biome check packages/web/src/pages/knowledge.tsx packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-settings.test.ts` → `Checked 3 files in 48ms. No fixes applied.`。

### 主会话复核

- 主会话复跑 `knowledge-management.test.ts` 与 `knowledge-settings.test.ts`：`Test Files 2 passed (2)`、`Tests 132 passed (132)`、0 skipped，exit 0。
- 独立 Opus 限定复核（a4aed）通过；评审范围为本记录三项修复与对应测试。

### 未验证

- 未启动浏览器做真实交互验收（本任务为已证实缺陷的最小修复，行为由真实 Query + MSW 组件测试覆盖）。
