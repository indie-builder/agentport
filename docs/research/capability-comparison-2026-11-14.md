# 主流智能体平台能力对照与落地候选（2026-11-14）

> 范围：Agentport / PACE「云端企业内部智能体平台」首轮能力侦察。
> 方法：只读本仓文档与代码；2026-11-14 联网检索/抓取平台公开资料。文中不含客户案例、benchmark 或第三方背书；本仓也没有此类材料，未虚构。
> 结论用途：供主会话选定「首个落地功能」，不是最终技术方案。

---

## 0. 结论速览

1. **本仓已经不缺「智能体执行底座」**：官方 Claude Agent SDK、`.claude` 文件定义、Docker 沙盒、MCP 网关、短期凭证、知识库 RAG、RBAC/对象授权、版本回滚、审计、记忆提案都已落地，且有真实链路证据。
2. **真正的企业级缺口集中在「治理与运营」而不是「能不能跑」**：
   - HITL 只有单次运行内的工具审批，缺分级自治策略、角色/参数级规则、跨重启恢复；stdio 工具没有审批桥。
   - 评估只有离线用例 + 子串匹配判分，缺在线抽样、轨迹评估、LLM-as-judge、人工标注队列。
   - 成本只有专家级单次预算与运行成本，缺团队/专家累计预算、告警与自动停机。
   - 审计有查询与导出，缺防篡改、SIEM 推送、保留策略。
   - IM 渠道（飞书/钉钉/企业微信机器人）未接入；定时任务有 cron，但没有外部 Webhook/通用事件触发器。
3. **推荐首个目标：统一工具审批策略与分级自治**。它直接对应官方 `.claude/settings.json` 的 `permissions`（allow / ask / deny）与 SDK `canUseTool`，复用已有 `approval_requests` 与运行内真暂停机制，不引入私有 DSL，不触碰 PRODUCT.md 的 Non-Goals，是「价值 / 成本」最高且最符合第一性原则的一项。
4. **Top 3 候选**：
   - C1 统一工具审批策略与分级自治（含官方 permissions 投影）
   - C2 审计合规增强（防篡改 / SIEM 推送 / 保留策略）
   - C3 在线 + 轨迹评估（LLM-as-judge / 人工标注队列）
5. **明确不建议现在做**：可视化工作流编排 DSL（与第一性原则和现有官方 `.claude/workflows/*.js` 冲突）；无治理的自动进化；SSO / 组织多租户（与现期 Non-Goals 冲突，需用户决策）。

---

## 1. 方法与证据可靠性

### 1.1 本仓

只读核对以下材料，并用 `rg` 定位到具体代码入口：

- `docs/CAPABILITY-GAP.md`：历史 50 轮六原语评估与差距矩阵。
- `docs/ARCHITECTURE.md`：分层、运行时拓扑、官方文件能力接入状态、知识库、权限模型。
- `PRODUCT.md`：产品定位、用户、约束与 Non-Goals。
- `docs/PROJECT-BRIEF.md`、`docs/REMAINING-TODOS.md`、`docs/OBSERVABILITY.md`。
- `packages/*/src` 与 `packages/*/AGENTS.md` 中与能力判断相关的入口。

### 1.2 平台资料可靠性分级

| 级别 | 含义 | 本报告处理 |
|---|---|---|
| **A** | 官方文档/官方定价页，本次直接抓取到正文 | 可作为事实引用 |
| **B** | 官方页面/官方帮助中心，但仅经搜索摘要，或页面未完整渲染 | 写「官方页面称」，关键细节标注「未逐条核实」 |
| **C** | 厂商营销文章、第三方自媒体、代理商文章 | 只作线索，不作为结论依据 |
| **D** | 本报告推断 | 明确标注「推测」 |

### 1.3 命名歧义（必须先说明）

「豆包 Work Buddy」在公开资料里至少对应三件不同的事，本报告不把它们混为一家：

- **豆包工作 / 豆包工作伙伴（Doubao Workmates）**：字节跳动/飞书体系；飞书官方帮助中心称 Aily 自 2026-08-14 起更名为 Doubao Workmates（B）。
- **WorkBuddy**：检索结果指向腾讯的企业办公智能体工作台（C）。
- **火山引擎 Ark / ArkClaw**：火山引擎的模型与智能体部署产品线（C，多为厂商自发布文章）。

因此下文中涉及这三者的能力均按「厂商公开页面/文章称」处理，不与 Dify、n8n 等可抓取官方文档的产品等权比较。

---

## 2. 本仓基线（只读核对）

### 2.1 第一性原则与判据

本仓最高约束：**一个智能体 = 官方 `.claude/` 目录下的文件集合**；DB 是编辑来源，文件是唯一投影；平台只负责渲染、只读挂载、交给 SDK 加载。判断「该不该做」先问：**这是官方文件系统的哪个文件/目录能力？**

由此得到的判据：

- 工具审批策略 → 官方 `.claude/settings.json` 的 `permissions`（allow / ask / deny）+ SDK `canUseTool`。
- 工作流编排 → 官方 `.claude/workflows/*.js`，不是可视化 DSL。
- 知识库 → 官方 `.mcp.json` 里的一个 MCP server 条目，语料不进工作区。
- 记忆 → 官方 `agent-memory/` / `MEMORY.md` + 主题文件，不另造记忆库。
- 评估、审计、成本、渠道 → 平台运营层能力，不是智能体定义格式；可以新建表/接口，但**不得替代或私有化官方定义**。

### 2.2 PRODUCT.md 的 Non-Goals（原文）

> 「本期不做第三方登录、飞书/钉钉等身份源同步、套餐额度/计费、组织多租户；本人使用记录仅展示已有运行用量与已记录成本；独立 MCP 与公开分享凭据保持各自边界，登录用户权限不扩展到这两类凭据。」

