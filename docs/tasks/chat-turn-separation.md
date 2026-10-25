# 对话轮次：去掉横线 + 每轮读数

## 目标
用户指出三个问题：轮次之间的横线是否必要；历史轮次不显示「完成 · N 轮 · 耗时 · token · 成本」；状态条整块横栏不知道怎么呈现更合适。
用户同时定下规则：个人项目不考虑历史数据与向后兼容，永远按当前最佳实践做。

## 决策
- 横线删除。轮次边界已由「用户胶囊 → 助手正文 → 读数行」表达，横线是重复信号。
- 运行状态从通栏 `RunStatusBar` 改成跟在最后一轮下方的 `RunFooter`，与完成后的读数行同位置同字号，运行结束原地替换。
- 停止入口移到输入框发送位；运行中只拦发送与 Enter，输入框保持可编辑。
- 历史轮次读数由会话详情按 `run_id` 批量带回（一次 `inArray` 查询），随 `ChatItem.runId` 挂到消息上；渲染时常驻占位、默认透明，指到或聚焦该轮才显影，触摸设备直接显示。
- 规则写入 `CLAUDE.md` 决策标准，作为后续改动的前置约束。

## 改动
- `CLAUDE.md`：决策标准新增「个人项目不考虑向后兼容」。
- `packages/shared/src/chat.ts`：`conversationDetailSchema` 新增 `runMetrics`，含 `runId` / `status` / `turns` / `durationMs` / `endedAt` / `tokens` / `costUsd` / `error`。
- `packages/db/src/repo/chat.ts`：新增 `listRunMetrics(db, runIds)`，一次批量取读数。
- `packages/api/src/features/chat/routes.ts`：`GET /api/conversations/:id` 汇总本页消息的 run_id 后批量取读数，随详情一并返回。
- `packages/web/src/lib/chat-state.ts`：`ChatItem` 的 text/tool 变体带 `runId`，历史解析时从消息透传。
- `packages/web/src/lib/use-chat-stream.ts`：`run_finished` 时给本轮流式项补上 `runId`，下一轮开始后它也能按 id 取读数。
- `packages/web/src/lib/queries.ts`：分页 `select` 合并各页 `runMetrics`。
- `packages/web/src/pages/chat.tsx`：
  - 轮次外层容器 `border-t pt-5` → `pt-5`。
  - `RunStatusBar` → `RunFooter`（脉冲圆点 + 状态 + 计时），不再横跨整列。
  - 停止入口移到输入框发送位（运行中发送位换成停止），删除「第 N 轮」前缀。
  - 历史轮次读数行：`group-hover/turn` / `group-focus-within/turn` 显影，`pointer-coarse` 直接显示，`motion-reduce` 取消过渡；`endedAt` 放进 `title`。
- `docs/DESIGN-SYSTEM.md` §6 对话态：同步轮次分隔、读数行与运行状态行规则。
- `packages/api/test/conversations.test.ts`：新增历史读数用例。
- web 测试夹具补 `runMetrics`，历史项断言补 `runId`。

## 取舍
- 读数行用「占位 + 显影」而不是绝对定位浮层：`MessageScrollerItem` 自带 `content-visibility: auto`，会建立绘制隔离并裁掉越界内容，绝对定位的浮层在实测中不显示。
- 发送后回到底部没有改 `MessageScrollerProvider` 的 `autoScroll` 语义（它只在原本贴底时跟随），而是新增 `ScrollToLatest`：只认「最后一条用户轮变了」，避免往上翻历史时被流式增量拽回去。

## 验证
- `pnpm --filter @agentport/web|api|db exec tsc --noEmit`：通过。
- `pnpm exec vitest run --project web`：29 文件 / 281 用例通过。
- `pnpm exec vitest run --project backend conversations|chat-history-pages`：27 用例通过；停 worker 后 `chat-admission` 11 用例通过。
- `pnpm lint:focus` / `pnpm lint:contract` / `biome check`：通过。
- 浏览器实测两轮会话：第一轮读数默认 `opacity: 0`，指到该轮变为 `1`，显示 `完成 · 1 轮 · 2.9s · 725 tok · $0.005 · 查看详情`；最新一轮常驻显示；轮次间只剩 20px 间距。
- 浏览器实测运行态：消息流内 `● 等待回复 · 00:01`，发送位为停止按钮，输入框可编辑；结束后原地替换为读数行。
- 浏览器实测上滚后发送（视口压到 520px）：发送前 `scrollTop=0`，发送后变为 `271`，即底部（`scrollHeight 597 - clientHeight 326`），全程无需手动回滚；助手回复结束后仍贴底。
