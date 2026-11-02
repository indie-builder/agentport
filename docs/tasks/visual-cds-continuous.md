# CDS 设计原则审计 Loop（持续）

## 目标
对照参考项目 `~/Documents/myself/open-claude-ui`（Claude CDS）的**设计原则**，持续审计 agentport 前端（packages/web）仍可改进项，每轮修复一批并验证。区别于上一轮「令牌/视觉值对齐」loop（已合并 main `7049266`），本 loop 聚焦**设计原则层面**：信息表达与克制、留白节奏、排版、色彩语义、动效物理、状态设计、图标细节、组件交互契约。

## 基线
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`
- 分支：`worktree-visual-cds-continuous`
- 起点：origin/main `7049266`（上一轮 CDS 对齐 loop 已合并）

## 约束
- 视觉层按 CDS；代码层按本项目规范（shadcn/Base UI、语义令牌禁散落 hex、保 aria/键盘/焦点、无 emoji）。
- 主会话不写代码，全部派子代理；每轮 typecheck + build（必要时 visual:shots）+ Opus 独立终审 → 提交分支并 push。
- 不合并 main（除非用户明确授权）。
- 每 10 分钟由 cron 触发一轮（当前 job `f3383e16`）；已有完整轮次或无明显差异时只做巡检、不造改动。

## 参考设计原则（提炼自 open-claude-ui v1 文档）
1. **表达克制**：层级靠表面明度/字重/留白，不靠框线和彩色标签；一条视线最多 1 层闭合边框，容器内二级控件 ghost/无框；AI 正文零边框，操作栏 hover/focus 才出现；每区只 1 个主操作或危险动作，clay 不作装饰。
2. **留白节奏**：密度靠节奏非挤压；控件高 24/32、图标 16/20；对话 gutter 32、轮次 ~15、块 10、正文 4px 内缩；阅读宽 42–48rem、气泡 85%。
3. **排版**：7 档字号；标题 balance、正文 pretty、长串 anywhere；动态数字 tabular-nums；移动输入 ≥16px。
4. **色彩语义**：Surface 阶梯只差 1–3% 明度；clay 只做品牌/焦点/推理，蓝做运行就绪，红做错误危险；边框 0.5/1/1.5/2px 分场景。
5. **动效**：时长 60/120/200/300/450ms，进入 `.22,1,.36,1`、退出 `-4px/180ms`，四弹簧分场景；禁 linear/ease；reduce 下禁循环与位移。
6. **状态**：hover 150ms/5% 底、active .975–.98、focus 三层 clay 环、disabled 35%+not-allowed+pointer-none；空态上限 24px 图标+一句说明+一个次要动作；状态不只靠颜色。
7. **图标**：线性矢量统一描边；尺寸 12/14/16/20/24；行内 `-0.125em` 光学对齐；装饰图标不承担唯一语义。
8. **组件契约**：primary 只正向提交、secondary 默认无框、ghost 只内联、danger 只破坏；卡片单外框+hover -1.5px；浮层 16px 双环影。

## 改进 backlog（按价值，来自首轮双路审计）
### 高价值
- H1 **信息表达去冗余**：标题已是编辑/详情入口，底部又重复「查看详情/编辑/查看运行」（`plugins.tsx:250/346`、`skills.tsx:313/390`、`runs.tsx:171/211`）；页头主按钮与空态同名按钮重复（`channels.tsx:39/61`、`runtime-environments.tsx:72/109`）；频道头部计数再以头像/chip 重复表达（`channel.tsx:382-417`）。原则1、项目 §10。
- H2 **可点击暗示要诚实**：`ui/card.tsx:14` 默认给所有 Card 加 `cds-card-interactive` 上浮，但概览指标卡 `overview.tsx:546`、环境卡 `runtime-environments.tsx:184` 实际只能点标题 → 改为按需上浮。原则8。
- H3 **空态语言统一**：`knowledge.tsx:468`(96px 插画) vs `plugins.tsx:223`(PageNote) vs `audit.tsx:266`(表格内一行字) 三套；`personal-shares.tsx:249/282` 重复同文案。原则6（24px 图标+一句+一次要动作）。
### 中价值
- M1 **动效令牌落地**：DESIGN-SYSTEM 声明 5 档时长/8 缓动，`styles.css:111-113` 仅 `--ease-out-soft/--dur-fast/--dur-slow`；实现硬编码 150/140/90ms、0.12s（`app-shell.tsx:165/175/267`、`view-toggle.tsx:51-53`）、`duration-150` 回落默认 ease（`channels.tsx:105`、`eval.tsx:569`、`agents.tsx:4133`）。原则5。
- M2 **强调层级一致**：数字列被系统性弱化 `data-table.tsx:591` 用 muted，`personal-usage.tsx:465-471` 同值用 fg；同类读数 `overview.tsx:554`(text-3xl) vs `status.tsx:60`(text-xs)；停用徽章未突出 `agents.tsx:736-742`。原则1、3。
- M3 **knowledge 悬停跳变 bug**：`knowledge.tsx:138` `transition-shadow` 覆盖 Card transform，上浮瞬时跳变。原则8。
- M4 **阅读行长不统一**：`page.tsx:41` 60ch、`agents.tsx:1316` 70ch、`plugin-detail.tsx:366/394` 75ch（目标 42–48rem）。原则3。
### 低价值
- L1 图标尺寸散落（页面直写 size-3/5 约 59 处）与 16px 全局冲突。原则7。
- L2 发丝边混用：`table.tsx:22`（0.5px）vs `page.tsx:84`/`channels.tsx:70`（1px border）vs `agents.tsx:1477`（ring-1）。原则4。
- L3 `status-badge.tsx:14` brand tone 未被使用，`channel.tsx:777`/`chat.tsx:3343` 内联复制陶土光晕；空描述「—」vs「暂无描述」措辞不一。原则6、零死代码。

## 轮次记录
- **轮1（提交）**：信息表达去冗余 + 动效 bug。①plugins 页脚「查看详情」与标题 Link 同目标，删除页脚重复入口（保留「被 N 个专家使用」+ 编辑按钮）；②runs 页脚「查看运行」与标题 Link 同目标，删除；③knowledge.tsx Card `transition-shadow hover:ring-foreground/25` 覆盖默认交互过渡致 hover 上浮跳变，去掉 overrides。终审发现 4 个既有测试（plugin-editor/audit-action-feedback/run-detail-navigation/runs-view-toggle）仍按旧页脚入口定位，已等价改到标题链接（保留 URL/可访问名/backTo），4 文件 32 用例全绿。验证：typecheck exit0、web build exit0。遗留：另 7 个 theme-contrast/ui-focus-states 既有失败与本轮无关。
  - 待办调整：H1 剩余（channels/runtime 重复主按钮、channel 计数重复）、H2 卡片按需上浮、H3 空态语言统一、M1 动效令牌、M2 强调层级、M4 阅读行长、L1–L3 → 后续轮次。
- **轮2（提交）**：①H2 卡片 affordance 诚实——`ui/card.tsx` 新增 `interactive` 属性（默认 true），仅真·纯展示卡（overview 指标卡等，无任何可交互子元素）设 `interactive={false}`，消除「不可点却在 hover 上浮」的误导；②M2 数字排版一致——runs 卡片统计（耗时/成本/token 等）补 `tabular-nums`，与 personal-usage/data-table 一致。验证见下。
  - 终审发现并修复：最初整类移除 `cds-card-interactive` 会连带丢失常驻 `--shadow-panel`（卡片边界）——已拆为 `.cds-card-surface`（所有卡片常驻边界）+ `.cds-card-interactive`（仅 hover 上浮/过渡）；card.tsx 恒带 surface、条件加 interactive；同步 DESIGN-SYSTEM §2.3/§9 与 packages/web/DESIGN.md 措辞。验证：typecheck exit0、web build exit0。
  - 核实排除（审计过度声称，勿再改）：channel.tsx 头部的头像/chip 是 `xl:hidden` 的响应式身份/状态展示，非纯重复计数；personal-shares `empty="还没有分享"` 是 DataTable 分支，items=0 时已被上方 EmptyState 截胡，实际走不到。
- **轮3（提交）**：①M1 文档诚信——`DESIGN-SYSTEM §11` 原称「缓动全部在 @theme / 时长阶梯各档都是令牌」，实际 @theme 只有 `--ease-out-soft`/`--dur-fast`/`--dur-slow`/`--btn-spring`，其余曲线与时长是 utility 内联；按「文档服从代码」修正两条并保留 CDS 参考值。②status.tsx 把 PageHeader 后的孤立说明行「运行指标每 10 秒自动刷新」并入 PageHeader `description`，消除 `Page` 直接子节点造成的上下留白不均（§2 留白节奏 + 页面骨架）。
  - 核实排除：H3「空态三套语言」不成立——skills/servers/plugins/knowledge 主空态统一用 `PageNote`+BusinessIllustration；knowledge 的 96px 插画空态是刻意品牌化，非缺陷。M4「阅读行长」参考值 42–48rem 反而宽于现状 60–75ch，且为 max-width 语义，非同类框定，不做。
  - 收敛判断：经 3 轮，H1/H2/H3、M1/M2/M3/M4 已处理或核实排除；剩余仅 L1（图标尺寸散落，面广收益低）、L2（发丝边 0.5/1px 混用，属既有可接受限制）、L3（brand tone 现已被运行徽章使用）等细节，趋于收敛。后续轮次以巡检为主，不强行造改动。

## 非对话 / 非找专家页面 · 布局规范对齐（2026-11-02 新增范围）
参考项目 `open-claude-ui` 是 CDS 组件库/逆向文档（部分布局值为推导），**其布局规范大部分已被本项目 `DESIGN-SYSTEM` §8/§9/「全站页面布局契约」固化**（DESIGN-SYSTEM 本就由 CDS 派生、且是用户批准的权威几何契约）。映射：
- 外壳/侧栏/主区、非 chat 内容 24px → §376/§8.1；页面容器不居中最宽（主区平铺）→ §327/§376（与参考「资源页 max-w 1024–1152 居中」不同，**以本项目已批契约为准，不引入居中 max-w**）。
- 资源页工具栏顺序/宽度（搜索 224/筛选 144/排序 128）、资源中心两行 → §329/§378；卡片网格 1–4 列 / 表卡切换 sm:2 xl:3 gap-4 → §330/§336。
- 表格字号（表头 xs 12 弱色、单元格 sm 13、数字右对齐等宽）→ §331；表格用共享 Table → §8.5。
- 个人模块宽度/阅读 75ch/短字段 448/标签列 96 → §334/§8.8/§367；设置表单宽度、弹窗档位（确认 400/520/720、定时任务 1024 两栏）→ §368/§9。
- 阅读工具栏 ReaderToolbar、成果侧栏 400px、公开分享 728px → §360/§335。
- 返回控件：detail 页用页头 leading 图标、专家配置/运行环境用「返回列表」文字（**多为上下文合理差异，不强制统一**）。
参考里**尚未固化、且与本项目契约不冲突**、值得后续评估采纳的：①网格/工具栏用容器查询替代视口断点（架构性，收益大但改动大，暂缓）；②详情两栏可拖拽 resizer（暂缓）；③空态推荐 ≤24px 图标（本项目资源页用 BusinessIllustration，属刻意品牌化，保留）。

**本范围方法**：逐页对照 DESIGN-SYSTEM 布局契约 + 参考规范，只在「真实实现漂移」或「参考确有更优且不冲突」时修，逐条记录证据；不重构已批契约的几何。
**候选审计清单**（下一轮起逐条核实）：roles 搜索 `w-64`(256) vs 契约 224；plugin-detail 返回 `ghost icon-sm`(28) vs 其它 detail `outline icon`(32)（上下文差异，酌情）；knowledge-detail 文档阅读未设 max-w（长文可读性，评估加 ~75ch，需不破坏侧栏/tabs）；native Table(runtime/accounts/ops) 已用共享 ui/table（合规）；分页四套按各 API 语义保留。
- **轮4（布局范围首批，提交）**：核实后确认布局整体已高度符合契约。落地两处真实漂移：①roles 搜索 `w-64`→`w-56`（对齐 §378 224px）；②plugin-detail 返回 `ghost icon-sm`(28)→`outline icon`(32) 与 knowledge/run detail 一致。终审发现并修：按钮变大后描述缩进 `ps-11`→`ps-12` 并同步注释。核实排除：knowledge-detail 实为 tabs 管理页（正文阅读在 1100px 预览 Dialog 内），无需加阅读宽度；卡片网格全部 `sm:2 xl:3 gap-4` 合规、搜索/排序宽度基本合规。验证：typecheck、web build exit0。
- **轮5（巡检，无代码改动）**：核验 §336 表/卡切换覆盖（ViewToggle 在 runs/ops/runtime/accounts/shares/usage + 记忆提案经 `memory-review.tsx` 复用共享 ViewToggle，全覆盖）、个人模块六页均用 PageHeader、卡片网格 `sm:2 xl:3 gap-4`、搜索/排序宽度合规 → 布局范围判定收敛。范围 A 亦无有意义剩余差异。后续转轻量巡检，不强行造改动。
- **轮6（提交）**：M1 动效缓动 token 统一（轮3 只做了文档诚信，代码层 `duration-150` 漏 `ease-out-soft` 的实为真漂移）。全仓筛出 13 处写了 `transition-<prop>`+`duration-150` 但漏缓动 token（回落 Tailwind 默认 `cubic-bezier(0.4,0,0.2,1)`），逐处补 `ease-out-soft`：app-shell(240/252/621)、plugin-file-tree、personal-memory-panel、ui/accordion、knowledge(862)、eval(569)、channels(105)、agents(4133)、chat(2437)、data-table(576——其 TableRow 自带 `transition-colors`，故该行 duration 有效)、styles.css `.skip-link`(320 原 `ease`→`var(--ease-out-soft)`)。Opus 终审首轮抓出 data-table 与 skip-link 两处遗漏并补齐。验证：typecheck/build exit0。
- **轮7（巡检，无代码改动）**：对剩余维度做一次全量核实，均合规、无真实漂移：①焦点环——`outline-none` 命中项均为 input/textarea/combobox，焦点由包装原语（input-group 等）绘制，非丢失；②排版——审计日志时间戳 `font-mono tabular-nums`、data-table 数字列 `text-right font-mono tabular-nums`，动态数字均等宽；③颜色——tsx 中 hex 仅 chart.tsx 的 Recharts 内部选择器（`[stroke='#ccc']`/`#fff`），非样式值；④图标——`strokeWidth` 覆盖均为图表数据描边（规则：图表沿用自身数值），全局图标仍 1.75/16px；⑤动效残留 90/140/160ms 为 150ms 级 hover 淡入，与全站 `duration-150` hover 标准一致。范围 A、B 均判定收敛，转轻量巡检。
- **轮8（全站审计，6 组并行，2026-11-02）**：对除对话页外全部页面按 §8/§9/§10 + 参考布局逐页只读审计，产出分优先级清单：P1×1（channel.tsx:168 多人群聊人类消息丢作者名，已代码核实）、P2×~14、P3×~20、文档缺口×3。完整清单见会话交付。
- **轮9（提交，机械一致性批）**：筛选宽统一 144px（agents 启用状态、personal-usage 统计窗口/状态/来源）；ops「下次触发（UTC）」表格 + 卡片补 `tabular-nums`；accounts 创建时间补 `font-mono tabular-nums`。裁决保持 agents 排序 `w-32`=128 不动。typecheck/build exit0，Opus 终审通过。P1 与其余 P2（卡片假可点、频道作者名、异步刷新错误态、空态去重、个人字段 a11y 等）留待后续轮次。
- **轮10（提交，执行/评估页）**：run-detail 页头返回控件改入 `PageHeader leading`（删外层包装 div 与 className 覆盖，对齐 plugin-detail）；步骤 h2 `text-sm`→`text-base`；选中步骤 `bg-hover`→`bg-selected`，Opus 终审追加修正为 `bg-selected hover:bg-selected`（ghost 按钮 hover 会盖选中色）。eval 运行中状态 `warn`→`brand` tone + 圆点 `bg-warning`→`bg-button-primary`（format.ts 类型联合同步），与 RunStatusBadge 统一。typecheck/build exit0，Opus 终审通过。
- **轮11（提交，空结果清除筛选）**：§9 空结果给恢复动作。accounts 空态：筛选无结果（settled）时补「清除筛选」（清 q、重置 offset、保留 view；按钮 size=sm）；personal-usage 空结果：区分「窗口无数据」与「筛选无结果」——新增 `hasActiveFilter`，有筛选时标题改「没有匹配的运行记录」并给「清除筛选」（清 agent/trigger/status/cursor，保留 days/view）。真实 URL 键为 agent/trigger/status（来源=trigger，非 source）。typecheck/build exit0，Opus 终审通过。
  - 备注（P1 暂缓）：channel 多人群聊「人类消息缺作者名」受数据模型限制——`ChannelMember` 无成员显示名，`memberLabel` 对他人仅回退 `shortId`，无法补真实作者名；仅能显示 opaque shortId，属产品取舍，待用户定夺。
