# B/C 执行证据：健康流回读与账户客户端状态隔离

契约：[system-architecture-modernization-contract.md](system-architecture-modernization-contract.md) §4–§6。基线 `68241bab58ad8ec59727d70677bec790af2a5ae2`。

## 改动文件

源码：

- `packages/web/src/lib/queries.ts`：`useRun(runId, poll = true)` 只改 `refetchInterval`；`meQuery` 在返回已认证身份前绑定聊天归属；`logoutAccount` 同时清查询缓存与聊天状态，`clearSessionQueries` 仍只清查询缓存。
- `packages/web/src/lib/chat-store.ts`：草稿归属标记（键由现有草稿键派生）、进程内归属、`bindChatIdentity`；`reset` 同时清归属并同步递增 `accountEpoch`。
- `packages/web/src/lib/use-chat-stream.ts`：发送被接受后先 `reconnecting`，`onopen` 才 `streaming`；协议 `error` 立即 `detached`；订阅 `accountEpoch`，账户 reset 时同步复用 `closeStream` 作废旧 generation、关闭 EventSource 与重试计时器。
- `packages/web/src/pages/chat.tsx`：`RunReconciliation` 用 `useRun(run.runId, run.status !== 'streaming')`。
- `packages/web/src/components/app-shell.tsx`：两个显式退出入口都调用 `logoutAccount`。

测试：

- 新增 `packages/web/test/chat-run-polling.test.ts`（真实 QueryClient/useRun observer + 可控 EventSource，同一运行 6 秒窗口数请求）。
- 新增 `packages/web/test/chat-session-identity.test.ts`（真实 `meQuery`、显式退出、存储不可用）。
- 新增 `packages/web/test/chat-session-stream.test.ts`（独立 Opus C 阻断复核）：聊天 hook 保持挂载，从真实 `meQuery` 换身份与 `logoutAccount` 触发，释放晚到事件、发送失败与恢复响应。
- `chat-stream.test.ts`：协议 error 立即 detached；接受后 onopen 前 reconnecting。
- `login-route.test.ts`：真实登录表单 A→B 清稿、A→A 保稿。
- `chat-ux.test.ts`：发送后未 onopen 的可见文案改为现有 reconnecting 文案。
- `api-requests.test.ts`：401 跳转不删草稿。

## 红 → 绿

红（实现前，同一任务树）：

- `chat-run-polling.test.ts` 3 失败：健康 6 秒窗口完整运行详情请求 `4` 次（期望仍为首次 `1` 次）；未 onopen 时窗口 `3` 次（期望 `2`）；协议 error 后状态仍 `streaming`（期望 `detached`）。
- `chat-stream.test.ts` 2 失败：协议 error 后仍 `streaming`；接受后仍 `streaming`（期望 `reconnecting`）。
- `login-route.test.ts` 1 失败：B 身份确认后旧账户草稿仍为 `{"":"draft from the old account"}`（期望已清）。
- `chat-session-identity.test.ts` 实现前：无归属旧稿未清、A→B 草稿未清（两条真实隐私断言）；`logoutAccount`/`bindChatIdentity` 尚不存在（两条缺失 API 断言）；另有 1 条 `/me` 失败保稿用例因测试客户端默认重试而先报错，测试已关掉重试，该条属于保稿护栏、基线上本就通过。同账户多次 `/me`、未认证 `/me`、改密后同账户重登等保稿用例在基线上即通过。

绿（实现后）：

- B/C 指定套件（chat-stream、chat-recovery、chat-lifecycle、chat-drafts、chat-ux、login-route、login-redirect、api-requests、run-query、两个新套件）：`227/227` 通过，`0` 跳过。
- 旧完整 web 报告（实现阶段，`/tmp/agentport-architecture-BC-web-full.json`、`/tmp/agentport-architecture-BC-web-full-final.json`）：`131` 个文件（`414` 个 suite）、`1593/1593` 通过、`0` 跳过。这里的 `414` 是 suite 数，不是文件数。
- 独立 Opus 复核重跑（`/tmp/agentport-architecture-BC-review.json`）：`131` 个文件（`414` 个 suite）、`1594/1594` 通过、`0` 跳过。与上一行是不同时间点，不合并计数。
- 独立 Opus 发现 C 阻断后的修复（详见 [BC-review.md](system-architecture-BC-review.md)）：新增 `chat-session-stream.test.ts` 先红后绿；完整 web 最终态（`/tmp/agentport-architecture-BC-identityfix-green-web-full3.json`）`132` 个文件（`416` 个 suite）、`1600/1600` 通过、`0` 跳过。
- `pnpm --filter @agentport/web typecheck`：通过。
- `pnpm lint:focus`、`pnpm lint:contract`：通过。

命令（均从任务树）：

```sh
rtk bypass pnpm exec vitest run --project web <契约列出的套件与两个新套件> \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-<stage>.json
rtk bypass pnpm exec vitest run --project web \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-web-full.json
rtk bypass pnpm --filter @agentport/web typecheck
rtk bypass pnpm lint:focus
rtk bypass pnpm lint:contract
```

## 可见行为变化与限制

- 发送被接受但事件流尚未 `onopen` 时显示现有 reconnecting 文案（“连接已中断，正在重连”），`onopen` 后进入“等待回复”。不新增状态或心跳。
- 协议 `error` 立即按 `detached` 处理并恢复详情回读，不必等浏览器 `onerror`；连接清理与有限重试仍由原 `onerror` 逻辑负责。
- 首次确认身份发现没有归属的旧草稿时直接清掉，不做迁移；显式退出会清空草稿、消息、输入、运行读数、成果引用、附件与历史面板状态。401 不删稿；同账户 401 重登、改密重登保留草稿；不同账户确认身份后才清。
- 账户级 reset 现在会同步关闭仍挂载的旧事件流与重试计时器；换账户后晚到的发送成功/失败、恢复响应和 SSE 事件都不再写回新账户状态。同账户 `/me` 不触发该信号，运行中的流与草稿保持原行为。
- `sessionStorage` 不可用时只在本次页面生命周期内保留归属，不跨刷新猜测归属，也不新增持久层。
- 健康 `streaming` 只表示“已 `onopen` 且没有已知协议错误”，不证明没有静默网络中断；浏览器 `onerror` 与服务端终态补偿仍是恢复机制。
- 未改认证服务、用户登录配置、API/DB/worker/SDK、shared 类型、LoopX；未 commit。
