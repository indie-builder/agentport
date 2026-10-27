# Wiki 版本写入减少查询往返

## 目标

将 Wiki 下一版本号计算并入 INSERT，每次保存少一次 SQL 往返，保持页面行锁、乐观锁、版本/指针/来源原子更新。用户授权提交并合并 PR、删除本树和验证实例、更新 main。

## 方案

Opus 探索并固定最小契约，沿用已合入 PR61 的 Drizzle 标量子查询写法；Sonnet 实施及回归，Opus 独立评审，独立 PostgreSQL/Redis 验证。版本详情读取无收益明确候选，不改。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/wiki-version-insert`
- 分支：`refactor/wiki-version-insert`
- 起始 origin/main：`0d1d10dec1f6bf7426180478a2b7e1a94dceffe9`
- 本树初始差异为空；主 checkout 原测试报告差异不属于本轮。
- 允许：`packages/db/src/repo/knowledge.ts` 的 saveWikiVersion 版本号 SELECT/INSERT，`packages/api/test/knowledge-wiki-routes.test.ts` 必要回归、本记录。
- 不改 schema/索引/迁移/依赖，不修改其它任务或运行底座。

## 当前有效决定

- 用户既有 commit/push/PR/merge 和清理更新授权有效，主会话不写源码/测试；Sonnet 实施，Opus 独立评审。
- 仅删除独立 MAX 查询，将按 pageId 过滤的 coalesce(max(version),0)+1 标量子查询设为 INSERT version，保留 returning。
- 页面 SELECT FOR UPDATE 与 INSERT 仍是不同语句，原事务锁和乐观锁检查、缺页null保持。
- 手动发布、SDK首稿current、已发布/stale只追加、回退复制新版本、来源失效与发布规则不变，版本/指针/来源写入原子性保持。
- 不添加锁/重试/兼容层/理论防护，不宣称端到端提速倍数。
- CI 不触发、不等待、不监控；仅本轮隔离环境验证，不动共享服务、配置或登录态。

## 已替代项及原因

无。

## 步骤

- [x] 并行探索并核对范围
- [x] 同步 main、创建隔离工作区
- [x] 依赖与独立库迁移
- [x] Sonnet 实施和行为/查询次数回归
- [x] Opus 独立评审与范围验证通过，无阻断项
- [ ] 提交、PR、合并
- [ ] 清理工作区和实例，更新 main

## 改动文件

- `packages/db/src/repo/knowledge.ts`
- `packages/api/test/knowledge-wiki-routes.test.ts`
- `docs/tasks/wiki-version-insert.md`

## 下一步

实现、范围验证与独立 Opus 评审通过；评审另行复跑23项无跳过，确认READ COMMITTED配置下锁后INSERT新快照、来源FK失败完整回滚。按已有授权提交合并、清理本树和实例、更新 main；实际交付结果以GitHub/Git状态为准。

## 验证

- 本轮 pace-wiki-version-pg（127.0.0.1:61590）、pace-wiki-version-redis（127.0.0.1:61592）。
- 锁定依赖安装、shared/core/db 构建和隔离库既有迁移通过。
- 新真实PG query spy用例旧实现先红，新实现 INSERT 含 max 标量子查询且无独立 MAX SELECT；首版/连续序号通过。
- 新并发保存用例两个请求同页得到1/2版；来源FK23503失败回归确认版本、current指针及来源全部回滚。
- 主会话最终 wiki-routes、worker wiki/wiki-update、knowledge-package 4文件52项通过，0跳过；db build、API typecheck、两文件Biome与diff检查通过。
- 页面行锁和INSERT仍独立执行；不改变乐观锁、manual/sdk/stale及来源原子性。
- 未发现涉及的产品文档与代码冲突，未跑完整产品E2E或耗时基准，不宣称整体提速。
