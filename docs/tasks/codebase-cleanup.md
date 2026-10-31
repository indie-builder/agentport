# 全项目代码清理（codebase-cleanup）

## 目标

清理整个仓库的冗余与废弃代码、导出、样式和依赖，降低阅读与维护成本；**不改变 UI 视觉、不改变业务功能**。验收标准：

- 每个删除/合并候选都有全仓检索证据（含动态入口、字符串引用、根测试/fixtures/配置）。
- 每个改动范围都有可执行的最低验证命令与真实输出。
- 清理完成后按 Codebase Design 评估模块边界，再经独立 Opus 终审。
- 主 checkout 保持干净，产出只在 worktree。

## 方案

三阶段推进，各阶段独立验收，均已登记为 LoopX todo：

1. **全仓审计 + 清理**（`todo_2ce3bf6ca7282ba0e2fdc176`）：按包分区并行审计——web 前端、api、worker、core、db、shared、sandbox 七个包与根目录（脚本/测试/配置/依赖）。只采纳有全仓检索证据的高信心候选；删除 → 合并 → 复用，每批跑对应 typecheck/build/test。
2. **Codebase Design 审视 + 收益重构**（`todo_4ddb7f0adec138e5c6e5f0e4`）：检查模块深度、Seam 与调用方重复承担的事实，只做有可证明收益的重构。
3. **验证 + 独立 Opus 终审**（`todo_59a82d7964983336736bb15b`）：按固定 diff 与验证证据独立判断，未过不交付。

