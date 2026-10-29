# 聊天历史分页的滚动位置保持

## 目标

修复已诊断的聊天分页滚动缺陷，并用真实浏览器几何证据验收：

1. **补旧消息后跳到最新**：向上翻到顶、加载更早一页后，视图被拽回底部。期望保持点击前正在阅读的消息在视口内的位置。
2. **分页保持分支永不触发**：「加载更早消息」入口是 `MessageScrollerContent` 的第一个子项，原语用「旧首 DOM 子项在新数组中的 index > 0」识别 prepend，入口永远停在 index 0，`preserveScrollOnPrepend` 保持分支无法命中，落到跟随底部分支。

验收标准：

- 首屏 125 条 fixture 只渲染 075–124；点击前记录 `history-message-075` 所在消息项的稳定 id 与相对视口 top，确认可见。
- 加载 50 条后 025–124 唯一、075 仍可见，相对视口 top 容差 4px，且远离底部（不是只在顶部或只看列表长度）。
- 再向上滚加载最后一页：入口消失，点击前可见消息（025）相对视口 top 仍容差 4px。
- 显式发送新一轮用户消息仍回到底部；向上阅读时追加的助手增量不抢滚动；末尾用户消息在补旧重新解析后不再触发回底。
- 旧的 `scrollTop < 100` 断言必须替换为阅读位置保持，不放宽为只断言列表长度。

## 方案

根因与修法（用户已诊断、Opus 只读确证）：

- **缓存重解析换对象**：`mergeOlderHistory` 对整段历史重新 `historyToItems`，末尾历史消息的 id / messageId 不变但对象引用改变；`ScrollToLatest` 只比较对象引用，误判为新用户轮并 `scrollToEnd`。修法：有持久 id 的历史用户项按 `id ?? messageId` 识别同一消息；没有持久 id 的新发送用户项保留对象身份比较。显式发送仍然回到底部。
- **入口挡住 prepend 识别**：把「加载更早消息」入口从 `MessageScrollerContent` 移到 `MessageScrollerViewport` 内、Content 之前的正常流，让真实消息成为 Content 首项；沿用原语 `preserveScrollOnPrepend` 默认能力，不写手工滚动算法、ResizeObserver 或强制 `scrollTop = 0`。
- 不换实现、不改 `@shadcn/react` 原语、不加新依赖。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线 commit：`e060e3a`（= `origin/main`，工作树 HEAD 一致）
- 开工时已有未提交差异（他人/前序任务，不还原、不提交）：
  - `packages/web/src/pages/chat.tsx`（前序 chat 缓存挂载修复）
  - `packages/web/test/chat-ux.test.ts`（前序缓存行为测试，本次不改）
  - `tests/chat-history-pages.e2e.ts`（前序历史入口/定位器修复）
  - API/worker/shared/db/文档等其他作者的差异，归属见 `docs/tasks/codebase-review-loop.md`
- 本任务允许改动：
  - `packages/web/src/pages/chat.tsx`
  - `tests/chat-history-pages.e2e.ts`
  - 新增 `packages/web/test/chat-scroll.test.ts`（滚动身份识别行为测试；不改 `chat-ux.test.ts` 既有缓存测试）
  - 本记录 `docs/tasks/codebase-review-chat-scroll.md`
  - 自己的 gitignored `.tmp/codebase-review-chat-scroll/` 临时启动脚本与日志
- 明确不改：`packages/shared` / `packages/db` / API / worker / agents 字段源码、历史 filter 主记录与 e2e 主记录、依赖与配置。

## 当前有效决定

- 用户要求：主会话直接执行，不派代理、不提交；scope 是纯 bug，普通执行，架构已定不换实现。
- 先红后绿：真实 E2E 几何证据与诚实 unit 分层；不引入付费模型。
- 不用旧 `dist` 冒充新源码；如并发构建占用，先做源码/单测，浏览器验证等构建稳定。
- 可复用 `.tmp/codebase-review-e2e/run.sh` 的做法，但必须读脚本、起自己唯一的随机 PG/Redis/端口实例，用最新源码产物，不改原脚本、不写其他代理日志目录。

## 已替代项及原因

- 取代旧 E2E「补旧后 `scrollTop < 100` 且离底部 > 700」：该断言只要求仍在顶部，不能证明阅读位置保持，也与入口移出 Content 后的正确行为不符。

## 步骤

