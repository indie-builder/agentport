# 技术栈合规循环（10 轮）

> 目标：持续发现并修复「本可以复用项目技术栈、却手写实现」的地方，前后端都覆盖。
> 每轮结束都要跑全量校验；发现问题、修复、再发现，直到 10 轮跑完或连续两轮零发现。

## 每轮固定流程

1. **发现（必须隔离上下文）**
   - 派 2–4 个 `Explore` 子代理，每个只审一个范围，互不重叠。
   - 子代理之间不共享上下文；主会话只接收结论表，不接收文件正文。
   - 范围按层切分，示例：`api 路由与校验` / `db 与队列` / `sandbox 与 worker` / `web 页面` / `web 组件与 hooks`。
2. **汇总与定级**
   - 合并成一张表：`严重（真违规）` / `次要` / `可接受（手写更合适，写明理由）`。
   - 只修前两类；第三类必须写明为什么保留，避免下一轮重复发现。
3. **修复（并行）**
   - 按文件边界拆分修复线，每条线声明「只改这些文件」。
   - 共享文件（`App.tsx`、`queries.ts`、`shared` 类型、schema）由主会话统一改，或先改后冻结。
4. **验证**
   - `pnpm typecheck`（全部包）
   - `./node_modules/.bin/biome check packages/*/src`
   - `pnpm test`
   - 涉及前端交互的改动，用 ego-browser 对 `localhost:5173` 实测一次
5. **记录**
   - 提交信息写清「替换了什么、删了多少行」。
   - 本轮结论追加到本文件的「轮次记录」。

## 判定标准

**算违规**（必须改）：
- 手写了已有库能提供的东西：浮层、焦点陷阱、下拉、折叠、拖拽、分栏、虚拟列表、表单校验。
- 服务端状态绕过 TanStack Query：组件里裸 `api.*`、手动 `setInterval` 轮询、写完手动 `refetch`。
- URL 状态放在组件 state：筛选、分页、选中项。
- 前端：手写 toast、手写 class 合并、手写图标粗细、硬编码色值/圆角。
- 后端：Fastify handler 里写 `safeParse` 而不是用 schema；手写 zod 已能表达的校验；绕过 `typed()`。
- 数据层：手写 SQL 拼接（应用 Drizzle 查询构造器）、手写重试/事务（用 repo 既有封装）。

**不算违规**（写明理由后保留）：
- 库不建模的东西：SSE 流与重连、贴底滚动判定、本地时钟、localStorage 的信任边界校验。
- 引入依赖比手写更重的：4 类 token 的 JSON 高亮、3 行的事件监听。
- 平台能力本身：隐藏 `<input type="file">`、`prefers-reduced-motion` 查询。

## 收敛条件

- 连续两轮零「真违规」即提前结束。
- 每轮必须比上一轮缩小范围：记录本轮新发现数量，若连续两轮数量不降，说明维度切得不对，换维度。

## 轮次记录

<!-- 每轮结束时追加：轮次、范围、发现数、修复数、验证结果、提交 -->

### 第 1 轮 — 2026-10-21

**范围**：API 路由与校验 / DB 与队列 / Sandbox 与 Worker / 前端组件（四条隔离子代理）。
**发现**：30 项真违规 + 22 项次要。
**修复**：五条并行线（API、DB、Worker+Sandbox、前端、shared 契约），另由主会话修 sandbox 镜像打包。

关键结论：
- 登录是唯一未认证写路径，却用手写 `typeof` 校验 → 改为 zod schema。
- `agent_runs.model_token_hash` 无索引，模型代理每次请求都全表扫 → 已加部分索引（迁移 `0016`）。
- Redis 流协议在 producer 与 runner-client 中逐字符串重复 → 常量与键名抽到 `@agentport/shared/run-stream.ts`。
- sandbox 镜像未打包 `@agentport/shared`，新增的 stdin 校验会让镜像运行时 `ERR_MODULE_NOT_FOUND` → Dockerfile 与构建脚本已修，并用真实镜像验证。
- 前端：6 个裸 `<button>`、两个漂移的 Brand、3 组死导出、33 处任意圆角、16 处冗余 strokeWidth → 全部收敛。

**验证**：7 包 typecheck、biome 126 文件、139 测试全过（停 worker 后跑完整集成）。
**遗留**：`mayEnableTool` 需从 core 导出（sandbox 未声明 core 依赖）；`slugSchema` 需从 shared 导出；队列工厂仍需下沉。

### 第 2 轮 — 2026-10-21

**范围**：错误处理与日志 / 测试与跨包重复 / 前端无障碍与动效（三条隔离子代理）。
**发现**：12 项真违规 + 12 项次要 + 8 个测试缺口。
**修复**：四条并行线。

关键结论：
- **第 1 轮的漏修**：只有 worker 换到了 shared 流常量，API 的 producer 仍保留自己的副本。本轮补齐，并加了契约测试（mock 值证明 producer 真的在消费 shared，而非复制）。
- **真实功能缺陷**：`overview` 的智能体名链接嵌在 `disabled` 按钮里，用户点不动。根因在 data-table：无交互的行不该渲染成 button。
- **无障碍**：8 处 `focus-visible:outline-none` 没有焦点环兜底，键盘用户完全看不到焦点。已删，回落到全局黑环；浏览器实测全站 Tab 遍历无遗漏。
- **幂等回归**（本会话发现并修）：audit 写入改成 `newId('audit')` 后，基础设施重试会为同一次运行写多行。给 `writeAudit` 加 `dedupeKey`，worker 传 `aud_<runId>` 且 `onConflictDoNothing`。
- 测试从 139 增至 162，新增 producer 契约、限流开关、TypeID 解析、pg 23503 分支、toAppError 映射。