对应到本报告：SSO/OIDC/SAML、飞书/钉钉身份源同步、组织多租户、套餐计费四类候选**一律标注冲突**，不作为首轮推荐；内部预算/停机控制若只是「防止成本失控」而非「套餐计费」，可单独立项，但需用户确认边界。

### 2.3 当前能力基线（摘要）

| 层 | 已有的关键事实 | 证据 |
|---|---|---|
| 定义 | 官方 `.claude/` 文件渲染：`CLAUDE.md`、`.mcp.json`、`.claude/agents/*.md`、`.claude/skills/**`、`.claude/rules/*.md`、`.claude/output-styles/*.md`、`.claude/hooks/**`、`.claude/workflows/*.js`、`.claude/settings.json` | `packages/core/src/workspace.ts`；`docs/ARCHITECTURE.md`「官方文件能力与接入状态」 |
| 运行 | 每会话 Docker 沙盒，supervisor 常驻，每轮新 runner，SDK `settingSources: ['project']` | `packages/sandbox/src/runner.ts`；`docs/ARCHITECTURE.md` §2–§3 |
| 工具 | stdio / 远程 HTTP / HTTP API 转 MCP；平台自身暴露为 `/mcp`；知识库内置只读 MCP；短期 run token；SSRF 白名单；工具级启停；OpenAPI 导入 | `packages/api/src/modules/servers/*`；`docs/ARCHITECTURE.md` §4 |
| 权限 | `businessId` 稳定身份、默认四角色、DB 可配置角色×功能矩阵、对象范围（全部/本人/被指定）、频道角色 | `packages/shared/src/access.ts`；`packages/api/src/http/access.ts`；`docs/ARCHITECTURE.md` §8 |
| 知识 | pgvector + 全文混合检索、RRF、rerank、版本 COW、FAQ/Wiki、14 种来源、ASR、图片 OCR/caption | `packages/api/src/modules/knowledge/*`；`docs/ARCHITECTURE.md` §6 |
| 评估 | 离线用例、批次快照冻结、历史/比较、导出；判分为子串匹配 | `packages/contract/src/eval.ts`；`packages/worker/src/eval-runner.ts`；`packages/shared/src/chat.ts:329` |
| 审计 | 结构化审计、目标筛选、1000 条有界导出、dedupeKey 幂等 | `packages/db/src/repo/audit.ts`；`docs/OBSERVABILITY.md` |
| 记忆 | 官方 auto-memory、个人记忆 DB + 只读投影、记忆提案（用户触发、确认制）、版本/回滚、子智能体记忆 | `docs/ARCHITECTURE.md` §5.1 |
| 交付 | 运行详情、成果快照/版本/下载、固定版本公开分享、专家包导入导出、命名运行环境 | `docs/ARCHITECTURE.md` §3.2、§5、§6.7 |

---

## 3. 对标平台能力摘要

> 只列「可核实的能力类别」，不复制营销数字。可靠性按 §1.2。

| 平台 | 可核实的定位与能力 | 可靠性 |
|---|---|---|
| **Dify** | 开源 LLMOps / Agentic Workflow：可视化 Workflow、Agent 节点、Knowledge Pipeline（抽取→清洗→分块→索引→检索测试）、Plugins/MCP、发布为应用/API/嵌入/MCP。企业版页面明确写：SAML/OIDC SSO、细粒度 RBAC（精确到 Workflow）、SCIM、防篡改审计日志实时推送 SIEM、单次调用级全链路追踪、多租户隔离、租户级配额/计费/访问策略、K8s/Terraform、BYOK。 | A |
| **n8n** | 工作流自动化 + AI Agent：AI Agent 节点、MCP Server Trigger、MCP Client、工具调用人工批准、轻量/指标评估、工作流历史与 Git 版本控制。定价页明确：SSO/LDAP（Business+）、审计日志（Enterprise）、日志流式外送（Enterprise）、多环境（Business+）、自定义项目角色（Enterprise）。 | A |
| **Microsoft Copilot Studio** | 低代码构建 agents / workflows / apps：知识源（网站、SharePoint、上传文件）、连接器（站点称 1500+）、MCP、agent flows、human-in-the-loop、发布到 Teams / Microsoft 365 / SharePoint / 网站 / 自定义渠道、评估测试集、活动跟踪与分析、DLP/治理。 | B（官方 Learn 索引抓到；细节经搜索摘要） |
| **OpenAI AgentKit / Agent Builder** | 可视化多步 agent 工作流画布、类型化节点、发布版本快照、trace graders 评估、ChatKit / Agents SDK 部署。官方 guide 明确 **Agent Builder 计划于 2026-11-30 停止**；Guardrails 与 human-approval 分支见发布文章（B）。 | A（guide）/ B（发布文章） |
| **LangSmith** | 全链路 tracing、离线评估（datasets + experiments）、在线评估、evaluators（Human / Code / LLM-as-judge / Decision model / Pairwise）、Annotation queues、trace/thread 级评估、dashboards/alerts/automations。 | A |
| **扣子 Coze 企业版** | 官方企业页强调「统一身份、统一权限、统一审计」、企业 Skill 中心、共享 Skills、模型服务、组织策略、分部门 Agent。本页为客户端渲染，抓取只得到标题，具体字段与粒度**未核实**。 | C / 未核实 |
| **飞书 Aily / 豆包工作伙伴** | 官方帮助中心称 Aily 已于 2026-08-14 更名 Doubao Workmates。搜索摘要称：知识问答、数据连接器与精细化权限、图形化 Workflow、调优台、额度分配与消耗可查。官方文档页本次未取到正文，细节**未逐条核实**。 | B / C |
| **钉钉 AI 助理 / DEAP** | 官方页面（经搜索摘要）：AI 助理知识库问答、创建/发布/可见范围/管理员审批；DEAP 企业 AI 平台含智能体管理（开发、评测、观测、生命周期）、技能中心（官方/三方/MCP）、AI 知识管理（知识集/评测集/训练集）、模型管理、运营中心、多角色授权、敏感词、API-key。审计日志细目**未核实**。 | B |
| **企业微信** | 官方 AI 开放能力页：智能机器人可通过 CLI / MCP 调用消息、邮件、文档、表格、智能表格、待办、日程、会议、微盘、通讯录；官网称机器人升级了插件与工作流能力。智能机器人概述文档称支持单聊/群聊多类型消息、流式回复、主动推送（本次正文未完整抓取）。 | A（AI 开放能力页）/ B（机器人概述） |
| **火山引擎 Ark / ArkClaw** | 厂商文章称：一键部署、Skills Hub、多 Agent 协同、云沙箱隔离、权限与审计、飞书/钉钉/企业微信机器人集成。均为厂商自发布/推广文章。 | C |
| **豆包工作 / WorkBuddy** | 媒体对比文章称：豆包工作与飞书文档/群消息/会议/知识库打通并继承飞书权限与审计；WorkBuddy 有 Ask/Plan/Craft 三级自主度、Skill/Expert/Connector 生态、多模型。 | C |

