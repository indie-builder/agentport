# AskUserQuestion 官方接口与真实探针

查证日期：2026-10-28。用于US-6.2接入设计，产品链路验收另见[任务记录](../../tasks/agent-clarification.md)。

## 官方契约

- [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)：原生AskUserQuestion进入canUseTool回调；应用展示模型生成的问题，回传原questions及answers，继续同一次工具调用。每调用1–4问，每题2–4选项；支持多选与用户自由文本。
- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)：需要用户交互的工具不会因allow规则而绕开回调；dontAsk则直接拒绝，不调用canUseTool。default下未被预批准的调用进入回调，因此回调不能默认批准所有工具。
- 安装SDK0.3.311：CanUseTool上下文提供signal、toolUseID、requestId；AskUserQuestionInput.answers为Record<string,string>，本轮多选采用官方共同支持的逗号加空格拼接字符串。问题原文作为键，自定义答案为值。
- SDK回调可持续pending，平台仍按原整体run超时退出；子智能体当前不支持原生提问。

## 最小真实探针

探针仅启用AskUserQuestion，独立cwd/config、settingSources为空，不加载本仓库定义。两次运行经现有模型网关，未启动或更改共享服务。

| 显式模式 | 回调次数 | 实际工具结果 | 最终结果 |
| --- | --- | --- | --- |
| default | 1 | 原questions加答案Alpha回传，工具结果is_error=false并确认收到Alpha | success，最终文本Alpha |
| dontAsk | 0 | 模型实际调用AskUserQuestion后permission_denied，is_error=true，permission_denials记录该调用 | 无法经回调回答；该探针以maxTurns终止 |

合计成本约$0.0153。default运行约6.7秒，dontAsk运行约2.4秒，未重试。证据原始输出保留在开发树`.tmp/clarification-probe/`；本文件只保留非敏感事实，模型网关凭据不进入仓库。

## 结论与边界

新智能体默认default并补专用回调，可以提供原生提问；显式dontAsk必须保持其官方拒绝语义，不通过隐式改写绕过。回调仅对原生主会话提问收答案，其余未预批准调用拒绝；文件hook与MCP工具服务端审批继续独立生效。

本探针只证明本机官方SDK问答往返，不证明Linux沙盒、PG/API/SSE恢复、浏览器表单、真实业务审批或多选全部已通过。完整验收需覆盖提问→回答→同run文件交付，以及拒答、停止和超时。
