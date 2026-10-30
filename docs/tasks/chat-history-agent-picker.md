# 恢复聊天历史栏的专家选择关系

## 当前有效决定（2026-10-31，第二次纠正）

用户要求以 PR124 前主分支 `b683903` 的对话顶部结构为准，保留后加的控件样式。下文此前仅恢复 picker 归属、保留跨栏外顶栏的方案与验收是历史记录，已被本节替代。

- 恢复历史栏／消息列／成果栏从工作区顶部并排开始；移除跨栏外顶栏，把现有 ChatTopBar 通过 ChatColumn 的 header 插槽放回消息列内。
- 历史收起：消息头部显示历史开关、搜索、专家选择、标题／操作、成果入口；历史展开：消息头部隐藏搜索和专家选择，历史头部显示专家选择与新建，下面是既有搜索全部会话。
- 保留 56px 消息头部与 24px 内边距、中性色和浅线控件、历史 200–360px、成果 400px、832px 阅读轴线、单实例底部 Composer 及全部业务／焦点行为。无需回退其它页面或整文件。
- Sonnet A 独占 chat.tsx 和三个聊天测试文件，先红后绿；Sonnet B 独占正式设计规范与本任务文档，二者并行。实现后独立 Opus review 和实页三栏顶部对齐验收。**本轮实现、定向验证、实页验收与独立 Opus review 均已完成；本轮证据见下节，不复用第一次纠正或浅线任务结果冒充本轮验证。** 当前未提交、未合入。

## 第二次纠正的实施与验证（2026-10-31）

- 实际启动旧主分支 `b683903` 前端 5191，沿用有效会话查看同一历史会话，未重新登录。旧版展开后专家与会话标题同排、消息头部无搜索，截图 `/tmp/chat-old-main-history-20261031.png` 已查看。对照后已停止临时前端并删除无源码差异的参考树；5190、5173、3000 保持运行。
- Sonnet 将 ChatTopBar 经 header 插槽放回 ChatColumn 的 Page 内，删除跨栏顶栏包装；展开时头部搜索卸载。保留输入浅线、底部单实例 Composer、现有尺寸与业务处理。
- 新行为测试先红：头部不属于消息 Page，两个定向用例失败；改动后两项转绿。主会话完整运行六文件相关回归：`pnpm test:web packages/web/test/chat-ux.test.ts packages/web/test/chat-outputs.test.ts packages/web/test/chat-drafts.test.ts packages/web/test/chat-attachments.test.ts packages/web/test/chat-search-navigation.test.ts packages/web/test/conversation-search-ui.test.ts`，6 文件 178 测试通过。
- 主会话运行 `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build`、`pnpm lint:focus`、三文件 Biome，全部退出 0。自动测试报告无 Git 差异。
- 1480×840 已有会话展开：历史头部 `x224 y4 w267.3047 h56`，选择器 `x236 y16 w207.3047 h32`，消息头部 `x492.3047 y4 h56`。专家选择与 h1 各 1 个，消息头部搜索 0。输入边线仍为 `rgb(230,230,230)`。
- 打开成果：历史、消息头部、成果均从 `y4` 开始，成果 `x1076 y4 w400 h832`；标题与成果开关仍属于消息列。截图 `/tmp/chat-restored-topology-history-20261031.png`、`/tmp/chat-restored-topology-outputs-20261031.png` 已查看。
- 收起历史：专家在消息 Page、头部搜索恢复为 1，历史开关保留焦点；专家菜单 Escape 回到实际选择触发器。1000×800 Sheet 打开时可见专家仅 1 且在 dialog，头部搜索 0；正常 reload 起点验证 Escape 后回历史开关、头部专家与搜索恢复。一次从菜单退场焦点立即切换视口的连续操作回焦到专家，重新以正常打开路径复测结果如上，不扩大修复范围。
- 欢迎态截图 `/tmp/chat-restored-topology-welcome-20261031.png` 已查看，保留底部输入与建议按钮；展开后专家在历史、单 h1、消息头部无重复搜索。浏览器 space 73 已交回用户，停在历史展开欢迎态。
- 未发新消息、未触发 worker；不声称覆盖新的流式、工具调用或审批执行。独立 Opus review `ad95542e75a0718b6` 源码与测试通过，唯一 P3 为规范声称消息列位置不变，已改为消息列随分栏开合移动并伸缩；`a8838eeadd822a085` 点验关闭 finding，整体通过。全部差异未提交、未合并。