**平台层结论**：

- 成熟平台的功能重心已经从「可视化编排」转向 **治理、评估、渠道与成本**；Dify/n8n/LangSmith/Copilot Studio 的可核实企业能力几乎都落在 SSO、RBAC、审计、评估、监控、配额上。
- **HITL 已是通用能力**：n8n 的工具调用人工批准、Copilot Studio 的 human-in-the-loop、Dify 的人工审核节点、OpenAI 的 human-approval 分支都指向同一件事。
- **评估正在从离线用例扩展到在线/轨迹评估**：LangSmith、Copilot Studio、OpenAI trace graders 都把「生产轨迹」当成评估输入；本仓目前只有离线用例。
- **渠道接入是 adoption 的关键差异**：企业微信、飞书、钉钉、Coze 都把「进入 IM / 办公套件」作为默认分发面；本仓目前只有平台内频道。

---

## 4. 企业级智能体平台必备能力维度表

状态：✅ 已具备；🟡 部分具备；❌ 缺失。成本：S / M / L（相对实现与验证成本，不是工期承诺）。

### 4.1 治理与身份

| 维度 | 本仓状态 | 证据（文件/文档） | 对标平台做法 | 落地价值（云端企业内部） | 成本 |
|---|---|---|---|---|---|
| **组织 / 多租户** | ❌ 单组织；个人数据按 `businessId` 隔离，但没有 tenant/org 维度 | `docs/ARCHITECTURE.md` §6.3「仍不引入组织多租户」；`packages/db/src/schema.ts` 无 org/tenant 表 | Dify 企业版单集群多业务单元、租户级配额/计费/访问策略；Copilot Studio 依托 M365 租户；n8n 多环境/项目角色 | 多部门数据边界、成本归属、集团级隔离 | L（与 Non-Goals 冲突） |
| **身份与 SSO** | 🟡 仅用户名/密码 + 会话吊销；无 OIDC/SAML/SCIM/第三方登录 | `packages/api/src/modules/auth/better-auth.ts:29`（`emailAndPassword` + `username`，无 social/OIDC 插件）；`packages/api/src/modules/auth/session.ts` | Dify SAML/OIDC + SCIM；n8n SSO/LDAP + SCIM；Copilot Studio Entra ID；飞书/钉钉/企微原生身份 | 企业统一身份、离职即吊销、免密登录 | M–L（与 Non-Goals 冲突） |
| **RBAC / 对象级授权** | ✅ 角色×功能矩阵 + 对象范围（全部/本人/被指定）+ `businessId` 隔离 + 频道角色 | `packages/shared/src/access.ts`；`packages/api/src/http/access.ts`；`packages/db/src/repo/access.ts`；`docs/ARCHITECTURE.md` §8 | Dify 细粒度 RBAC 到 Workflow；n8n 自定义项目角色；Copilot Studio 安全角色/DLP；Coze 统一身份/权限（未核实） | 已达标；后续可把工具/知识库对象也纳入同一授权模型 | S（在现有模型上扩展） |
| **审计合规** | 🟡 审计日志 + 目标筛选 + 1000 条导出 + dedupeKey 幂等；无防篡改、SIEM 推送、审计保留策略、数据驻留 | `packages/db/src/repo/audit.ts`；`docs/OBSERVABILITY.md`；`packages/worker/src/maintenance.ts` | Dify 防篡改审计日志实时推送 SIEM；n8n 审计日志 + 日志流式外送；Copilot Studio DLP/治理；钉钉称等保三级/敏感词（B） | 企业内审、取证、等保/合规检查 | S–M |
| **沙盒 / 凭证 / 隔离** | ✅ 每会话 Docker、非 root、只读根、cap-drop、memory/cpu/pids、出站三档、AES-256-GCM 密钥、短期 MCP/模型 token、模型凭证代理 | `packages/sandbox/src/*`；`packages/core/src/secrets.ts`；`docs/SECURITY.md`；`docs/CAPABILITY-GAP.md` 六原语 | Dify 沙盒/代码执行；Copilot Studio Power Platform 连接器；Coze 云沙盒；n8n 自托管 | 本仓差异化的安全底座 | —（无需新增） |
| **数据保留 / 备份** | ✅ 版本保留 50、终态运行 90 天、消息 30 天、`pg_dump` 备份/恢复、知识数据包 | `docs/CAPABILITY-GAP.md` 循环 4/14；`scripts/backup.sh`、`scripts/restore.sh`；`docs/ARCHITECTURE.md` §6.7 | n8n 分套餐保留期；LangSmith 保留策略；Dify 企业版数据驻留 | 已够用；后续补审计保留策略 | S |