- **轮12（提交，个人模块 a11y/字号）**：personal-security 密码表单三字段补无障碍关联（Field `data-invalid`、Input `aria-invalid`+`aria-describedby`、FieldError `id`，参照 knowledge-faq 既有写法；当前密码补齐 data-invalid/aria-invalid）；personal-usage 专家列（主信息）字号 13→`text-base`(14)（§8.8）。typecheck/build exit0，Opus 终审通过。
- **轮13（提交，skills 权限门控）**：skills 卡 CardFooter「编辑」按钮对无 `skills.update` 用户也显示、点开是只读「查看」弹层（名实不符）；按 plugins/servers 既有 `className={canUpdate ? undefined : 'hidden'}` 隐藏之（标题链接仍可打开只读查看）。typecheck/build exit0，Opus 终审通过。
  - 核实排除：审计「卡片假可点 → interactive=false」不成立——§150/§348 明确「可交互卡（有标题链接/编辑动作）加 cds-card-interactive hover 上浮，纯展示卡不加」，知识库才是唯一整卡链接卡（§362）；资源卡当前 interactive=true 合规，不改。
- **轮14（提交，缓存刷新错误态）**：区分「首载失败（无数据）」与「后台刷新失败（有缓存）」——后者不再整块 ErrorState「内容没有加载出来」而丢数据，改为保留旧数据 + 顶部 PageNote(danger) 提示 + 重试（照 status.tsx 范式）。三处：overview 主视图、ops 定时任务、ops AttentionPanel。Opus 终审抓出 a11y 回退（原 ErrorState 有 role=alert，PageNote 无）→ 修共享 `PageNote`：`tone="danger"` 时输出 `role="alert"`（default 不变，11 处 danger 调用受益）。typecheck/build exit0，Opus 两轮复核通过。
- **轮15（提交，频道页去重/间距）**：channels 空列表时页头与空态「新建频道」重复 → 页头按钮仅在 pending/error/有数据时显示，空态唯一入口；列表外层 PageSection `divided={false}` 去掉 Header 下多余全宽顶线（避免与列表 border 叠层）；channel 头部「N 成员·M 智能体」加 `xl:hidden`（xl+ 由右侧栏承载，断点对齐 sidebar `xl:flex`）。typecheck/build exit0，Opus 终审通过。
  - 核实排除：status 页头 description 内联——PageHeader 是 `min-h-14 flex-wrap` 自适应行，"内容自然换行可增高"符合 §8.2，非缺陷，不改共享组件。
