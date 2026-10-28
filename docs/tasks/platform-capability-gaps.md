# 智能体平台能力匹配与持续补齐

## 目标

以使用智能体完成工作的完整用户故事为单位，沿目标、上下文、执行、必要确认、产出查看和反馈修改查找真实断点。参考产品只取智能体相关行为，结合本仓库实际调用链核对；按现有技术栈完成缺口实现、验证、独立评审、PR 与合并。用户于 2026-10-28 明确授权每 30 分钟持续推进完整流程；产出查看明确保留，云服务功能排除。

## 方案

先由 Opus 核对现有能力并提出设计，与 Sonnet 外部官方资料调研并行；主会话固定实现契约后，将互不冲突的代码与测试任务分配给 Sonnet。实现后由独立 Opus 评审，按范围验证，通过后提交 PR 并合并。不新增第二套执行底座，不为追齐竞品而增加无实际用途的能力。

## 基线与范围

- 主 checkout：`/Users/xbjt/Documents/myself/agentport`。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/platform-capability-gaps`。
- 分支：`worktree-platform-capability-gaps`。
- 起点：`23026430cbe775b8325cdca034a04a89a1f056b9`，已 fetch 并确认等于 `origin/main`。
- 初始工作区干净，无他人差异。
- 当前范围：首轮原生任务清单可视进度；shared/core 配置契约、sandbox/worker 转发持久化、web 实时历史展示，三条文件域独立执行。无数据库 schema 变更。

### 首轮固定契约

- `packages/shared/src/chat.ts` 导出 `progressTodoSchema`、`ProgressTodo`，形状 `{ content: string, activeForm: string, status: 'pending' | 'in_progress' | 'completed' }`。
- 既有 `tool_result` 事件添加可选 `todos: ProgressTodo[]`；省略表示无变更，空数组表示清空，每次完整替换。
- 原生 `TodoWrite` 由官方 env 启用（`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`、`CLAUDE_CODE_ENABLE_TASKS=0`），复用 `SANDBOX_RUNTIME_ENV` 和 `.claude/settings.json.env`。尊重显式 disallowedTools。
- runner 关联顶层调用 ID，仅成功 TodoWrite 的有效 `tool_use_result.newTodos` 产生快照；不解析自然语言、不采用失败输入、不让子智能体覆盖主清单。
- worker 将快照随原有 tool_result 内容落库，并对用户可见字符串按现有方式脱敏。
- web 工具项保留 `todos`，每用户轮次只显示最后确认快照；实时、历史、重连复用相同数据。停止/失败/成功都不擅自改清单状态。
- 不新增任务表、endpoint、队列或执行循环；保留现有工具详情与状态行。
- Opus 首轮评审新增范围：真实导出包必须携带两个可移植 TodoWrite env（不混入沙盒专有运行限制），由独立执行者修改 `packages/api/src/features/agent-package.ts` 及其导出/导入测试。
- 清单完整 JSON UTF-8 字节超过现有 `maxFieldBytes` 时不发送 `todos`，保留原工具详情和上一确认清单、记录明确 stderr 原因，不发送删减后冒充完整的快照。
- A 单写 shared/core 与其测试；B 单写 sandbox/worker 与其测试；C 单写 web 与其测试。主会话单写任务记录，架构/设计文档待实现后交单一代理更新。

## 当前有效决定

- 用户已授权识别缺口、查最佳实践、落地、验证、提交 PR 与合并。
- 每 30 分钟执行，最新任务 ID `9512675a`；会话内有效，7 天自动到期。此前任务均已取消以防重复。此前任务均已取消以防重复。
- 用户最终明确核对方法：**从使用智能体的完整用户故事识别缺口**。逐条核对目标提出→上下文提供→执行→澄清/确认→产出查看→反馈修改，给出实际断点与验收证据，不以功能目录或竞品服务清单代替故事。
- 用户最新明确：**以智能体本身应具备的能力为核心，排除参考产品的云服务概念和能力；同时明确保留产出查看。** 不把云盘、项目空间、多端协同、分享发布、云服务调度列为本任务缺口。
- 产出查看属于用户明确要求：智能体生成的文件或内容应能在当前任务中找到、打开预览，必要时下载；复用既有成果面板，补足生成→保留→查看的必要链路，不扩展为云盘服务。先完成在途 TodoWrite 修复验收收尾，再设计实现该能力。
- Harness／办公智能体仅作为智能体能力的参照：指令行为、上下文与记忆、技能工具、规划执行、子智能体、权限确认、结果自检及文件读写等原生执行能力。Work Party 身份未核实，不自行等同于其他产品。
- 当前 TodoWrite 属于智能体规划执行能力，继续完成在途修复、验证与评审；不以此代替完整的智能体能力核对。
- 官方 `.claude` 文件系统为智能体定义；复用 Claude Agent SDK 与既有栈。
- 主会话只编排、读代码、审查、验证与提交，代码由子代理修改。
- 遵循 `ub-mode`；能写行为测试则先红后绿。CI 不自动触发、不自动监控。
- 待办唯一来源为 `docs/REMAINING-TODOS.md`，本记录只保留本轮证据和进度。

## 已替代项及原因

- 最初包含 Dify / LangGraph 等搭建平台的广泛对标已被用户补充取代，改以办公 Harness 的真实工作体验为主。原两条调研已停止，按新基准重新并行派发。
- 旧循环提示已替换，后续轮次沿用最新对标方向。
- 用户后续纠正后，以完整智能体用户故事为核对单位；平台云服务矩阵已撤下。产出查看是用户明确保留的交付环节，不随云服务排除。

## 评审与修复

- 首轮后端 Opus 不通过：导出包未带 TodoWrite env、快照绕过字段字节上限。分别派给 Sonnet 修复并补测试；字节限制修复已返回，新增2条测试，sandbox全域83/83通过（执行者报告，待主会话复验）。
- 首轮前端 Opus 不通过：工具结果反序返回或补历史页时，清单按工具开始位置选错；步骤/计数使用字号不合规范。Sonnet 已修确认顺序与字号令牌，并补反序/分页用例；Opus 复核通过。
- 后端导出与字节限制修复均已获 Opus 复核通过。文档复核仅要求纠正结果查看的旧排除句，已按用户最新决定修正。
- 后续仅复核修复及新增范围，不重复重扫已通过部分。

## 步骤

- [x] 阅读流程与踩坑记录，创建循环与隔离环境。
- [x] 并行核对现有能力与外部最佳实践。
- [x] 固定首轮缺口、文件边界与验收方式。
- [x] 子代理实现、行为验证与整理（A shared/core，B sandbox/worker，C web 并行；评审修复分别完成）。
- [x] Opus 独立评审并处理发现（前后端修复复核通过，文档旧方向句已纠正）。
- [x] 按范围验证、更新文档，经 PR #96 合并；提交 `cb16868`，main 合并提交 `cd95b19`。
- [x] 已清理独立验收资源与干净 worktree（2026-10-28 交付后完成，下轮核对记录）。

## 改动文件

- `docs/tasks/platform-capability-gaps.md`：任务基线与进度。

## 智能体能力核对（2026-10-28）

以用户最新边界重新核对，只判断智能体本身的能力及官方文件/SDK接入，原先平台产品矩阵已撤下。下列是核对维度，不将待核对项冒充确定缺失；Opus 正按此范围复核已有实现。

| 智能体能力 | 需要核对的行为 | 当前证据范围 |
| --- | --- | --- |
| 指令与行为 | 身份、目标、规则、输出风格、模型与推理配置 | 已有配置与文件渲染，需汇总加载证据 |
| 上下文与记忆 | 会话上下文、长期记忆、规则与资料读取 | 已有resume/fork、原生记忆及规则，核对能力边界 |
| 技能与工具 | 技能发现/资源读取、MCP工具选择调用、执行结果处理 | 已有技能/MCP链路，核对原生能力遗漏 |
| 规划与执行 | 拆解任务、维护步骤状态、执行与纠错 | 本轮补齐原生TodoWrite及进度投影，正在修评审问题 |
| 子智能体协作 | 委派、能力绑定、权限边界、结果汇总 | 已有单层委派与子级绑定，真实加载验收范围待列明 |
| 权限与人工交互 | 需要时澄清、请求确认、批准/拒绝及停止 | 已有工具审批与停止，原生追问接入待核对 |
| 输入与输出执行 | 智能体实际读取、修改、计算和生成内容的工具能力 | 按工具与沙盒权限核对，不用聊天附件/云盘/产物下载服务代替判断 |
| 自检与反馈修正 | 按目标检查输出、识别失败、依据反馈继续修正 | 核对技能/提示与工具证据，不把平台评估跑批等同智能体自检 |

### 首轮官方依据

- https://code.claude.com/docs/en/agent-sdk/todo-tracking （2026-10-28 实际读取）：新模型可能默认不提供任务工具；允许显式 opt-in，`CLAUDE_CODE_ENABLE_TASKS=0` 选择 `TodoWrite`。业务清单工具与后台 `task_progress` 消息不同。
- 本地 SDK `0.3.311` 的 `sdk.d.ts`、`sdk-tools.d.ts`：user 消息 `tool_use_result` 提供工具结构化结果，`TodoWriteOutput.newTodos` 提供已确认的完整列表。
- 清单仅是模型报告的进度，不是运行成功或成果质量的替代判据。

### 外部产品依据

2026-10-28 调研，未在竞品中执行真实付费任务。`Work Party` 未找到可确认的官方产品身份；WorkBuddy 是独立查证的参照，不能写成用户已确认二者相同。

| 官方来源 | 查证到的实践 | 本项目采用范围 |
| --- | --- | --- |
| [WorkBuddy 任务对话](https://www.workbuddy.cn/docs/workbuddy/Conversation) | 执行步骤/阶段说明、中间结果；追加消息排队，当前轮结束后处理 | 首轮采用可见业务步骤，后续考虑消息队列；不宣称百分比/剩余时间 |
| [WorkBuddy 结果查看](https://www.workbuddy.cn/docs/workbuddy/Results) | 产物查看与交付 | 保留当前任务产出查看、预览与必要下载；只排除云盘、分享发布等服务扩展 |
| [千问办公基本链路](https://docs.qwenwork.cn/getting-started/basic-workflow) | 关注状态和步骤，检查目标/格式/事实/文件可用性 | 只参考智能体执行与自检行为，不建设验收管理平台 |
| [千问办公个人网盘](https://docs.qwenwork.cn/web/personal-drive) | 网盘服务 | 按用户最新要求排除 |
| [豆包工作任务模式](https://www.doubao.com/work/docs/zh-cn/articles/047323472965) | 调研代理报告有步骤与中间结果说明；主会话直接读取仅返回标题 | 证据局限保留，具体交互在实际访问后才能照搬 |
| [Claude Agent SDK 任务跟踪](https://code.claude.com/docs/en/agent-sdk/todo-tracking) | 原生工具活动及结构化成功结果 | 本轮实现依据；不复制竞品执行内核 |

主会话已独立读取 WorkBuddy Conversation 与千问 basic-workflow 正文核实上述事实；其他来源的产品实操和稳定性未验。

### 本轮发现的文档冲突

- `docs/ARCHITECTURE.md` §6.8 原称仅标题 OCR 修复“尚未合入 main”，实际基线已由 PR #95 合入；现已修正，保留真实 embedding/企业来源未验限制。
- `docs/REMAINING-TODOS.md` 原称子智能体自有MCP未接通，与当前渲染/绑定/边界hook实现冲突，已更正；真实子级调用仍待验收，未扩大声明。
- `docs/USER-STORIES.md` US-2.4 原称所有内置文件工具默认关闭，与记忆/技能参考目录例外冲突，已按代码修正。

## 真实验收（首轮）

- 隔离运行根目录为本 worktree，基线 `2302643` + 未提交实现；配置只读主 checkout `.env`；URL `http://127.0.0.1:55577`。
- 独立库 `todo_progress_053cdfdffd4e40d8`、独立 Redis `backend_test_redis_9582eb8a86a5440f`、沙盒镜像 `agentport/sandbox:todo-progress-20261028`，未替换共享服务。
- `.tmp/platform-capability-gaps/verify.ts` 真实模型验收 exit 0，14/14：4 次 TodoWrite 成功快照、3项状态逐步推进、SSE succeeded、历史最后快照与实时一致；真实 outputTokens=893、costUsd=0.0365。
- 浏览器通过真实登录 POST 进入该会话，历史显示1份清单、3项已完成，单一h1。首次步骤12px，后续按review修复并重新构建复验，最终值见下。
- 浏览器登录后默认到工作台 `/`；最初误等 `/chat` 超时，随后读取实际页面确认登录成功，未绕过认证。
- 浏览器最终刷新：1份清单、3项已完成，步骤 `15px/26px`，单一h1，页面无横向溢出；截图 `/tmp/agent-todo-progress.png` 已读取确认。
- 已完成资源清理：cleanup exit 0，临时API/worker、沙盒、精确Redis容器、隔离库与临时工作区删除；`docker ps` 仅余原有4个开发容器正常运行。
- 后端和前端独立review修复复核均通过；文档阻断旧句已按明确要求纠正。