**验证**：7 包 typecheck、biome 154 文件、162 测试全过；浏览器实测焦点环与链接可点。
**遗留**：`Tabs` 不再是 Radix（改成分段按钮，失去了方向键导航）；如需方向键语义要换成带真实面板的 tablist。

### 第 3 轮 — 2026-10-21

<!-- 待主会话填写本轮范围、发现数、修复数与验证结果 -->

**范围**：_(待填)_
**发现**：_(待填)_
**修复**：_(待填)_
**验证**：_(待填)_

### 第 3 轮 — 2026-10-21

**范围**：安全边界 / 依赖与资源生命周期 / 文档与代码漂移（三条隔离子代理）。
**发现**：3 项高危 + 7 项真违规 + 12 项次要。

关键结论：
- **高危：全局限流是关闭的。** `global:false` 让只有 5 个路由受限，SSE 完全开放；每个订阅者 `duplicate()` 一条 Redis 连接，一个会话就能耗尽 `maxclients`。改为 `global:true`（120/min），`/health/metrics` 加 `requireAuth`。
- **高危：API 关机永远走不完。** `app.close()` 等待所有 socket，而 SSE 用 `reply.hijack()` 长连接，唯一能关它们的 `closeProducer` 挂在 `onClose`（关完之后）。SIGTERM 必然超时被 SIGKILL，Redis/PG 连接泄漏。改为先关 producer、超时兜底、强制断连。
- **高危：workspace 目录无界泄漏。** 可重试失败耗尽重试后目录不清；实测清理出 **42 个** 残留目录。加了启动清扫与终态清理。
- 文档：sandbox 镜像构建配方因我上轮改 Dockerfile 而失效（`COPY shared/: not found`），已全面修正；CI 同样问题一并修复。
- 安全：`isServerUsableInSandbox` 是从未被调用的死代码，选择删除并明确记录「stdio 在沙盒内执行是有意为之」。

**验证**：7 包 typecheck、biome 154 文件、163 测试全过、`docker compose config` 有效。
**遗留**：`Tabs` 无方向键导航（第 2 轮取舍）；sandbox 镜像 musl 二进制问题未修（需换基础镜像）。

### 第 4 轮 — 2026-10-21

**范围**：性能与 N+1 / 并发与状态一致性。
**发现**：4 项高危竞态 + 6 项性能热点。

关键结论：
- **取消被吞**：worker 先 `exists(cancelKey)` 再 `subscribe`，落在窗口里的取消永远收不到——API 已回 202 并写 `cancelled`，容器却跑满超时。改为先订阅再检查。
- **终态被覆盖**：终态写回没有 `status='running'` 守卫，取消与完成并发时 DB/审计/SSE 三方不一致。
- **重试机制对沙盒后错误失效**：可重试失败在 throw 之前就写了 `failed`，重试任务被自己的守卫跳过。`attempts: 2` 形同虚设。
- **性能**：`listMessages` 无上限；会话列表的 lateral 子查询对全部会话求值（实测 0.596ms/25 次 loops → 0.091ms/3 次）；聊天页每个 token 重渲染全部工具行（实测 300 → 0）。
- worker 消息逐行插入（约 1000 次往返）→ 改为 500/批。

**验证**：7 包 typecheck、biome 155 文件、165 测试全过、构建通过、迁移 0017/0018 已应用。
**遗留**：`queued` 状态的陈旧 run 无清扫（需要 `created_at` 列）；聊天面板无虚拟列表，长会话仍全量渲染。

### 第 5 轮 — 2026-10-21

**范围**：API 契约完备性 / 部署与环境一致性。
**发现**：2 项阻断 + 9 项真问题。

关键结论：
- **阻断：smoke 每次部署都假失败。** 第 3 轮给 `/health/metrics` 加了鉴权，smoke 仍匿名探测它。已改为匿名断言 401、登录后断言 200——顺带把安全属性也测了。
- **阻断：release workflow 红。** 漏了 shared 暂存步骤，`COPY shared/` 必失败。已补齐并跑 actionlint。
- **测试静默跳过**：`vitest.config` 硬编码 Redis 无密码，而 `up.sh` 写入随机密码，导致 `pnpm test` 拿到 WRONGPASS 后**静默跳过 87 个测试**。改为读同一份 `.env`：87 skipped → 0 skipped。
- **用户可见：评估失败无原因。** 服务端存了 `error`，客户端类型没有该字段，UI 只显示「失败」。已补字段并加「失败原因」列。
- **零 response schema**：web 解析的 5 个端点现在有 schema，形状漂移会被测试抓到而不是静默丢弃。
- 错误文案英文混杂且泄露内部 id → 全部改为中文带下一步。
- 沙盒镜像不可复现（无锁文件）→ 提交 `package.docker-lock.json`，`npm ci`，基础镜像按 digest 固定。

**验证**：7 包 typecheck、biome 156 文件、165 测试全过、`compose config` 有效、全部脚本 `bash -n` 通过、smoke 实跑全绿。