- **轮16（提交，文档缺口对齐·文档服从代码）**：①§9 知识库详情任务页签由 5 项更正为实际的 7 项（文档/来源/检索测试/离线评估/FAQ/Wiki/处理记录）；②§9 阅读工具栏补说明：插件详情无单文件下载，下载即页头「导出 ZIP」整包，工具栏不设下载（知识库/成果仍保留下载）；③`packages/web/DESIGN.md` 个人资料分区更正为「身份（h2，含姓名表单+用户名+角色）→ 账号详情（1px 分隔线 + 折叠展开业务 ID）」，与代码一致。docs-only，无需构建。
- **轮17（提交，knowledge 空态去重 + 频道行高）**：knowledge 空列表隐藏页头「新建知识库」（空态唯一入口；空态按钮共用 `createButtonRef` 保焦点回退）；channels 列表行高收敛——`ChannelRow` py-3→py-2、右侧信息三行合并为两行（未读徽章与时间同行）。**真实渲染实测**（visual-check 隔离栈，1440/1280 截图）行高约 56–62px（≤64，§8.3）、右列不溢出；知识库空态仅一个「新建知识库」。typecheck/build exit0，Opus 终审通过。
  - **P1 决策（用户「按建议处理」）**：频道多人群聊作者名——`ChannelMember` 无成员显示名、`memberLabel` 对他人仅回退 `shortId`，补真实作者名不可行；仅能显示 opaque shortId，收益有限且需改共享 chat 渲染、风险高 → **维持现状**，记为已知限制。

