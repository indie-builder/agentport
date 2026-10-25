# 会话标题与操作菜单

## 目标
用户要求参考截图缩短消息区会话标题，紧随标题放三个点，菜单集中改名、删除、Fork，不占满标题栏。

## 方案与共享契约
- h1 使用 CSS `max-w-[8em] truncate`，完整文本保留在 DOM/title 可访问；更多按钮常驻但无已保存会话时禁用。
- 菜单重命名/Fork 复用现有 mutation/确认对话框。删除新接入，真正删除仅在用户确认后发送 DELETE。
- 新接口 `DELETE /api/conversations/:id`，认证、id schema、成功204、未知404、queued/running冲突409（CONFLICT）。
- DB `repo.chat.deleteConversation(db,id): Promise<boolean>`：不存在false，活动run抛CONFLICT，成功true。删除锁序与admitChatRun一致：先agent key share再conversation update，再查queued/running后级联删除。保持FK parentId set null（Fork不删）；无schema变更。
- web `api.deleteConversation(id):Promise<void>`；新增removeLocalConversation(id)清除本地索引。请求失败保留草稿、确认与当前会话；成功清理当前会话缓存并切新会话，刷新列表/运行/概况相关缓存。
- 请求期间禁用菜单冲突操作与发送/导航关闭确认，保留原流式/审批/历史恢复和对话布局。

## 文件边界
后端：packages/db/src/repo/chat.ts、packages/api/src/features/chat/routes.ts、packages/api/test/conversations.test.ts。
前端：packages/web/src/pages/chat.tsx、lib/api.ts、lib/chat-state.ts、test/chat-ux.test.ts（必要局部测试）。
主会话：文档、整合、验证与评审。

## 追加要求（2026-10-25，用户截图）
- 消息区标题行与会话历史标题行都**不要底部分隔线**（参考截图标题直接落在纸白上）。
- 会话历史头部**去掉“对话”二字**，把专家选择直接放到该位置；右侧保留新建/关闭。整行高度与消息区标题行一致，避免多占一块空白。
- 因此历史头部只有一行：专家选择 + 新建（+ 移动端关闭），其下直接是搜索与会话列表；不再有第二行。

## 验收
- 标题截短但完整标题可读取，菜单紧随；未落盘会话禁用真实操作。
- 重命名/Fork复用、删除取消不丢数据、删除失败保留会话、删除成功列表与页面一致。
- 后端认证/404/409/成功级联/Fork保留测试，使用真实测试库fixture；不删除用户会话。
- 并发使用事务锁覆盖发送准入，安全/并发测试必须真实运行。

## 下一步
并行实现；测试前暂时停止已有api/worker避免抢测试任务，结束后恢复。不提交。

## 验证
待本轮验证。
