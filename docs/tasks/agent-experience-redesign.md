# 智能体体验重构（使用专家 × 定义专家）

## 目标

用 Impeccable `init → critique → shape → distill` 流程重做 Agentport / PACE 的智能体体验，服务两类业务任务（同一账号，不新增权限角色）：

- **使用专家**：找专家、直接用、对话、取交付物、分享成果、维护个人偏好、发起历史回顾。
- **定义专家**：创建/定义专家，维护专家记忆（自动进化是未实现缺口）。

两类用户共用一条主路径：**找专家 → 直接用或创建 → 沟通 → 交付物预览、下载、分享 → 个人和专家记忆/回顾**。

验收：

1. 两类用户的主路径在真实页面可走通，每一步都有真实后端能力支撑，不以占位或伪造状态冒充。
2. 运维观测从业务主入口剥离，不进入使用/定义专家的主路径。
3. 品牌设计数值、已选技术栈、文件系统定义第一性原则保持不变。
4. 每项能力仍以官方 `.claude` 文件为唯一投影，DB 仍是编辑来源；运行仍只使用 Claude Agent SDK 一个底座。
5. 固定版本公开分享、个人偏好、历史回顾已实现；自动进化仍未实现，不写成已交付。

## 方案

- 流程：Impeccable `init`（复用并更新根 `PRODUCT.md`，不新建第二份产品文档）→ `critique`（对现状做启发式评分）→ `shape`（先定 UX/UI 再写代码）→ `distill`（先减后加，收敛到本质）；`polish`/`harden` 仅按契约进入。
- 编排：设计、审计与契约由 Opus 负责；契约固定后由 Sonnet 并行实现；独立 Opus review；主会话只编排与验证。
- 设计与实现遵守 `ub-mode`：先能用，再正确，再规范；先减法后加法。
- 视觉与栈不换：只用 `docs/DESIGN-SYSTEM.md` 与 `styles.css` 的 `@theme` token；shadcn/ui + Base UI + Tailwind 4；不引入第二套组件、状态或路由库。
- 领域与文件：能力仍落官方 `.claude` 文件（skills / agents / settings / hooks / memory 等），不新增私有定义格式；记忆与回顾必须能被 SDK 真实加载。
- Impeccable 产物：根 `PRODUCT.md` 是产品定义的唯一权威文本；不新建根 `DESIGN.md`，设计权威仍是 `docs/DESIGN-SYSTEM.md`；`.impeccable/` 已被 `.gitignore` 忽略，其 surface brief 与截图属本地工作产物，不入库。
- 证据：以真实浏览器操作与真实运行结果验收；参考其他产品只借布局与结构，设计仍用本项目体系。

### 信息架构契约（2026-10-29，2026-10-30 补充）

- **工作**：找专家 `/agents`（默认入口，`/` 重定向到此）、对话 `/chat`、记忆 `/memory`、定时任务 `/schedules`。
- **构建**：资源 `/skills`（技能 / 连接器 / 插件 / 知识库）、评估 `/eval`。
- **运维**：底部独立入口 `/operations`；进入后使用独立导航——概况（原 `OverviewPage`）、运行、运行环境、健康、审计，并提供「返回工作区」。
- 专家移出资源中心；资源中心只保留技能、连接器、插件、知识库。
- 登录成功回到工作区（`/` 重定向到 `/agents`）；主按钮文案为「登录」/「正在登录…」/「重试」，不使用「进入工作区」/「正在进入」。
- 专家卡：主操作「开始对话」；名称链接进入配置页；停用专家不执行；移除技术计数与 slug。
- 创建：名称、角色、职责与工作方式前置；模型与 slug 收进高级设置；保留导入。
- 专家详情：页签「专家记忆」；移除运行统计页签，改为「查看运行」次级链接。
- 成果进入产生它的对话轮次与右侧成果面板；固定版本分享链接为 `/s/<shareId>#<token>`，token 只在 URL 片段。
- `/memory` 分「个人偏好」与「历史回顾」两个页签；历史回顾可按专家筛选。
- 不再新建艺术卡与独立数字分身卡；数字分身角色完整保留。

### 记忆架构（2026-10-30）