## 全站一致性专项（2026-11-02 起，6 维并行审计）
用户反馈「同类事情各页做法不一」（选专家仅为示例）。6 维只读审计（选择控件/专家展示、按钮与操作、页面骨架工具栏、状态与反馈、表单弹窗、排版数字图标文案）合并为下列主题，分批落地（每批：子代理→typecheck/build→Opus 终审→提交分支，不合并 main）。
- **A 数据完整性**
  - A1(P1) 后台刷新失败整块替换缓存：channels/channel/personal-shares/personal-usage/conversation-outputs 仍是 `isError?ErrorState:内容`，改 `isError && data===undefined` 才整块替换，有缓存则保留+PageNote(danger)+重试（同轮14 范式）。share-dialog 经核实为「错误提示与列表并列追加」非替换，无需改。
- **B 专家选择与身份**
  - B1(P1/P2) 抽共享 `AgentPicker`（chat.tsx:1370-1446 蓝本：可搜索 Combobox+头像+名称+角色），替换 channel 绑定、ops 执行专家、memory 执行/目标专家；频道 @ 提及补头像/角色/空态。⚠改 ops 前须同步 `DESIGN-SYSTEM:368`。〔进度：B1a 已完成——抽出 `components/agent-picker.tsx` 并让 chat 复用，行为等价；B1b-1 已完成——AgentPicker 增 field 触发形态，频道绑定智能体改用之；B1b-2a 已完成——记忆提案执行/目标专家改用 AgentPicker(field)；B1b-2b 已完成——ops 定时任务执行专家改用 AgentPicker(field)（RHF Controller 接线，triggerRef/onBlur），并同步 DESIGN-SYSTEM:368；B 主题完成〕
  - B2(P2) 统一专家身份展示：AgentAvatar 接入运行详情/使用记录/总览；抽 `agentRoleLabel`；已删除专家统一「已删除的专家」。〔进度：已删除专家文案已完成——personal-usage/overview/runs 的「已删除」统一为「已删除的专家」（7 处），typecheck/build exit0，Opus 通过。待评估：AgentAvatar 接入 run-detail/usage/overview 受数据约束（运行行仅 `agentName`，无 role/description/slug），需数据侧支持，暂缓；`agentRoleLabel` 抽取待与相关页一并评估〕
