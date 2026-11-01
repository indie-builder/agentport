---
name: PACE
description: Claude CDS 亮色外观：暖灰画布、纯白内容面、陶土主操作、发丝边与双环浮层，数据蓝只属于图表。
colors:
  canvas: "#FCFCFB"
  surface: "#FFFFFF"
  panel: "#FFFFFF"
  sunken: "#F9F9F7"
  chip: "#F6F6F4"
  hover: "#F3F3F0"
  selected: "#EAE9E4"
  accent: "#EAE9E4"
  accent-foreground: "#151515"
  selected-foreground: "#151515"
  secondary: "#F3F3F0"
  secondary-foreground: "#151515"
  line: "rgba(0, 0, 0, 0.10)"
  line-strong: "rgba(0, 0, 0, 0.20)"
  control-boundary: "rgba(0, 0, 0, 0.35)"
  input: "rgba(0, 0, 0, 0.10)"
  input-focus: "#BDBDBD"
  link: "#A8482B"
  fg: "#151515"
  muted-foreground: "#525252"
  subtle: "#8A8A8A"
  primary: "#151515"
  primary-hover: "#151515"
  primary-foreground: "#FFFFFF"
  ring: "#D97757"
  button-primary: "#D97757"
  button-primary-hover: "#CC5A36"
  button-primary-active: "#AD4724"
  success: "#187646"
  warning: "#8A5600"
  warning-soft: "#FBF3E4"
  danger: "#B42318"
  danger-soft: "#FCEBE9"
  chart-runs: "#2A78D6"
  code: "#F6F6F6"
  code-block: "#0D0D0C"
  code-block-fg: "#E6E6E4"
  scrim: "rgb(0 0 0 / 0.4)"
typography:
  display:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "28px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  subheading:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
    letterSpacing: "0em"
  body:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "0em"
  md:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "26px"
    letterSpacing: "0em"
  label:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
  label-strong:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0em"
  meta:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0em"
  meta-strong:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
  mono:
    fontFamily: '"anthropic-mono", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
rounded:
  card: "12px"
  item: "8px"
  icon: "8px"
  tag: "6px"
  pill: "9999px"
  composer: "20px"
  bubble: "18px"
  dialog: "16px"
  popover: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.button-primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.item}"
    padding: "0 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.button-primary-hover}"
    textColor: "{colors.primary-foreground}"
  button-primary-active:
    backgroundColor: "{colors.button-primary-active}"
    textColor: "{colors.primary-foreground}"
  button-solid:
    backgroundColor: "{colors.button-primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.item}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.item}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.icon}"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.item}"
    padding: "0 10px"
    height: "32px"
  tab-list:
    backgroundColor: "{colors.hover}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.item}"
    height: "32px"
  tab-active:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.fg}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.icon}"
  badge-default:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.fg}"
    typography: "{typography.meta-strong}"
    rounded: "{rounded.tag}"
    padding: "0 8px"
    height: "20px"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.icon}"
    padding: "4px 6px"
  menu-item-highlight:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  sidebar-item:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.selected-foreground}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.item}"
    height: "32px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "16px 0"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.dialog}"
    padding: "16px"
  user-message:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.bubble}"
    padding: "12px 16px"
---

# Design System: PACE

## Overview

**Creative North Star: "The Quiet Workbench（静默工作台）"**

PACE 的世界是一张安静的暖灰工作台。根容器铺 `canvas #FCFCFB`，侧栏透明坐在画布上；主工作区是贴边平铺的纯白 `surface`，分区只靠底色差异与留白。工具、标题与正文是暖墨色，主操作与焦点用陶土 `clay`，状态只在需要时以小面积语义色或呼吸点出现。

这套系统用陶土承担「可执行」与焦点，用暖灰阶梯承担层级：普通主操作、发送、登录共用 `#D97757` → `#CC5A36` → `#AD4724` 三态实底；正文链接用深陶土 `#A8482B`；Input / Textarea 聚焦用陶土微光（1px 陶土边 + 三层微光），其余输入类用 `input-focus` 浅中性线，composer 用三态阴影。唯一的蓝色是运行图表首系列的数据蓝。层级由留白、分组、字重与实底/浅底关系表达，动作色不扩展到状态与数据。

本文是当前实现的快照，机器可读 token 以 frontmatter 为准；规范与用户已批准目标见 [DESIGN-SYSTEM](../../docs/DESIGN-SYSTEM.md)。配色与控件外观以 Claude Design System（CDS，参考 open-claude-ui）为准，仅亮色；2026-10-30 批准的布局契约与 2026-10-31 批准的字体收紧已落到当前实现。本文只记录实现值，不把未覆盖的浏览器证据写成已验收，未覆盖项与规范差异见 Known Gaps 和对应任务记录。

**Key Characteristics:**
- 平铺外壳：`canvas #FCFCFB` 画布 + 贴边 `surface #FFFFFF` 主区，无渐变、无外边距、无外层描边。
- 陶土动作三态：`#D97757` / `#CC5A36` / `#AD4724`，白字；hover/active 档对比度更高。
- 暖灰状态层：hover `#F3F3F0`，selected / accent `#EAE9E4`，chip `#F6F6F4`。
- 输入默认发丝边 `rgba(0,0,0,.10)`；Input / Textarea 聚焦用陶土微光（`.cds-focus-glow`：1px 陶土边 + `--shadow-focus-glow`），其余输入类聚焦用 `input-focus #BDBDBD`，composer 聚焦用 `shadow-composer-focus`；checkbox/radio 强边界 `rgba(0,0,0,.35)`，见 Known Gaps。
- 正文链接与 `link` 变体用深陶土 `#A8482B`；卡片用 `--shadow-panel`，hover 上浮 1.5px 并换 `--shadow-panel-hover`。
- 数据蓝 `#2A78D6` 只用于图表首系列，不参与任何 UI 动作；焦点环为陶土 `#D97757`。
- AnthropicSans → Inter → 中文回退的 13/20 界面档与 14/22 对话阅读档；CDS 弹簧、入场与呼吸动效按本页当前值。

## Colors

暖灰纸面、暖墨文字与陶土动作；没有外壳渐变或第二套强调色。

### Primary

