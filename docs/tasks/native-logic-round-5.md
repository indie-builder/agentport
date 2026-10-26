# 手写逻辑简化：第五轮

## 目标

基于当前项目代码和技术栈查找能复用原生能力或现有实现的简化，改善真实资源处理或响应行为。用户授权修改、提交并合并 PR，删除已合并工作区、更新 main。

## 方案

Opus 并行窄域检查 API 和 core/web 网络客户端，确定候选后由 Sonnet 实施，独立 Opus 评审和范围验证后提交。没有明确收益则不制造改动。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-5`
- 分支：`refactor/native-logic-round-5`
- 起始 origin/main：`edb740c12df0d6df94dde48a567cf11da81c5e0a`
- 本树初始差异：空。
- 主 checkout 已有 `.vitest/json/output.json` 未提交变化，不属于本轮，不覆盖或提交。
- 本轮固定候选（主会话已确认同根因）：`packages/api/src/features/market/search.ts`、`packages/api/src/features/market/leaderboard.ts` 在 `if (!response.ok)` 分支直接 throw，未消费/取消响应体；按 Undici 7.29.1 官方要求，不需要 body 时必须 consume 或 cancel，否则连接资源等 GC 释放。两处仅在 throw 前 `await response.body?.cancel()`。
- 新增回归：`packages/api/test/market-fetch.test.ts`（新建），直接调用真实 `searchMarket`/`fetchLeaderboard`，用可恢复 `vi.stubGlobal('fetch')` 把请求桥接到本地临时 HTTP 服务（保留 options/signal），不新增生产注入参数。
- 不改 URL/cache TTL/stale fallback/错误码/成功解析；不新增 helper/配置/依赖；不碰 `market/install.ts`、`plugins`、`skill-provenance` 工作区。
- 本轮只独占本记录与上述三个文件，直到返回。
- core/web 客户端探索已结束，本轮没有收益明确的简化候选，保持现状。

## 当前有效决定

- 本轮 commit/push/PR/merge 和清理更新已授权，无需再次确认。
- 主会话不写源码或测试；Sonnet 执行，Opus 独立评审，评审通过才提交。
- 子代理不再派发、不自行提交为执行分工，不能解释成用户撤销授权。
- 不触发、不等待 CI，不开启 PR 监控。
- 不改共享服务、数据库、配置或登录态。
- 保留前四轮成果；引用弹窗 Query 迁移已否决，不重复尝试。

## 已替代项及原因

无。

## 步骤

- [x] 同步 main 并创建隔离工作区
- [x] 锁定依赖安装、shared/core/db 构建与 API 构建通过
- [x] 探索候选并固定范围
- [x] 实施与必要测试（TDD：先红后绿）
- [x] 独立 Opus 评审通过，无阻断项
- [x] 范围验证
- [ ] 提交、PR、合并
- [ ] 删除本树、更新 main

## 改动文件

- `docs/tasks/native-logic-round-5.md`
- `packages/api/src/features/market/search.ts`
- `packages/api/src/features/market/leaderboard.ts`
- `packages/api/test/market-fetch.test.ts`（新增）

## 下一步

实现、范围验证与独立 Opus 评审均通过。按既有授权提交、创建并合并 PR，确认合入后删除本树、更新 main；实际交付结果以 GitHub/Git 状态为准。

## 验证

- Undici 官方（Node v24.22.0，undici 7.29.1）：不需要响应体时必须 consume 或 cancel；依赖 GC 会过度占用连接，可能导致停顿/死锁。修复仅在两个 `if (!response.ok)` 分支 throw 前 `await response.body?.cancel()`。
- TDD 红：修复前跑 `pnpm vitest run packages/api/test/market-fetch.test.ts` → 4 failed / 2 passed。四个失败均为连接 close 断言（`expected +0 to be 1`），覆盖 search/leaderboard 的无缓存 503 与过期缓存 503；两个成功路径用例修复前已通过，证明失败只来自未释放连接。测试自身曾因跨用例 close 事件串扰误判，已改为每个临时 server 创建时捕获独立计数对象。
- TDD 绿：修复后同命令 → 6 passed（576ms）。
- API market 相关现有测试：`market-fetch` + `market-leaderboard` + `market-install` → 3 files / 12 tests passed。
- API 构建/typecheck：`pnpm --filter '@agentport/api' build` → `tsc -b` 成功。
- Biome：三个改动文件 `biome check` → No fixes applied。
- `git diff --check` → 通过；测试生成的 `.vitest/json/output.json` 已还原，工作区只剩上述源码/测试/记录差异。
- 主会话最终复验市场三个文件 12 项测试通过，0 跳过；API build/typecheck、三个文件 Biome 和 diff --check 均通过。
- 测试使用本地 HTTP 上游，不连接真实 skills.sh 或共享数据库；未做完整产品 E2E，不声称量化提速。
- 独立 Opus 评审通过：扩展检索发现的 4 个 market 相关测试文件共 14 项通过，连接关闭、清理和缓存行为无阻断项。
- 本轮未发现涉及的产品代码与文档冲突。
