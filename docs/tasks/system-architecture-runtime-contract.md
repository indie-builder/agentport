# 系统架构调整：运行边界裁决与执行合同

> 2026-10-31 R5 修订指针：删除编排与 worker 关停以
> `system-architecture-runtimeB-revision.md` 为准，实现证据见
> `system-architecture-runtimeB-shorttx-evidence.md`；本文其余 R1/R2/R5.1 结论不变。

## 范围与有效约束

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`；审计基线由主任务指定为 `68241ba`。本单元不执行 Git、不改源码、不操作 LoopX，仅写本文件，不改任务主记录或 `DECISIONS-PENDING.md`。
- 核对日期：2026-10-31。本合同是针对六项候选的独立裁决，不将事实审计建议直接视为已证实缺陷。
- 智能体定义继续采用官方 `CLAUDE.md`、`.mcp.json`、`.claude/agents/*.md`、skills/settings/plugins 文件；DB 是编辑来源。不得新增私有 definition sidecar、第二套执行循环、部署服务、容器种类或 BullMQ Worker。
- 保留原有功能、字段、权限、错误传播、原生 SDK 执行、单层同步委派及记忆资产。不得以“SDK 无对应选项”为由直接删除可独立运行专家的配置。
- 已读本树 `CLAUDE.md`、`docs/PITFALLS.md`、`docs/DEV-WORKFLOW.md` §2。模型分工：本合同固定关键判断；后续执行由 Sonnet high 按互斥文件分区完成；提交前由独立 Opus high 按固定 diff 和行为证据终审。

## 结论

| 候选 | 裁决 | 最小完整处理 |
|---|---|---|
| 1 根提示误列子级 MCP | 接受 | 根提示与等待说明按根 `serverNames` 过滤；`.mcp.json` 继续保留根与启用子级的并集；不改现有 hook 授权 |
| 2 标题截断正文 | 接受，并扩到同根因的子文件解析 | 用官方 Markdown 文件内明确、成对、末尾锚定的生成区边界替换普通标题/自然语言截断；真实导出再导入核对完整正文 |
| 3 init 未逐项核对 skills/agents | 当前拒绝作为修复项 | 官方类型仅给列表，没有证明这些列表等于各作用域完整可调用集合；已有真实 CLI 发现测试；不添加猜测式 fail-closed |
| 4 子级单独 timeout 声明 | 接受声明错误；拒绝删字段或自造委派计时器 | 生成说明明确子级受自身 `maxTurns` 和根运行总超时约束；保留 `timeoutMs` 独立运行语义及编辑/导出能力；编辑标签注明适用范围 |
| 5 上游 MCP 凭据暴露 | 接受实际信任边界；拒绝擅自全代理化 | 现有原生 MCP 视为受信执行环境；准确记录 0600/只读挂载/文件工具 hook 无法隔离 Bash 的限制；修复删除清理生命周期，不宣称 env 插值是凭据隔离 |
| 6 Read/Edit 绝对路径错误 | 拒绝：候选误读模板 | 路径常量已有 `/`，模板再加 `/`，实际生成正确的 `//mnt/...` 与 `//workspace/...`；保持实现与现有断言 |

## 官方与本地 SDK 证据

核对官方页面，并与已安装 `@anthropic-ai/claude-agent-sdk@0.3.311` 的 `sdk.d.ts` 对照。不是依赖技能中的通用 API 示例推断 Agent SDK：`claude-api` 技能明确区分两者，本任务仍使用现有 Agent SDK。

- [官方子智能体](https://code.claude.com/docs/en/sub-agents)：frontmatter 支持 `maxTurns`、`skills`、`mcpServers`、`disallowedTools`、`memory`、`effort` 等，没有每次委派的 `timeoutMs`。未识别字段会被忽略；不能往 YAML 塞一个 timeout 并宣称生效。省略 `tools` 时继承工具；子智能体默认也加载 CLAUDE.md 指令，因此根 MCP 清单必须说明是主会话绑定，不暗示所有子级共用根绑定。
- [官方 TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript)：`AgentDefinition.maxTurns` 是 agentic turns 上限，没有独立 wall-clock timeout。`SDKSystemMessage` 的 `agents?: string[]`、`skills: string[]`、`slash_commands: string[]` 并未给出“逐项精确对应主会话、子级 preload、插件别名”的充分语义。
- [官方权限](https://code.claude.com/docs/en/permissions#read-and-edit)：`//path` 是文件系统绝对路径，单 `/path` 锚定 settings 来源。Read/Edit 规则不能约束任意 Python/Node 子进程读文件；原生文件 hook 也不是进程隔离。
- [官方 MCP](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)：`.mcp.json` 支持 `${VAR}` / `${VAR:-default}`，可用于 command/args/env/url/headers；这是配置取值机制，不是让同容器 Bash 看不到 secret 的机制。部分模型/云凭据变量被官方特殊处理，不能盲目复用模型环境变量作为 MCP 凭据名。
- 本地类型文件：`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.311_@anthropic-ai+sdk@0.135.0_zod@4.6.7__@modelconte_9c48cbba0853e0ec3f0a53a7af315c40/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。`AgentDefinition` 在 38–108 行；`SDKSystemMessage` 在 6211–6296 行。`agents` 可省略，`skills` 是字符串列表，没有“完整已加载能力清单”的注释。

## R1：根 MCP 清单与授权一致

### 已确认事实

- `packages/worker/src/server-bindings.ts` 构建根与启用子级绑定并集；`packages/worker/src/index.ts:784` 后续保留各 agent 的名称映射。
- `packages/api/src/features/agents/workspace.ts:94`、`:121`、`:163` 同样为预览构造并集与 `serverNames`，因此问题应在共享渲染层一次修复。
- `packages/core/src/workspace.ts:262` 的 `renderClaudeMd` 直接枚举所有 `input.servers`；`:248` 的 MCP 等待说明也只看并集是否非空。
- 同文件 `renderAgentMd:365` 已按 `agent.serverNames` 过滤，证明这是现有共有契约，而非需要新建授权系统。
- `packages/sandbox/src/runner.ts:301` 明确不能在会话级 deny 子级专用 server，否则子级也会继承 deny；父级越权由 `sub-agent-permissions.ts` 的 PreToolUse hook 拒绝。保留此机制。

### 实施合同

1. 复用现有语义：`serverNames === undefined` 时使用传入 servers 全集；显式 `[]` 表示根无绑定。不得将空数组退回全集。
2. 根 `CLAUDE.md` 的工具枚举、无 MCP 分支、MCP 等待说明只依据根绑定。明确清单属于主会话，子级依据自己的 agent 文件使用工具。
3. `.mcp.json` 仍是并集；子级 B 必须真实可用。不得通过删掉 B 或扩大根权限使描述“看起来一致”。
4. 保持共享 `delegationWaitSection` 导出及调用方语义；只在实际多处需要时提取小型 own-server 计算，不新增权限对象模型。

### 必要行为测试

`packages/core/test/workspace.test.ts`：根仅 A、子仅 B，断言根工具清单不列 B，`.mcp.json` 同时包含 A/B，子文件引用 B。另测根显式 `[]`、子有 B：根仍说明无 MCP，不生成根的 MCP 等待段。保留 undefined 的既有默认行为及现有 hook 测试。

## R2：正文与生成段的可逆边界

### 已确认事实及范围扩展

- `packages/core/src/official-files.ts:10`、`:26` 以第一个 `\n## 工具使用\n` 截断。该标题可以合法出现在用户 systemPrompt 中，导致导入静默丢失后文。
- `packages/api/src/features/agent-package.ts:754`、`:797` 真实使用此解析结果；更改 `agentport.json` 不能修正正文来源，且不能把 systemPrompt 复制进新 sidecar。
- 同类真实缺陷还存在于 `parseChildAgentMd:126`：以自然语言 `DELEGATION_NOTE` 第一次出现截断。用户正文若包含“你是被父智能体同步调用的：直接执行任务并返回最终文本。”同样丢失后文。此项与根解析共用同一修法，必须一起处理。
- `packages/api/test/agent-package-zip.test.ts:1230` 已有真实 OpenUI 导出/导入测试，但正文没有同名标题，`:1249` 的旧注释把标题当成正文边界。现有通过不能证明任意正文保真。

### 选定格式

采用官方 Markdown 内的生成区，不增字段或文件。以如下普通 HTML 注释包住整个生成后缀；注释只是平台编辑器识别自己生成内容的语法，不声明为 SDK 官方配置字段，SDK 仍直接加载可读 Markdown 指令。

```markdown
# 名称

用户正文，包括任意同名标题或标记示例。

<!-- agentport:generated:start -->
## 工具使用

生成的工具、等待、子级、OpenUI 等说明。
<!-- agentport:generated:end -->
```

子级正文在名称/描述之后保留，固定同步委派、禁止再委派及提问等说明同样包进该生成后缀。根和子级使用同一个边界约定。

解析要求：

1. 先沿用 BOM/CRLF 规范化，再识别“独占行、成对、文件末尾锚定”的生成后缀。结束行后只允许空白。选择终端结束标记之前最后一个独占开始行；真实渲染器的开始标记始终在用户正文之后。
2. 绝不能再次用 `indexOf` 第一次出现、标题文本、自然语言等待说明来截断。用户正文中单个标记、成对标记、完整示例块、重复标题必须全部保留；渲染器追加的最末层才是生成区。
3. 渲染生成区自身不得出现独占边界行：生成的结构文本由代码控制；原先由 `inlineText` 压平的部分保持不变，但 OpenUI 等进入最终生成后缀的文本（`description`/`name`/`inputSchema`/`outputSchema` 及 server/skill/sub-agent 派生行）会在最终统一出口逐行转义独占的保留标记行（在 `<` 前加一个反斜杠），既保留多行和原文字面量，又不让它成为解析边界。根生成正文走该统一转义；子级生成后缀只有 3 行固定文本、不含任何外来值，不需要同一 helper。用户 prompt 与外层 wrapper 不处理，解析规则不变。测试覆盖边界样例，避免依赖概率或随机 UUID。
4. 没有终端有效生成后缀的官方手写 Markdown，沿用“全文是用户指令”的导入能力；不再对旧标题或自然语言边界做 fallback。完整使用保留注释语法的手写尾段属于显式生成区约定；这不是从普通标题猜测其来源。普通用户 prompt 经 renderer 导出时，纵使包含完整相同尾段，也位于外层生成区之前，不会被误切。
5. 若发现开始/结束标记的残缺或顺序无法明确，不静默丢正文；按普通正文保留或返回明确输入错误，保持一种确定行为。不要再加一套旧格式兼容解析器。
6. 保真范围沿用既有定义：行尾规范化为 LF、首尾空白沿用 `.trim()`；中间正文逐字保留。本任务不借机重新定义所有字段的空白规范。

末尾标记不作为机密或权限边界；不能用它防 prompt injection。它解决的是本平台合法产物的无损 roundtrip。

### 必要行为测试

- `packages/core/test/official-files.test.ts`：root 和 child 的 `parse(render(prompt))` 同时覆盖普通标题、重复 `## 工具使用`、原 `DELEGATION_NOTE`、单独 start/end、完整同标记示例（含中间/末尾）、多个示例、CRLF、BOM、没有生成区的手写文件。
- 不只拼字符串调用 parse。扩展 `packages/api/test/agent-package-zip.test.ts` 现有真实流程：创建带上述内容的根与子级 → 导出成功 ZIP → 真实导入新实体 → GET 核对完整 prompt → 再导出，验证生成区没有回流或重复，末尾正文仍在；保留 OpenUI、skills、rules、子级 memory 与 sidecar 元数据行为。
- 同步涉及边界的 fixtures/注释。只改本修复触达的断言，不把“不能含用户同标题”的错误断言留着。

### 实施与定向复审（2026-10-31）

R2 已按上述边界修复并通过定向独立 Opus 复审：原始 `START` 输入正文严格逐字相等，独立探测的根 192、子 12、转义 8 组场景通过；core 63 + ZIP 52 共 115/115、0 skipped，报告 `/tmp/agentport-architecture-runtimeA-r2fix-review.json`。R1/R4/UI 先前 PASS 保留，runtime A 不再有阻断。本段只记录状态，证据文件由修复分区维护。

## R3：不把 init 字符串列表扩成新的能力校验系统

现有 renderer 和导入入口已验证文件；runner 设置 `settingSources: ['project']`，按文件加载能力，`options.skills` 与插件 namespaced skills 走官方接口。真实 CLI 的 `initializationResult()` / `supportedCommands()` 与 `supportedAgents()` 已有测试模式。

本次实际运行 `packages/sandbox/test/skill-discovery.test.ts`：存在的 project skill 可发现，缺失的 skill 不会凭空出现，两个测试均通过，无跳过。`sdk-skills.test.ts` 的三个测试也通过，验证真实 SDK argv/control initialize 传递，且没有 `Skill(*)`。

官方只声明 init 有这些字段，未证明 `skills` 是所有子级 preload 与插件 alias 的完整并集，`agents` 甚至可省略。不能用“集合不相等”直接让所有运行 infra 失败。候选未给出合法渲染文件未被加载的复现，因此本轮不改 runner init 校验，不删既有 MCP/plugin 错误报告。

以后若能在合法产物与支持版本上稳定复现缺失：优先沿用上述零模型调用的真实 CLI characterization 确定语义，再决定是否检查，不能先造假 init fixture 证明自己的假设。

## R4：超时的真实适用范围，保留字段能力

### 已确认事实

- `workspace.ts:244`、`:309–313`、`:448–450` 声称每个子智能体有自己的委派超时。
- `packages/worker/src/index.ts:732` 读取本次发起 agent 的 `timeoutMs`，传入 `runInSandbox`；`packages/worker/src/runner-client.ts:804` 对整个 run 竞速超时。SDK 子定义没有对应 timeout。
- `packages/shared/src/agent.ts:93` 是所有专家的配置；子级仍是完整专家实体，解绑或独立执行时需要自己的 timeout。专家包既有 sidecar 保留 `timeoutMs`，不是可以直接删的死字段。
- `packages/web/src/pages/agents.tsx:3559` 仅标“超时 (毫秒)”，没有区分独立运行与被委派。

### 实施合同

- 根子级列表去掉虚假的“超时”列，可保留 slug/适用场景并按需展示真实 `maxTurns`；不要新增与用户任务无关的指标表。
- 等待规则明确“子级受自身 maxTurns 限制；整轮委派计入主运行总超时，主运行超时会中止本轮”，删除“子级自己的秒数到时仅本次委派失败”。
- 子级文件不再读取 `timeoutMs` 生成父级等待秒数。不要写非官方 timeout frontmatter，不创建 TaskStop 定时器、额外 AbortController 或私有 Agent 工具。
- 保留 DB/API/shared/export/import/版本快照的 `timeoutMs`。编辑标签统一为“独立运行超时 (毫秒)”或等义清晰名称；当它作为子级被调用时，字段旁一条必要适用范围说明即可：“被委派时使用主运行总超时。”不禁用或丢失配置，解除 parent 后原值仍在。
- 前端实际文件由另一份 API/frontend 合同的执行者拥有；本单元只交叉提出上述语义要求，不与其并写。若主任务尚未分配，单独分派，不让 core 执行者顺手修改 UI。

测试：core 生成结果不再含子级独立秒数，仍含真实轮次/根总超时说明；保留 runner-client 总超时/取消回收测试。API 包 roundtrip 保留各实体不同 timeoutMs；UI 测试证明编辑保存仍带原值，绑定/解绑不清空。不能把纠正文案说成实现了独立委派 timeout。

## R5：凭据与删除生命周期

### 5.1 实际信任边界

`packages/core/src/tools.ts:14–30` 将 stdio env / HTTP headers 上游凭据写进 `.mcp.json`。容器绑定 `/workspace:ro`；runner 默认允许 Bash。只读与 0600 防止部分外部修改/访问，却不能阻止同 uid 容器进程读取后经网络发送。默认 egress open 是现有明确配置，`docs/SECURITY.md:63–65` 已承认长期上游 secrets 不受 per-run token 撤销影响。

这是真实可执行的边界，实际发生与否取决于模型/技能/插件执行内容与凭据权限；本审计没有运行攻击或访问真实 secret，不给出虚构概率。工具授权 hook 能限制 SDK MCP 调用，不能阻止 Bash 直接拿 token 使用其上游权限。

本轮采用最小策略：

1. 保留用户已选的原生 stdio/HTTP MCP；模型 proxy 继续只保护模型凭据，generated MCP 继续使用按 run token。
2. 安全说明明确“沙盒执行内容可读取所绑定原生 MCP 凭据；仅绑定受信任代码和该任务所需的最小权限凭据”。这项边界说明不需要新增 UI 弹窗、审批流或默认关闭 Bash。
3. 保留现有停稳后移除 `.mcp.json`、吊销 per-run token、失败禁止复用的顺序；补齐删除的 session 目录回收。
4. 不把 `${VAR}`、headersHelper 或额外文件 chmod 当成同容器 secret isolation。将真实 token 换到 SDK 进程 env 后，Bash/stdio 子进程仍可能继承或读取；这只能另行评估落盘收益，不能以安全修复名义本轮机械迁移。
5. 不引入上游统一代理、主机工具执行、按工具 egress 策略或第二套 MCP 路由；这些会改变原生集成、凭据信任及功能边界，需要独立决定，见末尾待决策。

### 5.2 删除问题已确认，不能只补 rm

- `packages/api/src/features/agents/routes.ts:734–775` 删除 agent 后清理 sdk-sessions / conversation-outputs / conversation-inputs，遗漏 session-sandboxes。
- `packages/api/src/features/chat/routes.ts:763–832` 已清 session-sandboxes，但直接在 DB 删除后 rm，未先关闭 idle supervisor。
- `packages/db/src/repo/agents.ts:561` 会在绑定锁内拒绝真实 queued/running；`packages/db/src/repo/chat.ts:137` 会按 agent→conversation 锁序拒绝 queued/running。保留这些实际有效的保护，不能重复另造删除状态字段。
- `packages/worker/src/sandbox/sessions.ts:578–604` 在 run 结束后继续保留 idle 容器；`:233` cleanup 是面向 run 的 recovery，不能当成“随时按会话杀容器”的 API。
- session 根在 `session-workspace.ts:27`，包含 workspace/.mcp.json 与 outputs 草稿。worker `index.ts:979` 正常移除 stable workspace 的凭据，但失败分支/崩溃可留残余。
- worker 启动的 `sweepStaleWorkspaces:425` 仅扫 run_ 目录，不扫 session-sandboxes；不能声称已有 sweep 自动兜底。
- provider 没有按会话持久定位：session 容器名是 `pace-session-<随机>`。删除 DB 后再“通知 worker 清理”会丢失 persisted sandboxId，不足以覆盖 worker 重启后的残留。

### 5.3 选定的最小完整关闭合同

使用现有 API、Redis、单 worker 进程与 `SessionSandboxes` / `SandboxProvider.destroyById`。新增的只是有限请求/应答，不是新服务或新 BullMQ Worker，不承载模型循环。已有 `sandbox-probe` 的有限等待/清理模式与 runner-client 的 Redis cancel 连接模式可复用，但不复用 probe 队列去运行不相关删除任务。

顺序必须是：

1. 入口沿用权限、schema 与 current 查找。
2. 删除 repo 事务沿用既有锁序与 queued/running 校验。**锁保持到关闭确认和 DB 删除完成**，阻止关闭与新准入交叉。不要只在路由锁外预检。
3. 在该事务内查清目标会话 IDs，以及目标 run 的非空 sandboxIds（同一容器复用时去重）。只删除目标 agent 的会话；子专家与其持久记忆继续保留。调用一个注入的 `beforeDelete` 回调，回调只请求关闭容器，不操作 DB，避免跨进程读同一已锁行形成死锁。
4. API 向现有 worker 发送有唯一 requestId、过期时间和精确会话/sandbox 身份的关闭请求。worker 在开始前检查请求仍有效；只接受此内部信道，入口做一次 schema 校验。请求不携带凭据、主机路径或任意 Docker 命令。
5. worker 的 `closeIdle` 语义先拒绝 `active`、`leaseHeld`、`acquirePending` 的匹配 entry，复用 `destroyEntry` 的并发合并和失败保留。对同 ID 的活跃新 run 不得直接按 ID 强杀。entry 已由重启丢失时，用事务查询得到的 sandboxIds 走既有 `destroyById`，其“已不存在”是成功，“停止/删除无法确认”是失败。没有 entry 且没有 persisted ID 才可视为空操作。
6. **仅在全部目标已确认销毁后应答成功**。任一异常/超时，删除事务回滚，DB 索引和所有目录保留；可安全重试。部分已关闭的 idle 容器不恢复，下次正常对话可重建。返回现有错误体系中的明确服务不可用/冲突结果，不能返回 204 并只记 warning。
7. API 收到成功后事务删除行，再清理 runtime 目录。agent 删除覆盖 sdk-sessions、session-sandboxes、conversation-outputs、conversation-inputs；单 conversation 删除只清该 conversation。agent-memory、子专家 memory、个人 memory 必须保留。
8. 已停止容器后若 rm 失败，保留明确日志和目标路径身份，不能说“凭据保证无残留”。沿用既有 best-effort 文件清理是可接受限制；不因此假装 DB 事务仍可回滚。文档交付明确此故障结果。
9. 等待必须有界，信道失败/worker 不在线时不删 DB、不删目录。迟到请求不能在锁释放后误杀新 run：worker 始终执行 idle-only 检查，先判 busy 再销毁；新会话容器身份不在旧请求目标内。ACK 丢失时 API 可失败，不能把“消息已经发出”当成确认。
10. worker shutdown 要等待当前关闭请求收尾，并释放新增 Redis 连接/监听；不安装常驻轮询测试门禁。

调用期持有现有删除锁会短时阻塞相关准入，这是保证“确认关闭前不丢索引”必要的有限临界区；不得把网络等待放到未受限重试或无限 timeout 中。复用已有错误/关闭预算，并用行为测试验证失败回滚。若实现中发现既有 DB statement timeout 小于关闭预算，先收窄等待预算或在专用事务局部设置，不修改全局连接策略。

### 5.4 必要安全/生命周期测试

- API + repo：queued/running 删除仍冲突；关闭回调未被调用，目录未删。成功删除有真实关闭 ACK，再出现 DB 删除和目录回收。
- 注入延迟 ACK，同时尝试准入：验证锁内顺序，准入不得在关闭和删除之间成功；agent/会话两入口都覆盖。不能仅 mock 一个“close 被调用”。
- worker 单元：idle 删除；active/lease/acquirePending 拒绝；不存在 ID；同容器多次引用去重；失败 entry 保留可重试；部分成功其余失败；迟到请求不会杀新 lease。
- 集成：真实 Redis 请求/应答，worker 不在线、超时、失效请求、ACK 丢失/迟到；不得复用开发 Redis/DB。可在测试进程注册处理器，不新开生产 worker 种类。
- Docker 行为验证：启动可控 idle supervisor，创建含假 secret 的 session workspace；执行 agent/会话删除，确认容器停止/移除后目录才消失。重启处理器后按 persisted sandboxId 仍能清容器；停容器失败则实体和目录仍在。测试绝不使用用户真实凭据。
- 删除 agent 后 parent/child 记忆、个人记忆与其他 agent/conversation 目录仍在；删除 conversation 后其他会话保持可续聊。

## R6：绝对路径候选撤回

`runner.ts:89` 的 `memoryDirectory = '/mnt/agent-memory'`；`memory-permissions.ts` 导出的 OUTPUTS_DIR、INPUTS_DIR、SUBAGENT_MEMORY_DIR 也以 `/` 起始。因此：

```typescript
`Read(/${memoryDirectory}/**)` // 实际为 Read(//mnt/agent-memory/**)
```

`packages/sandbox/test/runner.test.ts:282`、`:421`、`:442` 已断言官方绝对路径。不是“依赖 hook 恰好兜底”的错误；不改这几行，不新增路径 helper。本轮未单独重跑 runner.test.ts，因此不将读到的断言说成已执行证据。

## 文件所有权与并行执行分区

所有执行者 Sonnet high；开始改源码前加载 ub-mode。主会话与其他 Opus 只固定合同、审查与验证，不亲自写源码。

| 单元 | 独占文件范围 | 产出/验收 | 并行关系 |
|---|---|---|---|
| A：官方文件渲染与 roundtrip | `packages/core/src/workspace.ts`、`packages/core/src/official-files.ts`、`packages/core/test/workspace.test.ts`、`packages/core/test/official-files.test.ts`、`packages/api/test/agent-package-zip.test.ts` | R1/R2/R4 生成声明修复；真实 ZIP 回导与 root/child prompt 保真 | 与 B 并行；不动 agent-package.ts API 实现，不动删除 tests |
| B：关闭与删除生命周期 | `packages/worker/src/sandbox/sessions.ts`、`packages/worker/src/index.ts` 的关闭接线、必要时 `runner-client.ts` Redis 接线、`packages/db/src/repo/agents.ts` / `chat.ts` 删除事务、API agents/chat 删除 handler、对应现有 tests；确有必要才新增小型内部信道模块与 shared schema | R5.3 全链路关闭确认、锁内顺序、失败回滚、完整目录回收与安全行为证据 | 与 A 并行；所有 B 文件单一写入者；跨 API/frontend 单元先划出删除 handler 所有权 |
| C：配置语义/文档整合 | 由另一份 API/frontend 合同原写入者负责 `packages/web/src/pages/agents.tsx` 与关联 UI tests；主任务统一更新 SECURITY/ARCHITECTURE/主记录 | timeout 编辑范围说明、凭据信任边界、删除失败语义 | 与 A/B 并行；不得让 A/B 代理并写上述文件 |

B 内数据库→请求合同→worker→API 接线有真实接口依赖，由一个执行者完成或先固定具体 schema 再拆；不为“并行”让两个代理同时修改 index.ts、routes.ts 或 repo 同一文件。B 若需扩展 docker/provider 文件，先向主会话声明文件租约；仅允许复用已存在的 destroyById，不为这次删除加入任意容器查询/管理 API。

与另一份 API/frontend 合同的交界：此处不修改 agent-package.ts、共享输入字段设计或页面结构；R4 字段保留和标签语义由主会话合入其契约。B 删除局部需要 routes.ts 所有权，主会话先分配块或将该文件交给单一执行者，不发生并写。

## 验证命令与当前真实结果

以下命令均从本工作树运行。基线证据已执行：

```sh
pnpm exec vitest run --project backend packages/core/test/workspace.test.ts packages/core/test/official-files.test.ts packages/sandbox/test/skill-discovery.test.ts packages/sandbox/test/sdk-skills.test.ts
```

结果：4 文件、42 测试通过、0 失败、0 跳过。包含真实 native CLI 的两个 skill 发现测试，无模型请求。RTK 只显示报告路径，已读取 `.vitest/json/output.json` 的 success=true 和各 suite 结果核对；这是基线行为，不证明待修复用例已通过。测试运行会更新该生成报告，主会话不要把它混入交付源码。

执行后的必要范围命令：

```sh
pnpm exec vitest run --project backend packages/core/test/workspace.test.ts packages/core/test/official-files.test.ts packages/core/test/workspace-input.test.ts packages/api/test/agent-package-zip.test.ts packages/api/test/agent-package-zip-format.test.ts
pnpm exec vitest run --project backend packages/sandbox/test/runner.test.ts packages/sandbox/test/sub-agent-permissions.test.ts packages/sandbox/test/memory-permissions.test.ts packages/worker/test/session-sandboxes.test.ts packages/api/test/agents.test.ts packages/api/test/chat.test.ts
pnpm --filter @agentport/core typecheck
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/worker typecheck
pnpm --filter @agentport/sandbox typecheck
```

B 新增的内部信道测试需加入第二条命令的实际文件清单；UI 执行者按其改动补页面测试与 web typecheck。依赖 PG/Redis/Docker 的测试应在既有 globalSetup 隔离环境跑；不可用时明确跳过与原因，不能以 core 纯测试代替真实 ZIP/删除集成证据。锁/关闭顺序的行为测试和真实 Docker 证据不能由 typecheck 或静态源码正则代替。

没有新增依赖、schema 列或迁移需求；B 的锁/回调只是已有 repo 行为扩展。若执行者认为必须新增持久删除状态或 schema，停止该分支并交 Opus 判断，不自行扩成异步 GC 系统。

## 文档与实际实现冲突、待决策及下一步

主会话需合并到其统一记录的冲突：

1. 生成提示声称根可调用并集 MCP，hook 实际仅允许根绑定。
2. 正文解析器把普通用户标题/自然语言当生成边界，违背专家包正文保真要求；现有测试注释将这种截断当正常约定。
3. 生成提示声称子级独立 timeout，实际仅根 run 总 timer；界面 timeout 标签未说明适用范围。
4. agent 删除遗漏 session-sandboxes；conversation 删除虽包含该目录，却未先确认 idle 容器关闭。现有启动 sweep 只覆盖 run_，不能宣称覆盖会话残留。
5. SECURITY 对上游凭据可留存有记录，但“已修复”不能被解读为 Bash 不可读取；新增安全说明应明确受信执行边界。绝对路径候选则不是冲突，是审计误读，撤回。

需要用户未来单独决定的只有：若目标变成“模型/沙盒进程不能接触上游 MCP 长期凭据”，是否允许改变原生 stdio/HTTP 的执行与凭据边界。此要求不在当前最小修复中，环境变量插值不能满足它。当前合同无需因此停止 R1/R2/R4 与生命周期修复，也不隐含新增代理服务授权。

下一步：R2 已完成修复与定向复审，R1/R4/UI 结论保留，R3/R6 拒绝不变；runtime B 基础 94 项与真实 Docker 3 项通过，模块已交给生产 `api/index` 接线者，尚未完成 HTTP 最终验收；knowledge 仍在实施；整任务终审与联合验证未完成。本文只完成裁决与状态同步，未执行 Git 操作。