- **陶土动作（Clay Action）** (#D97757 / #CC5A36 / #AD4724)：`default` 与显式 `solid` 主操作、发送、登录共用的实底三态；焦点环 `ring` 同为陶土。它是唯一的主操作与焦点强信号，不用于正文。
- **链接深陶土（Link Clay）** (#A8482B)：正文链接与 `link` 变体；白底 5.79:1、`selected` 4.76:1，保留装饰线下划线。

### Secondary

- **浅中性层（Quiet Neutral）** (#F3F3F0)：`secondary` 按钮、ghost 的 hover/展开、分段页签容器与悬停层；资源页胶囊分段轨道用 `sunken`。它表达「可交互或下沉」，不是文字色。
- **选中灰（Selected Gray）** (#EAE9E4)：当前导航项、选中页签、菜单键盘高亮、用户消息气泡。它与浅中性层只差一档，靠上下文而不是色相区分。
- **Chip 底（Chip Surface）** (#F6F6F4)：资源与角色标签的弱色底。

### Tertiary

- **数据蓝（Data Blue）** (#2A78D6)：只用于运行图表的首个数据系列。失败系列仍用 `danger`。它不是 UI 强调色，也不承担「可点击」语义。

### Neutral

- **画布（Canvas）** (#FCFCFB)：应用根容器与侧栏底色；公开分享页也铺这一层。它不再等同于纯白内容面。
- **纸白（Paper White）** (#FFFFFF)：`surface`、`panel`、卡片、弹层、主内容区与输入基底。内容区不得铺渐变。
- **分隔线（Hairline）** (`rgba(0, 0, 0, 0.10)`)：卡片与弹层的 1px ring、表格与分组分隔、页签当前项边框。只做分组；输入默认边线借用同值 `input`，但分隔本身不表达可编辑。
- **输入默认边线（Input Boundary）** (`rgba(0, 0, 0, 0.10)`)：Input、Textarea、Select 触发器、Combobox、InputGroup、CodeMirror 搜索输入的默认 1px 发丝边，等同 `line`；不新增 hover 加深。对白约 1.25:1，是已接受的已知限制。
- **输入聚焦（Focus Glow）** (`#D97757` + `--shadow-focus-glow`)：Input / Textarea 真实 `:focus-visible` 时把边线换成陶土并叠三层微光；陶土边对白约 3.12:1、对 `selected` 约 2.57:1。
- **输入聚焦线（Input Focus）** (#BDBDBD)：Select 触发器、Combobox、InputGroup 与 SourceEditor 普通聚焦时替换默认边线；对白约 1.88:1，低于 3:1。
- **Composer 聚焦（Composer Focus）**：composer 文本控制器真实聚焦时，InputGroup 外框保持 `input` 边线并换 `shadow-composer-focus`（1px 内环 + 外阴影），不叠加 2px 光环。
- **强边界（Strong Boundary）** (`rgba(0, 0, 0, 0.35)`)：`control-boundary` 用于未选中 checkbox/radio 与 off 开关轨道；对白约 2.43:1、对 `selected` 约 2.00:1，低于 3:1，是 CDS 已接受的限制。`line-strong` (`rgba(0, 0, 0, 0.20)`) 只作较强分隔。
- **正文墨（Text Ink）** (#151515)：正文、标题、选中项前景与普通图标。
- **辅助灰（Helper Gray）** (#525252)：placeholder、描述、元信息、注释、表头次要信息；承载可读文字。
- **装饰灰（Decorative Gray）** (#8A8A8A)：只用于装饰图标与禁用例外，不承载需要阅读的信息。
- **代码块（Code Block）** (#0D0D0C / #E6E6E4)：围栏/块级代码的深色面与浅色正文；行内 `code` 仍是浅 chip `#F6F6F6`，两种代码形态不互换。
- **状态色**：success `#187646`、warning `#8A5600`、danger `#B42318`；浅底分别是 `#FBF3E4`、`#FCEBE9`。只在小面积表达结果。
- **遮罩（Scrim）** (`rgb(0 0 0 / 0.4)`)：Dialog、Sheet 等模态遮罩。

### Named Rules

**The Flat-Shell Rule.** 应用外壳平铺全幅：根容器铺 `canvas #FCFCFB`，侧栏透明坐在画布上，主内容区贴边铺 `surface #FFFFFF`。外壳不得再加渐变、圆角、外边距、描边或悬浮阴影；分区只靠画布与表面的底色差异。

**The Clay-Action Rule.** 主操作与焦点使用陶土：`default` 与显式 `solid` 共用 `#D97757` → `#CC5A36` → `#AD4724` 的实底三态与白字，焦点环 `ring` 同为 `#D97757`。链接用深陶土 `link #A8482B`；蓝色不是动作色。

**The Data-Blue Exception Rule.** `#2A78D6` 是系统中唯一的蓝色，只允许出现在 `chart-runs` 数据系列；失败用 `danger`。它不得蔓延到导航、按钮、焦点、徽章或状态。

## Typography

**Display Font:** AnthropicSans → Inter（`"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif`）
**Body Font:** 同上
**Label/Mono Font:** AnthropicMono → JetBrains Mono（`"anthropic-mono", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`）

**Character:** 一套人文无衬线承担全部界面与阅读，等宽只服务代码、标识与数值。字号克制，层级靠字重、间距与对齐，不靠新增字号档。

### Hierarchy

- **Display** (500, 20px/28px, -0.02em)：只用于对话欢迎区标题「今天想完成什么？」。
- **Title** (500, 16px/24px, -0.01em)：普通页面 h1 与无效分享页标题。
- **Subheading** (500, 14px/22px)：列表标题、卡片标题、对话标题与对话内的区块标题。
- **Body** (400, 14px/22px)：对话、Markdown、OpenUI 默认正文与对话输入；用户气泡共用同一档与行高。
- **Reading** (400, 15px/26px)：运行详情、评估、记忆与插件详情等保留的原有正文/标题用途；不是第二套对话正文。
- **Label** (400/500, 13px/20px)：导航、按钮、输入、表格单元格与说明文字。这是界面默认档。
- **Meta** (400, 12px/16px)：徽章、时间戳、ID、表头与密集只读元信息。
- **Mono** (400, 12px/20px)：代码块、行内代码、标识与数值读数。

`body` 的起点是 15px/1.5，只作未显式覆盖时的兜底；主要界面与对话分别显式使用 13/20 与 14/22，不能把兜底当作阅读规范。`body` 使用 `text-wrap: pretty`；`h1`–`h3` 使用 `text-wrap: balance` 并加 `letter-spacing: -0.01em`。字号与布局几何不做全局 rem 缩放。OpenUI TextContent 显式 `small` 13/20 与 `large` 16/24 保留，默认跟随 14/22。

### Named Rules

**The One Reading Size Rule.** Markdown 阅读正文只有 14/22 一档：h1 18/26、h2 16/24、h3–h6 14/22 加 600 字重（以外层字号为下限），任何标题都不小于正文。不要再引入第二个正文尺寸。

**The 13/20 UI Rule.** 可操作控件与界面文字默认 13/20；11px 只留给高密度只读数据，12px 只给元信息与徽章，不用小字去弥补层级不足。

## Layout

桌面端布局，窗口窄于 `lg` 时侧栏改为抽屉，仍按桌面密度，不为触摸新增尺寸。应用外壳平铺全幅：根容器铺 `canvas` `#FCFCFB`，透明侧栏（展开 224px / 收起 64px）直接坐在画布上，主内容区贴边铺 `surface` `#FFFFFF`；没有外层圆角、外边距、渐变、描边或阴影。分区靠画布与表面的底色差异和留白表达。

非 chat 内容区水平、底部各 24px（`px-6 pb-6`）；`Page` 默认区块间距 24px，`PageHeader` 单行最小高 56px、不另加顶部或横向 padding，`PageSection` 内部间距 16px、默认顶部 20px。`PageToolbar` 自身 `gap-3`（12px），控件内部 8px 由组内组合决定；搜索桌面 224px 且可收缩，筛选 144px，排序 128px。窗口收窄时允许换行、内部滚动与容器伸缩，但表格只在自身容器内横向滚动，页面不出现横向溢出。

对话阅读轴线 832px，含左右 24px 的外容器最大 880px；聊天没有横跨三栏的外顶栏，历史、消息列与成果栏从工作区顶部并排开始。消息列自带 56px 头部（`px-6`，左右 24px）：历史收起时显示历史开关、搜索、唯一专家选择、标题操作与成果开关；历史展开时只留历史开关、标题操作与成果开关，专家选择与搜索、新建移入历史头部。历史头部同为 56px（`px-3`、`gap-1`）：左侧专家选择，右侧 32px ghost「新建会话」；侧栏不再有新建会话入口。成果面板 400px 从顶部开始；Composer 在消息列之后距底 24px、始终同一位置。会话历史默认收起 0，首次展开 240px，可在 200–360px 间调整并记忆。窄桌面历史 Sheet 同理，Sheet 关闭后回到消息头部。

资源中心工具区固定两行：首行类型导航与管理操作，次行来源/搜索/筛选/排序/数量；专家卡以独立操作行收尾，不设底带或分隔线。个人模块使用标准 Page / PageHeader / PageSection 骨架，默认个人资料，各分区可直达并提供返回工作区；入口在侧栏底部用户信息，展开与收起行为一致；进入后由同一主侧栏承载六项个人导航，具体几何见下方 Personal。

间距节奏取 4 / 8 / 12 / 16 / 20 / 24px。所有尺寸、宽高、图标 16px / `strokeWidth 1.75`、边框 1px、页签指示线与焦点 2px 以当前实现值为准；几何调整只按已批准布局契约进入，不通过新增 border 或页面级 padding 临时改变。

### Schedules（定时任务）

- **Dialog:** 新建与编辑共用 `DialogShell`，最大宽 1024px，沿用 20px 水平内容边；表单容器 ≥800px 时两栏：左栏自适应、右栏总宽固定 320px（含 1px `line` 竖分隔与 24px 左内边距，不额外累加），两栏 gap 24，右栏 `self-start` 自然高；更窄的桌面窗口顺序堆叠。不改现有全局 token、主题与 shadcn/Base UI 控件尺寸。
- **Editing surface:** 左侧是开放编辑面，不包分区卡。名称常态无边框（透明 border）、14/22 medium，占位「任务名称」，关联标签 sr-only；下方 16px 是可见「任务内容」标签与 Textarea。Textarea 常态透明边框、最小高 160px（约 8 行）、随内容自然增高；聚焦与错误态仍用共享输入边线与焦点规格。
- **Expert:** 紧接正文下 12px 的轻工具行：标签「执行专家」在左，内容宽 Select 在右（最大 240px）；不设大分区、不 `mt-auto` 贴底。编辑已有任务时专家只读。
- **Right:** 顶部「执行计划」标题，频率与时间（UTC）同行；weekly 七个 Toggle 多选星期、至少一天，custom 直接编辑五段表达式并原样回填，五段 cron 是后端唯一存储值。启用开关在执行计划后 20px，不贴底。
- **Footer:** 取消（outline）在前，创建任务 / 创建中… 或保存更改 / 保存中…（常规主操作）在后，右对齐；短视口页脚 sticky、始终可达；保存中禁用关闭与提交，dirty 的取消、Esc 与外部点击沿用共享放弃确认。
- **Out of scope:** 不提供位置或时区选择，也不出现模型、附件、授权、到期、输出方式等后端不支持的项。
- 实现与验收记录见 [schedule-ui-redesign](../../docs/tasks/schedule-ui-redesign.md)；用户尚未认可外观，技术与视觉评审不构成用户的设计批准。

### Knowledge（知识库）

- **创建**：默认只显示名称、描述；Slug、模型、分块与 Wiki 自动刷新在「高级设置」。唯一可用向量模型默认选中，中文名称可自动生成有效 slug；多个模型需明确选择。高级字段报错自动展开并聚焦。成功后直接进入该库文档工作面。
- **详情**：标准 56px 页头，左侧返回、库名和状态，右侧 32px「使用此库的专家」「设置」；任务按文档、来源、检索测试、Wiki、处理记录排序。文档栏为 220px 文件夹 + 20px 间距 + 自适应内容，标签管理邻近标签筛选，上传为主操作。权限按既有动作叶分别呈现。
- **恢复与关系**：首次失败文档进入按文档过滤的处理记录；记录含对象、错误与分页。处理表最小 1024px，对象最小 224px、步骤最小 240px，窄桌面只在表格容器内横滚。专家关系只显示有权确认的配置，无法确认时明确提示；空关系提供现有专家列表入口，不另造绑定编辑。
- **设置**：模型选择读取安全候选投影，端点管理仍用独立权限；切换模型立即影响检索，已有文档需重建恢复向量检索。未保存设置不能执行重建；重建逐文档切换新版本，失败文档保留原版，成功文档不回滚。空白 Wiki 可直接写作，已有版本未加载时不会误当首版。
- 布局与动线记录见 [knowledge-ux-review](../../docs/tasks/knowledge-ux-review.md)。该验收使用真实组件与固定数据隔离夹具，不覆盖真实登录、外部来源、模型调用与写链路，外壳侧栏为等价几何占位；测量数字见任务记录。已发布 Wiki 尚未进入专家检索，单独跟踪。

### Personal（个人）

- **导航：** 进入 `/personal/*` 后，主导航把「工作 / 构建」替换为三组六项：与专家协作（个人记忆、记忆提案）、工作记录（我的分享、使用记录）、账号（个人资料、账号安全），继续使用共享 `SidebarLink`、`aria-current`、展开 224px / 收起 64px 与窄桌面 Sheet；内容顶部不再出现横向 chip。侧栏底部依次为「返回工作区」、独立「退出登录」与账号入口；无对应权限的项按现有 permissionIds 隐藏，退出仍走现有登出跳转。
- **页头与轴线：** 六页都从单行 56px `PageHeader` 开始，恰好一个 h1；统一左对齐、与普通页面同宽、不限制整页 1024px 的 `Page`，页头、正文与操作共右轴，不再嵌套 768/896 次级宽度。沿用外壳左右 24px、底部 24px；组内 8/12、子组 16、区块 24。分区标题 14px medium、正文 13px、元信息 12px，个人模块列表主信息 14px；局部操作贴内容边界，全页动作 32px。分区线按渲染顺序：PageHeader 下第一个顶层分区不画线，其后每个顶层分区以 1px 分隔线 + 20px 上内距隔开；折叠或条件区块按当前是否渲染判断谁在第一。纯几何只写在本节，不新增私有全局组件规则。
- **个人资料：** 姓名字段最大宽 448px，横向标签列 96px，字段值与取消 / 保存右对齐；姓名、用户名与角色先出现，业务 ID 收在按需展开的「账号详情」中，展开后仍完整可读。个人资料与账号安全表单共用同一字段尺度；页头下的资料表单是第一分区，其后「身份」区以 1px 分隔线 + 20px 上内距开始。
- **个人记忆：** 阅读态优先正文，阅读正文限 75ch，显式「编辑」；编辑态复用现有 SourceEditor，编辑区与版本历史用整条内容宽，取消 / 保存与未保存状态就近出现，保存成功明确「下一轮对话会带入」。空态左对齐任务轴并提供「自己填写」与「从对话整理」两个动作，「从对话整理」进入记忆提案创建。版本历史作为按需展开的 Collapsible 放在正文之后的同一内容带，不常驻空版本列。
- **账号安全：** 页头「修改密码」按需展开表单，默认先呈现当前会话与其他登录会话；当前会话与其他会话为独立分组，分组标题用 h2。表单依次为当前密码、新密码、确认新密码，与个人资料同字段尺度，并明确提交后撤销全部会话。当前会话不可撤销；其他会话主行显示最近活动时间、IP 与就近撤销动作，完整 UA、登录时间与到期按需展开全文；会话鲜度 403 在会话区说明并提供重新登录，撤销失败在当前弹层内可见。改密收起时会话区是第一个顶层分区、不画线；展开后改密表单在前，会话区以 1px 分隔线 + 20px 上内距开始。只呈现现有字段，不猜设备、位置或风险等级。
- **记忆提案：** 创建按「来源 → 目标与执行专家 → 核对摘要」三步推进，未真实选择前不代用户决定；列表以目标与决策状态为主、摘要为次、成本为元信息。详情在单个 Dialog 内竖向滚动，先完整呈现目标与修改前后差异（含索引变化），再给理由、证据与来源，最后提供采纳 / 拒绝 / 重新生成；长段落与索引完整换行，不截断、不横向溢出。无变化时只标记「无需变更」并展示当前内容一次，不渲染修改前后对比网格；失败原因显示 worker 终态文案（如「记忆提案生成超时」）。采纳后给出去目标查看的入口，拒绝时明确链接查看的是当前内容。
- **我的分享：** 文件名为可识别主信息，来源会话、分享时间与操作首行对齐；来源会话标题默认两行，同一标题节点经「展开来源」切换为全文并可跳转来源对话，按钮随之变为「收起来源」，不额外复制标题。每行显式提供「查看分享」「复制链接」，撤销作为次要危险动作就近出现；撤销确认说明链接将立即失效，失败留在当前弹层。只在 `DataTable` 内显示一次当前页行数，游标分页放在表格之后。
- **使用记录：** 汇总窗口与统计合并为紧凑区，运行明细更早进入首屏；汇总为无卡片三行 `dl`（运行含总计与六状态、Token 输入/输出、已记录成本），状态以小网格呈现并保留全部计数。主表保留专家、来源、状态、时间与去向五列，落点动作同视野可见，不靠整行点击猜测；耗时、成本、Token 与运行 ID 收在原生 `DataTable` 展开详情中，不改变查询、汇总或权限；提供复用 status 过滤的「只看失败」。汇总区是第一顶层分区、不画线；有 `overview.read` 时运行区以 1px 分隔线 + 20px 上内距开始，无该权限时运行区本身是第一分区、不画线。

### Roles（角色）

- **布局**：顶部横向每个角色一列，左上角为功能表头，列头用 `sunken` 底区分；左侧纵向为功能层级树的行头，父功能下缩进查看、创建等子功能，整组可展开收起，不把父子平铺成「专家 · 查看」；数据区只用 `surface`/白底，单元格只放复选框（父级三态），授权范围在矩阵外的角色设置中配置，整张矩阵一次保存。角色增多时只在表格容器内横向滚动。
- **展开与未保存反馈**：保留上述布局；工具栏提供「全部展开」「全部收起」，每个功能组行头仍可独立折叠，搜索期间强制展开并禁用折叠。单元格变化按保存基线的逐叶 scope 集合差异判定，新增、撤销与范围调整分别标记（`td data-changed` + 中性浅底/边界，title 与复选框 `aria-description` 说明），父组收起时聚合子叶变化仍可见。工具栏显示真实变化的叶权限数与最近一次角色/功能/动作，改回基线或保存成功即清除；父组只聚合不重复计数。
- **实现机制**：矩阵的唯一表单草稿由 `src/lib/use-zod-form.ts` 的 `useZodForm` + React Hook Form 管理：`useFieldArray` 负责角色增删，单元格与角色列头按字段路径用 `useController`/`useWatch` 订阅，`defaultValues`/`reset`/`dirty` 与离开保护共用同一份状态，不另存基线副本。功能层级行的展开收起由 TanStack Table 9.3.1 `rowExpandingFeature`（`createExpandedRowModel`、`autoResetExpanded:false`）管理，全部展开/收起用 `toggleAllRowsExpanded`。服务端状态仍由 TanStack Query、可导航状态仍由 TanStack Router 承担，职责不变。
- **性能**：2026-10-31 在迁移前后用同一脚本、同一隔离夹具（89 个权限叶、4 个角色、556 个复选框）、1480×840 开发模式下，从 React 根 fiber 读取 `actualDuration`，预热 2 次、采样 12 次对比。迁移前（页内 memo + 手写草稿）点击窗口内全部 commit 合计中位/P95 为 23.95ms/34.10ms，迁移后（RHF + TanStack Table）为 16.70ms/18.40ms；角色名输入路径从 23.00ms/44.20ms 降到 15.95ms/23.80ms。点击的首次 commit 从 15.05ms 变为 16.60ms、事件到首次 commit 从 17.50ms 变为 21.85ms，略有回退；角色名输入的首次 commit 从 23.00ms 降到 13.40ms、事件到首次 commit 从 29.6ms 降到 19.6ms，因此不能概括为所有指标更快。数字为 React commit 时间，不等于绘制延迟，本轮未测绘制。基线以 RHF `defaultValues` 为唯一来源，变化计数按 `roleId` 统计 scope；重新加载返回 503 时保留草稿。本轮 90 个 web 用例及 typecheck/build/lint:focus/lint:contract/Biome/diffcheck 均通过。
- **视觉验收**：2026-10-31 以真实组件 + 固定数据隔离夹具实测（89 个权限叶、4 个默认角色；夹具拦截全部 API 写请求）：1492px 窗口页头 139px、556 个数据 `td` 每格一个 checkbox，列头浅灰、功能行头白；1024px 窗口文档宽 1024、表格容器 client 宽 738；新增第 5 个角色后容器 `scrollWidth` 799，`scrollLeft` 为 60.5 时 sticky 功能行头仍在 x=248；关闭角色设置后焦点回到实际触发器，整组折叠与搜索展开均已实测。未覆盖真实登录与 PUT 写库，不代表用户认可。

## Elevation & Depth

系统默认是平的。外壳、表格与列表没有投影；卡片用 `.cds-card-interactive` 的 `--shadow-panel`（1px `line` 环 + 轻投影），卡片 hover 上浮 1.5px 并换 `--shadow-panel-hover`。深度只出现在卡片、浮层与 Composer：所有菜单、Select、Popover、Dialog、Sheet、Toast 共用 CDS 双环 overlay 阴影；Composer 使用默认/hover/聚焦三态阴影，普通输入的陶土微光只属于焦点。

### Shadow Vocabulary

- **Overlay** (`inset 0 0 0 1px rgba(0, 0, 0, 0.10), 0 0 0 1px rgba(0, 0, 0, 0.10), 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)`)：菜单、Select、Combobox、Popover、Dialog、AlertDialog、Sheet、Toast。`shadow-md` 与 `shadow-lg` 都映射到这一值。
- **Composer**：默认 `0 4px 20px rgba(0, 0, 0, 0.035), inset 0 0 0 1px rgba(0, 0, 0, 0.10)`；hover `0 4px 24px rgba(0, 0, 0, 0.06), inset 0 0 0 1px rgba(0, 0, 0, 0.20)`；聚焦 `0 4px 24px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(0, 0, 0, 0.20)`。
- **Focus Glow** (`inset 0 0 0 1px #ffffff, 0 0 0 1.5px #d97757, 0 0 6px 1px rgba(217, 119, 87, 0.25)`)：普通输入与文本域经 `.cds-focus-glow` 使用的陶土焦点信号；无边框按钮类仍用单层 2px `ring`。
- **Panel** (`0 0 0 1px rgba(0, 0, 0, 0.10), 0 1px 3px rgba(0, 0, 0, 0.04)`)：卡片常驻边界与轻投影，取代单独 ring。
- **Panel Hover** (`0 0 0 1px rgba(0, 0, 0, 0.20), 0 4px 16px -2px rgba(0, 0, 0, 0.09)`)：卡片 hover 时配合 `translateY(-1.5px)`。
- **Modal Scrim** (`rgb(0 0 0 / 0.4)`)：模态遮罩，不是阴影。

### Named Rules

**The One-Shadow Rule.** 浮层只有一种双环阴影值，Composer 只有三态阴影，卡片只有 `--shadow-panel` / `--shadow-panel-hover` 两态，外壳无阴影。不得新增第二套浮层阴影，也不得给卡片或外壳叠加其它投影；陶土焦点微光只用于焦点，不作为常驻装饰。

## Shapes

形态是克制的圆角矩形：外壳本身平铺全幅、没有外框圆角；卡片与线程容器为 12px，Dialog 为 16px，Popover / Select / Combobox / DropdownMenu 为 10px，Composer 为 20px，用户消息气泡为 18px；常规按钮、输入、页签容器、菜单项与侧栏展开条目为 8px。共享 `Button` 的 `size="icon"` 32px / `icon-lg` 36px、紧凑 28/24px 图标按钮、小控件、页签项与侧栏折叠按钮实例均为 8px。徽章、标签与侧栏收起态 32×32 图标块为 6px；头像、胶囊按钮与模型选择器为 9999px。Checkbox 保持 4px。

边线宽度全部沿用既有值：1px border/outline、2px 页签指示线与焦点轮廓。只换颜色，不通过新增边框改变控件尺寸。容器用圆角裁切图片与内容，不使用斜切、硬投影或装饰性几何。

## Components

### Buttons

暖墨与陶土工具，次要动作保持轻。

- **Shape:** 常规高 32px、8px 圆角、13/20 500；紧凑 28px / 8px；大号 36px。图标按钮用 `size="icon"` 32px / `icon-lg` 36px，与 `icon-sm`（28px）、`icon-xs`（24px）同为 8px；侧栏折叠按钮实例也显式 8px。保留 1px 透明边框占位，尺寸不因换色变化。所有共享按钮带 `.cds-btn-squish`：active 时 `scale(0.975)`，使用 15 阶 `--btn-spring` 弹簧。
- **Primary:** `default` 用 `button-primary` 陶土实底、白字，hover `#CC5A36`、active `#AD4724`；disabled 仅降透明度并禁止交互。
- **Solid:** 发送、登录等显式动作与 `default` 共用同一陶土三态实底。
- **Outline / Secondary / Ghost / Plain:** outline 白底、1px `line` 边线、`fg` 字，hover 与展开 `#F3F3F0`；secondary 用 `#F3F3F0` 底；ghost 透明，hover 与展开 `#F3F3F0`；plain 保持透明且不加 hover 底。取消、筛选与菜单触发器不因主操作改成陶土实底。
- **Link:** `#A8482B` 深陶土文字，保留下划线 hover 与可访问名，不靠蓝色表明可点击。导航与下载入口用原生 `Link` / `<a>` 配 `buttonVariants`，保持链接语义与既有外观，不用 `Button` 强制 `role=button`。
- **Focus:** 实底按钮用单层 2px 陶土 `ring`，并在实底外留 2px 背景色间隔；invalid 时危险边框与焦点环共存，实底 offset 不消失。除 Input / Textarea 的陶土边 + 微光（`.cds-focus-glow`）与其余输入类的边线换色算同一焦点信号外，不要同时出现边框与光环两层普通态焦点信号。

### Tabs

- **Segmented:** 容器 `#F3F3F0`、8px、3px 内边距、高 32px；项为 8px 圆角、13/20，未选中 `#525252`、hover `fg`；当前项用 `#EAE9E4` 底 + `fg` + 1px `line` 边框，去掉小阴影。
- **Resource segmented:** 资源页「内部 / 市场」用胶囊轨道：`sunken` 底、`rounded-pill`、`p-0.5`；当前项为 `surface` 白 thumb + `fg` + `shadow-sm`，非当前项 `muted-foreground`、hover `fg`。
- **Line:** 列表透明、不铺底；当前项文字 `fg`，底部 2px `primary` 指示线保持原位置与宽度。
- **Focus:** 页签项用单层 2px 陶土 `ring`，不改变容器尺寸。

### Inputs / Fields

- **Style:** 白底、1px `input` `rgba(0,0,0,.10)` 发丝边、8px 圆角、高 32px、13/20；placeholder `#525252`。Input、Textarea、SourceEditor、Select 可编辑触发器、Combobox、InputGroup 与 CodeMirror 搜索输入共用同一默认边线与尺寸；不新增 hover 加深。共享 Input / Textarea 保持 13/20；对话 composer 文本区例外使用 14/22（`base`）。桌面窗口收窄（含 767px）时仍固定 13/20，不再切换 16px 移动端字号。
- **Focus:** Input / Textarea 把既有 1px 发丝边换成陶土并叠 `--shadow-focus-glow` 三层微光（`.cds-focus-glow`）；Select 触发器、Combobox、InputGroup 与 SourceEditor 仍把边线换成 `input-focus` `#BDBDBD`；composer 文本控制器聚焦时外框保持 `input` 边线并换 `shadow-composer-focus`（1px 内环 + 外阴影），均不叠加 2px 光环；InputGroup 由外框承担焦点，内部输入不再画第二层。
- **Invalid / Disabled:** invalid 用 `danger` 边框优先，并用真实 `:focus-visible` 的 2px `ring` outline + 2px offset 补焦点；错误边框不能代替焦点。只有真实禁用的输入才使用独立于输入边线的禁用背景与透明度（`control-boundary/50`），空内容只禁用发送按钮。未选中 checkbox/radio 用 `control-boundary`，checked/on 用 `primary` + 白色勾/点/thumb；off 开关轨道用 `control-boundary` 与白 thumb；Toggle 选中态是 `selected` + `fg`，不是深色实底。选中的 checkbox / radio / switch 聚焦时用单层 2px `outline` + 2px offset，不叠加 ring；未选中沿用各原语既有的单层焦点信号；普通字段标签由控件自身表达焦点，卡片式字段标签统一用外圈。真实浏览器已实测选中 Checkbox/Switch/Radio（`outline solid 2px`、`offset 2px`，无可见 ring）、普通标签、卡片标签、独立 invalid 控件，以及卡片 invalid 组合（3 个控件 border `rgb(180,35,24)`，内部 outline none / ring 0，外层 label 单层 2px ring）；forced-colors 系统轮廓保留。

### Menus / Popovers / Overlays

- **Menu / Select / Combobox / Popover:** 白浮层、1px `line` ring、双环 overlay 阴影；菜单与浮层 10px 圆角（`--radius-popover`），菜单项 8px 圆角、`4px 6px` 内边距。浮层经 `.cds-overlay-enter` 以 `opacity` + `scale(.96)` → `1` 弹入（200ms）。普通文字 `fg`、描述 `muted-foreground`；hover 与键盘高亮用 `accent` `#EAE9E4` + `accent-foreground` `#151515`；危险项用 `danger`，不被普通 hover 覆盖。
- **Dialog / AlertDialog / Sheet:** 基础 Dialog 白表面、16px 圆角（`--radius-dialog`）、1px `line` ring、overlay 阴影、16px 内边距；`DialogShell` 改为 `p-0`，头部 `px-5 py-3.5`、内容区 `px-5 py-4`。Modal 遮罩 `scrim`。基础 Dialog 标题 14/21 500（`leading-normal`），描述 13/20 `muted-foreground`。确认的主操作为陶土实底，取消为 outline，危险确认保持 destructive。Sheet 贴边展示，不设圆角。
- **Tooltip / Toast:** Tooltip 保留既有反色（`fg` 底、白字），不做成白浮层；Toast 白底、1px `line`、overlay 阴影，操作按钮用显式 outline，关闭按钮白底中性 hover。Toast、操作按钮与关闭按钮的焦点都用单层 2px `ring` outline、offset 2；操作按钮只用该 outline，不叠加按钮基类 ring 与焦点阴影，视觉上不出现第二圈光环。

### Cards / Tables / Lists

- **Cards:** 纯白底、12px 圆角、1px `line` ring；卡片统一带 `.cds-card-interactive` 的 `--shadow-panel`，卡片 hover 上浮 1.5px 并换 `--shadow-panel-hover`。Card 根是带 `py-4` 的纵向 flex，子块间距 16px（`size="sm"` 为 12px），根本身没有水平 padding；Header、Content、Footer 各自承担 16px 水平内边距，Footer 独立 `p-4`，存在 Footer 时根 `pb-0`。因此不能描述成「所有裸 Card 子节点统一 p16」。CardTitle 为 14/22（`text-base`），sm 卡为 13/20（`text-sm`）；描述 13/20 `muted-foreground`。真实浏览器已测量标题行高 22px。
- **Expert card:** 208px（`h-52`）固定高、同列宽、16px 网格 gap 与内边距、40px 头像（「创建数字分身」入口保持 80px）。已创建卡按 208px 固定预算布局：上下内边距各 16px（合计 32px）、48px 身份头部、12px、72px 中部、12px、32px 操作行。身份头部为 40px 头像加名称链接与角色两行，停用徽章与角色同行，右上角只保留「更多」操作菜单；中部为全宽、最多两行的介绍与最多两行的权限原因，空介绍保留中部空间且不造占位文案；底部为独立 32px 操作行，左侧「开始对话」主操作，右侧带 `IdCard` 图标的 outline「工牌」按钮。无使用权限时权限原因可见并以 `aria-describedby` 关联「开始对话」，停用专家不提供可执行对话。可访问名为「查看 <名称> 工牌」的按钮打开工牌专用的插画式实体证件：沿用 Base UI Dialog 的焦点、Esc/外部点击关闭与关闭后返回原触发器，但作为明确例外使用透明 DialogContent，不套标准头部或白色弹框外壳，标题「<名称> 的工牌」仅 sr-only，关闭按钮可达，不改动全局 DialogShell 契约。视觉为居中的 96px 挂绳与扣环连接 360px 宽竖式卡套，内含 96px 原插画头像；卡套以真实 DOM 展示数字员工身份、姓名、岗位、启停、完整介绍、员工编号（真实 id）与上岗时间（真实 `createdAt`，含年与时区；缺失或无效显示「未记录」，空介绍显示「未填写介绍」）。短视口整体单层滚动，长姓名与介绍不截断；白底中性 token，现有插画配色例外沿用，不新增动效；只读不请求详情，不展示提示词、成员资料或二维码等虚构统计。不使用 CardFooter、底带或分隔线。**保留（受保护）**：找专家页的扇形「新建专家」入口卡与「创建数字分身」卡是用户刻意要求的创建入口，不得删除、合并或改为仅页头入口。
- **Tables / Lists:** 纯白底、1px `line` 分隔；表头 12px `muted-foreground`，单元格 13/20；行 hover 与展开用不透明 `hover` `#F3F3F0`，选中用 `selected` `#EAE9E4`；卡片页脚同为 `hover` `#F3F3F0`。真实浏览器已测量表头 12px 辅助色与行/页脚底色。
- **Skeleton / Progress / Separator:** Skeleton 用 `sunken`；Progress 活跃主线用 `primary`，终态走原结果语义；Separator 用 `line`。

### Empty states

- 空态沿用 `EmptyState` / `PageNote`：`EmptyState` 传 `illustration` 时替换原 40px 圆底图标，未传保持默认图标与动作；行内 `PageNote` 复用 `icon` 槽。业务插画只经 `BusinessIllustration` 取 `standard` 96px / `compact` 64px / `error` 144px 三档，固定宽高、`alt=""`、`aria-hidden="true"`，纯装饰、无文字、无动画；`public/brand/scenarios/` 六张场景图仍只服务品牌 Logo 切换。

### Messages / Code / Charts

- **User message:** 右对齐 18px 胶囊、`selected` `#EAE9E4` 底、`fg` 文字、14/22、内边距 12px 16px、最大宽 85%；附件用中性 outline 徽章。助手正文在纯白上无气泡。
- **Message entrance:** 每轮消息以 `.message-fade-up` 入场（0.4s 上浮淡入）；减少动态效果时直接显示。
- **Code / Shiki:** 围栏/块级代码为深色面 `code-block` `#0D0D0C`、12px 圆角、1px `white/10` 边线、12/20 等宽；Shiki 背景透明，浅色语法用 `code-block-fg` `#E6E6E4`，关键字/函数/链接用暖陶土调的浅色，注释、参数与标点用暖灰层次，复制反馈 2.5s 后衰减回初始态。行内 `code` 仍是浅 chip `#F6F6F6` 配 `fg`。深色代码块内选区用陶土半透明底配白字。
- **CodeMirror:** selection 与 searchMatch 用 `selected`，gutter `muted-foreground`，搜索面板白底 `fg`，真实可编辑搜索输入使用 `input` 默认边线与 `input-focus` 聚焦边线，按钮仍用 `line`。
- **Charts:** 白底、网格 `line`、坐标与 tooltip 用 `muted-foreground` / `fg`；首系列 `chart-runs` `#2A78D6`，其余系列用中性灰阶并叠加虚线/纹理，失败系列 `chart-failed`（即 `danger`）。图表不播放动画。

### Navigation

- **Sidebar:** 透明底，坐在 `canvas #FCFCFB` 画布上；宽 224px / 收起 64px。条目高 32px；展开态 8px 圆角（`rounded-item`），收起态为 32×32 图标块、6px 圆角（`rounded-tag`）。普通文字 `fg`，分组与账号元信息 `muted-foreground`；hover `#F3F3F0`；当前项 `selected` `#EAE9E4` + `selected-foreground` `#151515`，保留 `aria-current`，不加彩色竖条。收起态状态只落在图标块上。工作分组不再包含记忆；进入个人模块后，同一主侧栏把工作 / 构建分组替换为「与专家协作 / 工作记录 / 账号」三组六项（个人记忆、记忆提案、我的分享、使用记录、个人资料、账号安全），当前项与折叠几何不变，不新增第二套导航。
- **New conversation:** 只在会话历史头部出现，32px ghost 图标按钮；侧栏不设新建会话条目。
- **Account / personal entry:** 账号触发器保留紧凑 12px 标签与 8px 圆角；展开时头像与姓名靠左、按账号入口外观呈现，不套用导航选中行；展开与收起状态点击都进入同一「个人」模块（默认个人资料），不直接登出。个人资料只自助编辑显示姓名，username/businessId/角色只读；个人模块包含个人资料、个人记忆、记忆提案、账号安全、我的分享与使用记录；分享表格标题为「我的会话分享」。专家记忆、定时任务与平台凭据不迁入个人模块。登出保持独立动作，位于「返回工作区」与账号入口之间，不占页头。账号入口本身是链接，不再保留账号下拉菜单；通用菜单 hover/键盘高亮仍用 `accent` `#EAE9E4`。

## Do's and Don'ts

### Do:

- **Do** 保持外壳平铺全幅：`canvas #FCFCFB` 画布 + 贴边 `surface #FFFFFF` 主区，无渐变、外边距、外框圆角或描边。
- **Do** 用 `button-primary` 陶土三态（`#D97757` / `#CC5A36` / `#AD4724`）承载 `default` 与 `solid`，配白字。
- **Do** 用 `input` `rgba(0,0,0,.10)` 画输入默认发丝边，用 `line`（同值）只做分组与分隔；checkbox/radio 强边界用 `control-boundary` `rgba(0,0,0,.35)`。
- **Do** 用 `selected` / `accent` `#EAE9E4` 表示当前导航、选中页签、菜单高亮与用户消息。
- **Do** 每个控件只留一层常驻焦点信号：Input / Textarea 用 `.cds-focus-glow`（1px 陶土边 + `--shadow-focus-glow`），其余输入类换 `input-focus`，composer 换 `shadow-composer-focus`，按钮类用 2px 陶土 ring（Toast 使用 outline）；实底按钮外加 2px 背景色间隔，错误态可另用 2px outline 补焦点。
- **Do** 保持 13/20 界面档与 14/22 对话阅读档、16px 图标 / 1.75 线宽与 CDS 动效；全局 15/26 令牌保留给运行详情等原用途，几何按本页 Layout 当前值。
- **Do** 把 `chart-runs` `#2A78D6` 只用于图表首系列；失败用 `danger`。
- **Do** 把 12/16 留给徽章、时间戳与密集元信息，把 11px 留给只读的高密度数据。

### Don't:

- **Don't** 把 `#2A78D6` 或任何蓝色用于导航、按钮、焦点、徽章或状态。
- **Don't** 给外壳加回渐变、外边距、圆角、描边或悬浮阴影，也不要把外壳白框铺到画布后面。
- **Don't** 把默认徽章或 secondary 徽章改成深色填充；它们应是浅中性底配 `fg` 字。
- **Don't** 用 `subtle` `#8A8A8A` 承载可读文字，或用非 `control-boundary` 的浅色承担 checkbox/radio 强边界。
- **Don't** 给已经使用陶土微光或 `input-focus` 的输入再叠 2px ring；唯一例外是错误态用 2px outline 补焦点（边框表达错误，outline 表达焦点）。
- **Don't** 在 CDS 双环 overlay、Composer 三态阴影、卡片 `--shadow-panel` 与陶土焦点微光之外再引入第二套阴影，或给表格加投影、给卡片叠加其它阴影。
- **Don't** 重新引入深色主题、第二套主题提供器、品牌蓝别名或页面级硬编码色值。
- **Don't** 让 Markdown 标题小于正文，或新增第二个阅读正文字号。
- **Don't** 在已批准布局契约之外临时改变宽高、内边距或断点；几何调整先更新规范与契约，配色、字体、焦点与动效仍按本页主题成果。

## Known Gaps

- 输入默认发丝边 `rgba(0,0,0,.10)` 对白约 1.25:1、`input-focus #BDBDBD` 对白约 1.88:1、`control-boundary` 对白约 2.43:1，均低于 WCAG 2.2 非文字 3:1；陶土聚焦边对白约 3.12:1、对 `selected` 约 2.57:1；陶土 `button-primary` 上的白字约 3.12:1，只适合图标或大号文本。这些是 CDS 视觉下用户已接受并公开记录的限制；不得宣称输入边界、焦点或整页 WCAG AA 达标。
- Input / Textarea 聚焦用陶土微光（`.cds-focus-glow`）；Select 触发器、Combobox、InputGroup 与 SourceEditor 仍用 `input-focus`；composer 实际焦点由 `shadow-composer-focus` 表达。Select 关闭键盘态未独立取证，采用同一 `input-focus` 适配。
- CDS 输入 hover、invalid、disabled 与 Select 关闭键盘焦点尚未逐项取得浏览器参考；本轮只修实际焦点缺陷，保留现有错误与禁用语义。
- 个人模块基础实现已随 PR #146 合入 main（基线 624dc3b）。上一轮个人中心重设计的 ship 结论被用户在实际屏幕否定，随后按 1024px 单轴与 448/96 字段尺度重做；本轮独立终审提出 7 条 must-fix，均已修复并定点复核为 resolved，旧结论不再作为当前实现证据。最终实现已复核：六页各一个 h1、无 document 横向溢出，1492 与 1024 两宽均从 x248 开始、右缘分别为 1272 / 986；使用记录表头、数据行与展开详情同 x=288；分享四列首行对齐，1024 下表格 clientWidth 与 scrollWidth 一致；账号安全分组标题为 h2；提案「无需变更」不渲染对比网格，失败原因显示「记忆提案生成超时」。前端全量 142 文件 1712 条、定向 156 条通过，web `typecheck` / `build`、`lint:focus`、`lint:contract` 与 Impeccable detect（返回 `[]`）通过；worker memory-review 26/26 为已记录结果（本次文档复核复跑时 PostgreSQL 不可用，套件跳过，未重新执行）。仍未验证：真实 403/409 未触发；无 `overview.read` 但有 `runs.read` 的分支未用相应账号实测；改密、撤销会话 / 分享、采纳 / 回滚提案与个人记忆投影等真实模型写链未在真实数据执行，不能宣称这些链路或整页验收全部通过。上一轮曾发生一次非预期真实提案运行（成功、无需变更，costUsd 0.0152，未采纳、未写入个人记忆），该事实保留。实现与验证入口见 `docs/tasks/personal-center-ux-brief.md`，基础记录见 `docs/tasks/personal-module.md`。
