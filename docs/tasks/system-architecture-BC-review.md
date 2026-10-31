# B/C 独立 Opus 终审：C 修复定向复审 PASS

契约：[system-architecture-modernization-contract.md](system-architecture-modernization-contract.md) §5；执行证据：[system-architecture-BC-evidence.md](system-architecture-BC-evidence.md)。

## 本轮结论：PASS（2026-10-31）

基线 `68241bab58ad8ec59727d70677bec790af2a5ae2`，任务树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。本轮独立审查只核 C 新增的 `accountEpoch`、同步订阅与既有清理链；B 已通过部分只跑相关回归，不重审其他动态分区。开工已有未提交差异属于原任务及并行分区，本轮不还原、不提交，只更新本文；已读根 CLAUDE、DEV-WORKFLOW、PITFALLS、主 checkout 最新 `packages/web/CLAUDE.md`（任务树无此文件）、契约 §5 和 B/C 证据。

没有新增阻断，无需产品源码修复。原三条独立 probe 在当前实际源码下全部通过。

核查位置与结果：

- `packages/web/src/lib/chat-store.ts:201–209`：账户 `reset` 清草稿/归属后在同一个 Zustand `set` 中递增 `accountEpoch`；`resetConversation:184` 不递增。已安装 Zustand `vanilla.js:11` 在 `setState` 返回前同步通知订阅者，因此失效不依赖后续 React effect。
- `packages/web/src/lib/use-chat-stream.ts:227–251`：订阅 effect 直接返回 unsubscribe，`closeStream` 稳定；每个 hook 各订阅自身 refs。账户变更同步进入 `closeStream`，先推进 generation、清 recovery/history 请求，再清 retry、关 source。卸载时取消订阅，原 mount effect 继续设 `mounted=false` 并关流。额外实测包含双 hook、StrictMode 重挂载、rerender 不重订阅、卸载后订阅归零，以及 source.close 内同步触发旧 handler 仍不能写回。
- `use-chat-stream.ts:260/283/488/590/639/685/709`：晚到恢复、历史、发送成功/失败均沿原 generation/归属检查失效；原文恢复在检查之后。原三条 probe 验证真实 `meQuery` 确认 B 后的旧 delta、A 晚到发送失败、显式退出后未卸载旧流；入库新测试另验证退出后重试不续生和 reset 返回前关闭。额外 probe 验证 A 的晚到发送成功也不能覆盖 B 新稿或创建 source。
- `chat-store.ts:217–220`、`queries.ts:104–124`：同 A 绑定直接返回；401/改密沿原查询清理保稿，不触发账户 reset。`app-shell.ts:279/322` 的用户菜单与 `553/728` 的 AccessDenied 均仍接共享 `logoutAccount`，`357` 改密只清 Query。两个 UI 入口本轮核源码接线，未分别做浏览器点击验收。

独立验证（没有名称过滤，所选文件完整执行）：

```sh
rtk bypass pnpm exec vitest run --project web \
  packages/web/test/chat-session-stream.test.ts packages/web/test/chat-session-identity.test.ts \
  packages/web/test/chat-stream.test.ts packages/web/test/chat-recovery.test.ts \
  packages/web/test/chat-lifecycle.test.ts packages/web/test/chat-drafts.test.ts \
  packages/web/test/chat-ux.test.ts packages/web/test/chat-questions.test.ts \
  packages/web/test/login-route.test.ts packages/web/test/login-redirect.test.ts \
  packages/web/test/api-requests.test.ts packages/web/test/run-query.test.ts \
  packages/web/test/chat-run-polling.test.ts packages/web/test/account-rbac.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-review.json
rtk bypass pnpm exec vitest run --config /tmp/agentport-bc-identityfix-review.config.mjs \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-review-probe.json
rtk bypass pnpm --filter @agentport/web typecheck
```