- **专家记忆**：原生 auto-memory，模型在运行中自动写入 `agent-memory/MEMORY.md` 与主题文件，不逐条确认；主会话文件工具受路径 hook 限制，子智能体文件工具仍被拒绝。`MEMORY.md` 是索引，官方启动只加载前 200 行 / 25KB。
- **个人偏好**：`user_preferences` 为权威（`revision` 乐观锁），`memory_changes` 记账；投影到 `WORKSPACES_DIR/_user/CLAUDE.md`（0700/0600、原子 rename），只读挂到 `/mnt/user`，由 `UserPromptSubmit` hook 每轮以 `additionalContext` 注入，上限 9000 字符 / 36 KiB。**不是** SDK 自动发现的用户级 `CLAUDE.md`，`settingSources` 仍为 `['project']`。
- **历史回顾**：用户触发的 `agent_runs.trigger='review'` 运行；`tools: []`、`settingSources: []`、`persistSession: false`、关闭 auto-memory，结构化输出提案；证据必须是会话原文的连续子串；沿用专家预算、超时、取消与 worker 关停；不建沙盒、不追加消息、不写成果。
- **确认制**：提案写入个人偏好、专家 `MEMORY.md` 或专家规则，采用后才落账；不是自动进化。
- **并发与恢复**：采用、拒绝、回滚、手工编辑共用目标级 advisory lock；专家记忆先写 `.memory-journal/` 日志、原子 rename、再提交账本，失败按原字节恢复或保留日志供下次显式恢复。
- **版本与回滚**：`memory_changes` 保存 before/after 完整快照，规则含 `globs`；冲突按完整快照比较。

### 调研决策（2026-10-30）

不引入 Mem0、Zep、Letta、LangMem 等外部记忆服务或第二套执行底座。借鉴 Manus / Fleet 的候选确认、Devin 的来源与索引分离、Letta 的 Git 式版本思想、claude-mem 的索引优先；实现仍用官方 `.claude` 文件与现有 PostgreSQL。只有实测文件检索不足时，才做可重建的检索索引，并先给出基准证据。详见 D-73。

## 基线与范围

- 工作目录 `/Users/xbjt/Documents/myself/agentport`，分支 `redesign-agent-experience`，起始 `HEAD` = `5ccf9d40997b190dc7a18e67a4d18c847f5f105e`，开工时 `git status --porcelain` 为空。
- **流程例外**：默认规则是建 worktree（`docs/DEV-WORKFLOW.md` §2）；本任务 developer 明确要求 in-place，故不建 worktree，产出落当前目录的 `redesign-agent-experience` 分支。例外来源为本轮任务指令，不推广到其他任务。
- 本步为文档同步：允许写 `PRODUCT.md`、`docs/{ARCHITECTURE,DESIGN-SYSTEM,USER-STORIES,PROJECT-BRIEF,DECISIONS-PENDING,REMAINING-TODOS,PITFALLS}.md` 与本记录；源码、配置、脚本变更由实现子代理负责。后续提交与合并按 2026-10-30 授权执行。
- 文档同步期间，其他 worker 已并行修改实现与测试（专家/资源/壳/登录、记忆、回顾、分享、沙盒与 worker 等）；本步不触碰，也不改写其行为。
- 实现文件域（契约固定后由独立 worker 并行，同一文件只能有一个写入者）：
  - **shell / routes / login**：`packages/web/src/components/app-shell.tsx`、`packages/web/src/routes/`（含 `_shell` 路由、`-search.ts` 与生成的 `routeTree.gen.ts`）、`packages/web/src/pages/login.tsx`，以及 `shell-route.test.ts`、`login-route.test.ts`、`login-redirect.test.ts`。
  - **agents / schema / tests**：`packages/web/src/pages/agents.tsx`、`packages/shared/src/agent.ts`；必要时的 `packages/db/src/schema.ts`，以及 `agents-*.test.ts`。
  - **resource-page / tests**：`packages/web/src/components/resource-page.tsx` 与 `resource-*.test.ts`。
  - **memory / review / share**：`packages/api/src/features/{memory,memory-reviews,output-shares}/`、`packages/worker/src/{memory-review.ts,index.ts,session-workspace.ts}`、`packages/sandbox/src/{runner.ts,memory-permissions.ts}`、`packages/web/src/pages/{memory.tsx,memory-panel.tsx}`、`packages/web/src/components/{memory-review,share-dialog}.tsx`、`packages/web/src/routes/s.$shareId.tsx` 及对应测试。
- 不允许：改动品牌数值与设计基准；更换已选技术栈；新增第二套智能体定义格式；把运维观测放回业务主入口。提交、推送与合并按 2026-10-30 授权执行。

## 当前有效决定

