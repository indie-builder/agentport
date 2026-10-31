# 剩余待办清单（2026-10-31）

> 来源：原 LoopX `agentport-goal` 的 68 条 open todo，经代码与文档逐条核对后收敛。
> LoopX 已不再使用；本文件是唯一待办来源，后续由 `/loop` 或人工按序执行。
> 已核对 50 条为已完成/过时（见文末），不再跟踪。

## P0

- **WeKnora 核心知识库能力补齐（2026-10-31，本地功能已合入，剩余外部验收与旧默认库阻塞）**：以本地 WeKnora 为参照补齐管理与智能体能力。已落管理/版本 COW、FAQ、Wiki、统一检索/MCP、来源撤权、ZIP、离线评估、ASR 与 9 种新增来源；官方 SDK 文件 first、共享源与完整快照契约不变。实现已由 [PR #127](https://github.com/indie-builder/agentport/pull/127) 合入 main（`f93c276`），独立前后端问题均已修复并 PASS；整合验证覆盖 backend/web/DB/shared/core 全范围、零 skip，typecheck/build/focus/contract 通过，最终文件与用例数字见 [任务记录](tasks/knowledge-weknora.md)，本文不重复易过期的计数。用户后续已授权本地迁移：`agentport_business_e2e_dataset` 已应用 `0046`（账本 47 条），迁移前后数据不变；主 `.env` 指向的旧 `agentport` 库存在历史漂移（`0043` 失败），保持原样，默认库重建仍未授权。剩余只有外部验收与旧默认库阻塞：真实 Docling/ASR/视觉/语义质量、企业账号与 GraphRAG（需 Neo4j/模型费用）未验收；生产发布、清库重建与付费真实模型仍未授权。

0. **智能体能力补齐（首轮与产出查看已完成，2026-10-28）**
   - 范围：以使用智能体完成工作的完整用户故事核对能力，从目标、上下文、执行、必要确认、产出查看到反馈修改定位真实断点。明确保留当前任务的产出查看/预览与必要下载；排除云盘、项目空间、多端协同、分享发布等服务。过程与证据见 [任务记录](tasks/platform-capability-gaps.md) 与 [产出查看记录](tasks/agent-output-viewing.md)，验收统一见 [用户故事](USER-STORIES.md)。
   - 首轮：原生任务清单进度。当轮默认 `dontAsk` 下真实 SDK→沙盒→SSE→历史保存14/14通过，浏览器刷新恢复；review四项问题已修复并获独立复核通过；sandbox/worker 103/103、导出/配置93/93、web864/864及typecheck/build通过，已由 [PR #96](https://github.com/indie-builder/agentport/pull/96) 合入 main（`cd95b19`）。此证据只覆盖 US-6.3 的进度环节，不等于完整故事验收；清单是模型自报进度，不是成果质量判据。
   - ✅ **产出查看（2026-10-28 完成）**：原生 Write 生成文件、每轮不可变快照、版本查看/切换、下载与“基于此版本修改”已接通；真实两轮12/12、分支8/8、停止后保留2/2，浏览器预览/下载与反馈挂引用通过；串行后端1824/1824、Web905/905、API9/9、typecheck/build通过，独立评审通过。限制：Office 不预览、无删除工具、成果内容不脱敏（PDF 已由后续任务支持原生预览，见下）；详见 D-67 与任务记录。
   - 后续按完整故事继续核对：
     - ✅ **会话内图片成果预览（2026-10-30 实现、三轮 review 与浏览器验收通过，已由 PR #121 合入 main）**：PNG/JPEG/GIF/WebP 在会话成果面板与公开分享页经鉴权下载取 Blob，浏览器解码成功后才显示，损坏字节保留下载；同一路径多版用单选版本菜单（最新 / 上一版 / 前 N 版 + 时间）切换，列表分页外的旧版按 `runId + path` 取真实元数据。该任务私有成果只新增这 4 种图片预览，PDF/Office 当时仍下载（PDF 见下条）；公开页 PDF 随后续任务改为共享 `BlobPdf`；HTML/SVG 仅源码。三轮 Opus review 通过（末轮 `a9c2e499b17d5672d`，无 mustfix，86 条定向用例）；full web 118 文件 1396 用例 39.32s、API/Web typecheck/build、backend 18 通过；最终浏览器验收 `a7090b402c75b1cb1` 通过；源码 `e4d414d` 已由 PR #121 合入 `main` `70e28e2`。限制：元数据接口仍整份读取文件字节；坏图、大图与 HTML 在真实浏览器中的表现未测，大图内存未单独测量；分页外旧版由单测覆盖。详见 [任务记录](tasks/image-output-preview-20261030.md)。
     - ✅ **会话成果 PDF 原生预览（2026-10-30 实现；三轮 review、最终验证与生产隔离浏览器验收通过；PR #123 已合入 `main` `b683903`）**：私有成果精确命中 `application/pdf` 后经鉴权下载取 Blob，公开分享页移除旧对象 URL/iframe 分支，两处共用 `BlobPdf` 原生查看器；先判断 `navigator.pdfViewerEnabled === true`，只把前 5 字节为 `%PDF-` 的文件交给查看器（仅 header 门槛，不是结构或安全完整验证），并以固定 `application/pdf` 建 Blob URL；不支持、header 不符、读取失败分别提示并始终保留下载，iframe 的 load/error 不作为解码成功判据，对象 URL 随换版与卸载释放。CSP 仅新增 `frame-src 'self' blob:`，`object-src 'none'` 与 `script-src 'self'` 保持；无新依赖、API、DB 或模型费用；Office 仍下载，4 种图片预览与 HTML/SVG 源码行为不变。API 一审 `a1f97d67a04771d6d` 26 用例、Web 一审补修 `ada812d28cc77c763` 97 用例、二审 `ab003ecf947f052cb` 无 mustfix、第三轮 `a18c436ffd11f7505` 无 mustfix（4 文件 110 用例）；生产隔离浏览器 `a46306ac16227d1ce` 通过（独立随机 PG+Redis、端口 63465、production 真实 CSP、`pdfViewerEnabled=true`、私有/公开 ONE/TWO、切版刷新、下载 sha、公开无 cookie、伪 PDF 无 iframe、引用不发模型、清理 0）；主线程最终复验 full web 119 文件 1412 用例 39.50s、api/web typecheck/build、backend 3 文件 26 用例 2.62s 通过。实现 `ca5cb28`、文档 `9caf2fa` 已由 PR #123 合入 `main` `b683903`。限制：只测 Chromium，加密/坏结构 PDF 由原生 viewer 兜底未逐一实测，大 PDF 未压测。详见 [任务记录](tasks/pdf-output-preview-20261030.md)。
     - ✅ **澄清提问（2026-10-28 完成）**：官方 `AskUserQuestion → canUseTool` 接通，问题持久化/SSE/聊天与运行详情回答/刷新恢复/拒答/停止/超时均已实测；隔离环境最终源码4条真实模型run通过，回答后同run原生交付，MCP副作用仍独立批准。新建默认`default`，显式`dontAsk`保持拒绝。未覆盖多问题/多选真实模型组合、凭证跨流式帧显示；关闭原因在SDK取消路径为通用`closed`。详见 [任务记录](tasks/agent-clarification.md)。
     - 上下文记忆：专家原生 auto-memory、个人偏好（DB 权威 + `_users/<sha256(businessId)>/CLAUDE.md` 只读投影 + `UserPromptSubmit` 每轮注入）、记忆提案（用户触发、确认制）与固定版本公开分享已实现。剩余：真实容器 + 官方 SDK + 本地假模型的子记忆加载与文件工具边界已 16/16 通过，但付费真实模型的跨 run 召回、续聊刷新与应用效果仍未验证/审计；子智能体独立记忆源码评审与最终测试夹具复验均已通过（原生 `memory: project` + 既有 `agent-memory/` 直接挂载，SDK 原生自动加载且与主会话记忆独立；子智能体原生文件工具默认启用但仅限自身记忆 Markdown；stable 25 文件 376 用例、web 72、outputs 31、migration `generate` + `migrate` 隔离库通过，SDK 最新接口 16/16 PASS，浏览器全部 PASS、0 残留；运行整合 13 文件 195/195 PASS，未提交、未合并，见 [任务记录](tasks/subagent-memory-20261030.md)）；有效分享页其它格式的真实文件浏览器验收未完成（图片与 PDF 的 Bearer 下载已在隔离生产浏览器验证）；自动进化未做。
       - **主题经验升级（2026-10-31 验证及独立评审通过，本任务 PR 交付，合并状态以 GitHub 为准）**：已采用官方主题文件 + 短索引、用户触发记忆提案、目标 `name` / 伴随 `index` / 证据 `kind` / 整篇正文写入，以及独立记忆 ZIP 下载；不新增服务、后台 LLM 或派生管线。shared/worker/web 与 API、跨端独立 review 均 PASS，完整浏览器主路径（受控提案的来源归因、双文件对比/采用、索引版本、ZIP 下载与公开回导 3 份正文一致、整次回滚、无需变更）已通过；验证及独立评审通过，不能据此把记忆待办整体勾选或宣称已上线。真实容器 + 官方 SDK + 本地假模型只证明加载与边界，付费真实模型的归纳质量、跨 run 召回与应用效果仍未审计；最终回归数字与证据以任务记录为准。已识别、本阶段未覆盖的 5 项真实缺口：运行时允许嵌套主题文件，但 API/UI 仅支持平铺；SDK 原生直接写入不进入版本账本；专家文件与规则手工编辑缺少旧稿基线保护；父会话的子智能体材料不能回顾到子专家；运行保留期清理会影响记忆提案来源证据。详见 [任务记录](tasks/memory-upgrade.md)、[执行契约](tasks/memory-upgrade-contract.md)、[研究](tasks/memory-upgrade-research.md)。
     - 环境与覆盖缺口：知识库 e2e 仍缺 seed。共享 `agentport/sandbox:dev` 缺 GNU bash 的旧失败已由独立镜像 `agentport/sandbox:redesign-validation-642ddc7d` 解决（原受影响 SDK 用例 10/10 通过、无 skip；最终后端 247 个测试文件、2422 条用例全部通过、0 skip），但旧 `agentport/sandbox:dev` 本身仍缺 bash，本轮未覆盖它。上述验证使用 fake 模型、无付费请求；其它真实付费模型链路仍未验证，不得据此声称已验证。
     - ✅ **附件输入（2026-10-28 完成）**：随消息上传文本/图片/PDF，会话目录持久化并只读挂到 `/mnt/inputs`，主智能体用原生 `Read` 读取；隔离真实模型验证三附件读取、报告哈希一致、历史附件跨轮重读、分支删源后继续读取，跨会话下载404、伪类型/超限400。Office等走知识库；Compose为完整环境，宿主直跑需同一绝对WORKSPACES_DIR与兼容UID。详见 [任务记录](tasks/agent-attachments.md)。
     - 结果自检：现有评估跑批以文本匹配为主，智能体是否按目标核验自身产出尚未审计。
     - 运行中补充指令：运行中目前只能停止，能否向当前 run 追加指令待核对。
   - 验证方式：实现后按改动范围跑测试与类型检查，真实沙盒验收单列，不以单测代替。
   - 导出包已携带两个可移植 TodoWrite env 并保留输出风格，导入不执行外来 env；往返测试通过，未带出沙盒专有运行限制。

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
   - ✅ **子智能体自有 MCP（已接通，2026-10-28 按代码更正）**：`renderSubAgentMd` 写子定义 `mcpServers` 名称引用，worker 以父与启用子级绑定生成 `.mcp.json`（`packages/worker/src/server-bindings.ts`），runner 的 PreToolUse 边界 hook 按子级 server 与技能拒绝越权，`packages/core/test/workspace-input.test.ts` 有渲染断言。限制：子级实际加载仍以真实模型调试验收，真实模型下的子级工具调用尚未验证，不声称已端到端验收。`docs/SUBAGENTS-VERIFICATION.md` 仍是 2026-10-24 的验证快照，其中「平台尚未接通」已过时，本次未改该文。
   - 技能参考文件：已放行主会话 `Read` 只读 `.claude/skills/<slug>/references/**/*.md`（写入仍仅限记忆目录）；此前 Read 只允许记忆目录导致 references 不可读。

## P2

- **桌面首次用户 QA 后续项（2026-10-28）**：会话有消息后缺少当前专家身份、会话标题为首条消息截断、资源导航名称过长、空会话操作禁用提示、停止无输出后仍显示“等待回复”、专家下拉退场残影需实测归因。共享库机器名专家是数据环境因素，不自动改名。首轮与复跑证据见 [QA 任务](tasks/launch-qa-first-run.md)，移动端按用户明确要求排除。

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
