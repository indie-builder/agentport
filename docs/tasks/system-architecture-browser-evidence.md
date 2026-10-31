# 系统架构现代化：A/B/C 真实浏览器验收证据

> 执行日期：2026-10-31。本文件只记录浏览器与运行时证据；代码审计与契约裁决见 `system-architecture-modernization-contract.md`、`system-architecture-A-evidence.md`、`system-architecture-BC-evidence.md`，本文不重复。

## 1. 基线与运行源

- 代码根：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`
- 分支：`refactor/system-architecture-modernization`
- HEAD：`68241ba`（未提交 A/B/C 及其他并行改动仍在工作树；本次未 commit/push/merge，未改产品源码、测试、契约或 `.loopx/`）
- 前端产物：`packages/web/dist`（控制会话 2026-10-31 15:29 构建，早于本次验收）
- API：从本树 `packages/api/src/index.ts` 用 `tsx` 启动，读当前 `packages/shared`/`packages/core` dist；`packages/db` dist 早于源码，本次先执行 `pnpm --filter @agentport/db build`（仅重建构建产物，未改源码）再启动。
- 访问 URL：`http://127.0.0.1:59585`（本次独占端口）
- 环境隔离：本轮随机 PostgreSQL 库 `architecture_browser_047e16b03cb94c0c`、独占 Redis 容器 `backend_test_redis_1a32da9dab3a4e71`（db 9）、临时 `WORKSPACES_DIR`/`KNOWLEDGE_DIR` 均在 `.tmp/architecture-browser-sysarch-1031/`；未连接开发库、未改动用户登录或既有服务。测试账户为本轮随机生成并只写入 0600 临时 state 文件，未打印凭据。
- 浏览器：ego-browser，TaskSpace 固定名 `agentport-architecture-validation`（space 88），结束后 `finish({ keep: [] })`；未操作既有标签页，未清理 profile 全局存储。

## 2. 账户草稿隔离（C）

所有登录均在真实页面表单 POST `/api/auth/login` 完成，未复制 cookie 绕过登录。

| 场景 | 真实 UI 操作 | 结果 |
|---|---|---|
| A 新会话草稿 | A 登录 → `/agents` 点「与 浏览器验收专家 开始对话」→ 在 `textarea[placeholder="描述你想完成的事…"]` 输入 `EVIDENCE-A-DRAFT-ALPHA` | 输入框可见该文本；sessionStorage 含草稿标记与 A 的 businessId 归属 |
| A 显式退出 | 账户菜单 → 「退出登录」 | 回到 `/login`；sessionStorage 条目数 0；草稿与归属消失 |
| B 登录后打开对话 | B 登录 → 选择同一专家进入新会话 | 输入框为空，`aDraftVisible=false`；sessionStorage 只有 B 的归属标记 |
| A 会话过期后重登 | A 登录并输入 `EVIDENCE-A-REAUTH-BETA` → 在独占测试库执行 `delete from session where user_id in (select id from "user" where business_id=$1)` → 页面 reload | 被带回 `/login`，sessionStorage 草稿仍在；A 通过登录表单重新认证后回到原 `/chat?agent=…`，输入框仍为 `EVIDENCE-A-REAUTH-BETA`，归属仍为 A |

说明：本次「过期」用撤销测试库 session 行模拟，浏览器侧走的是正常 `/me` 未认证跳登录页与正常登录 POST，而非伪造 cookie。

## 3. 健康 SSE 与运行详情请求数（B）

事件注入方式：测试 worker 脚本从独占库发现带 `EVIDENCE-` 标记的 queued run，使用 `@agentport/shared` 的 `chatEventSchema.parse` 校验后 `XADD run:<runId>:events`，并按 worker 语义写入 assistant 消息与 run 终态；未启动模型、SDK 或真实 worker。

真实页面发送 `EVIDENCE-HEALTH-001` 后浏览器侧观测：

- EventSource 真实事件顺序：`onopen` → `run_started` → `assistant_block_start` → `text_delta`（“真实浏览器验收：”）→ `text_delta`（“事件流增量一”）→ 6 秒健康窗口 → `text_delta`（“；终态文本。”）→ `assistant_text` → `run_finished`。
- 健康窗口（onopen 至终态前至少 6 秒）内精确的 `GET /api/runs/<runId>` 只有 **1 次**：resource timing 显示首次详情在 `startTime 18174`，EventSource `onopen` 在 `18194`；随后到 24.3s 没有第二次完整详情请求。
- 同期仍有 `GET /api/runs/<runId>/approvals` 与 `/questions` 每 2 秒轮询；它们不属于被本批关闭的完整详情轮询，统计时已排除。
- 终态后页面显示完整回复与「完成 · 1 轮 · 8.0s · 查看详情」，`run_finished` 前未丢失已缓冲文本。
- reload 后 `GET /api/conversations/<conversationId>` 与 `GET /api/runs/<runId>` 各一次，助手正文与用户消息从数据库恢复完整显示。

## 4. 断线回读恢复（B）

真实页面发送 `EVIDENCE-DROP-001`，测试 worker 先发一段 `text_delta`，再发协议 `error`（API 随即结束流），5 秒后才把 run 写成 succeeded 并补齐消息。

- `onopen` 后收到 `text_delta`；`error` 到达后 DOM 保留已流式文本「断线前已收到的一段文本。」，并显示「连接已中断 · 运行状态未知」与重连入口。
- 断流后 exact `GET /api/runs/<runId>` 恢复轮询：CDP `Network.requestWillBeSent` 与 resource timing 显示断流后约 +2s、+4s 各一次（本次统计断流后 2 次）。
- DB 终态后页面通过回读恢复为「断线前已收到的一段文本。历史回读补全。」，显示「完成 · 1 轮 · 7.6s」，流式项未被重复追加。
- 全程 API 日志无 5xx 或未处理异常（`request completed` 89 条，5xx/ERROR 0 条）。

## 5. 结论与实际限制

通过项：

1. A 显式退出后 B 确认身份前清空 A 的新会话草稿；B 看不到 A 草稿与归属。
2. A 会话过期并重新认证后保留自己的草稿。
3. 健康 SSE 下完整运行详情 GET 只在首次发生，6 秒窗口无周期重复；增量与终态正常，reload 历史恢复完整。
4. 协议 error 断流后详情轮询恢复，已流式文本保留并可从数据库终态恢复。

限制与未覆盖：

- SSE 事件由测试 worker 脚本按 shared schema 注入并直接写测试库，不是真实模型/SDK 沙箱运行，**不构成模型质量、生成式 UI 或沙箱执行验收**。
- 本次只验证 A/B/C 所需路径；知识库、评测、删除等仍在并行实现的功能路径未使用。
- 断线场景用服务端协议 `error` 主动结束流，不是物理网卡断网；未额外模拟浏览器离线/重连计时耗尽。
- 未测试移动端（项目仅面向桌面端）。
- 验收脚本与运行时状态在 `.tmp/architecture-browser-sysarch-1031/`，结束后按约定删除；随机库与 Redis 容器由 supervisor 退出时清理。
