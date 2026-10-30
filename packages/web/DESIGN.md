---
name: PACE
description: Qoder 中性浅色外观：外壳静态渐变、纯白内容面、中性深色动作，数据蓝只属于图表。
colors:
  shell-start: "#ECEBC9"
  shell-mid: "#DDE3D4"
  shell-end: "#D1DAE3"
  canvas: "#FFFFFF"
  surface: "#FFFFFF"
  panel: "#FFFFFF"
  sunken: "#F6F6F6"
  hover: "#F6F6F6"
  selected: "#EFEFEF"
  accent: "#EFEFEF"
  accent-foreground: "#141414"
  selected-foreground: "#141414"
  secondary: "#F6F6F6"
  secondary-foreground: "#141414"
  line: "#E6E6E6"
  line-strong: "#767676"
  input: "#767676"
  fg: "#141414"
  muted-foreground: "#5F5F5F"
  subtle: "#828282"
  primary: "#0D0D0D"
  primary-hover: "#262626"
  primary-foreground: "#FFFFFF"
  ring: "#0D0D0D"
  button-primary: "#0D0D0D"
  button-primary-hover: "#262626"
  button-primary-active: "#404040"
  success: "#187646"
  warning: "#8A5600"
  warning-soft: "#FBF3E4"
  danger: "#B42318"
  danger-soft: "#FCEBE9"
  chart-runs: "#315FAD"
  code: "#F6F6F6"
  scrim: "rgb(0 0 0 / 0.4)"
typography:
  display:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: "32px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  subheading:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
    letterSpacing: "0em"
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "26px"
    letterSpacing: "0em"
  label:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
  label-strong:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0em"
  meta:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0em"
  meta-strong:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
rounded:
  shell: "16px"
  card: "16px"
  item: "9px"
  icon: "7px"
  tag: "6px"
  pill: "9999px"
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
    rounded: "{rounded.item}"
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
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.card}"
    padding: "16px"
  user-message:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
---

# Design System: PACE

## Overview

**Creative North Star: "The Quiet Workbench"（静默工作台）**

PACE 的世界是一张安静的工作台。屏幕外沿是一层不移动的暖黄到蓝灰环境光，工作区本身是纯白纸面；工具、标题与正文都是墨色，状态只在需要时以小块浅灰或语义色出现。没有品牌色在页面上争抢注意力，彩色只留给真正是数据的地方。

这套系统把「可点击」从颜色职责里拿掉：普通主操作与发送、登录共用中性深色实底，链接、焦点环与选中态也落在同一墨色系；唯一的蓝色是运行图表首系列的数据蓝。这样层级由留白、分组、字重与实底/浅底关系表达，而不是由强调色表达。

主题阶段是换肤记录：颜色、边线、阴影与外壳呈现来自 Qoder CN 桌面浅色界面的真实截图，焦点方案、输入边界与对比度是 PACE 的可访问适配，不声称来自 Qoder。2026-10-30 用户批准的布局阶段在此之上更新了侧栏、页面内容边、聊天顶栏/输入/成果宽度、专家卡与资源工具行的几何；字号、圆角、图标、动效与配色/焦点成果不变。本文按当前规范记录；浏览器几何验收已在覆盖的桌面范围内完成，未覆盖项见 [本任务记录](../../docs/tasks/qoder-visual-redesign.md)。

**Key Characteristics:**
- 纯白内容面，渐变只存在于应用外壳的三个外部根容器。
- 中性深色动作三态：`#0D0D0D` / `#262626` / `#404040`，白字。
- 浅中性状态层：hover `#F6F6F6`，selected / accent `#EFEFEF`。
- 可编辑边界独立于分隔线：`#767676` 对 `#E6E6E6`。
- 数据蓝 `#315FAD` 只用于图表首系列，不参与任何 UI 动作。
- Inter 的 13/20 界面档与 15/26 阅读档保持；动效不变，几何按本页 Layout 当前值。

## Colors

冷灰纸面、墨色文字与一层暖冷过渡的环境光；没有常驻强调色。

### Primary