### 修复后最终验证

- `pnpm exec vitest run --project backend packages/sandbox/test packages/worker/test/message-persistence.test.ts --reporter=default`：13文件、103/103 passed，exit 0。
- `pnpm exec vitest run --project backend packages/api/test/agent-package-zip.test.ts packages/api/test/agent-package-v2-validation.test.ts packages/shared/test/chat-events.test.ts packages/core/test/workspace.test.ts packages/core/test/workspace-input.test.ts --reporter=default`：5文件、93/93 passed，exit 0。
- `pnpm test:web --reporter=default`：88文件、864/864 passed，exit 0。
- `pnpm typecheck`、`pnpm build`：最终联合版本均exit 0。
- `pnpm lint:focus`、`pnpm lint:contract`：最终均通过；`git diff --check`无问题。
- 本地Biome检查15个源码/测试文件无错误，5条既有API测试 `noNonNullAssertion` warning未扩大处理。
- 执行者另报API全域99文件933/933、shared/core225/225；主会话只对上述指定范围独立复验，不冒充独立全仓测试。
- 未触发CI、未监控远端检查；测试生成的 `.vitest/json/output.json` 已仅还原本轮生成差异，不纳入提交。

## 下一步

首轮已由 PR #96 合并并清理；当前后续任务见 [产出查看](agent-output-viewing.md)。完整用户故事已补入 `docs/USER-STORIES.md` EPIC 6，继续按故事断点补齐能力。