### 4.2 知识与编排

| 维度 | 本仓状态 | 证据（文件/文档） | 对标平台做法 | 落地价值（云端企业内部） | 成本 |
|---|---|---|---|---|---|
| **知识库 / RAG / GraphRAG** | 🟡 RAG 已强：关键词 + 向量混合、RRF、rerank、版本 COW、FAQ/Wiki、14 种来源、ASR、图片 OCR/caption；**GraphRAG ❌**，真实企业源/真实模型质量未完整验收 | `packages/api/src/modules/knowledge/*`；`docs/ARCHITECTURE.md` §6；`docs/REMAINING-TODOS.md` P0 | Dify Knowledge Pipeline；Copilot Studio SharePoint/文件/网站知识；Coze 知识库（C） | 企业文档问答已可用；GraphRAG 只在真实多跳/关系查询出现时再评估 | GraphRAG L；检索质量评估 S–M |
| **工作流与多智能体编排** | 🟡 官方 `.claude/workflows/*.js`（project 级）+ 单层子智能体 + 频道多 agent lane + 定时运行；**无可视化 DSL、无持久化图执行** | `packages/core/src/workspace.ts`（workflows 渲染）；`docs/ARCHITECTURE.md`「官方文件能力与接入状态」；`packages/api/src/modules/channels/*`；`packages/worker/src/scheduling/scheduler.ts` | Dify 可视化 Workflow + Agent 节点；Coze DAG；n8n AI Agent 节点；Copilot Studio agent flows；OpenAI Agent Builder（2026-11-30 停止） | 官方文件编排已能表达多数内部任务；可视化 DSL 不是第一性原则要求的默认解 | DSL L 且不建议；持久化图执行 M–L（有真实需求再做） |
| **工具 / MCP 网关** | ✅ 三类来源（stdio / 远程 HTTP / HTTP→MCP）+ 平台自身 `/mcp` + 知识库内置 MCP + 短期 run token + SSRF 白名单 + 工具级启停 + OpenAPI 导入 + outputSchema + 审批 | `packages/api/src/modules/servers/*`；`packages/shared/src/mcp.ts`；`docs/ARCHITECTURE.md` §4 | Dify Plugins/MCP；n8n MCP Client/Server Trigger；Copilot Studio 连接器/MCP；企业微信 CLI/MCP；Coze 插件 | 已达标；缺的是策略层，不是网关本身 | S（策略） |
| **HITL 审批与分级自治** | 🟡 工具级 `requiresApproval` + run 批准/拒绝 + 运行内真暂停 + 过期 + 原生提问；**无角色/参数/风险分级策略，无跨重启恢复，stdio 工具无审批桥** | `packages/shared/src/mcp.ts:172`；`packages/api/src/modules/servers/generated.ts:258`；`packages/api/src/modules/chat/openui-tools.ts:180`；`packages/contract/src/runs.ts:33`；`docs/CAPABILITY-GAP.md`「持久化 HITL 未做」 | n8n 工具调用人工批准；Copilot Studio human-in-the-loop/升级；Dify 人工审核节点；OpenAI human-approval 分支（B） | 企业内部高风险操作（写库、发消息、付款、删除）必须可控 | 策略 S–M；持久化 HITL L |
| **记忆与自动进化** | 🟡 官方 auto-memory + 个人记忆 DB 投影 + 记忆提案（确认制）+ 版本/回滚 + 子智能体记忆；**自动进化 ❌** | `docs/ARCHITECTURE.md` §5.1；`docs/REMAINING-TODOS.md` P0；`PRODUCT.md`（自动进化仍是已确认缺口） | Dify 记忆；Coze 变量/记忆；LangGraph/LangSmith 由框架承担；Copilot Studio 无同等原生长期记忆（未核实） | 确认制比无人值守自动进化更安全；自动进化需要治理策略后才做 | L（不建议现在做） |
| **多模态 / ASR** | 🟡 文本/图片/PDF 附件、图片 OCR/caption、可选图片向量、ASR profile；真实视觉/ASR 质量与费用未验收 | `docs/ARCHITECTURE.md` §3.4、§6.2.1；`packages/api/src/modules/knowledge/read-image.ts`；`docs/REMAINING-TODOS.md` P0 | Dify 多模态模型；Copilot Studio voice；企业微信机器人接收图片/文件/语音；Coze 多模态 | 内部知识库已能处理扫描件/音频；先验收真实质量，再加新模态 | 验证 S–M；视频等新模态 L |

### 4.3 运营与交付

