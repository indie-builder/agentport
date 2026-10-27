# 剩余待办清单（2026-10-24）

> 来源：原 LoopX `agentport-goal` 的 68 条 open todo，经代码与文档逐条核对后收敛。
> LoopX 已不再使用；本文件是唯一待办来源，后续由 `/loop` 或人工按序执行。
> 已核对 50 条为已完成/过时（见文末），不再跟踪。

## P0

1. ✅ **重跑全量回归 + 20 条用户故事验收（2026-10-24 完成）**
   - 结果：`pnpm test` 965/965 全绿；E2E 42/43（唯一失败为真实对话在停 worker 时无消费者，属套件设计冲突）；真实模型 API 链路 6s 成功。HANDOFF 已更新。
2. ✅ **修复后重做空库部署演练（2026-10-24 完成）**
   - 结果：`pnpm run down --clean && pnpm run up` 从零建卷迁移启动，`pnpm smoke` = SMOKE OK。修正了 smoke 对空库 `tools/list` 的错误断言（空库返回 -32601 属 MCP 协议正确行为）。
3. ✅ **UI/UX 全页面独立审查（2026-10-24 完成 10/10）**
   - 原第 5–10 轮成果未留痕；本轮以当前代码重做：4 个 Opus 审查域并行覆盖 12 类页面与浮层，修 20 项（含 2 项 P0：收起态焦点隐形、技能支持文件草稿无保护），4 个 Sonnet 修复。
   - 验证：typecheck 全过、web 254/254、全量 965/965、build 通过、biome 0 error、lint:focus 通过；浏览器 320px 六页无溢出且各 1 个 h1。详见 docs/UI-UX-REVIEW.md。
   - 未覆盖：真实读屏/iOS/原生 200% 缩放；`index.html` favicon 仍为 brand.gif 待另换。
## P1

4. ✅ **真实部署验证安全项 + 收敛沙盒出站（2026-10-24 完成）**
   - 出站：`SANDBOX_EGRESS` 默认改 `open`（不隔离出站，明确写入文档）；`proxy` 未配 `HTTPS_PROXY`/`HTTP_PROXY` 时 `loadConfig` 直接抛错，worker 启动退出（fail-closed），删除原先静默降级 `open`。`none` 含义与启动警告不变。未实现出站代理本身。
   - 自动化：`packages/worker/test/config.test.ts`（默认值 / proxy 缺代理抛错 / proxy 带代理通过）；`security.test.ts` 增加 `/` 与 `/health/live` 的 CSP、`/mcp/*` 无 CSP；`auth.test.ts` 已有 logout 后旧 cookie 401。
   - 真实部署（运行中的 compose）：错误登录第 11 次 429（`RATE_LIMITED`）；`/` 与 `/health/live` 带 CSP、`/mcp/srv_missing` 404 且无 CSP；登录→logout→重放旧 cookie 401 `session expired or revoked`；`OPTIONS /api/servers` 伪造 Origin 无 `Access-Control-Allow-Origin`；容器内 `SANDBOX_EGRESS=proxy` 无代理启动 exit 1。
   - 未覆盖：`SANDBOX_EGRESS=none` 下模型/MCP 的失败表现（行为未改动，仍仅有启动 warn）；限流 429 未进单测（vitest 全局 `RATE_LIMIT_DISABLED=1`），改由上述部署验证覆盖。
5. ✅ **同步过时文档（2026-10-24 完成）**
   - README/DELIVERY 已按代码修正（600/min、D-17 已代理、4 种权限模式、/health 鉴权区分、规则/输出风格/记忆/技能资源/定时任务），并清理 DECISIONS/HANDOFF/CHANGELOG 残留 120/min。`rg '未代理|120/min|只有.*dontAsk|无鉴权'` 无命中。
6. ✅ **子智能体子级资源与自有 server 绑定（2026-10-24 处理）**
   - 技能参考文件：已放行主会话 `Read` 只读 `.claude/skills/<slug>/references/**/*.md`（写入仍仅限记忆目录）；此前 Read 只允许记忆目录导致 references 不可读。
   - 子智能体自有 MCP：官方支持子级 `mcpServers`（已在 ARCHITECTURE/SUBAGENTS-VERIFICATION 如实记录平台尚未接通、继承父工具集），完整实现（渲染/许可/按 run 子绑定鉴权，涉及授权扩散）列为后续明确项，不声称已支持。

## P2

7. ✅ **清死代码与无效配置（2026-10-24 完成）**
   - 删除 `components/ui/{input-group,popover,table,message}.tsx` 中无外部引用的具名导出：`InputGroupText`/`InputGroupTextarea`、`PopoverHeader`/`PopoverTitle`/`PopoverDescription`、`TableFooter`/`TableCaption`、`MessageAvatar`/`MessageHeader`/`MessageFooter`（连同定义与随之未使用的 import），净删 123 行。
   - 删除 `docs/OPERATIONS.md` 中幻影配置 `AGENT_DEFAULT_MODEL`、`AGENT_MAX_BUDGET_USD`（`packages/api/src/config.ts` schema 从未解析，文档“仅校验”说法有误）。
   - 验证：`pnpm -r typecheck` 全过；`pnpm test` 971/971；web 254/254；`biome check packages/*/src packages/*/test` 0 error；`pnpm build` 全过。
8. **低优先/可延后**（已逐项复核；2026-10-24）
   - ✅ **分支 UI 支持从任意已持久化用户消息分支（2026-10-24 完成）**：每条用户消息下方常显图标按钮，走 API `fromMessageId`；`ChatItem` 用户项新增 `messageId`（`id` 是合成 `${message.id}:0`，不可作锚点）；运行详情重建步骤（空 `conversationId`）不带锚点、不显示按钮；新发/流式消息无持久化 id 不显示入口。验证：web 257/257、全量 974/974、320px 无横向溢出，浏览器实测点第一条消息分支后新会话 `branch_of_message_id=msg_vb_u1` 且仅复制 1 条消息。
   - ✅ **overview 查询合并（已完成，`f733d08`，2026-10-25）**：`/api/overview` 由 6 条 SQL 合并为 3 条并行查询；counts（servers/agents/running/runs）并成一条，另两条为智能体聚合与最近 20 条运行。
   - **列表分页**：当前数据量下单页返回可接受，保持延后。
   - **SDK 层子智能体深度硬限制**：SDK 本身不提供深度参数；单层约束已由 API 父子校验 + 子智能体 `disallowedTools` 含 `Agent` 保证，硬限需自研，保持延后。

---

## 判定已完成/过时（50 条，不再跟踪）

- 前端与视觉（12 条）：设计系统已按实测落 272/68、728/56 与卡片例外；页面、品牌、聊天、导入导出、审计/详情均已实现。
- 安全与运行（13 条）：token 轮换、脱敏/上限、结构化审批、SSE 独立订阅、SIGKILL/孤儿收敛、短期 token/0600 均已在代码与 SECURITY 落地。
- 定义、评估与探索（11 条）：50 轮能力补齐已验收；评估队列、历史、技能/工具/版本已落地。
- 运维与交付（14 条）：部署、CI/发布、备份恢复演练、压测、指标、保留任务均有脚本与实测记录。