## 验证

- `git fetch origin main`：成功。
- `git rev-parse HEAD origin/main`：两者均为上述基线。
- `git status --short --branch`：干净。
- `gh repo view`：远程为 `indie-builder/agentport`，默认分支 `main`。
- `gh pr list --state open`：当前无开放 PR。
- `pnpm install --frozen-lockfile`：exit 0；未改依赖清单和锁文件。
- `pnpm -r --filter './packages/shared' --filter './packages/core' build`：exit 0。
- `pnpm typecheck`：所有 workspace 包通过，exit 0（实现前基线）。
- `pnpm lint:contract`：`project contract OK`，exit 0（实现前基线）。
- `pnpm exec vitest run --project backend packages/shared/test packages/core/test`：主会话独立复跑，28 文件、225/225 passed、0 failed、0 pending；exit 0，已读取 JSON 报告确认。
- `pnpm exec vitest run --project backend packages/sandbox/test/runner.test.ts packages/worker/test/message-persistence.test.ts --reporter=default`：主会话独立复跑，2 文件、49/49 passed；包含隔离 PostgreSQL 往返，无跳过，exit 0。runner mock 多次导入产生 `MaxListenersExceededWarning`（SIGTERM 监听数），测试未失败；未将该警告当作产品故障扩展本轮范围。
- `pnpm test:web --reporter=default`：主会话独立复跑，88 文件、860/860 passed、exit 0。
- `pnpm build`：所有包构建成功，exit 0。
- `pnpm typecheck`：联合实现后全仓通过，exit 0。
- `pnpm lint:focus` / `pnpm lint:contract`：均通过。
- `biome check`：RTK 首次仅报告 1 error 未给明细；按规则 bypass 展开重跑，12 文件无错误、exit 0。
- 上述结果为首轮评审前实现；导出与负载限制修复后将重跑对应范围。
- `docker ps`：现有开发 API/worker/PostgreSQL/Redis 正常运行，未停服务；后续后端测试使用既有 globalSetup 创建隔离资源。