| 维度 | 本仓状态 | 证据（文件/文档） | 对标平台做法 | 落地价值（云端企业内部） | 成本 |
|---|---|---|---|---|---|
| **可观测 / Trace** | 🟡 运行列表/详情、工具事件、token/延迟/成本、审计、`/health/metrics`、Bull Board、pino；无 OTel 导出、span 树、告警、SIEM | `docs/OBSERVABILITY.md`；`packages/db/src/schema.ts:788-802`；`packages/api/src/modules/ops/*` | LangSmith traces/dashboards/alerts；Dify 日志/标注；Copilot Studio activity trace/analytics；n8n executions/log streaming | 单机排障已够；企业运维需要导出与告警 | S–M |
| **离线 + 在线 + 轨迹评估** | 🟡 离线用例、批次快照冻结、历史/比较、导出、知识检索离线评估；**判分仅子串匹配**；无在线抽样、轨迹评估、LLM-as-judge、人工标注队列 | `packages/contract/src/eval.ts`；`packages/worker/src/eval-runner.ts`；`packages/shared/src/chat.ts:329`；`packages/api/src/modules/knowledge/retrieval-evaluation.ts` | LangSmith 离线 datasets/experiments + 在线 eval + evaluators + annotation queues；Copilot Studio 测试集/评估；OpenAI trace graders；n8n 轻量/指标评估 | 没有在线/轨迹评估就无法回答「生产里到底变好还是变坏」 | M |
| **成本 / 预算 / 停机** | 🟡 专家级 `maxBudgetUsd`（默认 2）、运行成本/token、个人使用记录；无团队/专家累计预算、告警、自动停机、模型路由配额 | `packages/shared/src/agent.ts:118`；`packages/db/src/schema.ts:798`；`packages/api/src/modules/personal/*` | Dify 租户级配额/计费；Copilot Studio Copilot Credits；Coze 配额；飞书/钉钉 AI 额度分配 | 防止单专家/单团队成本失控；与「套餐计费」Non-Goal 需划清边界 | M |
| **发布 / 分享 / 版本化** | 🟡 专家版本 + 回滚、成果固定版本公开分享、专家包导入导出、命名运行环境；**无智能体级对外 API/嵌入/渠道发布** | `packages/contract/src/agents.ts:174`；`packages/contract/src/output-shares.ts`；`docs/ARCHITECTURE.md` §3.2、§5、§6.7 | Dify 发布应用/API/嵌入/MCP；Coze 发布多渠道；Copilot Studio 发布 Teams/M365/SharePoint/网站；n8n 工作流激活/Webhook | 让非平台用户也能消费专家；需先定渠道与凭据边界 | M |
| **渠道接入（IM / 机器人）** | ❌ 只有平台内频道（人 + agent lane）；无飞书/钉钉/企业微信机器人、无 Webhook；知识库能连飞书/钉钉文档，但不等于消息渠道 | `packages/shared/src/channels.ts`；`packages/api/src/modules/channels/*`；`docs/ARCHITECTURE.md` §3.5；`rg webhook` 无命中 | 企业微信智能机器人 + CLI/MCP；飞书 Aily/豆包工作伙伴；钉钉 AI 助理；Coze 发布飞书/微信/抖音；ArkClaw 集成三家（C） | 用户不必打开新平台即可使用专家，adoption 最大杠杆 | L |
| **定时任务 / 触发器** | 🟡 cron 定时任务（专家 + prompt）、知识来源同步 cron、频道 @ 唤醒；**无外部 Webhook/通用事件触发器**；`trigger='event'` 仅用于内部评估 | `packages/shared/src/ops.ts`；`packages/worker/src/scheduling/scheduler.ts`；`packages/worker/src/eval-runner.ts:125`；`packages/api/src/modules/channels/*` | n8n Webhook/Schedule；Copilot Studio 定时/触发式 autonomous agent；Dify 定时任务（未核实）；Coze 定时（未核实） | 把内部系统事件（工单、告警、审批）接进专家 | S–M（需签名/鉴权/重放防护） |

---

## 5. 按「价值 × 成本」排序的落地候选

### 5.1 评分方法

为了让排序可复核，使用简单可解释的分数：

> **得分 = 缺口严重度（1–3）× 企业必备度（1–5）÷ 成本系数（S=1，M=2，L=3）**

- 缺口严重度：1 = 已有但薄；2 = 部分缺失；3 = 缺失。
- 企业必备度：5 = 招标/安全评审通常必问；1 = 锦上添花。
- 同分时按：① 是否与 Non-Goals 冲突；② 是否直接改善用户交付；③ 是否能在现有代码上增量完成；④ 风险与外部依赖。

### 5.2 排序表

| 排名 | 候选 | 缺口 | 必备度 | 成本 | 得分 | Non-Goals | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | **C1 统一工具审批策略与分级自治** | 2 | 5 | M | **5.0** | 无 | **首个落地** |
| 2 | **C2 审计合规增强（防篡改/SIEM/保留）** | 1 | 5 | S | **5.0** | 无 | 紧随其后 |
| 3 | **C3 在线 + 轨迹评估** | 2 | 4 | M | **4.0** | 无 | Top 3 |
| 4 | C4 成本预算与停机（不做套餐计费） | 2 | 4 | M | 4.0 | 边界需确认 | 备选 |
| 5 | C5 外部 Webhook / 事件触发 | 2 | 3 | S–M | 4.0 | 无 | 备选 |
| 6 | C6 IM 渠道接入（飞书/钉钉/企业微信） | 3 | 4 | L | 4.0 | 无（但涉及外部凭据） | 第二阶段 |
| 7 | C7 持久化 HITL（跨重启暂停/恢复） | 3 | 5 | L | 5.0 | 无 | C1 的阶段 2 |
| 8 | C8 SSO / OIDC / SAML | 3 | 5 | L | 5.0 | **冲突** | 需用户决策 |
| 9 | C9 组织多租户 | 3 | 4 | L | 4.0 | **冲突** | 需用户决策 |
| 10 | C10 智能体发布为对外 API / 嵌入 | 1 | 3 | M | 1.5 | 无 | 有真实外部消费者再做 |
| 11 | C11 GraphRAG | 2 | 2 | L | 1.33 | 无 | 不优先 |
| 12 | C12 无人值守自动进化 | 2 | 3 | L | 2.0 | 与确认制设计冲突 | 不做 |
| 13 | C13 可视化工作流编排 DSL | 0 | 2 | L | 0 | 与第一性原则冲突 | **不做** |

### 5.3 排序解释

