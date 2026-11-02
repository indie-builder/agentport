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