- **C 空态与创建动作**
  - C1(P1/P2) 空态三层（页面级 EmptyState / 区块 PageNote / 行内 Inline）+ 空态唯一主 CTA 用 `default`+sm + 空态时隐藏页头重复创建按钮（knowledge/channels/accounts/agents/runtime-env/servers/eval 约 7 页）。〔进度：knowledge/channels 此前已隐藏（轮15/17）；accounts 已完成——真正空列表时隐藏页头「新建账户」，搜索无结果保留；servers/runtime-env 已完成——真空列表隐藏页头「新建」并把空态创建升为主操作(default，runtime-env 空态按钮接管焦点 ref)；eval 已完成——用例空态去重复「新建用例」（保留标题栏那个）；agents 暂缓——受保护两张入口卡 + 筛选空态「新建/清除筛选」双动作属刻意设计，不强改〕
- **D 危险动作与行操作**
  - D1(P1) destructive 语义统一：ops/eval 行内删除、personal-shares 撤销、knowledge-settings 模型删除改 destructive（或菜单 destructive 项）。
  - D2(P1/P2) 列表行操作三形态收敛（多操作进「更多」菜单/单一动作文字按钮）；详情页返回/删除入口统一（配置页删除进菜单、返回入 leading）。〔进度：runtime-env-detail「删除」已从页头常驻 destructive 收进 Ellipsis「更多」菜单（对齐 agents），焦点 ref 挂菜单触发器；runtime-env-detail「返回列表」已从右栏文字按钮改 leading 图标返回（对齐 run-detail/knowledge-detail），typecheck/build exit0、Opus 通过。待评估：agents 详情页头复杂（leading 已挂 AgentAvatar、actions 含返回/查看运行/删除），返回入口是否迁 leading 需单独判断，暂留；其余详情返回入口已核对一致〕
