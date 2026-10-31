# sandbox 模块规则

> 通用原则、SDK 约束、交付流程见[根规则](../../CLAUDE.md)；镜像、挂载与运行约定见 [ARCHITECTURE](../../docs/ARCHITECTURE.md)。本文件只写 sandbox 的专属约束。

## 职责

- 只做容器内入口：`session-supervisor` 常驻接收 start/input/cancel，每轮拉起一次 `runner`；`probe` 做 stdio MCP 试连，`native-plugins` 调用官方 CLI 安装/枚举/读取插件。
- 不连 DB/Redis、不起 HTTP、不做业务编排、不决定空闲回收；容器生命周期由 worker 的 `SessionSandboxes` 管理。
- 任务、事件、supervisor 协议只用 shared 的 schema；不复制平台业务类型或另造定义格式。

## 协议与握手

- supervisor 先发 `ready`；收到 `start` 才 spawn runner，任务写入成功后才发 `started`；同一时间只允许一个 active run。
- stdout 只写 NDJSON 协议行（`supervisorOutputSchema` / `ChatEvent`），日志一律写 stderr。单行上限 `SUPERVISOR_INPUT_MAX_BYTES`（8MiB）：输入超限拒绝该命令，输出超限停止转发并按本轮失败收尾，不静默续读。
- runner 退出后，supervisor 等进程组停稳、stdout 排空，再发 `settled`；`stopped: false` 表示无法确认停稳，宿主必须销毁容器，不能复用。
- 取消走 `cancel`：先 SIGTERM，宽限期后对进程组 SIGKILL；stdin EOF 也走同一收尾。

## SDK 与权限

- 容器内 SDK 选项只在 `runner.ts` 装配：`settingSources: ['project']`、settings、permissionMode、allowedTools/disallowedTools、hooks、skills/plugins、resume/fork。不要新增平台私有的运行定义格式或第二套消息循环。
- 改动 SDK 选项或行为前，先核对官方文档与已安装的 `sdk.d.ts`（根规则）；本文件不替代官方文档。
- 保持现有边界：workspace 只读；`/mnt/outputs` rw；`/mnt/inputs` 与个人记忆只读；记忆与子智能体路径由 PreToolUse hook 按挂载根和身份收窄。`dontAsk` 下未预批准的工具不自动放行。
- 凭证只从 supervisor 的 `start` 帧进入进程环境；不把真实 token 写日志或落盘。

## 验证

`pnpm --filter @agentport/sandbox typecheck` 与 `packages/sandbox/test`；镜像构建/Docker 用例需要 Docker，缺失时按其前置跳过。