- **墨色动作（Ink Action）** (#0D0D0D)：`default` 与显式 `solid` 主操作的实底、链接文字、焦点环、checked/on 控件与 line 页签指示线。它是动作与当前位置的唯一强信号，不用于正文。

### Secondary

- **浅中性层（Quiet Neutral）** (#F6F6F6)：`secondary` 按钮、ghost 的 hover/展开、分段页签容器、代码块、Skeleton 与 chip 底。它表达「可交互或下沉」，不是文字色。
- **选中灰（Selected Gray）** (#EFEFEF)：当前导航项、选中页签、菜单键盘高亮、用户消息气泡。它与浅中性层只差一档，靠上下文而不是色相区分。

### Tertiary

- **数据蓝（Data Blue）** (#315FAD)：只用于运行图表的首个数据系列。失败系列仍用 `danger`。它不是 UI 强调色，也不承担「可点击」语义。

### Neutral

- **纸白（Paper White）** (#FFFFFF)：`canvas`、`surface`、`panel`、卡片、弹层与输入基底。内容区不得染灰或铺渐变。
- **分隔线（Hairline）** (#E6E6E6)：卡片与弹层的 1px ring、表格与分组分隔、页签当前项边框、外壳 outline。只做分组，不做可编辑边界。
- **可编辑边界（Editable Boundary）** (#767676)：Input、Textarea、Select 触发器、Combobox、InputGroup、CodeMirror 搜索输入与未选中 checkbox/radio、off 开关。它在白、选中灰与渐变最暗端都保持至少 3:1。
- **正文墨（Text Ink）** (#141414)：正文、标题、选中项前景与普通图标。
- **辅助灰（Helper Gray）** (#5F5F5F)：placeholder、描述、元信息、注释、表头次要信息；承载可读文字。
- **装饰灰（Decorative Gray）** (#828282)：只用于装饰图标与禁用例外，不承载需要阅读的信息。
- **状态色**：success `#187646`、warning `#8A5600`、danger `#B42318`；浅底分别是 `#FBF3E4`、`#FCEBE9`。只在小面积表达结果。
- **遮罩（Scrim）** (`rgb(0 0 0 / 0.4)`)：Dialog、Sheet 等模态遮罩。

### Named Rules

**The White-Inside Rule.** 所有内容表面（canvas、surface、panel、card、popover）都是纯白。三停点外壳渐变只通过 `bg-shell` 存在于 AppShell 的外部根容器；不得铺到内容、卡片或弹层后面，也不得随鼠标、滚动或时间运动。

**The Neutral-Action Rule.** UI 动作不使用品牌色。`default` 与显式 `solid` 共用 `#0D0D0D` → `#262626` → `#404040` 的实底三态与白字；链接与焦点同为 `#0D0D0D`。蓝色不是动作色。

**The Data-Blue Exception Rule.** `#315FAD` 是系统中唯一的蓝色，只允许出现在 `chart-runs` 数据系列；失败用 `danger`。它不得蔓延到导航、按钮、焦点、徽章或状态。

## Typography

**Display Font:** Inter（Inter Variable、Inter、system-ui、PingFang SC、sans-serif）
**Body Font:** Inter（同上）
**Label/Mono Font:** JetBrains Mono（JetBrains Mono Variable、JetBrains Mono、ui-monospace、Geist Mono、monospace）

**Character:** 一套人文无衬线承担全部界面与阅读，等宽只服务代码、标识与数值。字号克制，层级靠字重、间距与对齐，不靠新增字号档。

### Hierarchy

- **Display** (500, 24px/32px, -0.02em)：只用于对话欢迎区标题「今天想完成什么？」。
- **Title** (500, 16px/24px, -0.01em)：页面 h1、对话标题与无效分享页标题。
- **Subheading** (500, 14px/22px)：列表标题、卡片标题与对话内的区块标题。
- **Body** (400, 15px/26px)：对话、Markdown 与助手正文；用户气泡共用同一档与行高。
- **Label** (400/500, 13px/20px)：导航、按钮、输入、表格单元格与说明文字。这是界面默认档。
- **Meta** (400, 12px/16px)：徽章、时间戳、ID、表头与密集只读元信息。
- **Mono** (400, 12px/20px)：代码块、行内代码、标识与数值读数。

### Named Rules

**The One Reading Size Rule.** Markdown 阅读正文只有 15/26 一档：h1 18/26、h2 16/24、h3–h6 15/26 加 600 字重，任何标题都不小于正文。不要再引入第二个正文尺寸。

**The 13/20 UI Rule.** 可操作控件与界面文字默认 13/20；11px 只留给高密度只读数据，12px 只给元信息与徽章，不用小字去弥补层级不足。

## Layout

桌面端布局，不做移动端适配，也不为触摸新增尺寸。应用外壳由三部分组成：透明的侧栏（展开 224px / 收起 64px）、纯白主壳、以及主壳外只露出 4px 的外壳边距。主壳有 16px 圆角与 1px `shell-line` outline，没有 border 与阴影；侧栏在外，透出 `bg-shell` 渐变。

主区普通页面水平内边距 24px、底部 24px，页面使用 `Page` / `PageHeader` / `PageToolbar` / `PageSection` 骨架：Page 默认区块间距 24px，页头单行最小高 56px、不另加顶部或横向 padding，区块内部间距 16px。对话阅读轴线 832px，含左右 24px 的外容器最大 880px；56px 顶栏在整个历史/消息分栏上方，Composer 在消息区之后距底 24px、始终同一位置。会话历史默认收起 0，首次展开 240px，可在 200–360px 间调整并记忆；成果面板 400px。资源中心工具区固定两行：首行类型导航与管理操作，次行来源/搜索/筛选/排序/数量；专家卡无独立页脚底带。窗口收窄时允许换行、内部滚动与容器伸缩，但表格只在自身容器内横向滚动，页面不出现横向溢出。

间距节奏取 4 / 8 / 12 / 16 / 20 / 24px。所有尺寸、宽高、图标 16px / `strokeWidth 1.75`、边框 1px、页签指示线与焦点 2px 以当前实现值为准；几何调整只按已批准布局契约进入，不通过新增 border 或页面级 padding 临时改变。

## Elevation & Depth

系统默认是平的。外壳、卡片、表格、列表都没有投影：卡片用 1px `line` ring 划分边界，外壳用 1px outline。深度只出现在浮层与一个输入胶囊上：所有菜单、Select、Popover、Dialog、Sheet、Toast 共用同一个 overlay 阴影；对话输入胶囊保留一个极轻的 composer 阴影。外壳渐变是环境光，不是海拔。

### Shadow Vocabulary

- **Overlay** (`0 8px 24px -8px rgb(0 0 0 / 0.12)`)：菜单、Select、Combobox、Popover、Dialog、AlertDialog、Sheet、Toast。`shadow-md` 与 `shadow-lg` 都映射到这一值。
- **Composer** (`0 1px 4px 0 rgb(0 0 0 / 0.04)`)：仅对话输入胶囊；真实 1px input 边框仍在，不再用半个像素的 spread 模拟描边。
- **Modal Scrim** (`rgb(0 0 0 / 0.4)`)：模态遮罩，不是阴影。

### Named Rules

**The One-Shadow Rule.** 浮层只有一种阴影值，内容默认无阴影。不得新增彩色光晕、第二套浮层阴影，或在外壳与卡片上叠阴影。

## Shapes

形态是克制的圆角矩形：外壳、卡片、对话输入区与 Dialog 为 16px；常规按钮、输入、页签容器与菜单为 9px；图标按钮、小控件与页签项为 7px；徽章、标签与侧栏图标底为 6px；头像、胶囊按钮与用户消息为 9999px。Checkbox 保持 4px。

边线宽度全部沿用既有值：1px border/outline、2px 页签指示线与焦点轮廓。只换颜色，不通过新增边框改变控件尺寸。容器用圆角裁切图片与内容，不使用斜切、硬投影或装饰性几何。

## Components

### Buttons

中性的墨色工具，次要动作保持轻。

- **Shape:** 常规高 32px、9px 圆角、13/20 500；紧凑 28px / 7px；大号 36px。保留 1px 透明边框占位，尺寸不因换色变化。
- **Primary:** `default` 用 `button-primary` 实底、白字，hover `#262626`、active `#404040`；disabled 仅降透明度并禁止交互。
- **Solid:** 发送、登录等显式动作与 `default` 共用同一三态实底；不存在单独的蓝色实底。
- **Outline / Secondary / Ghost / Plain:** outline 白底、1px `line` 边线、`fg` 字，hover 与展开 `#F6F6F6`；secondary 用 `#F6F6F6` 底；ghost 透明，hover 与展开 `#F6F6F6`；plain 保持透明且不加 hover 底。取消、筛选与菜单触发器不因主色改成深色实底。
- **Link:** `#0D0D0D` 文字，保留下划线 hover 与可访问名，不靠蓝色表明可点击。
- **Focus:** 实底按钮用单层 2px `ring`，并在实底外留 2px 背景色间隔；error 态危险边框优先。不要同时出现边框与光环两层焦点信号。

### Tabs

- **Segmented:** 容器 `#F6F6F6`、9px、3px 内边距、高 32px；项为 7px 圆角、13/20，未选中 `#5F5F5F`、hover `fg`；当前项用 `#EFEFEF` 底 + `fg` + 1px `line` 边框，去掉小阴影。
- **Line:** 列表透明、不铺底；当前项文字 `fg`，底部 2px `primary` 指示线保持原位置与宽度。
- **Focus:** 页签项用单层 2px `ring`，不改变容器尺寸。

### Inputs / Fields

- **Style:** 白底、1px `input` `#767676` 边框、9px 圆角、高 32px、13/20；placeholder `#5F5F5F`。Input、Textarea、Select 可编辑触发器、Combobox、InputGroup 与 CodeMirror 搜索输入共用同一可访问边界。
- **Focus:** 只把既有 1px 边框换成 `ring` `#0D0D0D`，不叠加光环；InputGroup 由外框承担焦点，内部输入不再画第二层。
- **Invalid / Disabled:** invalid 用 `danger` 边框优先并保留可读错误文字；只有真实禁用的输入才使用禁用背景与透明度，空内容只禁用发送按钮。未选中 checkbox/radio 用 `control-boundary`，checked/on 用 `primary` + 白色勾/点/thumb；off 开关用 `input` 与白 thumb；Toggle 选中态是 `selected` + `fg`，不是深色实底。

### Menus / Popovers / Overlays

- **Menu / Select / Combobox / Popover:** 白浮层、1px `line` ring、overlay 阴影；菜单与浮层 9px 圆角。普通文字 `fg`、描述 `muted-foreground`；hover 与键盘高亮用 `accent` `#EFEFEF` + `accent-foreground` `#141414`；危险项用 `danger`，不被普通 hover 覆盖。
- **Dialog / AlertDialog / Sheet:** 白表面、16px 圆角、1px `line` ring、overlay 阴影；Modal 遮罩 `scrim`。标题 14/22 500，描述 13/20 `muted-foreground`。确认的主操作为深色实底，取消为 outline，危险确认保持 destructive。
- **Tooltip / Toast:** Tooltip 保留既有反色（`fg` 底、白字），不做成白浮层；Toast 白底、1px `line`、overlay 阴影，操作按钮用显式 outline，关闭按钮白底中性 hover。Toast、操作按钮与关闭按钮的焦点都用单层 2px `ring` outline、offset 2；操作按钮只用该 outline，不叠加按钮基类 ring 与焦点阴影，视觉上不出现第二圈光环。

### Cards / Tables / Lists

- **Cards:** 纯白底、16px 圆角、1px `line` ring、16px 内边距，默认无阴影；标题 14/22 500，描述 13/20 `muted-foreground`。
- **Expert card:** 16px 内边距、40px 头像、描述最多两行；开始对话在描述后 8px、与信息列同左边线，无独立页脚底带、`mt-auto` 或固定高度；空描述不留固定占位。
- **Tables / Lists:** 纯白底、1px `line` 分隔；选中行用 `selected`。当前实现的表格行 hover/展开使用 `muted` 的 50% 浅层，卡片页脚也使用同一半透明层；这与契约期望的不透明 `hover` 存在差异，本文件按构建记录，不把它升格为规则。
- **Skeleton / Progress / Separator:** Skeleton 用 `sunken`；Progress 活跃主线用 `primary`，终态走原结果语义；Separator 用 `line`。

### Messages / Code / Charts

- **User message:** 右对齐 `9999` 胶囊、`selected` `#EFEFEF` 底、`fg` 文字、15/26、内边距 8px 16px、最大宽 85%；附件用中性 outline 徽章。助手正文在纯白上无气泡。
- **Code / Shiki:** 代码块表面 `code` `#F6F6F6`、16px 圆角、1px `line` 边线、12/20 等宽；Shiki 背景透明，正文 `fg`，关键字/函数/链接 `primary`，注释/标点 `muted-foreground`。
- **CodeMirror:** selection 与 searchMatch 用 `selected`，gutter `muted-foreground`，搜索面板白底 `fg`，真实可编辑搜索输入 1px `input` 边框，按钮仍用 `line`。
- **Charts:** 白底、网格 `line`、坐标与 tooltip 用 `muted-foreground` / `fg`；首系列 `chart-runs` `#315FAD`，其余系列用中性灰阶并叠加虚线/纹理，失败系列 `chart-failed`（即 `danger`）。图表不播放动画。

### Navigation

- **Sidebar:** 透明底，透出 `bg-shell` 渐变；宽 224px / 收起 64px。条目高 32px、9px 圆角；普通文字 `fg`，分组与账号元信息 `muted-foreground`；hover `#F6F6F6`；当前项 `selected` `#EFEFEF` + `selected-foreground` `#141414`，保留 `aria-current`，不加彩色竖条。收起态状态只落在 32×32 图标块上。
- **Account / menus:** 账号触发器保留紧凑 12px 标签与 7px 圆角；下拉项 hover/键盘高亮统一用 `accent` `#EFEFEF`，不再为单个菜单保留另一套 hover 底色。

## Do's and Don'ts

### Do:

- **Do** 把三停点渐变只交给 AppShell 外部根容器的 `bg-shell`，内容表面保持纯白。
- **Do** 用 `button-primary` 三态（`#0D0D0D` / `#262626` / `#404040`）承载 `default` 与 `solid`，配白字。
- **Do** 用 `input` `#767676` 画可编辑边界，用 `line` `#E6E6E6` 只做分组与分隔。
- **Do** 用 `selected` / `accent` `#EFEFEF` 表示当前导航、选中页签、菜单高亮与用户消息。
- **Do** 每个控件只留一层焦点信号：输入类换边框，普通按钮类用 2px ring（Toast 使用 outline）；实底按钮外加 2px 背景色间隔。
- **Do** 保持 13/20 界面档与 15/26 阅读档、16px 图标 / 1.75 线宽与动效；几何按本页 Layout 当前值。
- **Do** 把 `chart-runs` `#315FAD` 只用于图表首系列；失败用 `danger`。
- **Do** 把 12/16 留给徽章、时间戳与密集元信息，把 11px 留给只读的高密度数据。

### Don't:

- **Don't** 把 `#315FAD` 或任何蓝色用于导航、按钮、焦点、徽章或状态。
- **Don't** 把外壳渐变铺到内容、卡片、弹层或登录页后面，也不要让它随时间、滚动或鼠标运动。
- **Don't** 把默认徽章或 secondary 徽章改成深色填充；它们应是浅中性底配 `fg` 字。
- **Don't** 用 `subtle` `#828282` 承载可读文字，或用 `line` `#E6E6E6` 冒充可编辑边界。
- **Don't** 给已经有边框的输入再叠光环，或同时保留边框与 2px ring 两层焦点。
- **Don't** 为浮层引入第二种阴影、彩色光晕，或给外壳、卡片、表格加投影。
- **Don't** 重新引入深色主题、第二套主题提供器、品牌蓝别名或页面级硬编码色值。
- **Don't** 让 Markdown 标题小于正文，或新增第二个阅读正文字号。
- **Don't** 在已批准布局契约之外临时改变宽高、内边距或断点；几何调整先更新规范与契约，配色、字体、焦点与动效仍按本页主题成果。
