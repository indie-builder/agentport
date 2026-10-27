# 知识标签批量确保

## 目标与方案

手写导入与文档PATCH目前每个标签一或两次查询。新增repo.upsertTags(Database,baseId,string[])一次批量插入已有名冲突忽略，仅对未插入名称一次inArray补查，按输入顺序返回；空数组0查询，单标签维持新增1/已有2。两个入口改用它，单标签创建接口保留upsertTag。保去重顺序、trim入口、同库内唯一、跨库隔离与缺行报错；插入复用INSERT_CHUNK=500按输入顺序分块。不扩大事务到导入/PATCH全流程。

## 基线与范围

- worktree /Users/xbjt/Documents/myself/agentport-worktrees/knowledge-tags-batch；分支perf/knowledge-tags-batch
- origin/main 6e3762815fd576b03bec112ad4f8a0ef73645ffb，初始无差异；主checkout原.vitest/json/output.json不动。
- 改packages/db/src/repo/knowledge.ts、api/src/features/knowledge/content-routes.ts、routes.ts、api/test/knowledge-content-routes.test.ts、db/test/knowledge-tags.test.ts（新增）与本记录。源码/测试分文件并行，Opus独立评审。

## 当前有效决定

用户授权实施、PR合并、删已合并工作区和专用实例、更新main；不触发/等CI。专用PG64088/Redis64090/9，不读主.env、不改共享账号。

入口先trim/拒空/最长64由现有schema负责。手写最多50去重；PATCH schema无标签数量上限，但路由无独立bodyLimit，由Fastify默认1MiB请求体上限约束，估算最多约15000个64字符标签，inArray参数低于PG绑定上限，因此补查保持单条IN，不为理论溢出加分支；插入复用INSERT_CHUNK=500防单条参数过多。

## 已替代项

上轮只记录候选；本轮确认实际N+E往返再修，单标签场景不为批量改变查询数。

## 步骤

- [x] 探索调用、约束、批量方案
- [x] 实现/测试并行完成；隔离依赖/前置构建与专用PG迁移完成
- [x] 真实顺序/去重/跨库/并发/501与1100大批/SQL计数与HTTP多标签空数组回归19项通过；类型构建与5文件Biome错误级通过
- [x] 执行代理补充后，15个知识库测试文件162项通过；50个全新标签实际1次查询、全部已存在2次、空0、单标签新增1/已有2
- [x] 生产独立评审通过；去重重复包装已清理，api typecheck/格式通过
- [x] 测试评审两处缺口已补：混合新旧恰2次查询；501/1100首批/中段/批界/末位已有标签的跨批回填、旧ID复用、查询=ceil(N/500)+1、实际2文件19项通过
- [x] 补充测试定点独立复核通过，两处阻断解除
- [ ] 提交PR合并、清理和main更新

## 验证与下一步

专用PG/Redis上本轮直接运行2文件19项通过（knowledge-tags 10、knowledge-content-routes 9），相邻4个知识库套件61项通过，执行代理串行15文件162项通过；db/api typecheck/build、5文件Biome错误级、diff check通过。生产与测试独立评审均通过。原有NUL/空内容/Redis down日志来自既有失败路径断言。

实际计数：50全新标签1次、全部已存在2次、空0、单标签新增1/已有2；混合新旧2；501/1100为3/4次。收益限减少数据库往返，未测端到端耗时。

按用户既有授权提交PR合并，确认合入后清理专用实例和干净工作区、main快进。未运行完整产品E2E或真实模型任务。