## 目标与状态（第一次纠正历史记录，已被第二次纠正替代）

2026-10-31 用户最新纠正：桌面展开会话历史时，智能体／专家选择应进入历史栏，与新建会话同排；收起历史后回到顶栏。当前把专家选择固定在顶栏，导致历史头部只剩新建图标及大块空白，本任务恢复原来的关系。

**实现、定向验证、实页验收和独立 Opus review 均已完成；当前交付为未提交、未合并差异。** 设计阶段与实施阶段的范围及证据分别记录在下文。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/qoder-controls-refinement`。
- 分支：`feat/qoder-controls-refinement`；实际 HEAD：`e61360e063d77f12283ec414f77d2a6d1545710c`。
- 起始状态存在上一轮已完成的控件浅线修正：根 `CLAUDE.md`、`docs/DESIGN-SYSTEM.md`、`packages/web/DESIGN.md`、`packages/web/.impeccable/design.json`；web 输入家族、动作控件、SourceEditor、搜索、memory-review、`styles.css`、`chat.tsx`；三个相关测试、`scripts/check-focus-contract.mjs` 及未跟踪的 `docs/tasks/qoder-controls-refinement.md`。全部属于上一轮，必须原样保留，不整文件恢复、不退回 HEAD、不覆盖它们。
- 上轮任务记录报告：Opus review 已通过，定向 11 文件 185 测试、typecheck/build 及相应机械检查通过。这是上轮证据，本任务未重跑，也不能作为新布局行为通过的证据。
- 当前 `chat.tsx` 相对 HEAD 的唯一已有差异是 composer 的 InputGroup class，必须完整保留：`h-auto rounded-card has-[[data-slot=input-group-control]:focus-visible]:border-composer-focus`。
- 本轮唯一允许写入：`docs/tasks/chat-history-agent-picker.md`。以下源码、测试及正式文档清单是后续实施边界，不是本轮写入授权。
- 无 commit/push/merge 授权；不操作凭据、数据库、后端、依赖或服务配置。

## 已核实事实与最小方案（第一次纠正，已失效）

现有 `ChatWorkspace` 已具有全部所需路径，不新增组件、状态、依赖、portal 或样式令牌：

1. `ChatTopBar` 在整个分栏外，已有 `showAgentPicker` 条件；当前 `desktop || !historyOpen` 导致所有桌面状态都显示顶栏专家选择。
2. 桌面 `aside[aria-label="会话历史"]` 已调用 `HistoryHeader`，但只传 `onNew`。`HistoryHeader` 已支持 `agent`、`agentId`、`agentOptions`、`onSwitchAgent`；缺少参数时渲染 `<div className="flex-1" />`，这就是新建按钮前的大块空位。
3. 窄桌面历史 Sheet 已向同一个 `HistoryHeader` 传入完整专家参数以及 `onClose`；该路径保持不变。
4. `renderHistoryPanel(inSheet)` 已共用历史列表、搜索、重命名和 portal 归属。保持它和现有 `HistoryPanel`，不新造一条历史渲染路径。

最小源码 patch：

- `ChatTopBar` 调用改为 `showAgentPicker={desktop ? historyCollapsed : !historyOpen}`。
- 桌面 `HistoryHeader` 调用保留 `onNew={newConversation}`，补传 `agent={agent}`、`agentId={agentId}`、`agentOptions={agentOptions}`、`onSwitchAgent={switchAgent}`，与既有 Sheet 参数来源一致。
- 更新同文件内与新行为矛盾的三处说明：返回 JSX 前“开合都不移动这些控件”的注释、`ChatTopBar` 的“不移动专家选择”注释、`showAgentPicker` 仅描述窄屏例外的属性注释。只说明专家选择随历史开合切换位置；外顶栏结构仍固定。
- `HistoryHeader` 本体沿用现有 `h-14 / items-center / gap-1 / px-3`、选择器 `min-w-0 flex-1` 和右侧新建图标，名称可截断，新建按钮仍可见；本任务不改其可选属性接口、不删除当前兜底分支、不改变 Sheet 关闭按钮规格。

该方案只改变选择器的渲染条件和桌面历史头部参数；不回退整轮布局。专家选择挂载位置可以变化，不要求前后为同一 DOM 节点。

## 当前有效决定（第一次纠正，已失效）

| 状态 | 唯一专家选择位置 | 同时保留的行为 |
|---|---|---|
| 桌面 `desktop=true`，历史收起 | 56px 外顶栏 | aside 不渲染；首次进入仍默认收起 |
| 桌面 `desktop=true`，历史展开 | 历史 `HistoryHeader` 左侧，与「新建会话」同排 | 外顶栏不重复选择器，也不保留选择器专属空占位；新建在同排右侧 |
| 窄桌面 `desktop=false`，历史 Sheet 关闭 | 外顶栏 | 既有窄桌面布局与焦点行为 |
| 窄桌面 `desktop=false`，历史 Sheet 打开 | Sheet 的 `HistoryHeader` | 既有模态、Escape、焦点管理、关闭按钮及 portal 子树关系 |

此处“历史展开”指会话历史面板的展开状态；打开某条历史会话不会额外强制展开面板，不改变默认收起策略。

必须保留的不变量：

- 唯一外顶栏仍在 `ChatWorkspace` 正常流、整个历史／消息分栏上方，高 56px、左右 24px；历史开关、搜索、会话 h1／操作和成果入口继续可达。移走选择器后由现有 flex 自然排布，不为保留其旧 x/y 新增占位；不要求其它顶栏子项维持旧 x 坐标。
- 历史宽度默认收起 0、首次展开 240px、可调 200–360px、拖拽记忆、`Group/Panel/Separator` 及 resize 回调不变；成果宽 400px、消息列最小宽约束及既有桌面断点不变。
- Composer 保持单次渲染、消息后正常流、距底 24px、832px 阅读轴线及首发 textarea／焦点行为。保留已完成的 `border-composer-focus` class，所有输入浅线、控件外观、颜色和焦点令牌均不变。
- 专家选择在欢迎态、已有消息及历史会话中都可用；同一时刻只有一处。继续用既有 AgentPicker／Combobox 的头像、名称、箭头、名称／角色／Slug 搜索和键盘交互。
- 继续调用 `switchAgent`，不改 URL、store、stream 或 query：换专家进入新专家的新会话、清除旧 conversation 参数与消息／运行上下文、保留未发送输入、刷新该专家历史、不取消后台运行；选择当前专家不清空会话。
- 新建仍走 `newConversation`；会话隔离草稿、附件／引用及已有导航处理不改。历史开合不能清空输入或重建消息流。
- 每个渲染状态恰好一个 h1，仍由外顶栏提供；HistoryHeader 不新增标题、说明、标签、分隔横线或空白占位。

### 搜索的确定落点（第一次纠正，已失效）

保留当前实现，不重新排列搜索：外顶栏「搜索会话」图标保持；历史头部放「专家选择 + 新建」，紧接 `renderHistoryPanel` 的现有「搜索全部会话」整行，再接历史列表。两入口仍共享 `search`／`ConversationSearch`，保持跨专家搜索及原触发器回焦；Sheet 来源仍通过 `inSheet` 挂在 Sheet 子树内。不要把搜索硬塞进 200px 的头部同排，不新增第三个入口或说明文字。

## 已替代项及原因（第一次纠正，已被第二次纠正替代）

> 第二次纠正已进一步移除跨栏外顶栏；本节以下内容（含“固定 56px 外顶栏继续有效”）仅保留为第一次纠正的历史证据。

用户本轮明确覆盖 2026-10-30 布局契约中的以下局部决定：

- “桌面专家选择永远固定在顶栏，历史开合前后同一 DOM 且 x/y 不变”。改为按上表切换归属；DOM 身份和坐标不再是专家选择的验收标准。
- “桌面 HistoryHeader 不放专家选择，只保留新建动作”。恢复现成专家选择参数路径，填补头部实际空白。

只替代以上专家选择关系；固定 56px 外顶栏、底部输入、分栏尺寸、消息与成果行为及控件浅线主题继续有效。Composer 的同 DOM／焦点测试仍有效，不能和选择器的旧错误断言一起删掉。

## Sonnet 实施包与独占文件（第一次纠正）

契约已定，显式 `model: sonnet`；执行前加载 `ub-mode`、读 `docs/PITFALLS.md`。两个包可并行，文件互斥；不能为实现方便改变本契约，遇到新设计判断回交 Opus。所有写入仅在当前工作树。

| 包 | 独占写入文件 | 产出与边界 |
|---|---|---|
| A：源码与行为测试 | `packages/web/src/pages/chat.tsx`；`packages/web/test/chat-ux.test.ts`；`packages/web/test/chat-outputs.test.ts` | 实施上述条件／传参／注释 patch，并先红后绿更新真实渲染行为测试。禁止修改 Composer、ChatColumn、HistoryPanel、AgentPicker 实现、store、stream、queries、ui 原语和成果组件。 |
| B：契约同步 | `docs/DESIGN-SYSTEM.md`；`packages/web/DESIGN.md`；`docs/tasks/qoder-visual-redesign.md`；`docs/tasks/chat-history-agent-picker.md` | 只同步专家选择位置及其验证要求，保留所有浅线主题未提交差异。旧任务记录只补充明确的局部替代说明与本记录链接，保留历史证据，不重写历史验证为新结果。不改源码／测试。 |

正式规范与历史记录的精确同步位置（行号为设计时位置，执行时按正文定位）：

- `docs/DESIGN-SYSTEM.md:95`，§2.1 第 3 条：删除“唯一专家选择永远在顶栏／同 DOM 和 x/y 不变／桌面头部不放专家选择”，按状态表描述；保留外顶栏、宽度及成果条款。
- 同文 `:230`，§6 空态图：标明收起时顶栏有专家选择，展开时历史头部为专家选择与新建；保留消息／输入结构及阅读轴线。
- 同文 `:266`、`:268`，§6 会话头部与专家切换说明：更新归属和头部分组，保留跨专家搜索、URL、草稿及后台运行语义。
- `packages/web/DESIGN.md:284`，布局快照：在现有外顶栏／历史尺寸描述中补上选择器随历史开合切换，避免把“固定外顶栏”误读为“全部子控件永远固定”；不改其它 token 与快照。
- `docs/tasks/qoder-visual-redesign.md:255`、`:256`、`:263`、`:283`、`:285`、`:304`：这些是旧契约及旧测试／坐标验收要求，在相关布局章节添加一处醒目的局部替代说明，链接本记录，明确仅专家选择同 DOM／固定位置要求失效；保留已执行历史及 Composer 验收。
- 根 `CLAUDE.md` 已指向当前设计规范，无专家选择固定位置的独立声明，不需改。`packages/web/.impeccable/design.json` 未发现该位置规则，不需改。`docs/tasks/qoder-controls-refinement.md` 的浅线任务记录保持原样。

## 行为测试契约（第一次纠正，已失效）

优先改现有用例，不新增源码字符串快照、class 断言、jsdom 伪几何或通用测试工具。

1. `chat-ux.test.ts:941`：将“不移动顶栏控件”用例改为验证收起 → 展开 → 收起。初始选择器在顶栏；展开后唯一选择器属于历史 aside，和新建按钮同属 HistoryHeader；收起后 aside 消失、唯一选择器回到顶栏。每一步保持专家名／头像／箭头、`aria-expanded`、输入值、URL 和单 h1。重新查询当前选择器，不再对前后选择器用 `toBe(picker)`；顶栏搜索节点保留原有稳定断言。
2. `chat-ux.test.ts:1017`：桌面展开后先断言选择器在 aside；缩窄且 `historyOpen=false` 时回顶栏；再放大且桌面历史展开时回 aside。始终只一处，保留 h1 和专家值。
3. `chat-ux.test.ts:987`：保留 Sheet 打开 → 放大为桌面且历史折叠 → 再缩窄的断点用例及唯一入口断言，不把 `historyOpen` 误用为桌面折叠状态。
4. `chat-outputs.test.ts:2104`：裸 `/chat` 展开历史后，仍为真实“先选择专家”空态、无永远 loading、未请求专家历史；选择器现在应属于该 aside，通过它选择专家后仍真实请求历史。替换 `closest(aside) === null`，保留后续行为断言。
5. 复用 `chat-ux.test.ts:1047` 既有打开会话后切专家用例：明确从展开的历史头部选择；保留新专家 URL、旧消息清理、草稿保留、历史刷新与未删除会话断言。收起顶栏选择器、名称／角色／Slug 搜索及同专家不清空的现有覆盖继续保留。
6. 保留首发 textarea 同节点／焦点、不抢其它控件焦点、Sheet 回焦、草稿／附件与跨专家搜索导航回归。历史开合由保留的顶栏按钮发起时焦点仍留在该按钮；专家 Combobox Escape 回到当前实际触发器，不因移位引用已卸载节点。

`tests/chat-history-filter.e2e.ts` 的 `showHistory`、历史列表作用域及“搜索全部会话”定位与新方案一致，现有全页唯一专家选择定位也可沿用；不需要修改 E2E 文件、fixture 或共享登录前置。实页验收沿同一用户路径验证，若执行时发现真实定位器冲突，先报告并扩大明确边界，不能顺手重写 E2E。本任务没有接口、配置、导出或数据库变更。

## 验证与实页验收（第一次纠正，已失效）

实现包 A 在现有代码上先跑新增／改后的最小用例，确认红测失败来自错误位置契约，再实施最小 patch。两个包完成后统一跑下列范围，不并行生成同一构建产物：

```sh
pnpm test:web packages/web/test/chat-ux.test.ts packages/web/test/chat-outputs.test.ts packages/web/test/chat-drafts.test.ts packages/web/test/chat-attachments.test.ts packages/web/test/chat-search-navigation.test.ts packages/web/test/conversation-search-ui.test.ts
pnpm --filter @agentport/web typecheck
pnpm --filter @agentport/web build
pnpm lint:focus
pnpm exec biome check packages/web/src/pages/chat.tsx packages/web/test/chat-ux.test.ts packages/web/test/chat-outputs.test.ts
git diff --check
```

上述文件完整跑，不用一个测试通过冒充整文件通过；不固定跑后端全套或重复上轮全部 185 测试。若新增失败或改动扩大，按新证据扩相应验证范围。

实页从本树已有 `http://localhost:5190` 预览入口验证，先确认运行源确属本树；端口不可用时按 `docs/DEV-WORKFLOW.md` 读取已有启动配置，不重启共享后端、不修改登录态。浏览器使用 `ego-browser`；沿用上轮约束，不抢占已交接给 agents 页面的 space 73。正式验收必须记录实际矩形／计算样式，不能以源码类名代替：

