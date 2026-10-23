# 剩余待办清单（2026-10-24）

> 来源：原 LoopX `agentport-goal` 的 68 条 open todo，经代码与文档逐条核对后收敛。
> LoopX 已不再使用；本文件是唯一待办来源，后续由 `/loop` 或人工按序执行。
> 已核对 50 条为已完成/过时（见文末），不再跟踪。

## P0

1. **重跑全量回归 + 20 条用户故事验收**
   - 现状：`docs/HANDOFF.md` 记录过 156/162、6 项失败；`docs/DELIVERY.md` 未复跑；`tests/smoke.e2e.ts` 默认跳过真实对话。
   - 验收：先停 worker，`pnpm test` 全绿；再 `E2E_FULL=1 pnpm test:e2e`；逐条核对 `docs/USER-STORIES.md` 并更新 HANDOFF。
2. **修复后重做空库部署演练**
   - 现状：`docs/FIRST-RUN.md` 说明“修复后未重新做整轮空库演练”。
   - 验收：隔离环境 `pnpm run down --clean && pnpm run up && pnpm smoke`。
3. **完成 UI/UX 独立审查剩余 6 轮**（当前 4/10）
   - 现状：`docs/UI-UX-REVIEW.md` 仅 4/10；读屏、iOS、200% 缩放未实测。
   - 验收：每轮覆盖 12 类页面并留实机证据；最终 `pnpm exec e2e run tests/regression.e2e.ts`。
   - 已发现的候选偏差（需先复核再修）：品牌为 GIF 而非 PACE 字标；侧栏宽度用 CSS 过渡而非 Motion。

## P1

4. **真实部署验证安全项 + 收敛沙盒出站**
   - 现状：`docs/SECURITY.md` 称限流/CSP/会话吊销仅单测；`packages/worker/src/sandbox/docker.ts` 的 proxy 不强制，`docs/OPERATIONS.md` 说明无代理时会回落 `open`。
   - 验收：登录连击得 429；响应含 CSP；logout 后旧 Cookie 401；伪造 Origin 不回显；`SANDBOX_EGRESS=none` 时模型/MCP 明确失败。
5. **同步过时文档**
   - 现状：`README.md` 仍写 120/min、模型凭证未代理；实际 `packages/api/src/plugins/security.ts` 为 600/min，D-17 已代理。`docs/DELIVERY.md` 仍写凭证未代理、仅两种权限模式、`/health` 无鉴权，与 `docs/HANDOFF.md`、`packages/shared/src/agent.ts` 冲突。
   - 验收：`rg -n '未代理|120/min|只有.*dontAsk|无鉴权' README.md docs/DELIVERY.md` 后逐条改正。
6. **验收子智能体子级资源与自有 server 绑定**
   - 现状：`docs/ARCHITECTURE.md` 称子技能资源真实加载未验证；`docs/SUBAGENTS-VERIFICATION.md` 称子 server 绑定被忽略。
   - 验收：真实模型跑“仅子智能体绑定 server/技能”的委派，记录事件与结果。

## P2

7. **清死代码与无效配置**
   - 现状：`components/ui/{input-group,popover,table,message}.tsx` 有未调用导出；`docs/OPERATIONS.md` 的 `AGENT_DEFAULT_MODEL`、`AGENT_MAX_BUDGET_USD` 仅校验不使用。
   - 验收：grep 无引用后删除，`pnpm typecheck && pnpm build`。
8. **低优先/可延后**（当前数据量与单机定位下不阻塞）
   - 分支 UI 仅支持从最新消息分支；agents/skills/eval 列表分页与 overview 查询合并；SDK 层子智能体深度硬限制。

---

## 判定已完成/过时（50 条，不再跟踪）

- 前端与视觉（12 条）：设计系统已按实测落 272/68、728/56 与卡片例外；页面、品牌、聊天、导入导出、审计/详情均已实现。
- 安全与运行（13 条）：token 轮换、脱敏/上限、结构化审批、SSE 独立订阅、SIGKILL/孤儿收敛、短期 token/0600 均已在代码与 SECURITY 落地。
- 定义、评估与探索（11 条）：50 轮能力补齐已验收；评估队列、历史、技能/工具/版本已落地。
- 运维与交付（14 条）：部署、CI/发布、备份恢复演练、压测、指标、保留任务均有脚本与实测记录。
