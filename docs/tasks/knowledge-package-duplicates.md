# 知识包重复校验修复

## 目标与方案

核实并修复知识包剩余六处 !Set.add 判重：Set.add 返回Set，取反永假。原位置用has判断后add，保留原错误文案/顺序和导入边界，不加helper/依赖/部署能力。已有图片Map不再改。公开导入入口回归错误包早拒绝且无落库，合法包保持成功。

## 基线与范围

worktree：/Users/xbjt/Documents/myself/agentport-worktrees/knowledge-package-duplicates；分支fix/knowledge-package-duplicates；基线origin/main c7c335d459643d95434a131856aa9f9a6b9c91f7，建树无差异。主checkout原.vitest/json/output.json不覆盖/提交。

允许修改api/src/features/knowledge/package.ts、api/test/knowledge-package.test.ts、本记录；docs/VALIDATION.md仅补充知识包唯一性入口规则。代码修改仅子代理，主会话核diff/运行验证/交付。Opus探索与独立评审，Sonnet实现/测试分文件并行。

## 当前有效决定

用户已授权提交推送PR合并、删除已合入工作区、更新main。按范围验证，不触发或等待CI。专用PG/Redis测试，不读主.env，不动共享账号/服务。无迁移/新增依赖/产品服务。

## 已替代项

无。

## 步骤

- [x] 定位全仓同模式，仅知识包剩余六处
- [x] Opus确认六处schema无唯一校验，非法输入可进入写文件/事务后撞DB唯一约束；修复入口错误避免无效工作
- [x] 实现/测试分文件并行派发；依赖安装、前置构建与专用PG迁移通过
- [x] 六处实现完成；API typecheck/build、生产文件Biome错误级、独立生产评审均通过
- [x] 知识包套件专用实例21项通过，含6类重复拒绝及不落库/不写文件、不同作用域合法复用；两套件合并复验42项通过
- [x] 测试代码独立复审通过；红绿实测旧实现6类均409→修复后精确400 INVALID_INPUT及21项通过
- [x] 最终类型/构建/静态核验
- [ ] 提交PR合并，确认后清树/实例、同步main

## 验证与下一步

- `pnpm --filter ./packages/api typecheck`、`build`：exit0；`biome check --diagnostic-level=error packages/api/src/features/knowledge/package.ts`：通过。
- `vitest run --project backend packages/api/test/knowledge-package.test.ts --no-file-parallelism`（专用PG64076/Redis64078/9）：1文件21项全部通过。
- 生产评审：六集合作用域/顺序正确，入口先于写盘与事务，文档一致，无剩余!Set.add。
- 测试文件仍有Biome导入排序/格式2处错误，执行代理处理中；未完成前不提交。全仓测试与真实产品E2E未跑。