- **E 骨架/工具栏/分区**
  - E1(P2) PageSection `divided={false}` 规则修正：status/runtime-environment-detail/overview(移除两个 divided=false)/eval 首个顶层分区不应画线。
  - E2(P2) 找专家工具栏布局（搜索左、筛选排序 ml-auto 大空白）改为资源中心顺序；memory-review 手写工具栏→PageToolbar、页级主操作移入 PageHeader actions；memory 专家筛选宽 176→144。〔进度：找专家（agents）工具栏已改为搜索(224)+筛选+排序左组（去 flex-1 与 ml-auto，中间空白消除）；待 memory-review 工具栏→PageToolbar + 主操作入 PageHeader + 筛选宽 176→144〕〔更新：memory-review 工具栏已改共享 PageToolbar、专家筛选宽 176→144 完成；「生成记忆提案」主操作入 PageHeader 暂缓——需把 create 触发器/状态从列表组件提升到页面层，跨组件改造风险高，维持工具栏内放置〕
  - E3(P3) 分页四形态统一（抽共享 Pager / 固定位置与外框）。〔核查：各页分页语义本就不同——accounts 为 offset+总页数+「上一页 / 页码 / 下一页」；personal-usage、personal-shares 为游标式「下一页 / 回到最新」无总数；另有「加载更多」游标列表。强行抽单一 Pager 会错配语义，暂不统一，保留各自形态〕