- **C1 与 C2 同为 5.0，为什么 C1 第一？** C2 更便宜，但 C1 直接保护「用户把真实工作交给专家」这条主路径，且是 PRODUCT.md「默认安全 / 最小权限」的直接体现；C2 可以在 C1 之后用很小成本补上。两者都无 Non-Goals 冲突。
- **C7 分数也是 5.0，为什么排第 7？** 它的成本 L 且需要改 runner/supervisor/审批恢复协议，风险高于收益；更合理的路径是先做 C1 的策略层，把「什么时候需要批准」做对，再决定是否投入持久化跨重启恢复。
- **C3 排第 3**：本仓评估底座（用例、快照、批次、比较、导出）已经存在，缺的是判分与在线/轨迹入口；补 LLM-as-judge 与在线抽样比从零建评估系统便宜得多。
- **C8/C9 分数高但排除**：与 PRODUCT.md Non-Goals 正面冲突。除非用户明确改目标，否则不做；本报告不把它们算进「首个功能」。
- **C13 明确不做**：可视化 DSL 会另造一套私有编排语义，违反「智能体 = 官方 `.claude` 文件集合」；官方已有 `.claude/workflows/*.js`，应优先把它的编辑/校验/预览做顺，而不是引入 Dify 式画布。
- **C6 第二阶段**：IM 渠道是 adoption 最大杠杆，但涉及外部应用凭据、消息重放、身份映射与审计，和「飞书/钉钉身份源同步」Non-Goal 的边界需要先说清。

---

## 6. 推荐首个目标：统一工具审批策略与分级自治

### 6.1 目标

为每一次工具调用建立**可配置的分级自治策略**，并把策略投影为官方 `.claude/settings.json` 的 `permissions`：

- `allow`：直接执行。
- `ask`：进入平台审批；API 侧 MCP 工具复用现有「真暂停 + 审批后继续」；沙盒侧工具通过 SDK `canUseTool` 桥接（阶段 2）。
- `deny`：拒绝执行并给出可操作原因。

匹配维度至少包括：专家、连接器、工具、调用者角色、HTTP method（generated 工具）、可选的参数风险规则。所有决策写审计，审批沿用现有过期与拒绝语义。

### 6.2 为什么是它

1. **企业必备**：n8n、Copilot Studio、Dify、OpenAI 都把「工具调用人工批准 / human-in-the-loop」当作平台能力；本仓只有单工具布尔开关，无法表达「财务写操作必须主管批准、只读查询直接放行」。
2. **完全增量**：`approval_requests`、运行内等待、批准/拒绝、过期、审计、频道审批、OpenUI 审批都已存在；缺的是策略层与官方权限投影，不是新执行循环。
3. **官方文件对齐**：Claude Code 官方 `.claude/settings.json` 支持 `permissions`（allow/ask/deny），SDK 支持 `canUseTool`；这正是第一性原则要求的「官方文件能力」，不需要私有 DSL。
4. **不碰 Non-Goals**：不涉及 SSO、身份源同步、计费、多租户。
5. **可验证**：可以用真实 sandbox + 本地假模型验证审批暂停/继续/拒绝/过期，不需要付费模型。

### 6.3 范围

**阶段 1（建议本次落地，S–M）**

- 策略模型与 DB 存储。
- 官方 `.claude/settings.json` 的 `permissions.allow / ask / deny` 渲染（stdio 工具）。
- API 侧 MCP 工具（generated / http / knowledge）继续走 `approval_requests`，但判定改为共享策略函数。
- 专家安全设置 + 工具编辑器策略列。
- 审计：策略变更、批准、拒绝、过期。
- 保留现有 `requiresApproval` 兼容语义：`true` 映射为 `ask`。

**阶段 2（后续，M–L）**

- stdio 工具的 `ask`：runner 的 `canUseTool` 经 supervisor/worker 桥接到平台审批；补齐「跨重启恢复」需要单独的运行状态机，不在本阶段承诺。
- 参数级规则（如路径、金额、SQL 关键字）与风险分级模板。

**明确不做**

- 不新建第二套执行循环。
- 不把策略写进 `CLAUDE.md` 或私有 JSON 定义；只写官方 `settings.json` + 平台策略表。
- 不承诺「暂停后跨 worker 重启恢复」；当前能力仍是运行内暂停。

### 6.4 架构落点

| 层 | 改动点 | 说明 |
|---|---|---|
| 共享契约 | `packages/shared/src/approvals.ts`（新）或扩展 `packages/shared/src/mcp.ts` | `toolApprovalPolicySchema`、`toolApprovalDecisionSchema`、匹配规则；API / core / sandbox 共用 |
| 纯函数 | `packages/core/src/tool-policy.ts`（新） | 输入策略 + 工具上下文 + 调用者角色，输出 allow/ask/deny；不碰 DB/IO，API 与 runner 共用同一实现 |
| 官方文件渲染 | `packages/core/src/workspace.ts` 的 `settingsJson` | 增加 `permissions: { allow, ask, deny }`；沿用「生成区」约定，不污染用户正文 |
| DB | `packages/db/src/schema.ts` | `api_tools` 增加 `approval_policy` jsonb（或独立表）；`approval_requests` 增加 `policy_id` / `decision` / `reason`；迁移 |
| 仓储 | `packages/db/src/repo/servers.ts` | 读写策略；保持现有工具 PATCH 语义 |
| API 执行 | `packages/api/src/modules/servers/generated.ts`、`packages/api/src/modules/chat/openui-tools.ts` | 把 `tool.requiresApproval` 的布尔判断替换为 `evaluateToolPolicy`；`ask` 复用现有等待/审批，`deny` 直接失败并审计 |
| API 契约 | `packages/contract/src/servers.ts`、`packages/contract/src/runs.ts` | 工具策略 get/put；审批项返回 `decision` / `reason` / `policyId` |
| 沙盒（阶段 2） | `packages/sandbox/src/runner.ts`、`packages/sandbox/src/questions.ts` | 把 `canUseTool` 从「只处理原生提问」扩展为「处理 ask 策略」；经 supervisor 协议转给 worker/API |
| Worker（阶段 2） | `packages/worker/src/runs/*`、`packages/worker/src/sandbox/sessions.ts` | 审批请求转发、等待、取消、超时；复用现有 run 生命周期 |
| Web | `packages/web/src/pages/servers.tsx`、`packages/web/src/pages/agents/agent-editor.tsx`、`packages/web/src/pages/runs/*` | 工具策略编辑、专家安全设置、审批收件箱/详情 |
| 审计 | `packages/db/src/repo/audit.ts` 调用点 | `tool.policy.updated`、`tool.approval.requested`、`tool.approval.decided`、`tool.approval.expired` |