- 2026-10-29 用户确认目标与执行方式：使用 Impeccable `init → critique → shape → distill` 落地。
- 业务用户两类：使用专家、定义专家；仍是单账号，不新增角色权限。
- 主路径、导航、专家卡、创建、专家详情、交付物、数字分身按「信息架构契约」执行。
- 运维观测不占业务入口；`/` 重定向到 `/agents`；概况迁入「运维」。
- 保留品牌设计数值（`docs/DESIGN-SYSTEM.md`：PACE 蓝 `#315FAD`；发送/登录实底 `#426FBD` 等）、已选技术栈、功能真实性、文件系统定义第一性原则（`CLAUDE.md` §0）与 Claude Agent SDK 单底座。
- 2026-10-30：固定版本公开分享、个人偏好、历史回顾已实现；自动进化仍未做。历史回顾是用户触发、逐次确认的运行，不冒充自动进化。
- 2026-10-30：不引入外部记忆服务；只有实测文件检索不足才做可重建索引。
- 运行环境 in-place，不建 worktree（例外来源见「基线与范围」）。
- 2026-10-30 用户明确授权「提交并启动」：提交当前分支并合入 `main`，启动动效 10 分钟、能力 30 分钟改进循环；能力任务完成后提交、推送、合并。循环契约见 [platform-improvement-loop.md](platform-improvement-loop.md)。仍不伪造验证或结论。当前功能提交已落 `8696a56` 并整合 main `646217c`，补修提交 `8ba7c90`（当前 HEAD）；两项独立 review 已报告的 mustfix 均已由 Opus 定点复核通过（回顾 pending 导航 reset、成果 runId-null 与 fork tool_result 合并锚点），合入 `main` 尚未执行。
- 2026-10-30 用户最新明确决定（覆盖立即启动）：两个定时任务先不启动，重启电脑后再由用户明确要求启动；当前记为 `paused_until_user_start`。本会话不创建 cron、不自动恢复，循环状态 `enabled:false`、两车道 `phase:'paused_by_user'`、`nextDue:null`，本会话 owner 锁已释放，`CronList` 无 jobs；提交与合并授权不变。

## 已替代项及原因

- 旧导航「工作台 `/` + 使用（对话/运行/定时任务）+ 构建（专家·技能·连接器·插件·知识库/评估）+ 系统（运行环境/健康/审计）」被「工作 / 构建 / 运维」替代。原因：运维观测不占业务主路径，专家提升为业务入口。
- 资源中心五类（含专家）被四类（技能/连接器/插件/知识库）替代，专家迁到「找专家」。原因：专家是使用主线，不是配置资源。
- 专家卡「配置」主操作 + 连接器/技能计数 + slug 被「开始对话」主操作、名称链接配置、移除技术计数与 slug 替代。原因：卡片先服务使用，再服务定义。
- 专家详情「运行统计」页签被「查看运行」次级链接替代。原因：统计不是定义专家的主任务，运行数据回运维。
- 「长期记忆」被「专家记忆」替代。原因：与个人偏好区分。
- 登录按钮「进入工作台」被「登录」/「正在登录…」/「重试」替代，登录成功仍落 `/agents`。原因：登录是提交动作，不是导航；成功后的去向由 `/` 重定向表达。
- 新建艺术卡与独立数字分身卡被取消；数字分身保留为 `AGENT_ROLES` 标准角色。原因：创建入口收敛，角色能力不减。
- 旧表述「公开分享、个人记忆、自动进化是已确认缺口，尚未实现」被「分享、个人偏好、历史回顾已实现，自动进化仍未做」替代。原因：代码、路由、表与 UI 已落地；实现状态与验收状态分开记录。
- 旧表述「个人记忆是另一项缺口」被「个人偏好已实现」替代；个人偏好不是用户级 `CLAUDE.md` 自动发现，而是 DB 权威 + 文件投影 + hook 注入。
- 旧表述「专家记忆可手工维护」被「原生 auto-memory 自动写入、不逐条确认」替代；手工编辑与历史回顾是补充，不是唯一写入方式。
- 根 `PRODUCT.md` 旧表述「管理员/操作员」「内置工具默认禁用，只允许 MCP 工具」被两类业务任务/单账号与工具例外（Bash、受路径限制的原生文件工具、TodoWrite）替代。原因：与当前 `CLAUDE.md`、`docs/ARCHITECTURE.md` §3 与 `packages/sandbox/src/runner.ts` 冲突。
- `docs/PROJECT-BRIEF.md` §1.4 早期「知识库与专家/技能/连接器/插件并列的资源页签」被「资源中心只保留四类，专家独立为业务入口」替代。原因：同上；历史原文保留，不重写。
- `docs/PROJECT-BRIEF.md` §0「共享文件由主会话维护」被「主会话定契约并指定单一写入者，主会话不直接编辑代码」替代。原因：与当前 `CLAUDE.md` 协作方式一致。
- 本记录旧步骤「只允许写五个文档」被扩展为当前八个文档 + 本记录。原因：任务要求同步架构、决策、待办与踩坑，避免实现已变而文档仍写缺口。
- 本记录旧表述「未获 commit / push / merge 授权」被「2026-10-30 用户授权提交并合 `main`、启动改进循环」替代。原因：用户本轮明确授权。

