# OpenUI 完整集成与官方实践重调

## 目标

完整接入本平台需要的 OpenUI 生成式 UI：组件、图表、表单、原生响应式变量、动作、Query/Mutation、流式、跨轮编辑、状态持久化、历史/分支恢复与工具审批；保持 Claude Agent SDK 执行底座、官方工作区文件定义和 shadcn/Base UI 视觉。

用户最新授权：按官方最佳实践审查建议重新调整。此前“完整交付、升级安全”的判断已被真实对照实验推翻，不能用旧测试数量证明本轮完成。新增非平凡逻辑先写行为测试、观察失败再修；最终须通过 Opus 独立评审、隔离回归和真实浏览器/模型验收。

## 基线与范围

- 分支：`worktree-openui-integration`。
- 工作树：`.claude/worktrees/openui-integration`，本任务所有产出均在树内。
- HEAD：`72a4db49413ec46e36000f9630c06e33196df183`。
- 初次任务开始无差异；本次重调沿用此前约九十项 OpenUI 未提交差异，保留后按授权修正，不整体还原。
- 范围：shared/core/db/api/worker/sandbox/web、必要生成命令和文档。
- 未授权 commit/push/merge；不操作其他会话进程或共享 compose 服务，不触发 CI。

## 当前有效决定

1. 真实 Zod 定义是组件契约来源，保留字段顺序、default、约束、record 值类型、refine、`reactive()`、action、description 和 componentGroups。shared 仍仅依赖 Zod，官方原语由浏览器注入。
2. `createOpenUiDefinitions({defineComponent, action, reactive}, renderers)` 组成实际前端 library；官方 CLI 从 `packages/web/src/openui/library.tsx` 生成 `packages/core/src/generated/openui.spec.json`。core 读取 spec 生成提示词，不 import 浏览器组件。
3. 不再从 JSON Schema 反编译 Zod，不再用 manifest 自比。升级检查要比对 fresh spec、当前官方契约与真实行为；依赖按声明的兼容范围核对，不把“同版本/同时升级”误写成官方要求。
4. 保留 `inlineMode` 混合回复；`editMode` 与跨轮 previous/完成后合并的持久化闭环一起验收。流中不能把半个 root 合并为最终界面。
5. `content` 保存原始输出，SDK transcript 不改；`uiProgram` 保存完成后各段合并后的完整混合文本。浏览器历史直接渲染快照，不二次合并。
6. UI 围栏独立命名空间，`blockKey=s0/s1…`，仅按 UI 围栏计数，Markdown 不计数。补丁只合并上轮同序号段，完整有效 root 可开始新程序；缺基线/非法程序保留原文并显示诊断，不猜修。
7. state 是官方不透明格式，存 `{version:1,blocks:{s0:rawRendererState}}`，每段独立恢复。branch 换消息 id 但原样复制 state；失败要可见可重试。
8. 动作完整保留 `type/params/context/message/formState/formName/messageId/blockKey`，尤其 `params.context`。先按入口上限校验，用户消息与动作在准入事务内一起存，worker 不得静默省略。
9. 工具每段闭包绑定 conversation/message/blockKey，不能倒找全局最后消息。工具目录和执行权限同源，凭证不进浏览器；stdio 仍由沙盒执行。
10. Query/Mutation 用官方 toolProvider 与错误/重试槽；202 审批在当前 UI 段可批准，Query 可重试，Mutation 必须用户显式再触发。会话审批有效 8 小时，重放批准不能续期或复活；run 审批语义不改。
11. 流块使用稳定 `streamBlockId`，不能以每帧变化的 uuid 或会重用的 blockIndex 作为唯一消息身份；完成后 canonical 快照与持久化 id 正确回填。
12. 不默认接入 Gateway/Autofix。它们是官方托管推理/纠错选项，并非 Renderer 使用前提；当前 SDK 保留原推理路径。

## 实现分工与真实依赖