### 6.5 契约与数据变更（建议）

```ts
// packages/shared/src/approvals.ts（示意，不新增注释以外的私有 DSL）
toolApprovalPolicySchema = {
  mode: 'allow' | 'ask' | 'deny',
  // 可选匹配维度；缺省表示该层不限制
  serverId?: string,
  toolName?: string,
  roleId?: string,
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  // 参数规则放阶段 2
}
```

- 一个工具可以有多条策略；判定顺序固定为 **deny > ask > allow**，并在契约测试里固定。
- 未命中任何策略时的默认值沿用现有行为：`requiresApproval=true` → `ask`，否则 `allow`。
- `deny` 的返回必须与现有工具错误形状一致，不能把内部策略细节回显给模型。

### 6.6 验证命令

按改动范围执行，不固定跑全套：

```bash
bun run typecheck
bun run lint
bun run test -- packages/api packages/core packages/db packages/sandbox
bun run test:web
bun run build
bun run db:generate && bun run db:migrate   # 隔离库
bun run test:e2e                            # 审批主路径
```

建议额外做一次真实 sandbox + 本地假模型的审批链路验收（不调用付费模型）：

- `ask`：工具调用暂停 → 批准 → 同一次调用继续 → 结果返回。
- `deny`：工具调用被拒绝 → 运行继续/按既有语义失败 → 审计有记录。
- `allow`：不产生审批行。
- 过期：超过 `expiresAt` 后审批不可用，运行收到明确原因。
- 权限：无 `runs.approve` 的用户不能批准；策略编辑受对象范围约束。

### 6.7 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| 双执行点漂移 | API 侧与沙盒侧各自判断，规则可能不一致 | 判定逻辑只放在 `packages/core/src/tool-policy.ts` 纯函数；API 与 runner 共用；契约测试固定优先级 |
| stdio 工具绕过 | stdio MCP 在沙盒内执行，不经过 API 的 `approval_requests` | 阶段 1 明确标注「stdio 仅支持 allow/deny 投影」；阶段 2 用官方 `canUseTool` 桥接；不得声称 stdio 已支持 ask |
| `dontAsk` 模式 | SDK 在 `dontAsk` 下不会调用 `canUseTool`，ask 会直接拒绝 | 文档写清：`dontAsk` 专家只能使用 allow/deny；默认权限模式已是 `default` |
| 等待占用运行超时 | 审批等待计入整体 run timeout | 沿用现有等待期限与独立审批槽；策略层不扩大默认等待 |
| 官方 settings 被误改 | `settings.json` 是生成文件，用户手工改会被下一轮覆盖 | 在 UI 与文档写明「策略在平台编辑，文件是投影」；不新增用户可写入口 |
| 审批信息泄露 | 策略/参数可能含敏感值 | 复用现有脱敏与 `arguments_summary` 边界；审计只存摘要 |
| 无跨重启恢复 | worker 重启后运行内暂停可能丢失 | 明确不在本阶段承诺；后续用独立运行状态机解决，不混入本功能 |

### 6.8 成本与交付顺序

- **阶段 1**：S–M。主要是契约、DB 迁移、core 纯函数、API 判定替换、Web 编辑与测试；不改 SDK 循环。
- **阶段 2**：M–L。主要是 runner/supervisor/worker 的 `canUseTool` 桥接与跨进程审批状态。
- 建议先交付阶段 1，用真实审批链路验收后再决定是否继续阶段 2。

---

## 7. 与 PRODUCT.md Non-Goals 的冲突清单

| 候选 | 冲突点 | 处理 |
|---|---|---|
| SSO / OIDC / SAML / SCIM | 「本期不做第三方登录」 | **不做**；若企业客户强制要求，需用户先改 PRODUCT.md |
| 飞书 / 钉钉身份源同步 | 「本期不做……飞书/钉钉等身份源同步」 | **不做**；IM 渠道接入与身份同步要分开立项 |
| 套餐额度 / 计费 | 「本期不做套餐额度/计费」 | 内部成本预算/停机可单独讨论，但不得实现套餐、账单、计费 |
| 组织多租户 | 「本期不做组织多租户」 | **不做**；现有 `businessId` + RBAC 继续作为单组织模型 |
| IM 渠道接入 | 不直接冲突，但会引入外部应用凭据与身份映射 | 可做，但需先确认与「身份源同步」的边界；建议第二阶段 |
| 自动进化 | 与当前「确认制，不是自动进化」的设计冲突 | 不做无人值守自动进化；只做用户在环的提案 |

---

## 8. 未核实项与后续核实清单

### 8.1 平台侧

