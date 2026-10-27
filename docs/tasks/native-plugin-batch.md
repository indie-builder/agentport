# 原生插件列表批量查询

## 目标与方案

/api/plugins/native现每个已安装项getPluginBySourceId一次完整行查询。改为repo一次inArray匹配sourceId并只投影sourceId，构建Set，原数组map标记imported。非空N→1，空集0查询。完整pluginId=name@marketplace匹配，保序/重复/版本与错误传播、CLI队列接口不变。不改SDK选项/CLI文件加载。

## 基线与范围

- 分支perf/native-plugin-batch；worktree /Users/xbjt/Documents/myself/agentport-worktrees/native-plugin-batch
- 起点origin/main 2ee4e891b7b7fcf83f79edc4da5a8a8d7747194e，初始无差异。
- 主checkout已有.vitest/json/output.json保留。
- 只改db/src/repo/plugins.ts、api/src/features/plugins/routes.ts、api/test/native-plugins.test.ts和本记录。

## 当前有效决定

用户授权实施、PR合并、清已合并树/实例、更新main，不触发等待CI。Opus探索/独立评审，Sonnet分文件执行。测试专用PG64084/Redis64086/9，不读主.env，不运行用户CLI/改共享登录。复用已有native.js mock夹具返回安装列表；不启真实队列消费者。

标签批量写入是另一候选，需两入口迁移和并发/顺序校验，本轮不混入。

## 已替代项

探索建议Map，但这里只需存在性，使用Set和sourceId投影更直接；单条getPluginBySourceId仍被import/adopt调用，保留。

## 步骤

- [x] 并行探索确认N次读取/现有批查模式
- [x] 实现完成；隔离依赖/前置构建/专用PG迁移完成；db/api类型构建与实现Biome错误级通过
- [x] 实际SQL次数与身份回归通过：N=3→1、空0、sourceId单列投影；2文件16项通过，三份代码Biome错误级通过
- [x] 独立生产评审通过；完整身份/排序重复/版本/错误传播保持
- [x] 测试独立评审通过，SQL spy直通/正对照/投影/完整响应和清理有效，无剩余阻断
- [ ] 提交PR合并、确认后清树/实例、main更新

## 验证与下一步

主会话命令：`DATABASE_URL=<专用64084> REDIS_URL=<专用64086/9> pnpm exec vitest run --project backend packages/api/test/native-plugins.test.ts packages/api/test/plugins.test.ts --no-file-parallelism`，2文件16项通过，无skip/失败。`biome check --diagnostic-level=error`三文件通过；db/api typecheck/build通过；git diff --check通过。生产与测试独立review均明确通过。

未发现产品文档冲突。未运行真实CLI安装、模型或完整产品E2E。按既有授权提交PR合并，确认合入后清理专用实例和干净工作区、main快进。收益限数据库查询次数和投影减少，不承诺端到端耗时倍数。