- **1440×900 桌面**：裸 `/chat`、已选专家欢迎态和一条已有历史会话各检查一次。默认收起时专家在顶栏；展开后头部左专家、右新建紧凑同排，选择器不在顶栏重复，也无原选择器空占位；搜索紧接头部、列表随后。收起可回顶栏。
- **实际几何**：记录外顶栏高度为 56px／左右内容边 24px；HistoryHeader 高 56px，专家与新建按钮垂直中心一致；记录头部底边与搜索上边间距，确认只保留现有 `gap-3`、没有新增空白行。选择器窄至历史 200px 时名称截断而新建可见；首次展开约 240px，拖拽至 200／360px 可用并记忆。外顶栏本身位置／高度不变，不要求专家或其它顶栏子项的 x/y 不变。
- **输入与成果**：历史收起／展开、成果独立开合均不清草稿；记录 composer 距底 24px、可用宽度内最大阅读轴线 832px；默认边线 `#E6E6E6`、文本聚焦 `#DDDDDD`，保留同一 textarea 与首发焦点行为。历史开启改变消息可用宽度时允许输入宽度自然收缩，不伪造相同坐标要求。
- **键盘与导航**：从历史头部切换到另一专家，URL 去掉旧 conversation、旧消息消失、未发输入带过去、历史刷新；同专家不重置。Combobox 搜索／方向键／选择／Escape 可用，Escape 回当前触发器；用历史开关开合不把焦点丢到 body。单 h1、会话操作、新建和成果入口持续可达。
- **搜索**：顶栏与历史内各打开一次同一搜索，验证跨专家命中、关闭回对应触发器、选中结果正确导航；不改现有按钮名称和搜索外观。
- **1000×800 窄桌面与跨断点**：历史 Sheet 打开时选择器只在 Sheet 内，关闭回顶栏；Sheet 的 Escape／回焦／搜索 portal 及重命名路径正常。跨 1024px 两方向检查现有 `historyOpen` 与 `historyCollapsed` 的各自状态，始终只有一个选择器、没有不可达入口。不新增手机适配。

