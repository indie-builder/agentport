# Implementation Plans

由 improve 技能生成于 2026-11-14，基线 commit `7166f519`。执行前请读完整份计划，遵守其 STOP 条件，完成后更新本表状态。

## 执行顺序与状态

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| 001 | 拦截生成式 MCP 工具路径参数的 `..` 越界 | P1 | S | LOW | — | DONE (#396, `46d043f3`) |
| 002 | 专家保存/回滚后失效 `agent-detail` 缓存 | P1 | S | LOW | — | DONE (#397, `555cd699`) |
| 003 | 同页历史导航不再静默丢弃专家草稿 | P2 | S | LOW | — | DONE (#398, `c7383a0d`) |
| 004 | 生成式 MCP 长期 token 改为加密/哈希存储（方案确认后实施） | P2 | L | MED | 维护者确认 | REJECTED（暂缓，见下） |

Status: TODO | IN PROGRESS | DONE | BLOCKED (原因) | REJECTED (理由)

## 依赖说明

- 四个计划相互独立，可并行。每个都可单独执行、单独验证。
- 001 与 004 都改 `packages/api/src/modules/servers/` 下文件但**不同文件、不同关注点**（001 只动 `generated.ts`；004 动 `repo.ts`/`mcp-endpoint.ts`/`package.ts`），可并行；若同一执行者串行做，先 001 后 004 避免合并冲突。
- 004 涉及已存在数据的 token 形态变化，务必先读其「STOP 条件」与回填步骤。

## 通用验证命令（来自本仓库 recon，勿臆造）

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 单包类型检查 | `bun run --filter @agentport/<pkg> typecheck` | exit 0 |
| 后端测试（bun:test，需 Docker PG/Redis） | `bun run test -- packages/api/test/<file>.test.ts` | 全绿、0 skip |
| 前端测试（vitest + jsdom + MSW） | `bun run test:web` | 全绿 |
| 格式化/规范检查（只读） | `bunx biome check <paths>` | 0 error |
| 焦点/边框契约 | `bun run lint:focus` | 退出 0，输出「校验通过」 |
| 项目契约 | `bun run lint:contract` | `project contract OK` |

> 注意：先构建共享包再跑后端测试（`bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`），否则测试加载的是旧 `dist`（见 `docs/PITFALLS.md`「workspace 包导出指向 dist」）。

## Findings considered and rejected（勿再报）

- **004 生成式 MCP 长期 token 加密存储（暂缓）**：Phase 0 调查确认沙盒 `.mcp.json` 用**按 run 的短期 token**（`worker/src/index.ts:157-158`），长期 `config.mcpToken` 只服务平台自测 + 文档所述的**外部 Host 回退**；仓库内无外部 Host 实际使用证据，且 D-21「暂不对外」、DB 绑 loopback、单机部署。改造需迁移 ~10 个直接 `select config->>'mcpToken'` 的测试 + 回填脚本，风险/成本高于现实收益。**若确认有外部 Host 使用，或备份会离开本机，再重启本项。**

- **全局 `Bun.serve({ idleTimeout: 0 })`**：`docs/PITFALLS.md` 明确记录为有意设置（Bun 默认空闲超时会在途请求被断），非缺陷。
- **数据表格列设置“移动错列”**：误读——`reorderColumns()` 自身过滤 `locked` 列，索引空间与 `draggable` 一致，无 bug。
- **频道 SSE 逐事件鉴权**：PITFALLS 要求回放中逐事件复核撤权，不能改为逐页检查；非缺陷。
- **限流 Redis 重连→503**：未验证 Bun 客户端重连语义，不建议擅自 fail-open。
- **compose 弱口令 / API `0.0.0.0:3000`**：DB/Redis 已绑 loopback，属单机本地边界；未擅自要求改监听/轮换。
- **空 slug 清理 `rm`、知识 blob 入队失败泄漏、重试消息 ID 变动**：仅代码模式、缺实际误删/可见性证据，降级为待测候选，不列入本批计划。

## 已列入但尚未建计划的候选（后续按需）

- 性能测量候选：运行详情无界 + 2s 轮询；记忆审核列表整段读会话（**既有审计称实测非问题，须先复测**）；`listServers` 每次解密全部 secret；knowledge 包导入请求内同步 CPU。
- 安全候选：OpenUI 来源链接 scheme 白名单（需先核对 React/CSP 处理 `javascript:`）；知识图片内联返回且接受 SVG。
- 一致性/技术债：`isPgCode` 两份实现；`cn` 双导入口径；三个超大前端文件（agent-editor / knowledge-faq / memory-review）。
- DX/文档：src 范围 Biome 39 error（26 为可自动修的 organizeImports）；`DECISIONS-PENDING.md` D-15 与 `PROJECT-BRIEF §9.4` 关于 `@bull-board/*` 的表述已过时（代码与 `OBSERVABILITY.md` 已接入 `/api/ops/queues`）。
