# 原生数据操作简化

## 目标

将文档版本号计算并入 INSERT，删除只包两条语句的事务，减少数据库往返并保持现有发布和错误边界。用户已授权提交 PR 并合并、删除已合并工作区、清理测试实例和更新 main。

## 方案

Opus 并行核查文档版本契约和工具目录遍历；确认边界后由 Sonnet 分域实施，独立 Opus 评审，主会话审查差异并运行范围验证。只复用现有 Drizzle/Node 能力，不新增依赖、服务或 schema。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/native-data-operations`
- 分支：`refactor/native-data-operations`
- 起始 origin/main：`cbc52038e701d8ba3bdf3c854a789194e1192a20`
- 本树初始差异为空；主 checkout 原有 `.vitest/json/output.json` 差异不属于本轮，不覆盖或提交。
- A：`packages/db/src/repo/knowledge.ts` 的 createVersion，新增 `packages/db/test/knowledge-versions.test.ts`；按评审发现扩展 `packages/worker/test/knowledge-ingestion.test.ts` 的 chunk insertion 取消用例，仅拦截 knowledgeChunks 并确认新分块已实际落库，保留旧current不切版。
- B：`packages/db/src/repo/openui.ts` 的 listOpenUiTools，`packages/db/test/openui-tools.test.ts` 多 server 回归。用 Node 24 / ES2024 原生 Map.groupBy 一次分组生成工具，替代每个 server 重复 filter；保留五列投影、SQL 排序、组内顺序、enabled/allow/deny、HTTP 分支和输出结构。
- 本记录主会话维护，执行子代理不修改；不动其他任务树。

## 当前有效决定

- 用户 commit/push/PR/merge、清理同步授权有效；Sonnet 写源码测试，Opus 独立评审，主会话不写代码。
- createVersion 的版本号改为按 documentId 过滤的 coalesce(max(version),0)+1 标量子查询，直接 db.insert().returning()，删除无其他职责的显式 transaction。
- 保留全部输入字段、TypeID、返回行和空返回错误；setCurrentVersion 与发布守卫不变，创建失败不得发布。
- 当前事务没有同文档行锁，同文档并发原本可能唯一冲突；本轮不新增锁、重试或并发成功保证，约束错误原样传播（SQL 错误文本可变化）。
- 不改 schema/索引/迁移/依赖，不触发/等待 CI，不开启 PR 监控。
- 验证仅使用本轮临时 PG/Redis，不读取主配置或改用户登录态。

## 已替代项及原因

无。

## 步骤

- [x] 同步主分支、创建隔离工作区
- [x] Opus 完成 A 契约核查
- [x] 依赖准备和本轮隔离库迁移
- [x] Sonnet A/B 并行实施与回归
- [x] B 探索结论处理并固定文件边界
- [x] 独立 Opus 评审及取消测试定点复核通过，无阻断项
- [x] 范围验证
- [ ] 提交、创建并合并 PR
- [ ] 清理本树和实例、更新 main

## 改动文件

按上文 A 范围；本记录随任务提交。

## 下一步

A/B实施、范围验证和独立Opus评审通过；取消测试覆盖回退已修，定点复核ingestion35/35通过。按已有授权提交合并、清理实例和本树、同步main；实际结果以GitHub/Git状态为准。

## 验证

- 专用容器 pace-data-ops-pg（127.0.0.1:56537）和 pace-data-ops-redis（127.0.0.1:56539）。
- 锁定依赖安装、shared/core/db构建和专用库既有迁移通过。
- B等价回归在旧实现10项通过；改后主会话db/API工具目录和worker action/persistence共4文件46项通过，0跳过。多generated、http、空组、排序、deny/disabled、metadata/approval覆盖，db build/typecheck与两文件Biome通过。
- A新增6项真实PG直接回归旧实现2失败后转绿，日志四语句(BEGIN/MAX/INSERT/COMMIT)→单INSERT。首版、独立文档递增、全部返回字段、FK失败不改变current、并发可能23505边界覆盖。
- 主会话统一复验9文件149项通过，0跳过；7包typecheck、db/API/worker构建、四文件Biome与diff检查通过。
- B独立Opus评审通过，另行10/10无跳过；A生产实现无错误，独立直接版本/chunks 8/8通过，但发现摄取取消测试提前abort的覆盖回退。
- 修复取消测试：只在knowledgeChunks insert触发abort，新增PG断言新版本两个chunk确已插入，旧current仍不变；原拦截在新断言下先红、修后绿。主会话重新运行9文件149项全过、0跳过，5文件Biome/diff通过；该测试定点复核待返回。
- 未发现涉及的产品代码与文档冲突；未跑完整产品E2E或端到端耗时基准，不宣称并发问题已解决或整体提速。
