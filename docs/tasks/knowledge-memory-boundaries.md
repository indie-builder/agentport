# PACE 知识与分层记忆：现有能力、原生能力及集成边界

> 2026-10-25。静态研究，不是实施或真实模型验收；腾讯具体服务选型等待平行研究证据，不预设其能力。

## 1. 目标、基线与范围

- 目标：明确外部 Agent Memory 服务如何补 PACE 缺口，并与已确认 WeKnora 核心建设协同。
- 工作树：`knowledge-base-research`；起始 HEAD `797edfeaabd39b040d01736c49273da18347ea92`。
- 起始已有决策文件修改及多份知识研究文档，均属原任务；本分支研究仅新增本文，不覆盖其他成果。
- 已读 `CLAUDE.md`、`docs/PITFALLS.md`、研发流程及 [WeKnora 已确认方案](weknora-core-proposal.md)。
- 不改产品代码、数据库、权限配置；不运行产品，不新增第二 harness，不承诺外部候选已满足下述契约。

## 2. 先分清四类对象

| 对象 | 职责及真相源 | 不应承担的职责 |
|---|---|---|
| SDK session transcript | 单会话执行历史；SDK JSONL + PACE 会话关联 | 不等于已核实的长期事实；压缩不是事实治理 |
| 原生 auto-memory | 专家跨会话经验、反馈、偏好、项目线索；`MEMORY.md` + 主题 Markdown | 不承载整份企业文档，不默认向其他专家公开 |
| 企业来源知识、Wiki、Feeds | 来源文档、版本、引用及持续摄取；按已确认知识方案建设 | 不冒充用户偏好或私有经验；Wiki 是有来源的派生产物 |
| 跨 agent 共享经验 | 经授权推广的可复用方法、经验或共享资料 | 不等于把全部 agent-memory 目录共挂载或把所有聊天入库 |

这些是职责边界，不是要求建立四套数据库，也不推荐自创“三层记忆 JSON”。

## 3. PACE 已有：可直接复用的链路

- `packages/sandbox/src/runner.ts:309` 使用官方 `query()`；`settingSources: ['project']` 加载工作区文件。
- 同处 inline `settings` 设置 `autoMemoryEnabled: true`、`autoMemoryDirectory: '/mnt/agent-memory'`；不是平台自行抽取事实后拼提示词。
- 主会话预批准 Read/Edit 记忆路径；`packages/sandbox/src/memory-permissions.ts:15` 的 PreToolUse 再逐次核路径。
- 当前仅普通 Markdown 允许读写，拒绝越界、符号链接及硬链接；技能 references 仅允许 Read。
- 同 hook 明确拒绝 `agent_id` 存在时的文件访问；子智能体不能直接读写父级记忆，不能把官方支持子智能体 memory 当作平台已接通。
- `packages/worker/src/index.ts:531` 创建专家专属 `WORKSPACES_DIR/<slug>/agent-memory/`，0700 权限。
- worker 将该目录 **rw** 挂载至 `/mnt/agent-memory`，与每次清理的 run 工作区分离；API 与 worker 共工作区持久卷。
- `packages/api/src/features/agents/routes.ts:586` 已有带认证的列表、单文件读取、PUT、DELETE；人工写删有审计。
- `memory-files.ts` 使用平面 Markdown 文件名约束、200000 字节上限、临时文件原子替换；不是向量记忆 CRUD。
- `packages/web/src/pages/memory-panel.tsx:35` 已有 MEMORY.md 初始化、主题文件编辑与删除；复用该入口，不再造平行编辑器。
- `packages/worker/src/index.ts:543` 另建 `sdk-sessions/<conversationId>/`，仅该会话目录 rw 挂到 `/home/node/.claude`。
- `runner.ts:258` 续聊传 `resume`，分支通过官方 `forkSession()` 后恢复；transcript 缺失按 infra 失败，不退回手拼历史。
- `packages/worker/src/messages.ts:17` 保存脱敏文本、工具调用及结果供页面历史展示；消息与 SDK 会话状态在同事务更新。
- 此消息投影不是完整 SDK transcript，不能据此重建全部压缩状态；工具结果仅按现有 content 保存，不应假定结构化来源引用已闭环。
- `scripts/backup.sh:62` 已备份持久工作区，包括 agent-memory 与 SDK transcript，排除临时 run 产物。
- `docs/ARCHITECTURE.md:201` 明确 transcript 不属可分享定义包；持久备份与公开导出必须分开。

