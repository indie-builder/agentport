# OpenUI 集成审计（2026-10-28）

## 目标

对照官方文档、已安装源码和本项目实际实现，判断现有 OpenUI 集成是否符合官方推荐方式，给出可核验的问题和最小改进建议。本次为一次性调研；用户要求的定时任务已删除，CronList 已确认没有任务。

## 结论

**架构方向符合官方支持的接入路径，但本地组件行为没有完整对齐。建议保留集成架构，优先修复适配层的实际故障。**

项目使用官方 Renderer、解析器、响应式状态、表单、Query/Mutation 和 mergeStatements；从真实前端 library 经官方 CLI 生成 spec，再由服务端生成提示词，符合官方主路径。自有聊天、传输、存储及 shadcn/Base UI 设计系统也是官方允许的集成方式。没有证据支持为了“更官方”而更换智能体底座或接入云服务。

但契约一致不等于组件行为一致。本轮复现了表格流式数据丢失、日期触发器无法打开、日期时区错位、复选默认项漏入提交载荷等问题。现有检查全绿，仍会漏过这些路径。

## 方案、基线与范围

- 分支：`docs/openui-integration-audit`。
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/openui-integration-audit`。
- 基线：`917d84c3bc4664c711ed56e51e3ffb765e9fac11`；初始差异为空。
- 已安装：`react-ui 0.18.1`、`react-lang 1.0.1`、`lang-core 1.0.1`、`cli 0.6.0`。
- 已读研发流程与 PITFALLS；官方资料、前端审查和后端调查并行进行，主会话核对关键源码并运行定向验证。
- 产品源码、测试、依赖、配置均未修改。研究记录为唯一新增文件，未提交、未合入 main。
- 主 checkout 原有 `.vitest/json/output.json` 差异不属于本任务，未触碰。
- 后端完整审查代理运行过久未返回，已停止；不将其视为已完成。主会话补核提示词、workspace、runner、动作与持久化关键入口，结合测试给出有限结论。

## 当前有效决定

仅交付调研和建议；不自动修复产品、升级依赖、迁移推理路由或接入外部服务，不调用付费模型，不发送外部反馈。定时任务保持删除状态。

## 官方符合性

| 范围 | 判定与证据 |
| --- | --- |
| 自有聊天和传输 | 官方 custom chat UI 要求保留 message list、composer、conversation state、transport，只替换助手消息渲染。项目做法符合。[官方文档](https://www.openui.com/docs/build-agents/custom-chat-ui) |
| 自定义设计系统 | 官方 shadcn 示例支持 `defineComponent` / `createLibrary` 配合任意设计系统。Base UI/Tailwind 适配可保留。[官方示例](https://www.openui.com/docs/openui-lang/examples/design-systems/shadcn) |
| library → spec → prompt | 项目真实 library 经官方 CLI 生成 spec，core 调用 `generateSystemPrompt`；当前 fresh spec 和官方契约检查通过。[官方生成流程](https://www.openui.com/docs/build-agents/ui-generation) |
| 官方 Renderer | `packages/web/src/openui/renderer.tsx` 使用官方 Root、Content、QueryLoading、QueryError、Retry；没有另造解释器。[Renderer](https://www.openui.com/docs/openui-lang/renderer) |
| 状态单独存储 | 已装 `react-lang/dist/exports-h9jw__Kr.d.mts:40` 明确由宿主决定嵌入消息或单独存储。项目按消息和 sN 段保存原始 state 属合理适配。[交互状态](https://www.openui.com/docs/openui-lang/interactivity) |
| 混合文本和多段 | 已装 parser 会抽取围栏代码，不能把正文保留视为 Renderer 的自动能力。共享分段器、每段独立命名空间是必要的项目责任。 |
| 增量编辑 | `mergeStatements` 是官方 API。项目在终态保存完整 `uiProgram`，原始输出另存，符合避免半个 root 提前合并的方向。[增量编辑](https://www.openui.com/docs/openui-lang/incremental-editing) |
| 动作与工具 | 官方由宿主处理动作、权限、工具调用和持久化；项目保留 `params.context`、formState、formName 和来源。定向回归通过。[动作](https://www.openui.com/docs/openui-lang/actions) |
| Claude Agent SDK | 在已核官方 stream adapter 清单未见专用 Claude Agent SDK adapter。应称“使用官方接口的自定义集成”，不能称“官方专用适配”。这不等于无法接入。[adapter 清单](https://www.openui.com/docs/agent/reference/adapters-and-formats) |
| Gateway / Autofix | 均不是 Renderer 的使用前提。接入会增加路由/账号/服务成本，本轮不推荐仅为对齐名称而采用。[Autofix](https://www.openui.com/docs/autofix) |

### 官方措辞与版本边界

- `generateSystemPrompt({cloud:true,...})` 配置模式只传 `preamble/examples/additionalRules`，不传 tools、bindings、editMode、inlineMode 等。官方建议这些功能在自有后端生成完整提示词；**不能据此推断 Gateway 的所有传输方式一概不支持这些功能**。[system prompts](https://www.openui.com/docs/openui-lang/system-prompts)
- Gateway 改变推理路由，不应未经验证就断言技术上无法与 Agent SDK 共用。当前没有必要迁移。
- 官方消息编码 `buildMessage/parseMessage` 是一种方案，不能据此要求项目把程序与状态改成一个字符串字段；本地公开类型明确允许单独存储。
- 官方 `extend({components:{override}})` 可替换组件定义。前端 Opus 探针确认覆写 84 个 renderer 后 schema 相同、Input 的 props 保留原对象。但运行期 import 官方 genui-lib 会加载其组件模块；Radix、视觉层与 bundle 成本没有实测，不建议直接引入。

## 实质问题与复现

下列路径均相对于本任务 worktree。P1/P2 表示本次建议优先级；不是对整个系统的安全评级。

| 优先级 | 问题与代码 | 证据与用户影响 | 最小方向 |
| --- | --- | --- | --- |
| P1 | `packages/web/src/openui/components/data.tsx:119` 的 EditableTable 用空依赖 useMemo 和 useState 锁定首次 data | 独立 jsdom 探针：空表流式补入两行后仍 0 行；同一完整程序首次挂载显示 2 行。主会话重跑对照，结果一致。 | 处理流式 props 更新及官方 state hydration，保留用户编辑；补真实生命周期测试。 |
| P1 | `forms.tsx:292` 的 DateTrigger 没有把收到的按钮属性/ref 传到底层 DOM | 实际 DatePicker 点击后无日历，aria-expanded 为空；透传 props 的 Popover 对照可以打开。违反 Base UI 自定义 render 组合契约。[官方规范](https://base-ui.com/react/handbook/composition) | 用项目现有按钮/正确组合方式保留事件、属性及 ref，验证点击和键盘。 |
| P1 | `forms.tsx:279` / `:288` 用 UTC 解析/截取日历日期 | Asia/Shanghai 本地选择 2026-10-28，`toISOString().slice(0,10)` 得到 2026-10-27；America/Los_Angeles 用 `new Date('2026-10-28')` 得到本地 27 日。主会话再次执行确认。当前入口故障会遮住后续日期错误。 | 将纯日历日期按本地年月日读写，分别覆盖 single/range 和正负时区往返。 |
| P2 | `forms.tsx:485` / `:618` 复选组与开关组只合并 stored 和 changed 项 | A 默认选中、点击 B 后画面 A/B 均选中，但实际提交仅 `swim:true`，缺少默认项 hiking。复选组独立重现；开关组同构代码及官方 aggregate 对照。 | 按所有条目构造当前 aggregate，再更新变化项；验证显示值与提交值一致。 |
| P2 | EditableTable 恢复/命名空间偏离 | 前端 Opus 探针：保存值 saved 被 original 覆盖；本地 `get/setFieldValue(undefined,...)`，官方 `EditableTable/index.tsx:52,109` 使用 tableName 作用域，且 effect 同步 existingValue/initialData。恢复探针未由第二条线再次复验。 | 与表格流式问题一起修，验证保存→卸载→恢复及动作载荷。 |
| P2 | `definitions.ts:476` 暴露 select/date-single/url/options，但 `data.tsx:178` 除 number 外统一文本输入 | 源码核对：options 无人消费，合法下拉列无法约束用户选项，日期列没有日期控件。官方提供 SelectCell、DateCell。 | 按已公开 schema 完成输入行为；不新增另一套表格底座。 |
| P2 | `packages/web/src/components/openui-message.tsx:146` 的 invalid 状态永久锁住回退 | 前端 Opus 同一实例先无效再有效的探针仍显示源码；主会话确认没有随 program 改变重置的路径。第二条独立探针未复验该项。 | 验证无效→有效 canonical 快照可以恢复，避免状态重置丢失正常输入。 |

### 为什么现有检查没抓到

`packages/web/test/openui-component-coverage.test.ts:249–255` 把 EditableTable、DatePicker 等列为“专项已覆盖”的豁免项；检索 EditableTable 只命中这份豁免清单。`openui:check` 证明 schema/default/refine/reactive 和生成物一致，不证明每个本地组件交互等价。升级手册中“每个组件都有渲染样例”的表述应限定为实际样例或豁免登记，不能宣称全部行为覆盖。

### 可以简化但不优先

- `library.tsx:41` 的兼容导出 `openUiLibrary` 无消费者；renderer 的 `library as openUiLibrary` 是局部别名，不是该导出的使用。
- `data.tsx:125` 的 dirty ref 只写不读。
- 官方组件契约副本有维护成本，但应先验证生成期复用或上游 schema-only 入口；不要重新引入 JSON Schema 反编译，已有实验表明会丢 reactive/refine 等语义。

## 后端关键入口核对与限制

- `packages/core/src/openui-prompt.ts:38–58` 从提交 spec 与当前工具描述生成完整提示词；`workspace.ts:325` 将其写入专家工作区 CLAUDE.md。
- `packages/sandbox/src/runner.ts:337–398` 用官方 query，cwd 指向 workspace，`settingSources:['project']`，`includePartialMessages:true`，按会话传 resume。
- `packages/worker/src/openui-action.ts:34–48` 把 params/context/formState/formName 传入模型提示词，不只传显示文本。
- `packages/worker/src/messages.ts:139–174` 只对主助手、非截断的 OpenUI 输出生成完整快照；子助手和截断块不参与。
- `packages/core/src/openui-response.ts:55–131` 按 sN 合并，调用官方 mergeStatements，并对结果解析校验。多段保留、显式删除、按序号匹配属于项目自定义语义，不应标成官方自动行为。
- 官方 SDK 文档与本地 sdk.d.ts 已核：includePartialMessages、resume、project settings 是真实选项。[Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)
- 未完成所有后端授权和会话分支的逐路径源码审查；已有定向测试通过不能代替完整审计。本次不声称 SDK 真实模型端到端验收通过。

## 版本调研

2026-10-28 官方/npm 查询：lang-core/react-lang 当前 stable 为 1.0.2，CLI 为 0.6.1，react-ui 仍为 0.18.1。1.0.2 changelog 涉及 telemetry、devtools 卸载和 React Native；未列出破坏性的 prompt/parser 变更，**未安装验证，不保证无其他行为差异**。CLI 0.6.1 未获得充分变更记录，仅确认发布版本。

官方 tag 对应提交：

- lang-core/react-lang 1.0.1、react-ui 0.18.1：`eb20708b9cc41afced5625e99e6ce8ec2f8a5435`。
- lang-core/react-lang 1.0.2、CLI 0.6.1：`f08a660535e55b5b2a24a0eb68568edaf9e4fe4b`。
- CLI 0.6.0：`2118fb27872a410ea664ddfd40c81ef374b142d9`。

证据入口：[官方仓库](https://github.com/thesysdev/openui)、npm registry `npm view <包名> version time.modified dist-tags --json`、`git ls-remote --tags https://github.com/thesysdev/openui`。上游升级还需与并行 update-tech-stack 任务协调，本次未修改其文件。