- [x] 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`、`docs/DESIGN-SYSTEM.md`；加载 ub-mode / shadcn / ego-browser / Vitest 技能。
- [x] 核对已安装 `@shadcn/react@0.3.1` 的 `message-scroller` 真实实现：prepend 识别依赖旧首子项 index > 0。
- [x] 固定基线 `e060e3a` 与既有差异归属，创建本记录。
- [x] 先补/改真实 E2E 几何断言并确认按预期失败（红）。
- [x] 最小修 `ScrollToLatest` 身份识别 + 加载入口移出 Content（绿）。
- [x] 补滚动身份 unit 测试（历史重解析不触发回底、新发送回底）。
- [x] 跑相关 chat web 测试、web typecheck、所改文件 biome。
- [x] 在独立临时 PG/Redis/端口与最新源码产物上跑 chat history E2E，记录真实计数与清理证据。
- [x] 更新本记录为待 Opus review。

## 改动文件

- `packages/web/src/pages/chat.tsx`
- `tests/chat-history-pages.e2e.ts`
- `packages/web/test/chat-scroll.test.ts`（新增）
- `docs/tasks/codebase-review-chat-scroll.md`
- `.tmp/codebase-review-chat-scroll/`（gitignored 临时脚本/日志）

## 下一步

- 待独立 Opus review；未返回结论前不标记已验收。
- 未授权 commit / push / merge，不执行。

## 验证

### 1. 单元测试先行（红）

改动源码前新增 `packages/web/test/chat-scroll.test.ts` 后执行：

```
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-scroll.test.ts
```

真实结果：`Test Files 1 failed (1)`，`Tests 2 failed (2)`。

- 身份用例：补旧合并后的重渲染 `expected "vi.fn()" to not be called at all, but actually been called 1 times`，即 `ScrollToLatest` 因对象引用变化回到底部；失败行 `chat-scroll.test.ts:143`。
- 结构用例：`entry.closest('[data-slot="message-scroller-content"]')` 非空，入口仍占 Content 首项。

### 2. 真实浏览器红证据（修复前产物）

先用修复前的源码产物跑新几何断言。`packages/web/dist`（21:01 构建，早于本次源码改动；已核对不含新代码）复制到本任务独立的
`.tmp/codebase-review-chat-scroll/web-dist-red`，再运行：

```
CHAT_SCROLL_WEB_DIST=<worktree>/.tmp/codebase-review-chat-scroll/web-dist-red \
  bash .tmp/codebase-review-chat-scroll/run.sh
```

真实结果：`Test Files 1 failed | 2 passed (3)`，`Tests 1 failed | 8 passed (9)`。
唯一失败为分页滚动，失败时实测几何：

```
last: expected {"sameId":true,"offset":3595,"steady":false,"visible":false,"distanceFromBottom":59}
  to match object {"sameId":true,"visible":true,"steady":true}
```

`sameId` 说明轮次项 id 稳定；`offset:3595`、`visible:false`、`distanceFromBottom:59` 说明视图被甩到底部，与诊断一致。

### 3. 修复后单元与静态检查

- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-scroll.test.ts` → `Test Files 1 passed (1)`，`Tests 2 passed (2)`。
- 完整相关 chat suite：`pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/chat-` → `Test Files 18 passed (18)`，`Tests 277 passed (277)`，无 skip。
- `pnpm --filter @agentport/web typecheck`（`tsc -b`）→ exit 0，无输出。
- `pnpm exec biome check packages/web/src/pages/chat.tsx packages/web/test/chat-scroll.test.ts tests/chat-history-pages.e2e.ts` → `Checked 3 files ... No fixes applied`，0 error。

### 4. 修复后真实浏览器绿证据（当前源码独立产物）

用当前源码构建独立产物，不覆盖公共 `packages/web/dist`：

```
pnpm --filter @agentport/web exec vite build \
  --outDir <worktree>/.tmp/codebase-review-chat-scroll/web-dist --emptyOutDir
```

产物时间 21:14，构建成功；旧结构标记 `load-older` 在产物中已不存在。

在独立随机 PG 库 `e2e_chat_scroll_*`、唯一临时 Redis 容器、随机 loopback 端口上运行
`auth.e2e.ts + chat-history-filter.e2e.ts + chat-history-pages.e2e.ts`，连续两轮：

```
Test Files  3 passed (3)
Tests       9 passed (9)   // 每轮
Duration    16.31s / 13.26s
```

清理证据（`cleanup-proof.txt`）：`e2e exited with 0`、`removed redis container ...`、
`dropped database e2e_chat_scroll_*`、`database remaining rows: 0`、`redis container remaining lines: 0`。
未使用共享库、共享登录态或付费模型。

修复后实测几何（1440×900）：

- 第一页：075 的 `beforeTop=60`、`afterTop=60`（偏移 0，容差 4px 内），`sameId` 不变，`distanceFromBottom>700`；025–124 唯一共 100 条。
- 最后一页：025 的 `beforeTop=60`、`afterTop=60`（偏移 0），入口按钮消失，000–124 唯一共 125 条，`distanceFromBottom` 约 8000。

### 5. 测试时序修正（非产品改动）

加入几何断言后，早期绿测仍出现 48–74px 偏移。逐帧采样显示：恢复后 `scrollTop` 从 4280 连续缓动回 4235、
`top` 从 60 变为 105，并伴随真实 `scroll` 事件，但没有任何 JS `scrollTop` 赋值、`scrollTo`、`scrollBy`、
`scrollIntoView` 调用；临时禁用 `content-visibility` 与 `overflow-anchor` 均不能消除。结论是 `wheelChatToTop`
在 `scrollTop<100` 即返回，滚轮合成器仍在收尾平滑滚动，测量把输入动画算进了阅读位置。

测试改为等滚轮真正停在顶部（`scrollTop === 0`），再等 `scrollend`（不支持时 600ms 兜底）后才记录锚点；
之后连续两轮绿测偏移为 0。产品代码未加入任何手工滚动算法或 observer。

### 6. 未覆盖 / 限制

- E2E 只运行 `auth` + 两份 chat-history 文件；`chat-replay.e2e.ts` 被 harness 以 `E2E_WORKER_PAUSED=1` 为前提跳过，未运行真实模型。
- 390px 窄屏用例仍只验证条数与唯一性，未加入相对位置几何断言。
- 浏览器几何证据来自 1440×900；不同字号/缩放下由原语按真实 DOM 位置恢复，未额外手写数值。
- `packages/web` typecheck 不含测试文件；新测试证据来自 Vitest 与真实 E2E 运行。
