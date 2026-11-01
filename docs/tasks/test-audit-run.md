# 测试用例审计与裁剪（test-audit campaign）

## 目标

按 `test-audit` 技能回答「哪些测试有用、哪些没用」，并只删除证据充分、删除后仍有 keeper 测试保护契约的用例。用户 2026-11-01 通过 `/test-audit` 发起。

## 方案

- 模式：Campaign（全仓范围，按包分 lane）。
- 目标：删除最无价值的一批声明，目标 20%（452 文件 / 5315 声明）；技能允许在台账证明剩余候选都在守合同时提前停止，不以凑数为目的。
- 预算：总行/分支覆盖率下降不超过 2 个百分点；有留存契约的文件单文件下降不超过 5 个百分点。
- 顺序：基线（声明数、覆盖率、跳过清单）→ 仓库级 junk 模式扫描 → 按 lane 逐条标注 R/F/C/D 并附证据 → 分层计划 → 分批删除并验证 → 独立保全复核 → 交接台账。
- 已知前提：本 worktree 基线是 `origin/main`，不含另一个未合入任务（测试信号加固）的修复；基线失败与已知偶发按 `docs/PITFALLS.md` 处理。

## 基线与范围

- 起点：`origin/main` = `c775e2d12b2f8e6df573318aa79f174a985ca364`，worktree `.claude/worktrees/test-audit-run`，初始差异为空。
- 范围：`packages/*/test/**` 全部单元/集成测试；不含 E2E（`e2e`）。
- 允许改动：测试文件、测试辅助、删除后解锁的测试专用生产接缝、`docs/tasks/test-audit-run.md`、`docs/PITFALLS.md`。
- 不改业务行为、CI 门禁、覆盖率阈值、依赖版本。

## 当前有效决定

- 用户 2026-11-01 调用 `/test-audit`：按技能执行；删除以证据为准，不为凑 20% 删除不确定用例。
- 主会话不写代码：删除批次由子代理执行并附验证证据。

## 已替代项及原因

无。

## 步骤

- [x] 基线：声明数、测试行数、覆盖率、跳过清单、基线失败。
- [x] 仓库级 junk 模式扫描（无断言、源码 grep、调用形状、快照清单、重复 provider 回放等）。
- [x] 按 lane 生成 R/F/C/D 台账（4 个只读子代理）。
- [x] 分层计划：每个契约的 keeper 与被淘汰的文件/层。
- [x] 删除裁定：**本批 0 删除**（见台账与理由）。
- [x] 执行 3 处断言修复（F），第 4 处经复核保留。
- [x] 独立复核：无删除，不需要保全复核。

## 改动文件

- `packages/web/test/dialog-validation.test.ts`：`leaves focus alone after a valid submission` 改为真实断言焦点未被移动（新增 sentinel input + `document.activeElement`）。
- `packages/web/test/conversation-search-ui.test.ts`：删除 `expect(syntheticClick).toHaveBeenCalled()`（Base UI 内部实现细节），保留场景 spy 与结果断言。
- `packages/web/test/runtime-environments.test.ts`：删除冗余的 `expect(refetch).toHaveBeenCalled()`，后续结果断言已覆盖。
- `docs/tasks/test-audit-run.md`：审计台账。
- 未删任何测试；未改生产代码。
- 保留未改：`agents-lifecycle.test.ts:1740-1753`（断言「折叠预览时不触发工作区渲染」，是懒渲染性能/AX 不变量，删除会失去唯一守卫）。

## 下一步

- 交付：等用户授权后提交；不 commit、不 push。

## 验证

- 声明数（`vitest list --json`）：3347（web 1644 / backend 1703）；测试与辅助文件 182,531 行。
- junk 模式扫描（全仓）：无 `expect` 的测试文件 0；`toHaveBeenCalled*` 文件 97（714 次断言）；读文件后断言 43 文件（185 处）；快照 0；显式 `skip/todo` 0；条件 `skipIf` 188（按设计跳过）。
- 覆盖率基线（`vitest run --coverage --coverage.include='packages/*/src/**'`，430 个生产文件）：行 85.10%、分支 75.55%、函数 79.94%、语句 81.88%；全量 153.45s。
- 基线失败：1 个 `run-pending-finish.test.ts > unconfirmed stop handoff`（409，已知跨文件串扰，已在未合入的 `test-signal-hardening` 分支修复；与本审计无关）。
- 断言修复后：3 个文件 `vitest run --project web` 48 用例通过；`pnpm --filter @agentport/web typecheck` 通过；`biome check` 三个文件通过；`pnpm test:web` 全量通过。
- 覆盖率影响：只改断言、未删测试、未改生产路径，执行路径不变，覆盖率不变（按技能预算 0 变化）。

### Lane 台账

| Lane | 范围 | 保留 R | 候选 C/D |
|---|---|---|---|
| api/db 调用形状 | api 10 文件、47 处断言 | 36：真实外部边界（fetch/DNS/Redis/BullMQ/MCP/SSE）、审批回调、安全负向副作用 | 6 处 `producer-contract.test.ts`（`run-stream.test.ts` 的 mock 回放）+ 1 处 `eval-enqueue-failure.test.ts:116` |
| web/worker 调用形状 | 约 45 处断言 | 约 40：对话流式、OpenUI 审批、沙盒生命周期、权限、错误形状 | `producer` 无；web 5 处（见下）+ worker 4 组（`eval-snapshot` 3 组、`knowledge-queue-dispatch` 整文件） |
| 读文件/源码 grep | 43 文件 | 39：真实产物校验（内容/权限/目录/ZIP/blob）、fixture 输入、真实计算/渲染 | `image-build-contract:56`（D）、`:101`（弱 D）、`child-skills:152`（C） |
| 超大套件 | 6 个最大文件 | 无整文件可退役；DB 版本/锁、API HTTP/文件投影、worker 取消编排为 keeper | `chat-outputs:1132`（C→blob-pdf:96）、`chat-outputs:435`（C→reader-toolbar:22） |

### 删除裁定（0 条）

- 单个断言级候选（`producer-contract`、`eval-enqueue-failure:116`、`runtime-environments:858`、`conversation-search-ui:197`、`agents-lifecycle:1764/1768`）都嵌在本身有效的测试里，删除不省套件时间，只减少一份廉价守卫。
- C 类 keeper（`run-stream.test.ts`、`eval-result-write.test.ts`、`knowledge-queue.test.ts`、`blob-pdf.test.ts`、`reader-toolbar.test.ts`）依赖 PostgreSQL/Redis；删掉总是运行的单元测试会让缺基础设施时失去该分支覆盖（技能 Gotchas 明确警告）。
- `dialog-validation:48-58`、`agents-lifecycle:1740-1753` 更该修断言（F）而非删除：前者标题承诺「焦点不动」却没断言；后者守的是懒渲染性能不变量。
- `image-build-contract:56` 守「不允许出现独立 sandbox manifest/staging」的架构边界，属 retention bar 的 architecture contract，保留。

### 门禁建议（AGENTS.md）

- 不为 mock 的私有调用形状写断言；同一契约只在一个最强边界（真实 DB/Redis/文件系统）验证一次，其它层用结果断言。
- 断言标题承诺什么就必须断言什么，禁止 `expect(() => …).not.toThrow()` 作为唯一断言。

## 结论

5315 个执行、3347 条声明中，证据支持删除的低价值用例为 **0**；仅 4 处断言可修复。规模大不等于冗余，绝大多数在守跨层契约。