## 验证：本轮真实结果

均在本 worktree，使用锁定依赖。下列显式测试共 **245 条通过**，不叠加 openui:check 内部重复测试。

| 命令/范围 | 真实结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm --filter @agentport/db... build` | shared/core/db 构建通过 |
| `pnpm openui:check` | 全部通过：84 组件 fresh spec、签名/schema/分组/规则、Zod/reactive、peer/runtime 对应 |
| web：openui-wiring、renderer-lifecycle、form-behavior、action-shape、message | 5 文件 40 passed |
| web：openui-renderer、component-coverage、form-ui、chart-ui | 4 文件 78 passed |
| backend：core openui-response、prompt、parse-parity；worker openui-action | 4 文件 34 passed |
| API openui-actions/state/tools；worker openui-persistence | 首次无主配置，64 skipped；随后显式 load env，通过 globalSetup 建独立测试库/Redis，4 文件 64 passed，0 skipped |
| sandbox runner；worker stream-block-id | 2 文件 29 passed |
| web/worker/api/sandbox `typecheck` | 全部退出 0 |
| web `build` | 通过；Renderer 按需 chunk 940.75 kB / gzip 254.71 kB，保留 >500 kB 告警；无前后基准 |
| `git diff --check` | 通过；唯一新增为本记录 |

可重复入口：

```sh
pnpm openui:check
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-wiring.test.ts packages/web/test/openui-renderer-lifecycle.test.ts packages/web/test/openui-form-behavior.test.ts packages/web/test/openui-action-shape.test.ts packages/web/test/openui-message.test.ts --reporter=default
pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/openui-renderer.test.ts packages/web/test/openui-component-coverage.test.ts packages/web/test/openui-form-ui.test.ts packages/web/test/openui-chart-ui.test.ts --reporter=default
pnpm exec node --env-file=/Users/xbjt/Documents/myself/agentport/.env ./node_modules/vitest/vitest.mjs run --project backend packages/api/test/openui-actions.test.ts packages/api/test/openui-state.test.ts packages/api/test/openui-tools.test.ts packages/worker/test/openui-persistence.test.ts --reporter=default
```

使用主 .env 仅作为测试 globalSetup 的连接入口；框架创建随机 PostgreSQL 库和独立 Redis，再注入测试进程，未修改共享配置/用户登录态。测试正常 teardown，无批量资源清理。

日志限制：审批 Query、故障注入事务错误为预期测试路径；jsdom 图表存在零尺寸告警；runner 套件出现 SIGTERM MaxListeners 警告。本次没有把这些日志隐藏或解释为真实浏览器验收。

### 独立反例探针

临时脚本位于 `/tmp/openui-verify/`，使用本树 Vite/Vitest/jsdom 和真实组件，未修改产品或测试。表格探针为观测型，对“passed”不作正确性结论，以输出为证据：流式 FULL_CELLS=0，对照 FRESH_ROW_COUNT=2；主会话重跑结果相同。

日期表达式：

```sh
TZ=Asia/Shanghai node -e 'console.log(new Date(2026,9,28).toISOString().slice(0,10))'
# 2026-10-27；用户选择为 2026-10-28
TZ=America/Los_Angeles node -e 'const d=new Date("2026-10-28"); console.log(d.getFullYear(),d.getMonth()+1,d.getDate())'
# 2026 10 27
```

复选组实际载荷为 `booking.hobbies.value={swim:true}`，画面默认 hiking 和点击后的 swim 都选中。Popover 对照：不透传属性的触发器无法打开，透传的可以打开。Calendar 实际回调返回本地零点，确认日期表达式适用于真实控件路径。

## 步骤与下一步

- [x] 官方依据、已装版本与符合性核查。
- [x] 前端独立 Opus 审查和代表性反例复现。
- [x] 后端关键入口核对、隔离定向回归、类型与生产构建。
- [x] 定时任务删除，研究记录保留在 worktree，产品未改。
- [ ] 如用户授权实施：先以失败行为测试修表格流式/恢复/命名空间、DatePicker 触发器与纯日期转换，再修默认项聚合及无效快照恢复，补齐表格列能力；完成独立评审。
- [ ] 需要对“完整最佳集成”作进一步保证时，补完整后端逐路径审查、真实浏览器和合成数据模型多轮验收。
- [ ] 最后评估补丁升级与生成期契约复用；不默认引入 Gateway/Autofix/外部监控。

## 未验证与文档冲突

本轮没有真实模型调用、浏览器实屏、全量测试、云端纠错请求或升级后对比；不能把历史验收当作本次结果。旧的契约自检/组件覆盖描述过强，与本轮组件反例冲突，需在实施修复时同步收窄文档保证。历史任务记录含先前未合入与随后已合入的时间线，本次以当前 Git 基线为准，不将历史阶段状态误读为当前状态。