## 步骤

- [x] 读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md` 与相关文档；记录 HEAD 与干净基线。
- [x] 用户确认目标、执行方式与两类用户主路径。
- [x] 按模板创建本任务记录。
- [x] Opus 固定核心信息架构契约（2026-10-29）。
- [x] 按契约同步 `PRODUCT.md`、`docs/DESIGN-SYSTEM.md`、`docs/USER-STORIES.md`、`docs/PROJECT-BRIEF.md`。
- [x] 按文件域并行派发实现（shell/routes/login、agents/schema/tests、resource-page/tests）。
- [x] 分享、个人偏好、历史回顾实现并接入导航与页面。
- [x] 按实现更新 `docs/ARCHITECTURE.md`、`docs/DECISIONS-PENDING.md`、`docs/REMAINING-TODOS.md`、`docs/PITFALLS.md` 与本记录。
- [x] 运行 `git diff --check`（结果见「验证」）。
- [x] 提交当前分支为 `8696a56`，整合 main `646217c`，补修提交 `8ba7c90`（当前 HEAD）。
- [ ] 补齐真实付费模型跨 run 召回、续聊刷新、子智能体记忆与有效分享页真实文件浏览器验收。
- [x] 两项独立 review 的已报告 mustfix 已由 Opus 定点复核通过：回顾 pending 导航 reset；成果 runId-null 与 fork tool_result 合并锚点（87 条定向用例复测）。
- [ ] 合入 `main` 尚未执行（授权不变）；改进循环暂停在 `paused_until_user_start`，待用户重启后明确要求再创建 cron 并启动。

## 改动文件

- `docs/tasks/agent-experience-redesign.md`
- `docs/tasks/platform-improvement-loop.md`
- `PRODUCT.md`
- `docs/ARCHITECTURE.md`
- `docs/DESIGN-SYSTEM.md`
- `docs/USER-STORIES.md`
- `docs/PROJECT-BRIEF.md`
- `docs/DECISIONS-PENDING.md`
- `docs/REMAINING-TODOS.md`
- `docs/PITFALLS.md`
- 实现侧改动较多，不逐一抄 diff；范围见「基线与范围」的实现文件域。

## 已完成与证据（2026-10-30，最终）

以下为本轮最终验证结果；早期中间数字与环境性失败已被最终结果替代，不再作为当前状态。

- **全仓 typecheck**：`pnpm -r typecheck` 完整通过。
- **全仓 build**：`pnpm -r build` 与最终 web build 完整通过。
- **Lint**：focus / contract 检查通过。
- **前端测试**：最终 118 个测试文件、1384 条用例全部通过，38.90s。
- **后端全量（锚点变更后）**：`SANDBOX_IMAGE=agentport/sandbox:redesign-validation-642ddc7d pnpm exec vitest run --project backend` 247 个测试文件、2422 条用例全部通过，0 skip，91.12s。该全量在输出锚点变更后运行；此后只有 web 工具结果字段改动，未再改后端。
- **定向复测**：成果 runId-null 与 fork tool_result 合并锚点 87 条用例复测通过；回顾 pending 导航 reset 定向复核通过。
- **补修事实**：成果 manifest 条目补 `userMessageId`/`afterMessageId` 锚点，清理或分支清空消息 `run_id` 后仍把成果挂回正确轮次（`packages/shared/src/outputs.ts`、`packages/core/src/outputs.ts`、`packages/web/src/pages/chat.tsx`，`chat-outputs.test.ts` 覆盖）；聊天历史合并 `tool_result` 时保留结果消息 `resultMessageId`，成果按该锚点回落；成果查询与旧分页逻辑未扩大。回顾提交成功先 reset 最新 blocker 再关闭，避免地址栏与路由不一致（`packages/web/src/components/memory-review.tsx`，browser history 测试覆盖）。
- **独立 sandbox 镜像**：`agentport/sandbox:redesign-validation-642ddc7d` 内 GNU bash 5.3.9、Claude Agent SDK 0.3.311，使用 fake 模型，无付费请求；真实 SDK 套件在该镜像上实际执行通过。共享开发镜像 `agentport/sandbox:dev` 仍缺 GNU bash，但本轮验收未使用它，真实 SDK 覆盖已由独立镜像解决，不再列为阻塞。
- **迁移**：本轮验证全部在 backend globalSetup 的随机隔离库完成，迁移隔离真实通过。
- **e2e**：regression + auth 共 10 条通过。
- **真实浏览器**：1512 / 1280 / 1440 三个宽度无横向溢出；记忆保存、版本、回滚可用；无效分享页显示正确；专家卡与搜索空态可用。
- **Impeccable detector**：0 findings。
- **Review**：两项独立 review 已报告的 mustfix 均已由 Opus 定点复核通过——回顾 pending 导航 reset；成果在 `run_id` 清空后按 manifest 锚点与 fork 合并后的 `tool_result` 结果消息 id 回挂（87 条定向用例复测）。未宣称整项验收全量通过；合入 `main` 尚未执行。
- **文档冲突修正**：`PRODUCT.md`、`docs/ARCHITECTURE.md`、`docs/USER-STORIES.md`、`docs/PROJECT-BRIEF.md` 中「个人记忆/公开分享未实现」已改为已实现，验收状态另列；`docs/ARCHITECTURE.md` 补个人偏好注入、回顾运行、锁/日志/快照与分享契约；`docs/DESIGN-SYSTEM.md` 导航补「记忆」并补记忆页/分享页规格；`docs/DECISIONS-PENDING.md` 补 D-70～D-73；`docs/REMAINING-TODOS.md` 更新能力状态与缺口；`docs/PITFALLS.md` 补本轮八条。

## 未完成与已知限制

- 真实付费模型跨 run 召回与续聊刷新尚未验收（测试均使用 fake 模型）。
- 子智能体独立记忆未实现。
- 有效分享页的真实文件浏览器验收未完成（仅完成无效分享页与路由/服务/UI 测试）。
- 真实付费模型生成回顾提案并采纳的完整浏览器链路未验收；回顾 pending 成功态与聊天锚点补修已完成并通过 Opus 定向复核，但整项验收未全量宣称通过。
- 合入 `main` 尚未执行；不把 `8696a56` / `8ba7c90` 或当前分支写成已合入。
- 共享开发库旧迁移历史未重置；本轮验证均在隔离测试库完成。
- 改进循环暂停：用户 2026-10-30 决定重启电脑后再手动启动（`paused_until_user_start`）；本会话不创建 cron、不自动恢复。
- 知识库 e2e 缺 seed。
- 共享开发镜像 `agentport/sandbox:dev` 仍缺 GNU bash；本轮真实 SDK 验收已改用独立镜像，不构成阻塞。
- 自动进化未做；历史回顾是用户触发、确认制，不是自动进化。

## 下一步

- 补真实付费模型跨 run 召回、续聊刷新、子智能体记忆与有效分享页真实文件浏览器验收。
- 补真实付费模型回顾提案 → 采纳 → 版本/回滚的端到端浏览器验收。
- 补知识库 e2e seed 后重跑知识库套件。
- 已报告 review mustfix 已定点通过；合入 `main` 尚未执行（授权不变）；改进循环暂停在 `paused_until_user_start`，用户重启后明确要求再启动（cron 尚未创建）。
- 自动进化仍为已确认缺口，需用户确认方案后再进入范围。
- 循环契约见 [platform-improvement-loop.md](platform-improvement-loop.md)。

## 验证

- 本步为文档同步：未改源码、配置或脚本；不宣称主任务实现验收全部完成。
- `git diff --check`：通过（exit 0，无空白错误）。
- 上述测试、build、浏览器、detector 与 review 结果来自本轮最终验证；未通过或未覆盖项（真实付费模型、有效分享浏览器、合入 `main`）保持原状态，不写成通过。已报告的 review mustfix 已定点通过，不据此宣称整项验收完成。
- 文档事实核对来源：`packages/api/src/features/{memory,memory-reviews,output-shares}/`、`packages/worker/src/{memory-review.ts,index.ts,session-workspace.ts}`、`packages/sandbox/src/{runner.ts,memory-permissions.ts}`、`packages/shared/src/outputs.ts`、`packages/core/src/outputs.ts`、`packages/db/src/schema.ts`、`packages/web/src/components/app-shell.tsx`、`packages/web/src/pages/{memory.tsx,memory-panel.tsx,agents.tsx,chat.tsx}`、`packages/web/src/components/{memory-review,share-dialog}.tsx`、`packages/web/src/routes/s.$shareId.tsx`。
