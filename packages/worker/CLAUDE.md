# worker 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；运行、关停与测试隔离见 [OPERATIONS](../../docs/OPERATIONS.md)。本文件只写 worker 的专属约束。

## 入口与队列

- 入口只起 BullMQ consumer、reconciler 与 scheduler（runs、eval、knowledge、maintenance、runtime environment builds、schedules），不暴露业务 HTTP API。唯一监听是模型代理（固定端口、Bearer run token），不把它扩成业务路由面。
- 能直接调用官方 SDK 的地方（知识 Wiki/图片处理、记忆审核）直接 `query()`；聊天执行走 sandbox。不要引入第二套执行循环或编排底座。
- 队列 payload 用 shared 的 `agentRunJobSchema` / `evalRunJobSchema` / `scheduleTriggerJobSchema`；事件用 `ChatEvent` 与 `run-stream.ts` 的 key/选项，不另写形状。

## 运行与状态

- 只认领 `queued → running`；BullMQ 重投 running 时不得再跑一遍。重复投递、取消与主体失效都先查 DB。
- 执行前从 run 行重查执行主体与权限；job/client 里的身份字段不参与判定，不降级成 system/admin。
- 重试仅限「停稳已确认 + 基础设施瞬时故障」；重试前把行改回 queued 再抛错。业务失败不重试，停稳未确认不得重跑。
- 终态用 CAS 只写一次并发布一条 `run_finished`。停稳后、消息已保存且不再重试才发布产出；停止未确认时只交接 `pendingFinish`，保持 running，等 reconcile 确认容器销毁。
- 每轮重新渲染工作区（`renderWorkspace` / `toWorkspaceInput`）；workspace 只读挂载，outputs 单独 rw，inputs 与个人记忆只读，子智能体记忆按现有 per-slug 规则挂载。解绑的 agents/skills/plugins 旧文件必须清掉。
- 会话容器复用走 `SessionSandboxes`；空闲回收、reconcile 与关闭都由这里管理，不新建第二个容器生命周期。

## 凭证与清理

- 模型代理启用时每轮用短期 token，DB 只存 hash；未启用时按现有回退注入真实凭证并保留启动告警。结束（无论是否停稳）都清 DB token 并撤销模型 token；停稳后删除 idle workspace 的 `.mcp.json`，删除失败则禁止复用并销毁容器。
- run 临时目录结束即删；稳定工作区、outputs、sdk-sessions、agent-memory 不随 run 或关停删除。
- 关停先 abort 新容器，再有界排空 run、关闭沙盒与队列，最后关 Redis/PG；清理失败如实记录并以非零码退出。

## 验证

`pnpm --filter @agentport/worker typecheck` 与 `packages/worker/test` 对应套件；Docker/Redis 相关用例按其前置跳过，不回落共享库。隔离库与临时 Redis 的细节见根规则和 [OPERATIONS](../../docs/OPERATIONS.md)。