| 分工 | 独占产出 | 依赖 |
|---|---|---|
| A 契约/spec/core | shared/openui、shared/chat、core、web/library、官方 CLI 与升级脚本/手册 | 无；最终 spec 从 C 的真实 library 导出 |
| B 消息/恢复 | worker、sandbox、db/repo/chat、web/chat-state、相关测试 | A 的分段器与 resolveOpenUiResponse |
| C 浏览器闭环 | web 除 A 的 library、B 的 chat-state 与独立 forms 修复 | A 的库接口、B 的完成快照、D 的工具与审批端点 |
| D 服务端边界 | api openui-tools/state、db/repo/openui 与相关测试 | A 的分段器供来源校验 |
| 动作准入 | api openui-actions/chat routes 和动作测试 | B 在 admitChatRun 内支持 userContent，同事务入库 |
| 表单行为 | forms.tsx 和真实交互测试 | 不依赖大库重构，已先修 |
| 验证准备 | 仅 .tmp/ 的隔离与浏览器启动器 | 最终 build 与本轮独立 sandbox 镜像 |

主会话仅定契约、合并接口、验证与记录；实现由 Sonnet，设计与独立 review 由 Opus。完整交接契约在 `.tmp/openui-revision-contract.md`（临时工作材料，提交前以代码/本记录为准）。

## 已独立复验（本轮）

- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-form-behavior.test.ts`：1 文件、8 项通过。真实点击覆盖 Chips/OptionCards 清空保持、required/email、非提交 primary 动作不被表单校验阻挡。
- `node .tmp/oui-isolated-env.mjs -- pnpm exec vitest run packages/api/test/openui-state.test.ts packages/api/test/openui-tools.test.ts packages/db/test/openui-tools.test.ts`：独立数据库和 Redis，3 文件、40 项通过，退出 0；临时资源已清理。
- D 独立评审：**不通过**。MCP structuredContent/isError/多 text 语义、坏 schema 400、原子 SQL 更新已确认；must-fix 为主助手/真实段存在校验，以及重复批准不得延长有效期。已派修，等待复核。
- 隔离启动器环境验收：chat-admission 11/11 通过，CLIENT LIST 无阻塞消费者，原服务未改动。
- `pnpm lint:focus`：通过。`pnpm lint:contract` 曾在forms错误图标逐个size处失败，删除size沿用全局LucideProvider后独立复跑通过。
- 文件包/配置往返独立复验：隔离launcher运行official-files/agent-package-zip/agents，3文件60项通过；CRLF格式往返不再吞进生成段，clone/rollback/换绑与两次导出有真实断言，临时资源清理完成。
- C浏览器闭环已报告46文件434项通过，主会话发现其段号用了0/1而非最终s0/s1，已派跟进统一并补Markdown不影响段号/branch恢复断言；此处不按报告视为已整体验收。
- 官方真实Zod源码复用时保留Thesys MIT许可，已把安装包LICENSE原文放入 `packages/shared/src/openui/LICENSE`；最终源码头和升级来源说明一并检查。
- C独立review：**不通过**。must-fix为Mutation审批不应放仅Query错误槽内、无id暂存值不能被flush清空、旧保存失败不能覆盖新输入、非空root下的parser错误必须可见。已派渲染器生命周期修复与真实runtime回归。
- B返回：worker canonical持久化/stable stream identity已写；部分22项DB流程测试通过临时 `.tmp/oui-verify/` alias替身验证，**不计最终通过**。A接口落地后必须删替身，以真实core/shared重跑。
- B独立review：**不通过**。must-fix为thinking后文本index与逐块完整assistant重新编号错配、无delta子智能体完整消息ID复用、reducer忽略完整assistant_text导致子输出丢失/截断标记不落地；已派真实SDK事件顺序与交错块回归修复。
- 接口补齐：B漏加admitChatRun.userContent，已派独立窄修；动作准入与消息事务必须完成后再验。
- D must-fix修复后独立复跑：隔离openui-state/openui-tools，2文件38项通过；真实sN段/子助手拒绝、重复批准expires不变、过期重放409均有断言。等待Opus复核，不以测试替代review。
- 首次真实跨模块typecheck：shared/core/sandbox/db通过；web真实library泛型与官方react-lang类型不匹配，已写接口交接说明，等待A收尾，不用强制断言绕过。
- 动作准入DB接口已接：userContent在既有事务单次入库，默认调用不变；新增4项真实DB断言（消息失败时run和继承审批回滚）报告通过。最终仍按真实A接口重跑。
- 汇合后主会话独立执行 `pnpm -r typecheck`：7包全部通过（退出0）。
- 主会话用真实core/shared执行隔离持久化/分支/准入测试：4文件26项通过，未使用 `.tmp/oui-verify/` alias，临时资源清理完成。
- 流式must-fix跟进已返回：真实SDK逐块顺序thinking→text、无delta子输出、交错delta和截断完整块覆盖等定向44项及扩大193项报告通过；终态回填由独立接口跟进继续收口。
- 隔离全量测试与构建正在运行，结果未返回前不记为通过。

## A 交付与验证（契约/spec/core，2026-10-25）

改动文件：

- `packages/shared/src/openui/definitions.ts`（新增）：84 个组件的**真实 Zod**，逐字段照抄官方
  `react-ui/src/genui-lib/**`；保留 `default`、`min(2)`、`z.record(string, boolean)`、
  `EntityList.refine`、`reactive()` 标记、`.describe()` 与字段顺序。
- `packages/shared/src/openui/kit.ts`（新增）：只依赖 zod 的 `OpenUiKit<C>` 注入接口，消除
  `unknown` / `as unknown as` 转型。
- `packages/shared/src/openui/meta.ts`（新增，生成物）：组件名与**注册顺序**、官方描述、12 个分组、
  5 个提示词示例与 40 条规则；由 `scripts/generate-openui-meta.mjs` 从官方包抽取。
- `packages/shared/src/openui/segment.ts`（新增）：唯一分段器；只认 `openui-lang|openui`，
  给 UI 段 `blockKey=s0/s1…` 与 `start/end` 偏移；`hasOpenUiSegment` 供 worker 判断。
- `packages/shared/src/openui/index.ts`（改写）：导出上述契约、`openUiPromptOptions`、
  `openUiToolsCacheKey`（名字+描述+入参+出参）。
- `packages/shared/src/openui/protocol.ts`：补 `OpenUiPromptOptions` 类型。
- `packages/shared/src/chat.ts`：`assistant_block_start` / `text_delta` / `assistant_text` 增加
  可选 `streamBlockId`；`run_finished.messageIds` 增加 `streamBlockId/parentToolUseId/uiFormat/uiProgram/uiState`。
- `packages/core/src/openui-prompt.ts`（改写）：只读 `src/generated/openui.spec.json`
  （官方 CLI 产物）生成提示词，主构建不 import web。
- `packages/core/src/openui-response.ts`（新增）：`resolveOpenUiResponse(previous, response)` +
  `resolveOpenUiResponseDetailed`（诊断）；每段独立、完成才合并、缺基线/非法程序保留原文。
- `packages/core/src/openui-response.ts` / `core/src/index.ts` 导出。
- `packages/web/src/openui/library.tsx`（新增）：`library` 与 `openUiLibrary` 同一实例，
  注入 react-lang 原语 + shadcn 渲染器；`promptOptions` 供 CLI 抽取。
- 根 `package.json`：`openui:meta`、`openui:spec`（官方 CLI 从真实 web 库生成）、`openui:check`；
  新增唯一 devDependency `@openuidev/cli@0.6.0`。
- `scripts/generate-openui-meta.mjs`、`scripts/check-openui.mjs`（新增）；
  删除 `generate-openui-schema.mjs`、`check-openui-upgrade.mjs`、`schema.ts`、`schema.ts.manifest.json`、
  `library.ts`（旧 builder 工厂）、`prompt-options.ts`。
- `packages/core/src/generated/openui.spec.json`（提交的生成物）。
- `packages/core/tsconfig.json` 纳入 `src/generated/*.json`。
- `docs/OPENUI-UPGRADE.md` 按新架构重写。

真实命令与结果：

| 命令 | 结果 |
|---|---|
| `pnpm openui:spec` | 生成 meta.ts（84 组件/12 分组）+ spec.json |
| `pnpm openui:check` | **9 项全 PASS**：重生成一致、组件名/顺序、签名、描述、12 分组、JSON Schema（default/minItems/record/refine）、示例+40 规则、peer 范围、lang-core↔react-lang 同版本 |
| `pnpm -r typecheck` | 7 包全绿 |
| `pnpm exec vitest run packages/core/test/openui-*.ts` | 7 文件 **46 项通过**：定义 parity、解析行为 parity（Text 默认值/联合/绑定树与官方逐字节相同）、reactive 变量改变后 Query 重跑、跨轮合并/双段/缺基线、分段器边界、spec 护栏、提示词 |
| `pnpm exec vitest run`（受影响跨模块：worker 持久化、chat-events、stream identity） | 4 文件 36 项通过 |
| `biome check`（A 的文件） | 0 问题 |

未做/交接事项：

- worker/sandbox/db 属 B；api/db openui 属 D；web 渲染器/组件/chat/state 属 C。A 只提供接口。
- 旧 `packages/web/src/openui/segment.ts` 与 `packages/shared` 的分段器重复；C 需删除前者并改 import。
- `run_finished.messageIds` 的扩展字段是可选位，由 B 在真实持久化路径回填。

## 行为验收矩阵

| 域 | 必须验证的用户行为 | 当前状态 |
|---|---|---|
| 官方契约 | Text 默认值、最小项数、布尔字典、真实 reactive 回写/Query 重跑、签名与描述/12groups 对照 | **A 已通过**（见下方「A 交付与验证」） |
| 生成/升级 | 官方 CLI 从真实前端库生成；fresh spec 对比产物；改默认值/绑定标记应使检查失败 | **A 已通过**（`openui:check` 9 项 PASS） |
| 流式 | 同 run 多 SDK 消息重复 index0、不同行 parent；stable id；截断/取消诊断 | 待 B |
| 跨轮编辑 | 第二轮只改一条语句仍保留原图表；双 root 独立；半 root 流中不破坏 previous | 待 A/B/C |
| 历史/分支 | 终态与刷新一致；格式切换不影响历史；branch state 复制后互不影响 | 待 B/C |
| 表单 | 点击校验、清空默认、Set/Reset/OpenUrl 非提交行为；完整 context/formState 进入模型 | 表单局部已过，跨端待验 |
| 状态 | 输入400ms内离开/点击动作仍 flush；失败可见重试；两个段并发不覆盖 | D 原子更新已过，其余待验 |
| 工具 | 两条历史消息/多个段真实来源；structuredContent；坏schema；失败可见重试 | D 局部已过，UI待验 |
| 审批 | 当前段批准/重试；8h说明；过期/null/重放不能绕过；Mutation不自动重放 | 待 D/C |
| 可访问性 | Tabs/Accordion/Carousel键盘、字段标签与错误、窄屏、一页一个h1、加载态不闪源码 | 待浏览器 |
| 真实路径 | 独立镜像运行本轮runner、真实模型两轮、浏览器输入/工具/审批/刷新、资源精确清理 | 待汇合 |

## 隔离验证纪律

- 集成测试：唯一临时数据库 + 独立 Redis 容器，禁止仅换 Redis db index 后声称完全隔离（CLIENT LIST 为实例级）。
- 可执行入口：

```bash
node .tmp/oui-isolated-env.mjs -- pnpm exec vitest run <定向文件>
node .tmp/oui-isolated-env.mjs -- pnpm test
```

- launcher 只创建/清理本任务前缀库和容器，不打印凭据，子进程 env 优先于 `.env`。
- 浏览器：本次 API 在随机端口直接托管本次 web/dist，CORS 与实际 origin 一致；不走其他 worktree 的5173/3000。
- 沙盒：本轮 runner 有变化，必须用独立 tag 构建实际新镜像；不能用旧默认镜像实测后宣称新 runner 正确。
- `streamBlockId` 只用于本轮实时身份，完整 SDK assistant UUID用于历史分支；不要把CLI每帧uuid混作稳定身份。
- 输出 raw 与 canonical 必须分离：用户点击动作的原始payload会进SDK，对UI补丁的合并只改数据库渲染快照，不重写SDK transcript。
- 进程只记录并清理自己 spawn 的 handles，禁止 `pkill -f`，禁止启停共享 compose。
- 模型只用合成验证数据，不发送工作区内容；只清理本任务 fixture。

## 官方依据（已读取）

- https://www.openui.com/docs/build-agents/ui-generation — 从前端真实 library 导出 LibrarySpec，后端只消费 spec。
- https://www.openui.com/docs/openui-lang/defining-components — Zod/component/ref 的组件契约。
- https://www.openui.com/docs/openui-lang/reactive-state — reactive schema 和 useStateField。
- https://github.com/thesysdev/openui/blob/main/spec/prompt.md — JSON Schema 不保存绑定标记；字段顺序、default 和签名语义。
- https://www.openui.com/docs/openui-lang/incremental-editing — previous 保留、完成后 merge、保存新的完整 previous。
- https://www.openui.com/docs/openui-lang/interactivity — state 不透明格式原样保存/恢复。
- https://www.openui.com/docs/api-reference/react-lang — toolProvider、Renderer.QueryError/Retry、原生 form/action APIs。
- https://www.openui.com/docs/openui-lang/actions — ToAssistant context 在 params.context；原生 Set/Reset/Run 由 runtime 执行。

## 历史方案及被替代原因

- 十组件示范版：用户明确要求完整集成，已替代。
- JSON Schema 反编译：对照实验确认 reactive/default/minItems/record 校验丢失，改真实 Zod 定义。
- manifest 自比和组件计数：行为错误时仍 PASS，改实际来源和行为校验。
- editMode 只合并同条消息：缺跨轮基线，改服务端 canonical 快照。
- 工具按最后消息/:0：历史和多个段错配，改每段真实来源。
- 动作只发 label 或丢 params.context：模型缺选中项/表单值，改完整协议。
- 以旧测试数量宣布完成：独立评审证实存在阻断，撤回结论；最终依本记录矩阵验收。

## 真实浏览器验收记录（本轮，持续更新）

- 独立数据库/Redis/API随机端口 `http://127.0.0.1:54540`，ego任务空间51；本轮独立沙盒tag `sandbox:openui-revision-20261025-native`，未覆盖默认tag。
- 实际页面 `/login` 输入凭据并提交，返回工作台；未通过注入Cookie绕过登录。
- Query合成场景：真实Select切“近3个月”，表格变为8/9/10月及182/196/208，柱状图同步；无可见alert。刷新后仍为近3个月、3条数据，h1数量1。已查看截图。
- 最新构建Mutation实测：第一次因fixture未替换发布工具名触发403（正确拒绝；fixture已在独立库修正），之后真实202显示当前段批准入口及8小时说明，批准后仍“尚未发布”，用户再次点击才“已发布”；无alert。
- 表单实测：空预算提交出现required；填3200并选hotel/camp，刷新恢复。实际提交保留未发送草稿；API读取入库片段确认params.context、context、formState/formName/messageId/s0完整。随后真实模型按预算/住宿输出方案，canonical已存。
- 真实模型两轮（独立新镜像/本次API）：首轮成功$0.0379，次轮只改标题成功$0.0410076，终态stable identity均在；canonical保留BarChart。真实浏览器加载完成后显示两轮图表，标题更新、无alert。加载阶段短暂闪源码已发现并派修，不忽略。
- 窄屏390px双UI段实测：document宽度390无横向溢出，s0折线图/s1表格独立可读，h1=1，无alert，已查看截图。
- 最新最终隔离全量JSON报告：1433项全部通过，0失败、0pending/跳过（退出0），未排除chat-admission；报告在 `.tmp/openui-final-tests.json`，临时库/Redis已清理。此前1431+1跳过为并行修复期间记录，以此结果为准。
- 更新构建的源码闪烁实测：页面加载期间sourceVisible=false，完成后两图表及更新标题仍正常；lazy门闩与限速浏览器也已回归。
- 真实会话UI分支及刷新：锚点前的图表保留，h1=1、无alert；未触发新模型run。
- 浏览器验收已通过stop文件只终止自身spawn子进程；隔离launcher退出0、删除本任务DB `oui_revision_test_67465603` 与独立Redis；移除本任务镜像tag及两个fixture工作区目录。共享服务未启停。ego任务空间51已结束；浏览器工具提示可选更新，未升级。
- canonical多段保留修复已落地，升级自检最后的真实default解析和旧dist拒绝正在收尾复核。
- 最终接口独立review：**不通过**，新增must-fix为已结束run补发缺terminal_missing导致canonical恢复漏触发、8h到期复用approvalId页面approved标记不清、工具桥未校验主助手与真实sN来源。已逐项派测试修复，1419全绿不等于这些路径通过。
- 隔离全量第二次：176文件1419项全部通过，退出0；临时库和Redis清理。此后如有新修复需重跑相关范围。
- 首次隔离全量：11项失败（生命周期7、恢复3、旧upgradeguard1），1365项通过。均为真实失败，不归因共享环境；对应实现已派修，待最终复跑。

## 最终验收执行次序

1. A/B/C/动作准入汇合后，核对导出名称、sN段号、canonical文本、streamBlockId终态字段，清掉旧反编译/merge/manifest路径及无人调用导出。
2. 每项新行为的定向测试先过；spec生成命令实际从前端library执行，fresh产物与受控spec对比。
3. Opus独立审查固定文件清单及接口；修复后只复核已修项和新增发现。
4. `pnpm -r typecheck`，隔离 `pnpm test`（不排除chat-admission），`pnpm -r build`，`openui:check`，focus/contract/biome。
5. 用单独标签构建本轮runner镜像，临时DB/独立Redis/随机API端口托管本轮dist，真实浏览器先合成fixture测试，再真实模型两轮。
6. 记录截图/实际交互、完整命令退出码及失败限制；只清理本任务资源。没有browser证据就不把交互验收打勾。

## 最终交付状态（2026-10-25）

- 已完成按官方实践重调：真实Zod/reactive契约→实际前端library→官方CLI LibrarySpec→core提示词，旧JSON反编译、manifest自比和重复分段器已删除。
- 动作/状态/工具/审批/流式/跨轮快照/分支完整接线；各轮Opus发现已修，最后定点复评明确**通过**，既定六项must-fix全部修复。
- 最终隔离报告：176文件，1433项全部通过，0失败0跳过，JSON报告 `.tmp/openui-final-tests.json`。
- `pnpm -r typecheck` 7包退出0；`pnpm -r build`退出0；focus/contract均通过；OpenUI50文件biome通过；`pnpm openui:check`11项通过，含fresh spec/真实默认值/refine/reactive行为和旧dist拒绝。
- 真实浏览器：实际登录、Select变量触发Query重跑、表单校验/刷新恢复/提交上下文/草稿、Mutation批准不自动重放、双UI窄屏390无溢出、一页一个h1、两轮模型增量图表和分支刷新、加载无源码闪烁均已操作。
- 真实模型：本任务独立镜像运行；首轮图表+次轮标题patch均succeeded，canonical图表保留；表单值到模型并生成方案。只发送合成数据。
- 本任务隔离进程、数据库、Redis容器、镜像tag、fixture工作区已精确清理，共享服务未启停；ego51已结束。
- **未commit/push/merge，未合入main**。所有差异保留在worktree供用户检查。

使用限制（如实保留）：

1. 维护官方84组件契约的源码副本，升级仍需审查上游差异；检查能定位不保证未来版本零改动。
2. http MCP工具目录需先测试连接刷新；stdio工具仍只在SDK沙盒执行，不暴露浏览器执行入口。
3. 多UI段补丁按sN位置匹配；删除段会使后续新消息段号前移，历史消息不变；表单状态按消息持久化，不自动跨新消息继承。
4. 浏览器覆盖代表性交互，不等于逐个手工操作84组件的所有组合。其它组件依真实runtime/契约回归覆盖。
5. Gateway/Autofix未接入，错误可诊断和重试，但不承诺模型每次生成都合法；构建仍有大chunk提示（chat gzip257.28KB/按需renderer249.32KB）。

## 下一步

用户已授权提交PR并合并；OpenUI已提交667e984，origin/main d9c5a45已整合。共享/执行、Markdown、迁移均经Opus复核通过；main0033/0034原样保留，新0035_pretty_tana_nile空库及main升级路径独立实测通过。合并后全部类型/构建/官方契约通过，完整隔离回归199文件1645/1645、0失败0跳过。固定测试库已换为每次独立库，失败清理小修复复核后提交合并记录并发布。
