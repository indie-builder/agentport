# 已有会话允许切换专家

## 目标
用户指出已有消息后专家选择被禁用；要求能切换其他专家，按新专家刷新历史，当前对话视图回到无消息状态。

## 方案
复用现有 switchAgent：关闭旧stream订阅、清运行/审批/消息上下文并导航仅带新agent，不删除原会话、不取消后台run、保留未发送输入。移除 AgentPicker 的 conversationId 禁用及仅为此传递的死props；重复选同专家不清会话。

## 改动文件
- packages/web/src/pages/chat.tsx
- packages/web/test/chat-ux.test.ts
- docs/DESIGN-SYSTEM.md

## 验收
真实DOM从已开历史conversation选另一专家，assert新agent URL无conversation、旧消息消失、历史按新agent查询、未发送草稿保留。实屏不保存或删除用户数据。

## 下一步
无。未提交。

## 验证
- typecheck、全量 web：29 文件 281 用例通过；两文件 Biome、git diff --check 通过。
- 独立 Opus 限定评审通过；同专家早退静态核对，测试未单独覆盖同ID。
- 浏览器从真实已开会话（原专家）选择 E2E 专家：URL 仅新 agent、无 conversation；原消息消失，未命名会话欢迎态；新专家历史列表加载，未发送草稿仍在。未保存测试输入到后端，验收后清空临时草稿。
- 本轮不改运行取消；切换中旧后台run继续执行。
