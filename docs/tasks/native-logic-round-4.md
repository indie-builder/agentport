# 手写逻辑简化：第四轮

## 目标

复用当前技术栈与原生能力，简化人工维护的逻辑，在保持功能的前提下改善稳定性与响应速度。用户授权修改、提交 PR 并合并，随后删除任务 worktree、更新本地 main。

## 方案

Opus 并行探索前端 Query 周边与 worker 非 SDK 辅助逻辑，固定最小完整契约后由 Sonnet 执行；独立 Opus 评审通过并完成范围验证后交付。候选必须有实际收益，不以风格调整凑提交。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-logic-round-4`
- 分支：`refactor/native-logic-round-4`
- 起始 origin/main：`a7c3c08886e053eb2d723b9cf6b952a4d212d894`
- 初始未提交差异：空。
- Worker A（本执行单元）固定范围：`packages/worker/src/knowledge/sources.ts`、`packages/worker/test/knowledge-sources.test.ts`、本记录；本执行单元独占记录直至返回。
- 本执行单元不派代理、不提交；提交/PR/合并仍按用户授权由主会话后续执行，属于执行分工而非撤销授权。
- 前端查询域不修改：轮询已使用原生 refetchInterval，其余逻辑负责终态补取、取消旧请求和草稿保护，没有收益明确的替代候选。
- 不修改或清理其他任务 skill-provenance 工作区。

## 当前有效决定

- 用户已授权 commit/push/PR/merge，无需再次确认。
- 主会话不写源码与测试，代码由 Sonnet 执行，Opus 独立评审。
- 子代理不自行提交或继续派发只是执行分工，不能记成用户撤销提交授权。
- 不触发、不等待 CI，不启动 PR 监控。
- 不操作共享服务、配置、数据库和登录态。
- 保留前三轮改动；引用弹窗 Query 迁移已因复杂度否决，不重复实施。

## 已替代项及原因

无。

## 步骤

- [x] 同步 main、创建隔离工作区
- [x] 准备依赖与构建
- [x] Opus 探索并固定契约
- [x] Worker A：实现 fetchChecked 错误响应体取消并补测试
- [x] Sonnet 实现与必要测试
- [x] Opus 独立评审
- [x] 范围验证
- [ ] 提交、创建并合并 PR
- [ ] 删除本树、更新 main

## 改动文件

- `docs/tasks/native-logic-round-4.md`
- `packages/worker/src/knowledge/sources.ts`
- `packages/worker/test/knowledge-sources.test.ts`

## 下一步

- Worker A 已完成：401/403/429/500 非成功响应在分类抛错前取消响应体；测试先红（429/500 连接保持打开）后绿。
- 前端探索已结束，保持现状；本轮仅调整 worker 来源错误响应释放。
- 主会话最终复验三文件 69 项测试通过，0 跳过；worker build/typecheck、两文件 Biome 与 diff --check 通过。Opus 独立评审通过，无阻断项，并独立复跑 sources/connector 34 项测试。
- 下一步按用户授权提交、创建并合并 PR，清理工作区并更新 main；实际结果以 GitHub/Git 状态为准。
- 未操作共享服务，测试使用本地 HTTP 上游；未覆盖完整产品 E2E 或真实外部来源。不声称量化性能提升。
- 未发现本轮涉及的产品代码与文档冲突。
- 用户已授权提交/PR/合并；本执行单元不提交仅为分工，待主会话收齐后执行。

## 验证

- `pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts -t 'HTTP failure responses'`
  - 修复前：2 failed（429、500 上游连接未关闭）、2 passed（401、403 原有取消行为）。
  - 修复后：4 passed。
- `pnpm exec vitest run --project backend packages/worker/test/knowledge-sources.test.ts packages/worker/test/knowledge-connector.test.ts`
  - 2 files / 34 tests 全部通过。
- `pnpm exec vitest run --project backend packages/worker/test/knowledge-ingestion.test.ts`
  - 1 file / 35 tests 全部通过。
- `pnpm --dir packages/worker typecheck`（`tsc -b`）：exit 0。
- `pnpm --dir packages/worker build`（`tsc -b`）：exit 0。
- `pnpm exec biome check packages/worker/src/knowledge/sources.ts packages/worker/test/knowledge-sources.test.ts`：2 files checked，无诊断（exit 0）。
- `git status --short`：仅上述三个文件；无测试报告等生成差异。
