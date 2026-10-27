# 智能体包导入复用技能资源分组

## 目标

导入复用多个已有技能时，一次按 skillId 分组资源文件，避免每个技能重复过滤全部资源；保持资源隔离、漂移警告与事务行为。用户授权提交并合并PR、清理工作区和实例、更新main。

## 方案

Opus探索后主会话核代码，采用原生Map就地一次分组，无新增依赖或抽象；Sonnet实施、Opus独立评审，专用PG/Redis回归后交付。文档版本写入候选的调度并发链未完整核实，本轮不同时扩入。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport-worktrees/skill-file-grouping`
- 分支：`refactor/skill-file-grouping`
- 起始origin/main：`19e9d1dc3cc1829027c849fe83c05c17d07b2918`
- 初始本树差异为空；主checkout测试报告差异非本轮，不覆盖。
- 允许：`packages/api/src/features/agent-package.ts`既有技能资源比较、`packages/api/test/agent-package-zip.test.ts`针对性回归、本记录。
- 不改schema/依赖/技能来源语义/ZIP编解码/SDK/其它任务。

## 当前有效决定

- 已授权commit/push/PR/merge及清理同步；源码测试由Sonnet，Opus独立评审通过后提交。
- existingFiles查询后按skillId建立Map<id, files[]>，保留所有文件和计数，每技能只取自己的列表再建原path→content Map；无资源返回空数组。
- 文件查询次数、内容/来源字段比较、输入顺序和警告顺序、原文件不覆盖及事务原子性不变。
- 资源过滤工作量S×F→S+F，不宣称数据库或端到端耗时倍数。
- 不触发/等待CI，不开启PR监控；只用独立环境，不动共享服务配置登录态。

## 已替代项及原因

不复用当前要求Database而非事务类型的仓储函数，以免为此扩展公共签名；与本文件现有Map分组风格一致，就地实现一次性逻辑。

## 步骤

- [x] 探索并核对现有实现与调用
- [x] 同步main并创建本树
- [x] 依赖准备与隔离库迁移
- [x] Sonnet实施及资源隔离/漂移回归
- [x] Opus独立评审及隔离测试定点复核通过，无阻断项
- [ ] 提交、PR、合并
- [ ] 清理实例和本树、更新main

## 改动文件

- `packages/api/src/features/agent-package.ts`
- `packages/api/test/agent-package-zip.test.ts`
- `docs/tasks/skill-file-grouping.md`

## 下一步

实现、范围验证与独立Opus评审通过；补强隔离用例后定点复核通过。按已有授权提交合并、清理本树和实例、更新main；实际交付结果以GitHub/Git状态为准。

## 验证

- pace-skill-group-pg：127.0.0.1:65246；pace-skill-group-redis：127.0.0.1:65248。
- 锁定依赖安装、shared/core/db构建和专用库既有迁移通过。
- 新行为回归在旧实现35项通过（等价重构），新实现同路径多技能资源隔离、空资源/额外文件/内容漂移、原文件不覆盖及警告顺序通过。
- 主会话最终agent-package-zip、v2-validation、subagent-bundle、skills 4文件81项通过，0跳过；API build/typecheck、两文件Biome和diff检查通过。
- 一次性合成计数S=4/F=10：旧40次比较，新10次分组+4次查表，共14次，未落盘，不冒称耗时收益。
- 评审补强隔离用例：incoming均为first-original，仅second资源漂移；共用首桶/末桶/交换桶三种临时错误注入均红，恢复后绿。独立Opus定点复核目标用例通过，完整4套件81项再次通过、0跳过。
- 未发现涉及的产品文档与代码冲突；未跑完整产品E2E或耗时基准。