- 本轮完整受影响 suite：`14` 文件、`51` suite、`263/263` 通过，`0` 失败、`0` pending、`0` todo；包含新套件 `6/6` 与 B 轮询回归 `5/5`。非本范围文件未选择，不记作测试 skip。jsdom 的 `Window.scrollTo` 未实现提示未导致用例失败。
- 本轮临时 probe：原 `/tmp/agentport-bc-review-probe.test.ts` 原样重跑 `3/3`，额外 `/tmp/agentport-bc-identityfix-extra.test.ts` `4/4`，共 `7/7`，`0` 失败、`0` pending、`0` todo。临时 config 只用于原探针与额外探针（不入库），指向本任务树源码；旧临时 config 的 include 已指向 polling 文件，故另用 review config 明确列出这两个 probe，避免跑错文件。
- web typecheck 退出 `0`。
- 已直接解析历史 JSON：red 为 `3/5` 失败，focused3 为 `6/6`；`green-suite2.json` 为 `14` 文件、`51` suite、`263/263`；`green-web-full3.json` 为 `132` 文件、`416` suite、`1600/1600`。后二者均 `0` 失败、`0` pending、`0` todo。完整 web 是已核验的前轮证据，本轮没有再次运行完整 web，不把它列为本轮新结果。

审查源码快照 SHA-256：`chat-store.ts` = `db69c711529c2d05c4756880c8d21f7508596f23c16d5a1affc27f4a4124b62b`；`use-chat-stream.ts` = `2980f9568790da24536a992ceb5b19fe00d1b1e8f00bcfcf65fa0c1b92f3f44a`；`chat-session-stream.test.ts` = `7fc6138574a36587b4b1b2dca8d374df0850fe6b0ab99d498d9a294ca50bea64`。

未发现本轮代码与契约/证据的冲突；下文阻断是修复前历史，已解除。未改产品源码、LoopX 或 Git；未重新审查 API/DB/worker/其他动态分区。

## 历史阻断（修复前独立 Opus 复现 3/3 失败，现已解除）

独立 Opus 用临时 probe（`/tmp/agentport-bc-review-probe.test.ts`，不入库）复现：账户级 `reset()`（`bindChatIdentity` 换人、`logoutAccount`）只清 Query/chat store，没有推进 `useChatStream` 的 `generationRef`、没有关闭 `EventSource`、没有清重试计时器；hook 的归属检查只有 `mounted + generation`，因此旧账户回调仍算“自己”。

三条真实失败：

1. `/me` 换到 B 后 `Outlet` 仍挂载（`/chat` 不卸载），B 的查询缓存已清空，A 的旧 `text_delta` 仍回写 store。
2. `/me` 换到 B 后，A 的晚到 `sendChat` 失败进入 `catch`，把 A 的原文恢复进 B 的输入框并保留在草稿槽。
3. `logoutAccount()` 后、路由卸载前，旧 `EventSource` 的晚到事件仍回写。

这是契约 §5 已要求的隐私边界（“晚到发送/恢复结果不能给新账户重新写回草稿/消息”），不是理论竞态。

## 范围

只改 C 的既有清理链：

- `packages/web/src/lib/chat-store.ts`：账户级 `reset()` 同步发出一个域内信号。
- `packages/web/src/lib/use-chat-stream.ts`：订阅该信号，同步复用现有 `closeStream()`（递增 generation、关闭 source、清重试计时器），让旧发送/恢复/事件回调全部失去归属。
- BC 关联测试：新增 `packages/web/test/chat-session-stream.test.ts`，从真实 `meQuery` 换身份与 `logoutAccount` 触发，挂载不卸载。
- 本文与 `system-architecture-BC-evidence.md`。

不改认证服务、API/core/knowledge/eval/runtimeB/LoopX；不造新状态机、通用 store registry 或跨应用取消框架；不改 B 的轮询/缓存终态行为；不 commit。

## 红 → 绿

基线（修复前，本任务树）：

