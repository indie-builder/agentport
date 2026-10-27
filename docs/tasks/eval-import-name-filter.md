# 评测导入仅查询候选重名

## 目标与方案

导入现读取目标agent全部已有用例name再Set判重；已有查询追加inArray(name,dataset.cases.map(name))，只取本次候选匹配项。复用Drizzle原生inArray，保持目标锁、agent缺失404、文件内重复跳过、警告顺序、批量插入、空dataset和审计。无新分支/抽象/索引。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/eval-import-name-filter；分支perf/eval-import-name-filter；初始origin/main 9259a0ae047ba90c676e3a25b355f52088fe57ac，建树无差异；实施后fast-forward到origin/main f33849d679da84e741219fdde3d5fc17b8d20c78，纳入并行任务的桌面端规则与下拉修复，无冲突。主checkout原.vitest/json/output.json及其他agent-dropdown-fix树不动。

只改api/src/features/eval/routes.ts、api/test/eval-files.test.ts、本记录。源码测试Sonnet分文件并行，Opus独立review；主会话验证与交付。

## 当前有效决定

用户授权真实收益后提交PR合并、清理已合入任务树和专用实例、main同步。专用PG64112/Redis64114/9，不主env/共享账号，不触发等CI。500条/1MiB原限制不变，同文件重复与已有重名仍跳过，不覆盖，不扩大锁或幂等。

## 步骤

- [x] 并行探索、确认候选与建立工作区
- [x] 生产过滤实现完成，依赖/前置构建/专用库迁移完成；主会话API typecheck/build和实现Biome错误级通过
- [x] 大量已有/少量导入SQL返回量证据及边界回归：两套19项主会话实跑通过，1000条已有仅返回2条匹配
- [x] 生产独立review通过；测试连接query清理缺陷已修复，定点独立复核通过，无剩余阻断
- [ ] 提交PR合并、清理/main同步

## 验证与下一步

主会话在对齐f33849d后，使用专用PG64112/Redis64114/9串行运行eval-files、eval两套件：2文件19项通过，0失败/跳过；API typecheck/build、两文件Biome错误级与diff check通过。

真实事务client查询捕获：1000条已有名仅返回2个候选匹配，SQL含参数化name IN，精准警告顺序和旧内容保留、跨agent隔离通过。生产Opus评审通过；测试首轮发现client.query未还原，已保存原函数并finally逐个还原，断言原函数恢复及后续import不增加捕获数组，定点独立复审通过，旧阻断已解除。

无产品文档冲突。评审通过后按授权提交PR合并，确认后删除专用实例和干净任务树、main快进。不声称减少SQL次数或数据库扫描耗时；未做全仓测试、真实模型或完整产品E2E。