实现完成后由独立 Opus 仅 review 本记录约定的差异、正式文档同步及上述证据；不重审已通过的控件浅线全量改动。无授权不提交。

## 步骤与下一步（第一次纠正）

- [x] 读取当前 `CLAUDE.md`、`docs/PITFALLS.md`、流程及相关源码／测试／布局规范，确定真实空白来源和现成复用路径。
- [x] 仅写入本记录，固定用户最新决定、最小 patch、互斥文件与验收方法。
- [x] Sonnet A／B 并行执行源码测试与文档同步。
- [x] 运行定向验证、实页测量并记录真实结果。
- [x] 独立 Opus review 完成，交付未提交差异。

**当前状态：实现、定向验证、实页测量与独立评审均已完成。** 交付为未提交差异，上轮控件浅线修正原样保留。本轮未发送新消息、未触发 worker 运行，不声称覆盖所有会话／运行状态。

## 本轮验证记录（第一次纠正，非本轮）

设计核对已确认 HEAD、初始未提交文件及 `chat.tsx` 的 composer 唯一已有 patch；已核对 `HistoryHeader`／AgentPicker／HistoryPanel 调用、两种历史状态、受影响测试断言、E2E 定位与实际 package scripts。仅新增本任务文档，不复用上轮通过数量冒充本轮验证。

