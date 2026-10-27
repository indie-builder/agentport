# 知识包图片引用索引

## 目标

减少知识包校验的重复线性图片扫描，保留信任边界校验、错误顺序、版本隔离与导入事务。修复同一图片循环中实际无效的重复名称判断。

## 方案

每版本原图片循环构造Map，以has判重、set存图片、get供chunk查询；替换imageNames Set及每chunk images.find，不新增依赖/抽象。MDN Map官方参考确认has布尔、set覆盖、平均次线性查找：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map 。Set.add返回Set，现有!add无法拒绝重复名，直接纠正而非保留错误兼容。

## 基线与范围

- 工作区：/Users/xbjt/Documents/myself/agentport-worktrees/knowledge-package-index
- 分支：refactor/knowledge-package-index
- 起点：origin/main 149ae08b47f2d704abf1d88767d8800b81727974；建树初始无差异。
- 主checkout原.vitest/json/output.json差异保留。
- 只改packages/api/src/features/knowledge/package.ts、对应knowledge-package/multimodal测试及本记录。其余Set.add疑点不混入。

## 当前有效决定

用户授权实施、提交PR合并、删除已合入干净工作区、同步main；不重复询问。Opus探索/独立评审、Sonnet执行，主会话维护记录、核diff和验证。API/DB测试使用专用实例，不复制主.env或更改共享登录/服务；不触发等待CI。

## 已替代项及原因

探索初提保留重复首项语义；实际读代码确认重复本应拒绝，选择Map.has直接修复同段无效判重，避免保留错误兼容层。

## 步骤

- [x] 并行窄域探索，选定知识包图片索引；PATCH查询候选后续再评估。
- [x] 核对现有实现/原生Map行为/建立隔离工作区。
- [x] frozen依赖安装、shared/core/db前置构建、专用PG迁移通过（64072；Redis64074/9）。
- [x] 实施与真实重名红绿回归、局部性能证据；首轮20+14项通过。
- [x] 补合法missing.png引用回归：断言具体清单外错误并核对无落库，原traversal断言保留。
- [x] 独立Opus review及缺失回归定点复核通过；主会话范围验证35项通过。
- [ ] commit/push/PR/merge；确认后清树/实例、更新main。

## 改动文件

- packages/api/src/features/knowledge/package.ts
- packages/api/test/knowledge-package.test.ts 或 knowledge-multimodal.test.ts（按实际测试组织选择）
- docs/tasks/knowledge-package-index.md

## 下一步

实施、主会话范围验证和独立评审均通过。按既有授权commit/push/PR/merge，确认merge和本树干净后清理专用PG/Redis及本树，main快进。未做全仓测试或真实大型包端到端耗时，局部基准不作整体性能承诺。

## 验证

- 专用PG/Redis初始化、API typecheck/build通过，改动两文件Biome错误0（既有warning保留）。
- 首轮knowledge-multimodal20项、knowledge-package14项通过；旧实现临时还原重名回归失败，实际继续到slug CONFLICT，恢复后重名INVALID_INPUT通过。
- 局部均衡1000图4000引用，含Map构建、300轮：find6.0297ms→Map0.1019ms，合法数据逐项等价assert通过。只代表查找阶段，不代表端到端导入。
- 最终主会话：`DATABASE_URL=<专用64072> REDIS_URL=<专用64074/9> pnpm exec vitest run --project backend packages/api/test/knowledge-package.test.ts packages/api/test/knowledge-multimodal.test.ts --no-file-parallelism`，2文件35项通过，0skip/0失败；改动文件Biome错误0。
- 主会话复跑局部基准：find5.9970ms/轮→Map0.1018ms/轮，等价assert通过。
- 独立评审确认实现正确；合法missing.png补测定点复核通过，无剩余阻断。
