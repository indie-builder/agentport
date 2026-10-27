# 连接器工具列表存在性投影

## 目标与方案

GET /api/servers/:id/tools仅用完整server行判断存在，改repo.servers.serverExists以id单列limit1判断。路由已有dbRepo直连，直接调用不新增API转接。查询次数保持，避免传输/解码config和secretsEncrypted。原单行查询保留其它调用；404/空200/排序/鉴权保持。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/server-tools-exists；分支perf/server-tools-exists；基线origin/main a9de1140952a50f08ace87bee2e1a0020f529817，建树无差异。主checkout原.vitest/json/output.json保留。

只改packages/db/src/repo/servers.ts、packages/api/src/features/servers/routes.ts、packages/api/test/servers.test.ts、本记录。Sonnet分文件并行执行，Opus独立review；主会话不写源码。

## 当前有效决定

用户授权确认收益后实施PR合并、删已合并工作区/专用实例、main快进。不触发等CI、不监控PR。专用PG64092/Redis64094/9，不读主.env/不改共享账号或服务。无新依赖/schema/产品服务。

## 已替代项

运行记录列表/详情已使用有效投影，未发现合格优化不改。连接器存在性复用现有Drizzle投影，官方依据https://orm.drizzle.team/docs/select 。不增加只转发的API repo wrapper。

## 步骤

- [x] Opus并行探索、调用链核实、建树
- [x] 实现完成；隔离依赖/前置构建与专用库迁移完成，主会话db/api typecheck、api build、2文件Biome错误级通过
- [x] 独立生产review通过：原getServerRow只转发，无业务副作用；GET其他行为保持
- [x] 实际投影/权限/404空非空响应验证及测试独立review通过，无剩余阻断
- [ ] 提交PR合并、确认后清树/实例、更新main

## 验证与下一步

主会话db/api typecheck、db/api build、3份改动代码Biome错误级与diff check通过。最终专用库串行运行servers、server-concurrency、generated-mcp、knowledge-server-guard：4文件34项通过，0skip/失败。

真实pool.query捕获确认存在性检查为SELECT id且无config/secrets_encrypted；配置和密文两列查询作正对照，避免否定断言恒真。存在空200[]且仍查工具，未知404且不查工具，匿名401；旧非空工具列表断言保留。生产与测试独立review均通过。

未发现产品文档冲突。收益限工具列表存在性查询单列投影，不承诺端到端耗时或查询次数减少。