发现一处旧注释：`routes.ts:576` 写“只读挂载”，实际 worker `readonly: false`，架构说明亦为 rw。本文以代码为准，后续实施时定向修注释，本轮不越界修改。

## 4. Claude 官方原生能力：已核实与版本限制

核对官方 [memory](https://code.claude.com/docs/en/memory)、[sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[prompt/文件加载](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)。
本地主 checkout 只读检查 `packages/sandbox/node_modules/@anthropic-ai/claude-agent-sdk/{package.json,sdk.d.ts}`，版本 **0.3.303**；未以版本号推断运行镜像已更新。

- 官方 auto-memory 是 Claude 自己选择保存的笔记；并非每个 session 都写，也不保证自动提取每条长期事实。
- 官方主题文件可带 `user/feedback/project/reference` 类型 frontmatter；优先沿用官方格式，不造平台替代语义。
- `MEMORY.md` 启动仅加载前 **200 行或 25KB，先到者为准**；主题文件由文件工具按需读取，不会全部注入。
- 官方默认目录为本机项目 memory，共享同仓库 worktrees；PACE 用明确专家目录改变作用域，不能照搬“所有专家共享”。
- 官方支持 `autoMemoryEnabled` 与绝对路径或 `~/` 的 `autoMemoryDirectory`；SDK `Settings` 确有这两个字段（9310、9314 行）。
- **文档漂移**：当前官方允许 directory 来自各 settings scope，并受 workspace trust 约束；本地类型注释仍称 projectSettings 会忽略。按官方裁决，但必须实测当前镜像；PACE 现走 inline settings，不依赖 checked-in 路径覆盖。
- 官方说明某些 self-hosted/background/嵌套会话对 auto-memory 有默认关闭或不能开启的限制；仅“传 true”不足以宣称所有运行模式均生效。
- 官方普通子智能体不加载父 auto-memory，fork 继承父上下文属例外；子智能体自身 `memory` 是独立目录能力，PACE 当前文件权限仍禁用它。
- SDK `resume` 加载既有 conversation；transcript 保存提示、工具调用、结果与响应。恢复依赖磁盘会话文件，不能仅保存 session ID。
- `persistSession?: boolean` 在本地类型1848行，默认 true；关闭后不能靠该 transcript 恢复。
- 本地也有 **alpha** `sessionStore`（1860行），说明为本地 transcript 成功后镜像双写；这是官方会话存储适配器，不是长期事实记忆服务，当前无须为此替换已用持久卷。
- 压缩由现有 harness 管理；摘要用于上下文连续性，不保证来源、事实修正、失效或遗忘，不能升格为知识真相源。
- 本地 `HookEvent` 含 SessionStart/SessionEnd/PreCompact/PostCompact；SessionStart source 含 startup/resume/clear/compact/fork（6654行起）。
- 生命周期 hook 可做观察、检查或受支持的上下文注入；不自带记忆数据库，也不应在每次结束后另启一套抽取模型循环。SessionEnd 有短超时，不能视为可靠唯一落库点。
- PACE 当前只注册相关 PreToolUse 边界；上述生命周期扩展属于可复用能力，**尚未在 PACE 接通**，不应声称 SDK 可直接配置完全部企业记忆治理。

## 5. 确实存在的缺口与外部服务触发条件

已有链路解决“专家能保存 Markdown、管理员可编辑、卷跨 run 存活”；仍缺少真实模型跨 run 写入/召回验收。
在此之前，不能凭“有 MEMORY.md”认定效果已达标，也不能凭“外部支持分层”认定必须换底座。

| 缺口 | 首先利用现有能力 | 何时外部服务值得加入 |
|---|---|---|
| 长期记忆检索规模与召回质量 | 短索引 + 主题文件；真实任务测召回 | 大量主题下实测漏召回、成本或延迟超标，外部检索有可复现收益 |
| 多 agent 共享经验 | 授权后发布共享知识/Wiki；小型静态经验用技能 references | 需要独立经验检索、组织范围治理且现有知识服务明显不足 |
| 来源、失效、更新与删除传播 | 复用知识建设的来源/版本/引用模型 | 外部引擎可提供经验证的冲突处理、时序事实或删除能力，并保留可移植文件 |
| 运维与恢复 | 复用卷及现有备份恢复 | 多宿主、规模或运维指标证明独立托管有收益；不是新建第二 harness 的理由 |

原生 memory 不是企业来源同步器；飞书/GitLab/Feeds、解析、引用、Wiki 更新删除仍是已确认 WeKnora 核心范围，不能被外部记忆采购取代或推迟。

## 6. 最小集成契约（设计要求，未实施）

1. **执行所有权**：唯一模型循环仍是 Claude Agent SDK。外部服务可经现有 `.mcp.json` 暴露受限工具，不接管会话、子智能体或 Wiki 生成循环。
2. **唯一写作者/真相源**：默认 native memory 由 Claude 主写、管理员修订；外部只读检索或可重建索引。禁止外部抽取器与原生 auto-memory 无休止双向改写同一事实。
3. **额外存储的例外必须说清**：若确需独立共享经验库，它只对经发布的共享记录负责，不充当原生私有 memory 的第二真相源；映射和删除职责明确后才接入。
4. **权限由服务端裁决**：工具凭证绑定 run、当前专家、允许的知识库/共享经验范围；不能信任模型传入的 agentId 或宣称“我是管理员”。沿用父子工具边界，默认不共享私有记忆。
5. **知识→记忆**：优先保存来源指针与适用条件，少复制正文；若确需摘录，保留源文档ID、版本、原链接和可访问范围。来源更新后可判断旧结论是否仍有效。
6. **经验→Wiki/共享库**：需要拥有私有内容发布权的人明确授权、审阅及去敏；生成草稿不自动扩大读者。推广后按知识内容的来源/版本/编辑流程管理。
7. **来源与生成结果分开**：检索证据、模型推断和用户纠正可辨认；服务返回可定位来源与版本，不能只给一段无法追溯的“记忆摘要”。复用知识引用消息链路，不另造私有引用格式。
8. **更新与遗忘**：源内容更新、撤权、删除应使其派生索引及知识/Wiki内容失效；私有记忆中相关摘录要有可定位的复核/删除范围。当前没有这条自动传播链，不能假称现成支持。
9. **删除语义**：忘记一条长期事实不等于删除聊天或 transcript；反向也不自动成立。用户请求彻底删除时，列明原生文件、索引/缓存、共享副本、聊天历史和备份各自处理范围及保留期限。
10. **历史限制可见**：已经进入模型上下文、历史消息或导出副本的内容不能靠删索引收回；撤权后限制新召回，并遵守已明确的历史保留规则，不承诺即时抹除所有副本。
11. **可移植交付**：原生 memory 保持官方 Markdown 可读可导出；私有记忆/会话默认不进入可分享专家定义包。共享知识另包导出来源与版本，外部索引应可重建，不只导出供应商私有ID。
12. **最小落点**：新增能力接现有记忆面板、知识来源/引用/同步管线、MCP授权、worker持久存储和备份；不新增自造 `.claude/knowledge` 或“三层 JSON”作为智能体定义。

## 7. 验证状态与后续验收

本轮完成的是文件/类型及在线官方文档核对；未启动产品、未调用真实模型、未运行已有测试，因此**没有新通过的运行验收结果**。
已有测试文件覆盖记忆链接边界、子智能体拒绝、API字节上限及原子写入、compose共卷；“有测试”不等于本轮执行通过。
实施时在具备依赖的工作树执行定向命令：

```sh
pnpm --filter '@agentport/sandbox' exec vitest run test/memory-permissions.test.ts test/memory-compose.test.ts
pnpm --filter '@agentport/api' exec vitest run test/memory-files.test.ts test/memory-routes.test.ts
```

包名已与实际 package.json 核对；这些是待执行命令，不得以命令模板代替真实输出。
真实验收必须分开证明：A run 自主写入→销毁容器→B 新 session 不传 resume 召回；原 session resume/fork 及压缩连续性；其他专家/子智能体不能读取私有记忆；知识来源更新/撤权/删除后检索与 Wiki/派生记忆的行为；备份恢复和有选择导出。
外部候选还需对同一任务集比较收益、成本、延迟、中文召回、去重纠错、删除与恢复；没有结果前只称“候选”。

## 8. 明确约束、未确认与下一步

- 已确认知识库/Wiki/Feeds/飞书/GitLab继续建设；本报告不改变范围，不新增产品实施授权。
- 腾讯候选具体身份、托管/开源边界、分层语义、MCP接口、费用、许可与删除保证由平行研究核实，本文不代填结论。
- 当前镜像 SDK/CLI 版本及 inline settings 实际生效、跨 run 自主记忆效果、子智能体原生独立记忆接入均未真实验收。
- 经验共享的具体对象、发布人、私有内容保留规则及跨来源删除政策仍需产品决定；不先建复杂多租户/RBAC。
- 下一步：主稿合并候选事实后，按本契约判断补充检索/共享治理是否有必要；优先验证已接原生链路，再决定外部接入范围。