- `git diff --no-index --check /dev/null docs/tasks/chat-history-agent-picker.md`：无空白格式错误输出；退出码 1 是 no-index 比较空文件与新增文件存在差异的正常结果。
- `git diff -- packages/web/src/pages/chat.tsx`：仍只有上轮 composer class 的一行变更，未写入本任务的源码 patch。
- 未跑行为测试、typecheck/build 或实页验收；这些是后续实施的验收项。

### 文档同步记录（2026-10-31 第一次纠正 B 包，已被第二次纠正替代）

- 已同步 `docs/DESIGN-SYSTEM.md`：§2.1 第 3 条改为按历史开合描述专家选择归属；§6 空态图标明收起顶栏与展开历史头部两种位置；会话头部及专家切换说明移除“固定顶栏／历史开合不移动”，保留跨专家搜索、URL、草稿与后台运行语义。
- 已同步 `packages/web/DESIGN.md` 布局快照：补上专家选择随历史开合切换归属；其它 token、尺寸与快照未改。
- 已在 `docs/tasks/qoder-visual-redesign.md` 布局章节加入一处局部替代说明，仅声明旧“专家选择同 DOM／固定位置”要求失效并链接本记录；历史证据与 Composer 验收未改写。
- 未改源码、测试或控件浅线主题/色值/限制差异；实现与验证仍待主会话提供真实结果。