| 项 | 状态 | 建议核实方式 |
|---|---|---|
| 扣子 Coze 企业版的 RBAC 粒度、审计字段、数据隔离 | 官方页客户端渲染，未取到正文 | 查阅扣子企业版帮助文档/开放平台，或申请试用 |
| 飞书 Aily / 豆包工作伙伴的知识库权限、Workflow 节点、审计 | 官方文档页未取到正文 | 直接查阅飞书帮助中心与 Aily 文档目录 |
| 钉钉 DEAP 的审计日志细目、评测/观测字段 | 仅搜索摘要 | 查阅 `open.dingtalk.com` 的 DEAP/智能体文档 |
| 火山引擎 Ark / ArkClaw 的权限、审计、沙盒隔离 | 厂商文章 | 查阅火山引擎官方产品文档与计费页 |
| OpenAI Guardrails / HITL 分支细节 | 官方 guide 未提，发布文章为 B | 查阅 OpenAI Guardrails 与 Agent Builder 废弃页 |
| Copilot Studio 分析/监控指标与评估方法 | 官方索引抓到，细节为 B | 查阅 `analytics-*` 与 `security-and-governance` 文档 |
| 企业微信智能机器人的流式回复/主动推送/插件工作流 | 官方 AI 开放能力页抓到；机器人概述未完整抓取 | 查阅 `developer.work.weixin.qq.com/document/61964` |
| Dify 是否有独立评估模块 | 官方企业页未列；搜索未命中独立评估页 | 查阅 `docs.dify.ai` 的 LLMOps/标注章节 |
| 各平台定价/配额 | 仅有公开定价页或营销数字 | 以官方定价页/合同为准，本报告不引用具体金额 |

### 8.2 本仓侧（已有文档自述的未验收项）

- 知识库真实企业源（飞书/GitLab/GitHub/Notion/Confluence/语雀/钉钉/IMA/Seafile/Nextcloud）与真实 embedding/rerank/视觉/ASR 质量未验收。
- GraphRAG 需要 Neo4j 与抽取模型费用，未部署。
- 自动进化未实现；记忆质量与跨 run 召回未用付费真实模型审计。
- 多机部署、持久化 HITL、模型凭证代理之外的强隔离升级均未开始。

---

## 9. 来源

### 9.1 本仓文档与代码（只读）

- `PRODUCT.md`
- `docs/CAPABILITY-GAP.md`
- `docs/ARCHITECTURE.md`（§2–§8、「官方文件能力与接入状态」）
- `docs/PROJECT-BRIEF.md`
- `docs/REMAINING-TODOS.md`
- `docs/OBSERVABILITY.md`
- `docs/SECURITY.md`
- `packages/api/src/modules/auth/better-auth.ts`
- `packages/api/src/modules/servers/*`
- `packages/api/src/modules/chat/openui-tools.ts`
- `packages/api/src/modules/knowledge/*`
- `packages/core/src/workspace.ts`
- `packages/shared/src/access.ts`、`packages/shared/src/agent.ts`、`packages/shared/src/chat.ts`、`packages/shared/src/mcp.ts`、`packages/shared/src/ops.ts`
- `packages/contract/src/agents.ts`、`packages/contract/src/eval.ts`、`packages/contract/src/output-shares.ts`、`packages/contract/src/runs.ts`
- `packages/db/src/schema.ts`、`packages/db/src/repo/audit.ts`
- `packages/sandbox/src/runner.ts`、`packages/sandbox/src/questions.ts`
- `packages/worker/src/scheduling/scheduler.ts`、`packages/worker/src/eval-runner.ts`
- `packages/web/src/pages/*`

### 9.2 外部来源

**A（官方文档/定价页，直接抓取）**

- Dify 企业版：https://www.dify.ai/zh/dify-enterprise
- Dify 主站：https://dify.ai/
- n8n 定价：https://n8n.io/pricing
- Microsoft Copilot Studio 文档：https://learn.microsoft.com/en-us/microsoft-copilot-studio/
- OpenAI Agent Builder guide：https://developers.openai.com/api/docs/guides/agent-builder
- LangSmith 评估概念：https://docs.langchain.com/langsmith/evaluation-concepts
- 企业微信 AI 开放能力：https://work.weixin.qq.com/nl/index/aicli

**B（官方页面/帮助中心，经搜索摘要或未完整抓取）**

- 飞书 Aily 平台介绍：https://aily.feishu.cn/doc/IWSWdUWSNoiVzMxBPLRcB6wrnRe
- 飞书 Aily 更名帮助：https://www.feishu.cn/hc/en-US/articles/790732948604
- 飞书官方文章：https://feishu.cn/content/article/7576921890476788922
- 钉钉 DEAP：https://www.dingtalk.com/qidian/page-fhaYNe4V.html
- 钉钉 AI 助理概述：https://open.dingtalk.com/document/ai-dev/introduction-to-ai-assistant.md
- 钉钉 AI 助理常见问题：https://open.dingtalk.com/document/aipass/faq-2
- 企业微信智能机器人概述：https://developer.work.weixin.qq.com/document/61964
- 企业微信 Bot ID/Secret：https://open.work.weixin.qq.com/help2/pc/21677
- OpenAI AgentKit 发布文章：https://openai.com/index/introducing-agentkit/
- LangSmith 产品说明：https://www.langchain.com/resources/what-is-langsmith

**C（厂商营销/第三方，仅作线索）**

- 火山引擎 ArkClaw 企业知识库：https://www.volcengine.com/article/36354
- 火山引擎 ArkClaw 2026 解析：https://www.volcengine.com/article/36936
- 火山引擎 ArkClaw 多 Agent 协同：https://developer.volcengine.com/articles/7622847677704716331
- 扣子企业版：https://www.coze.cn/overview/enterprise
- 豆包工作/WorkBuddy 对比：https://www.allagent.wiki/blog/china-office-agent-comparison
- WorkBuddy 介绍：https://www.aihr.wang/sites/9648.html
- 扣子企业版第三方解读：https://www.hsydls.com/Doc/11099.html

---

## 10. 给主会话的最小决策请求

1. 是否确认 **C1 统一工具审批策略与分级自治** 作为首个落地目标？
2. 若确认，是否接受「阶段 1 先做 API 侧 MCP 工具 + 官方 permissions 投影，stdio ask 放阶段 2」的范围切分？
3. 是否维持 PRODUCT.md 的四项 Non-Goals 不变（SSO / 身份源同步 / 套餐计费 / 组织多租户）？
4. 是否同意在阶段 1 验收中使用真实 sandbox + 本地假模型，不产生付费模型调用？