- **F 表单与弹窗**
  - F1(P1) 新建频道弹窗退出路径不一致/无草稿保护 → useDraftGuard+DraftGuardDialogs。〔进度：已完成——CreateChannelDialog 接入 useDraftGuard(isDirty,pending,onClose)+DraftGuardDialogs，pending 期拦截关闭、取消走 guard.close；成功导航带 ignoreBlocker:true 绕过尚未随 effect cleanup 注销的 dirty blocker（否则创建成功却停在列表）。typecheck/build exit0，Opus 两轮终审通过〕
  - F2(P2) 字段错误 aria 关联缺失：knowledge-documents/knowledge-wiki/personal-profile/knowledge-evaluations 的 FieldError 补 id + aria-invalid/aria-describedby。
  - F3(P2) 保存禁用策略（编辑态 `disabled={!dirty||pending}`、取消始终可用）、失败内联 vs toast 统一（表单失败内联 FieldError）、横向 Field 几何统一。
  - F4(P2,大) 多字段手写 useState→useZodForm（accounts/knowledge-settings/memory-review/runtime-env 等，按页分批）。
- **G 排版/数字/文案**
  - G1(P1) 数字格式统一走 `lib/format`（chat.tsx:3285-3297 绕过，耗时/token/成本精度不一）。〔进度：已完成——chat.tsx RunMetricsLine 三处手写格式化改为 formatDuration/formatTokens/formatCost，与 runs/run-detail/overview/personal-usage 一致；typecheck/build exit0，Opus 终审通过（12 项格式化边界断言全过）〕
  - G2(P2) 日期/时区统一 formatter（本地无年份、UTC 两处手写复制）。〔进度：已完成——`lib/format` 新增 `formatUtcDateTime`（UTC，替代 personal-usage/ops 两份重复实现）与 `formatDate`（本地 date-only，用于 accounts 创建时间，替换 `toLocaleDateString`）；两处「必须 UTC」语义保留，typecheck/build exit0，Opus 终审通过（三时区实测）。遗留：`formatDateTime` 无年份属既有紧凑取舍，未改〕
  - G3(P2) 数值列右对齐+font-mono+tabular-nums（knowledge-evaluations/知识进度等）。
  - G4(P2) `2xs` 越界到可点击/普通区（conversation-search 等）→ xs。〔核查：DESIGN-SYSTEM 规定 2xs(11/16) 仅用于密集只读数据（trace 时间戳/ID/分组小标签），不用于可点击控件或正文；全仓约百处，绝大多数落在密集只读视图内属合法用法，逐处改写主观且收益低。已完成可辩护的明确违例：knowledge-search「查看来源」外链 `text-2xs`→`text-xs`（typecheck/build exit0、Opus 通过）；其余（含按钮内次级状态、密集数据行列）保留 2xs〕
  - G5(P2/P3) 文案统一：保存/保存更改、新建 X/创建、空值「—」vs「暂无描述」、已删除专家。
  - G6(P3) 图标尺寸档位、分区标题 13/14 上下文。
