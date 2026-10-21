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