### 实施与验证记录（2026-10-31 第一次纠正，非本轮）

- A 包按契约修改 `chat.tsx` 的 `showAgentPicker` 条件与桌面 `HistoryHeader` 专家传参，并更新 `chat-ux.test.ts`、`chat-outputs.test.ts` 行为断言；未改 Composer、`HistoryPanel`、`AgentPicker`、store、stream、queries、ui 原语与成果组件。
- 红测：4 条新增／改写用例失败，失败原因均为历史展开后专家选择不在 aside，符合预期契约；实施后同 4 条转绿。
- 定向契约：`chat-ux`、`chat-outputs`、`chat-drafts`、`chat-attachments`、`chat-search-navigation`、`conversation-search-ui` 共 6 个文件 178 个测试通过。
- 主会话机械检查：`typecheck`、`build`、`lint:focus`、3 个改动文件的 Biome、`git diff --check` 均通过。
- 实页 1480×840 欢迎态展开：HistoryHeader `x=224 y=60 w=267.3047 h=56`；专家选择 `x=236 y=72 w=207.3047 h=32`；新建 `x=447.3047 y=72 w=32 h=32`（与选择器垂直中心一致）；搜索 `x=236 y=128 w=243.3047 h=32`，头部底边 116 到搜索上边间距 12；页面仅 1 个专家选择、1 个 h1。菜单 Escape 焦点回历史头部选择器；收起后选择器回顶栏 `x=328 y=16 w=176 h=32`，焦点回历史开关。
- 实页 1000×800：历史 Sheet 内仅 1 个专家选择且在 dialog 子树；Escape 后回顶栏并聚焦历史开关。
- 已有测试会话 `conv_01m6110qk6fqabc8km50yfbja2`：展开历史后选择器在 aside 内、选择器数量 1、历史列表 5 个子节点；输入默认浅线 `#E6E6E6` 保留。截图 `/tmp/chat-history-agent-picker-after.png`、`/tmp/chat-history-agent-picker-existing-final.png` 已人工查看。
- 清理自动测试报告 `.vitest/json/output.json`：与 HEAD 的 diff 为空（blob 哈希一致），无需 restore；未改动该文件。仿真 handoff 已清，5190 预览服务保持运行。
- 未发送新消息、未触发 worker 运行；未覆盖流式回复、工具调用、审批等运行态，也不声明这些状态通过。
- Opus 独立 review（`acdff`）确认源码通过，唯一 P3 是 `docs/DESIGN-SYSTEM.md:95` 仍要求其它顶栏控件坐标不变，与移走选择器后自然排布矛盾。该句已修为顶栏位置／高度不变、子项沿 flex 自然排布且不留空占位；Opus 定点复核（`ab41770dc9776182b`）确认与实现一致，关闭 finding，整体本轮通过。
- 上轮控件浅线修正仍原样保留在工作树。

## 交付状态（2026-10-31）

- 验证与独立评审均完成；本任务差异随分支 `feat/qoder-controls-refinement` 提交并创建 PR，等待合并，尚未合入 `main`。