- **轮18（提交，P3 收尾批：运行环境 a11y + 状态指标层级）**：runtime-environments 表格与卡片列表补 `aria-label="运行环境列表"`、runtime-environment-detail 构建版本表补 `aria-label="构建版本列表"`（对齐 accounts/roles/knowledge-detail 既有命名）；status `Metric` 数值 12→`text-sm`(13)、标签仍 12（§4 层级）。typecheck/build exit0，Opus 终审通过。
- **轮19（提交，P3 收尾）**：accounts 空态图标按语义区分——搜索无结果用 `SearchX`、无账户用 `UsersRound`（新增导入）；roles 工具栏在「N 项权限未保存」已显示时不再重复通用「有未保存的更改」（仅非权限改动时显示）。typecheck/build exit0，Opus 终审通过。
- **轮20（提交，F/G/B/D 收尾批）**：F1 新建频道弹窗接入 useDraftGuard+DraftGuardDialogs（成功导航 ignoreBlocker 绕过残留 blocker）；G1 chat RunMetricsLine 耗时/token/成本改用 lib/format；G2 日期 formatter 收敛到 lib/format（新增 formatUtcDateTime/formatDate，合并两处 UTC 重复）；B2 已删除专家标签统一「已删除的专家」；D2 runtime-env-detail 返回入口入 leading。均 typecheck/build exit0、Opus 逐批终审通过，只本地提交。
- **收敛状态（轮20 后）**：主题 A/B1/C1/D1/D2(除 agents 详情)/E1/E2(除记忆提案主操作)/F1/F2/G1/G2/G3 已完成。剩余为**大或主观项**，按「不强行造改动」暂缓并留档：F3 保存禁用/失败内联（跨多页表单，需拆小片）、F4 多字段手写 useState→useZodForm（大）、E3 分页四形态抽共享 Pager（跨页中等重构）、G4 `text-2xs` 越界（约百处、主观）、G5 保存/新建文案（弹窗提交 vs 页级保存栏属合理差异）、G6 图标尺寸/分区标题、B2 AgentAvatar 接入运行详情（受数据约束）、agents 详情返回入口（页头复杂）。视觉回归抽检（`/channels`、`/runs`、`/runtime-environments`、`/knowledge` @1440x900，隔离栈+真实登录）渲染正常、无布局回归；G4 已完成 knowledge-search「查看来源」外链 2xs→xs 的明确违例修复，其余 2xs 属密集只读合法用法保留。
- **轮21（提交，前端测试对齐）**：跑 `pnpm test:web` 发现全量红灯（原 27 项失败/12 文件），多为分支内 UI 变更后未同步更新的既有单测。本轮修复 6 文件、18 项（2 个提交）：①`f0bbb56`——AgentPicker 替换原生 select（选项文案含角色，`===` 精确匹配失配）与运行环境详情删除收进「更多」菜单（默认环境改 `aria-disabled`）导致失配：schedule-feedback/memory-review-page/runtime-environments；②`26ea8f6`——角色「未保存」文案去重（轮19）与 A1 缓存刷新失败提示（内联 danger PageNote 带 `role=alert`）导致失配：account-rbac/audit-data-retention/chat-outputs。均仅调整断言/定位、保留行为断言，Opus 终审通过。
- **遗留测试债务（轮21 后仍未绿，建议单独「前端测试对齐」专项）**：9 项/6 文件，均来自**更早分支提交或环境/令牌层面**，非本轮 UI 一致性改动直接导致：`chat-scroll`(ResizeObserver 在 jsdom 未定义)、`chat-trace`(滚动容器 `group-focus-within/turn:opacity-100` class 断言)、`copy-button`(按钮文案 `已复制`/`复制编号`)、`plugin-detail`(`ps-11` padding)、`theme-contrast`/`ui-focus-states`(CDS 令牌契约)。修法涉及测试环境 polyfill 或设计令牌对齐，需单独评估。
- **轮22（提交，文档：视觉权威统一到 impeccable）**：用户要求设计规范适配 impeccable。核对发现项目已用 impeccable 产物（根 `PRODUCT.md` + `packages/web/DESIGN.md` 8 段 + `.impeccable/design.json`），但 `docs/DESIGN-SYSTEM.md` 自带重复 YAML 令牌 frontmatter 且根 `CLAUDE.md` 仍把它当「视觉单一来源」，形成两份部分规范。落地：`DESIGN-SYSTEM.md` 删除重复 frontmatter 与 §2.1/2.2/§3/§4 数值表、改为引用 DESIGN.md/令牌，保留全部工程/交互/无障碍/信息表达/动效/技术栈/禁止规约（512→约 388 行）；根 `CLAUDE.md`、`packages/web/CLAUDE.md`、`DEV-WORKFLOW`、`README` 权威指向改为视觉=DESIGN.md、工程规约=DESIGN-SYSTEM；`DESIGN.md` 自述反转为视觉权威并同步 Select/Combobox/InputGroup 聚焦为陶土微光（对齐现有实现，修正其过时描述）。Opus 复核「工程规约零丢失」通过。提交 `a1d852b`。后续项已完成（提交 `8af9477`）：①`.impeccable/design.json` sidecar 已按 schema 定点同步（Select/Combobox/InputGroup 聚焦改为陶土微光、仅 SourceEditor/CodeMirror 用 input-focus，更新 generatedAt；token/组件结构不变，JSON 校验通过）；②SKILLS/BASE-FIRST/PROJECT-BRIEF/UI-UX-REVIEW/DECISIONS-PENDING 的视觉权威表述已改指 packages/web/DESIGN.md，工程规约仍指 DESIGN-SYSTEM。