## 基线与范围

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-cleanup`
- 起点：`origin/main` @ `7b5f0b271ba7a4d90bb8a7546d6262565eaa4f3a`，初始 `git status` 干净；已安装 frozen 依赖（`pnpm install --frozen-lockfile` 退出 0）。
- 范围：**全仓七个包（web/api/worker/core/db/shared/sandbox）与根目录**，不是单个包的子任务。
- 阶段 1 审计与清理已完成；阶段 2 设计已由 Opus 返回并固定为 3 个批次，已派三个 Sonnet high 按不重叠边界实施，源码由各包代理按文件边界写入，主会话不直接编辑代码文件。
- 不修改视觉/布局/令牌，不压缩或改写数据库迁移，不删除业务能力，不触碰其他任务 worktree。（原「未授权不 commit/push/merge」已被本轮授权替代，见「当前有效决定」。）

## 当前有效决定

- 用户已授权全项目代码清理，由 LoopX 执行（goal `codebase-cleanup` / agent `cleanup-controller`）。
- 清理优先「删除」而非「新增抽象」；不新增依赖、不新增门禁。
- 删除必须全仓 `rg` 核实调用方，不能凭文件短、单 Adapter 或名称判断死代码；路由生成文件、shadcn 官方组合导出、外部公共入口保持谨慎。
- 各包实施代理拥有其源码文件；主会话只负责记录、派发、复核与验证。
- **实际生产 MCP 现状**：worker 侧用 `previewMcpEntry`；API 预览与专家包导出仍各自组装脱敏。三者尚未统一，任何记录不得宣称已统一。
- 记忆限额/路径、worker 附件目录复用、挂载路径、API 重复 redact、`hasOpenUiSegment`/`recentUtcDays` 仅测试使用、MCP 不同语义均已由阶段 2 设计裁决，三批已实施并验证，见「阶段 2 设计决定与实施」。独立 Opus 终审已通过（`a7a3a7b4e73c0ebfa`）：全部 80 tracked 差异及 3 个未跟踪新文件已审，无阻塞正确性/安全/功能回归；唯一非阻塞修正已落到 `docs/tasks/knowledge-multimodal-contract.md`。代码交付完成；当时未 commit/push/merge、未合入，该状态已由本轮授权替代，见下条。
- **本轮 Git 授权（2026-10-31）**：允许本任务 commit / push / create PR / merge；合并确认、工作区干净且无其他会话占用后，退出并删除本 worktree，主 checkout 快进 main，本地与远程分支保留。合并完成前不写成已合入。

## 已替代项及原因

- **旧范围描述（已废弃）**：本文件此前把整个任务写成「本轮只做 `packages/web` 的只读审计」，并把允许改动文件限定为仅本记录。该描述把 web 子任务范围误当成整体范围，导致后端与根目录工作没有登记、实施阶段被误标为只读。现更正为：全仓七包 + 根目录，当前为实施阶段；web 审计只是已完成的一个子项。
- **旧验证表述（已废弃）**：「尚未进入代码改动阶段」不再成立；当前已有实际代码改动，验证证据按下文如实记录，未完成项不写成通过。

## 步骤

- [x] 建树并记录基线：`7b5f0b2...`，初始干净，frozen 依赖已安装。
- [x] 全仓审计：七包与根目录并行只读扫描，输出带调用方证据的高信心候选。
- [x] 清理 core：删除旧 `toMcpJsonEntry` 与无用 exports，同步 `docs/ARCHITECTURE.md`、`docs/IMPL-CONTRACTS.md`、`docs/tasks/knowledge-implementation-contract.md`（这三份由 core 代理写入，本记录不重复修改）。
- [x] 清理 API/DB：约 180 行废弃函数删除，调用方同步调整。
- [x] 清理 shared/worker/sandbox：完成，相关 21 文件 204 项测试通过。
- [x] 清理 web：无引用 helpers/UI 子组件删除，`@codemirror/autocomplete` 直接声明删除（保留传递依赖）。
- [x] 阶段 1 验证：install、全仓 typecheck、build、测试、lint 与 OpenUI 审计均按范围执行。
- [ ] 阶段 1 LoopX 状态：第一、二轮 refresh-state 与 quota 结算均已 settled（首轮 classification `cleanup_validated`，turn `cleanup-20261031T102400-session01a18a73`）；最终记录待主会话写入。todo complete 被工作树宿主守卫拒绝，三个 todo（`todo_2ce3bf6ca7282ba0e2fdc176`、`todo_4ddb7f0adec138e5c6e5f0e4`、`todo_59a82d7964983336736bb15b`）可能仍为 open，保持原状、未绕过；Todo open 不等于代码未完成。
- [x] 阶段 2 Opus 设计审视：返回 3 个固定批次与拒绝/保留清单，见「阶段 2 设计决定」。
- [x] 阶段 2 独立准入：新 turn `cleanup-design-20261031T104400` 绑定 `todo_4ddb7f0adec138e5c6e5f0e4`；第二 todo 可保留到终审。
- [x] 阶段 2 实施：三个 Sonnet high 代理按不重叠边界完成，三批验证见「阶段 2 实施与验证」。
- [x] 阶段 3 全范围验证 + 独立 Opus 终审：终审 `todo_59a82d7964983336736bb15b` 已通过（`a7a3a7b4e73c0ebfa`），全部 80 tracked 差异及 3 个未跟踪新文件已审，无阻塞正确性/安全/功能回归；唯一非阻塞修正（`knowledge-multimodal-contract.md` 工具清单）已记录。代码交付完成，未调用完成标记。

## 审计与清理结论（阶段 1 完成）

- **七包 + 根目录审计完成**；清理完成范围：core、API、DB、shared、worker、sandbox、web。
- **已删除**：worker/redact 转发（`packages/worker/src/redact.ts`）、sandbox 别名、死 schema 类型、API/db 废弃函数、web 无引用 helpers/UI 子组件、core 旧 MCP 函数；web 删除 `@codemirror/autocomplete` 直接声明但保留传递依赖。
- **阶段 1 保留候选（阶段 2 已裁决）**：personal-memory 限额/路径、worker 附件目录复用、API 重复 redact、`hasOpenUiSegment`/`recentUtcDays` 由阶段 2 实施；挂载路径公共化、MCP 不同语义、`shadow-composer` 等视觉 token 保留，理由见「阶段 2 设计决定」。
- **web 可达性**：`packages/web/src` 从 `src/main.tsx` 出发全部可达，没有整文件死代码；路由生成文件、官方组合导出、冻结视觉令牌按审计记录保留。
- **MCP 不得虚报统一**：API 预览与专家包导出仍各自组装脱敏，未复用同一入口。
- **OpenUI 审计缺口为既存登记**：`openui:audit` 84 组件中 missing 2（IconButton / MetricIndicatorWithStrikethrough），不虚报完整。

## 阶段 2 设计决定与实施（2026-10-31，三批已完成）

三个批次按不重叠文件边界由 Sonnet high 实施，均已完成；本节记录固定决定，验证证据见「阶段 2 实施与验证」：

1. **shared 记忆限额 + core 个人记忆投影**
   - shared 统一记忆限额：9000 字符 / 36 KiB / `CLAUDE.md`。
   - core 新增 personal-memory 集中目录：按 `sha256(businessId)` 建目录，并提供安全原子投影。
   - API/worker 保留既有 DB 锁与失败策略：API 投影失败仅 warn，请求仍成功；worker 投影失败中止。
   - sandbox/web 复用同一限额，不各自复制常量。
2. **API 脱敏复用**
   - 试删 API 私有脱敏实现，直接使用 shared。
   - 真实约 7 MB 输入的错误行为先红后绿，不先改实现再补测试。
3. **worker 附件与 OpenUI 复用 + web data-table 兼容**
   - worker 附件目录复用 core `conversationInputsDir`，OpenUI 判定复用 `hasOpenUiSegment`。
   - web data-table 只接受当前 `{hidden, order}` 格式；旧数组格式回默认值，不新增迁移分支。

**派发边界**：memory 代理独占 session-workspace 与 `ARCHITECTURE`/core `CLAUDE.md`；另外两组文件互不相交；任何组未完成前不得写成已实施。

**拒绝/保留（不新增代码）**：

- MCP runtime / preview / export 三者凭证语义不同，保留现状，不强行统一。
- 挂载字符串做公共化收益不足，保留。
- `isPgCode`、小 `hasCode`、`transaction` 不足以为短抽象，保留现有写法。
- `recentUtcDays` 的测试 oracle 保留。
- `shadow-composer` 等视觉 token 按 `DESIGN-SYSTEM` 规范保留，即使当前实现未消费。
- `skills` 的 `canInstall` 已传入但未消费，属安装按钮 UX 缺口；API 仍强制权限，无安全漏洞；本任务不扩功能。

## 阶段 2 实施与验证

三批均按固定边界落地，调用方策略保持：

1. **memory**：shared 统一限额、core 新增 `packages/core/src/personal-memory.ts` 集中投影（sha256 目录、原子写）；API 失败仅 warn、worker 失败中止的既有策略不变。测试先红（缺模块）后绿：7 文件 145 项通过。
2. **API 脱敏**：真实约 7 MB 输入先红（旧实现 `RangeError`），改用 shared 后 6 项测试全绿。
3. **worker/OpenUI/web**：worker 附件目录复用 `conversationInputsDir`，OpenUI 判定复用 `hasOpenUiSegment`；data-table 旧数组格式先红，改为回默认值后已包含在全量 web 测试中通过。

真实验证证据（阶段 2 完成后最终一轮，历史阶段证据保留但不累加成总数）：

- 最终 `pnpm typecheck` 退出 0。
- 全仓 `pnpm build` 退出 0；Vite 保留 >500k chunk warning。
- `pnpm test:web`：132 文件 1595 项全通过，无 skip。
- backend 最终 11 文件 187 项全过，无 skip。
- `lint:focus` / `lint:contract` 通过。
- 上列批次红灯证据：memory 缺模块红、API 7 MB `RangeError` 红、data-table 旧数组 case 红，均先于实现出现。
- 独立 Opus 终审（`a7a3a7b4e73c0ebfa`）通过：按固定 diff、契约与上述验证证据判断，扩读关联代码后未发现阻塞正确性、安全或功能回归。
- 未跑真实浏览器/SDK/Docker 端到端；`openui:audit` 仍为 84 组件 missing 2（`IconButton` / `MetricIndicatorWithStrikethrough`），属既存缺口，未在本任务修复。

## 文档冲突与历史标注

- **已修（旧 MCP 函数/常量）**：core 删除旧 `toMcpJsonEntry`；API 删除 `KNOWLEDGE_TOOL_NAMES` 集中常量，工具改为 `packages/api/src/features/knowledge/mcp.ts` 逐个 `registerTool` 注册。`docs/tasks/knowledge-multimodal-contract.md` 已改为常驻 `knowledge_search` / `knowledge_list` / `knowledge_read`，仅图片处理启用时注册 `knowledge_read_image`（对应代码第 70、101、144 行与第 185 行条件分支），并保留“历史写法”标注。
- **已修（废弃 DB/常量）**：删除 `packages/db/src/identity.ts` 死入口及 `packages/db/src/index.ts` 的导出；相关旧函数/类型与文档已同步，当前文档不再把这些入口写成可用。
- **已修（core 新增 I/O）**：`packages/core/src/personal-memory.ts` 新增 sha256 目录与原子投影 I/O，core 规则/架构文档已同步，个人记忆不再由 API/worker 各自实现。
- **已修（API 重复脱敏 shortcut）**：删除 `servers/test-connection.ts` 内私有 `redactSecrets` 及其“两份实现需同步”shortcut 注释，统一改用 `@agentport/shared`；`packages/worker/src/redact.ts` 转发层同时删除，worker 直接引用 shared。
- **已修（旧 servers 409 注释）**：删除 `servers.test.ts` 里“23505 实际返回 500”的已知缺陷注释；路由现按 cause 链映射 409，测试仍断言 409。
- **按历史标注，不翻修**：旧任务 `agent-experience-redesign` 仍写 `_user` 历史路径、`memory-upgrade-research` 的旧行号不是当前运行事实；保留原样并视为历史记录，避免把所有旧记录重写。
- **保留并登记 D77**：`skills.tsx` 的 `canInstall` 已传入但未消费，属安装按钮 UX 缺口（API 仍强制 `market.install`，无安全漏洞）；`--shadow-composer` 有定义/规范但当前组件未消费，按视觉规范保留。两者都不在本任务扩功能或删 token，见 `docs/DECISIONS-PENDING.md` D-77。

## 当前差异规模

按收尾时点（`.vitest/json/output.json` 已恢复 HEAD 后）：

- tracked：80 files changed, 140 insertions(+), 789 deletions(-)。
- untracked 新文件共 3 个、383 行：`packages/core/src/personal-memory.ts`（75 行）、`packages/core/test/personal-memory.test.ts`（143 行）、本记录 `docs/tasks/codebase-cleanup.md`（165 行）。
- 删除文件：`packages/db/src/identity.ts`、`packages/worker/src/redact.ts`。
- `.loopx/cleanup-final-vision.json`（27 行）是本轮 LoopX 终态记录，被 `.git/info/exclude` 忽略，不计入产品差异。
- `.vitest/json/output.json` 为临时报告（187 项全过），已恢复到 HEAD，不计入产品差异。
- 统计为当前快照；阶段 1 历史数字（62 files / +36 / -574）不再作为最终规模。

## 改动文件

- 本记录：`docs/tasks/codebase-cleanup.md`
- LoopX 阶段回写：`.loopx/cleanup-stage1-vision.json`、`.loopx/cleanup-stage2-vision.json`
- 源码由各包实施代理按边界写入（web/api/worker/core/db/shared/sandbox），不在此逐文件罗列；冲突时以代理实际 diff 为准。
- core 文档同步由 core 代理负责：`docs/ARCHITECTURE.md`、`docs/IMPL-CONTRACTS.md`、`docs/tasks/knowledge-implementation-contract.md`。
- 新增源码/测试：`packages/core/src/personal-memory.ts`、`packages/core/test/personal-memory.test.ts`。

## 下一步

- 阶段 2 三批与阶段 3 独立 Opus 终审均已完成并通过；全部目标代码交付完成。
- **本轮已获授权**：commit / push / create PR / merge。代码自终审后无新变化，沿用既有 typecheck、build、web 1595、backend 187 真实通过证据，不重跑。
- 合并确认 + 工作区干净 + 无其他会话占用后：退出并删除本 worktree，主 checkout 快进 main；本地与远程分支保留。
- 历史「未授权、未提交差异」记录已被本轮授权替代；合并未发生前不写成已合入。

## 验证

最终真实证据（阶段 2 完成后；历史阶段证据保留但不累加测试数）：

- `pnpm typecheck` 退出 0。
- 全仓 `pnpm build` 退出 0；Vite 保留 >500k chunk warning。
- `pnpm test:web`：132 文件 1595 项全通过，无 skip。
- backend 最终 11 文件 187 项全过，无 skip。
- `lint:focus` / `lint:contract` 通过。
- memory 先红（缺模块）后 7 文件 145 项绿；API 试连 7 MB 旧实现 `RangeError` 先红，后 6 项绿；data-table 旧数组 case 先红，修复后包含在全量 web 绿中。
- 以下为阶段 1 历史证据，保留但不再作为阶段 2 结论：install frozen 通过；shared/core/db build；后端 10 文件 172 项与 21 文件 204 项；`openui:audit` 84 组件 missing 2（既存缺口）；biome 既有 warning 属 HEAD 存量。
- 各实施代理 `git diff --check` 退出 0。
- 独立 Opus 终审 `a7a3a7b4e73c0ebfa` 通过，无阻塞正确性/安全/功能回归。

限制与未完成项（不虚报）：

- 未跑真实浏览器/SDK/Docker 端到端；`openui:audit` missing 2 为既存缺口。
- 阶段 1/2/3 三个 LoopX todo 可能仍 open（complete 被工作树宿主守卫拒绝）；Todo open 不等于代码未完成，未绕过守卫。第一、二轮 refresh+quota 已 settled，最终记录待主会话。
- 历史记录：当时未提交、未合入；该状态已被本轮 Git 授权替代。