```sh
rtk bypass pnpm exec vitest run --project web packages/web/test/chat-session-stream.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-red.json
```

结果 `3/5` 失败，和独立 Opus probe 一致：

- `/me` 换到 B 后旧 source 未关闭（`source.closed` 为 false），晚到 `text_delta` 可继续写。
- 换到 B 后旧发送失败，`catch` 把 `PRIVATE A DRAFT` 恢复进输入框。
- `logoutAccount()` 后断线重试计时器未清，推进 5 秒又新建了第 2 个 EventSource。
- 另 2 条（截断恢复、同账户保持）在基线上已通过：`recoverPersisted` 原有 `conversationId` 检查已挡住一半，保留为回归护栏，不计入红证据。

修复后：

```sh
rtk bypass pnpm exec vitest run --project web packages/web/test/chat-session-stream.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-green-focused3.json
rtk bypass pnpm exec vitest run --project web \
  packages/web/test/chat-session-stream.test.ts packages/web/test/chat-session-identity.test.ts \
  packages/web/test/chat-stream.test.ts packages/web/test/chat-recovery.test.ts \
  packages/web/test/chat-lifecycle.test.ts packages/web/test/chat-drafts.test.ts \
  packages/web/test/chat-ux.test.ts packages/web/test/chat-questions.test.ts \
  packages/web/test/login-route.test.ts packages/web/test/login-redirect.test.ts \
  packages/web/test/api-requests.test.ts packages/web/test/run-query.test.ts \
  packages/web/test/chat-run-polling.test.ts packages/web/test/account-rbac.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-green-suite2.json
rtk bypass pnpm exec vitest run --project web \
  --reporter=json --outputFile=/tmp/agentport-architecture-BC-identityfix-green-web-full3.json
rtk bypass pnpm --filter @agentport/web typecheck
```

- 聚焦新套件：`6/6` 通过（其中“同步撤销”一条是修复后补的时序护栏，未纳入上面的红证据）。
- B/C 受影响套件：`263/263` 通过、`0` 失败、`0` 跳过。
- 完整 web 最终态：`132` 个文件（`416` 个 suite）、`1600/1600` 通过、`0` 失败、`0` 跳过。新增的 1 个文件、6 条用例即本次修复的边界测试。
- `pnpm --filter @agentport/web typecheck`、`pnpm lint:focus`、`pnpm lint:contract`、`biome check`（三个改动文件）通过。

旧报告口径分开：实现阶段旧 full 为 `131` 文件 / `414` suite / `1593` 用例；独立 Opus 复核重跑为 `131` 文件 / `414` suite / `1594` 用例；本修复后为 `132` 文件 / `416` suite / `1600` 用例。`suite` 不等于文件数。

## 修复取舍与限制

- 只复用现有取消链：`accountEpoch` 由账户级 `reset()` 同步递增，hook 用 zustand `subscribe` 同步调用现有 `closeStream()`（递增 generation、关闭 EventSource、清重试计时器）。没有新状态机、全局取消框架或 store registry；`resetConversation`（切会话）不触发该信号。
- 归属判定仍是原有 `mounted + generation`；reset 同步推进 generation 后，晚到发送成功/失败、`recoverPersisted`、历史回填与 SSE 事件全部自动失效，不需要在每条回调里再加账户判断。
- 两个显式退出入口（用户菜单、`AccessDenied`）都调用同一 `logoutAccount()`；测试触发的是这个共享清理函数，没有分别点击两处 UI。入口接线未改，401/改密路径未改。
- 本次覆盖的是“账户 reset 后、聊天页尚未卸载”的窗口；真正卸载仍由原有 mount effect 关闭流。
- `accountEpoch` 只在内存中，不持久化；刷新后不存在可撤销的旧流，不需要跨刷新语义。
- 未改 B 的健康流轮询、缓存终态不截流与取消 invalidate 行为；未改认证服务、API/DB/worker/SDK/shared、LoopX；未 commit。
