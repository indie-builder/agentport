# OpenUI 状态保存单次归属读取

## 目标与方案

PUT openui-state成功路径先getConversation再getMessageInConversation，两次主键查询。消息conversation_id外键cascade保证消息存在则会话存在；改为先查消息，未命中再查会话区分CONVERSATION_NOT_FOUND与NOT_FOUND。命中2→1查询，错误路径仍2次；role/uiFormat/content/子代理/段/64KB/UPDATE合并/审计/错误码全部保持。

## 基线与范围

worktree /Users/xbjt/Documents/myself/agentport-worktrees/openui-state-single-read；branch perf/openui-state-single-read；origin/main fa48ab2130d754985c69bb7354503e37fb6d58bb，初始无差异；主checkout原.vitest/json/output.json保留。

只改api/src/features/chat/openui-state.ts及api/test/openui-state.test.ts(如需SQL计数证据)与本记录。Opus设计/评审，Sonnet实现和测试分文件并行，主会话验证交付。

## 当前有效决定

用户授权实施PR合并、清理已合入树和专用实例、main同步；不触发/等CI。专用PG64104/Redis64106/9，不读主.env、不改共享账号，无依赖/schema/迁移/索引/前端变更。前端400ms防抖；必须保留现有错误码与消息文案、跨会话NOT_FOUND、未知会话CONVERSATION_NOT_FOUND、权限和其他INVALID_INPUT优先判断。

## 步骤

- [x] 读真实路由/repo/外键/前端防抖与测试，确认最小改动
- [x] 实现完成；隔离依赖/前置构建/专用DB迁移完成，API typecheck/build和实现Biome错误级通过；生产Opus评审通过
- [x] 真实查询次数、错误分支和持久化回归已执行；测试独立review待返回
- [ ] 类型构建、PR合并、清树/实例、main更新

## 验证与下一步

主会话已运行API typecheck/build、两文件Biome错误级、git diff --check并全部通过；专用PG64104/Redis64106/9串行运行openui-state、openui-actions、openui-tools：3文件59项通过，0skip。查询次数真实捕获：成功1次，旧判据2次；错误分支保持两类错误，且跨会话不写状态。前端400ms防抖已核。

生产Opus评审通过，测试独立review待返回。通过后按既有授权PR合并、确认合入后清理专用实例和干净工作区、main快进。收益限一次主键查询，未测端到端耗时，未运行真实模型或完整产品E2E。
