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
  chip: "#F6F6F6"
  hover: "#F6F6F6"
  selected: "#EFEFEF"
  accent: "#EFEFEF"
  accent-foreground: "#141414"
  selected-foreground: "#141414"
  secondary: "#F6F6F6"
  secondary-foreground: "#141414"
  line: "#E6E6E6"
  shell-line: "#E6E6E6"
  line-strong: "#767676"
  control-boundary: "#767676"
  input: "#E6E6E6"
  input-focus: "#BDBDBD"
  composer-focus: "#DDDDDD"
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
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "28px"
    letterSpacing: "-0.02em"
  title:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  subheading:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
    letterSpacing: "0em"
  body:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "0em"
  md:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "26px"
    letterSpacing: "0em"
  label:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
  label-strong:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0em"
  meta:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0em"
  meta-strong:
    fontFamily: '"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
  mono:
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Geist Mono", monospace'
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

**Creative North Star: "The Quiet Workbench（静默工作台）"**

PACE 的世界是一张安静的工作台。屏幕外沿是一层不移动的暖黄到蓝灰环境光，工作区本身是纯白纸面；工具、标题与正文都是墨色，状态只在需要时以小块浅灰或语义色出现。没有品牌色在页面上争抢注意力，彩色只留给真正是数据的地方。

这套系统把「可点击」从颜色职责里拿掉：普通主操作与发送、登录共用中性深色实底，链接、按钮/全局焦点环与选中态也落在同一墨色系（输入聚焦另用浅中性 `input-focus` / `composer-focus`）；唯一的蓝色是运行图表首系列的数据蓝。这样层级由留白、分组、字重与实底/浅底关系表达，而不是由强调色表达。

本文是当前实现的快照，机器可读 token 以 frontmatter 为准；规范与用户已批准目标见 [DESIGN-SYSTEM](../../docs/DESIGN-SYSTEM.md)。配色与控件外观来自 Qoder CN 桌面浅色界面，输入默认/聚焦边线、composer 聚焦与焦点方案是 PACE 近似或可辨适配，不声称来自 Qoder。2026-10-30 批准的布局契约与 2026-10-31 批准的字体收紧已落到当前实现；本文只记录实现值，不把未覆盖的浏览器证据写成已验收，未覆盖项与规范差异见 Known Gaps 和对应任务记录。

**Key Characteristics:**
- 纯白内容面，渐变只存在于应用外壳的三个外部根容器。
- 中性深色动作三态：`#0D0D0D` / `#262626` / `#404040`，白字。
- 浅中性状态层：hover `#F6F6F6`，selected / accent `#EFEFEF`。
- 输入默认边线 `#E6E6E6`，普通聚焦 `#BDBDBD`、composer 聚焦 `#DDDDDD`（PACE 近似映射，低于 3:1 见 Known Gaps）；checkbox/radio 强边线仍 `#767676`。
- 数据蓝 `#315FAD` 只用于图表首系列，不参与任何 UI 动作。
- Inter 的 13/20 界面档与 14/22 对话阅读档；显式 OpenUI small 13/20、large 16/24 与全局 15/26 令牌保留；动效不变，几何按本页 Layout 当前值。

## Colors

冷灰纸面、墨色文字与一层暖冷过渡的环境光；没有常驻强调色。

### Primary

- **墨色动作（Ink Action）** (#0D0D0D)：`default` 与显式 `solid` 主操作的实底、链接文字、按钮/全局焦点环、checked/on 控件与 line 页签指示线；输入聚焦另用 `input-focus` / `composer-focus`。它是动作与当前位置的唯一强信号，不用于正文。

### Secondary

- **浅中性层（Quiet Neutral）** (#F6F6F6)：`secondary` 按钮、ghost 的 hover/展开、分段页签容器、`chip`、代码块 `code`、Skeleton 与 chip 底。它表达「可交互或下沉」，不是文字色。
- **选中灰（Selected Gray）** (#EFEFEF)：当前导航项、选中页签、菜单键盘高亮、用户消息气泡。它与浅中性层只差一档，靠上下文而不是色相区分。

### Tertiary

- **数据蓝（Data Blue）** (#315FAD)：只用于运行图表的首个数据系列。失败系列仍用 `danger`。它不是 UI 强调色，也不承担「可点击」语义。

### Neutral

- **纸白（Paper White）** (#FFFFFF)：`canvas`、`surface`、`panel`、卡片、弹层与输入基底。内容区不得染灰或铺渐变。
- **分隔线（Hairline）** (#E6E6E6)：卡片与弹层的 1px ring、表格与分组分隔、页签当前项边框、外壳 outline `shell-line`。只做分组；输入默认边线借用同值 `input`，但分隔本身不表达可编辑。
- **输入默认边线（Input Boundary）** (#E6E6E6)：Input、Textarea、Select 触发器、Combobox、InputGroup、CodeMirror 搜索输入的默认 1px 边线，等同 `line`；不新增 hover 加深。对白约 1.25:1，是已接受的已知限制。
- **输入聚焦（Input Focus）** (#BDBDBD)：普通输入真实 `:focus-visible` 时替换默认边线，是 PACE 中性近似映射，不是 Qoder 源码 token；对白约 1.88:1，低于 3:1。
- **Composer 聚焦（Composer Focus）** (#DDDDDD)：仅对话 composer 文本控制器聚焦时由 InputGroup 外框使用，来自 Qoder 焦点分离实测；对白约 1.36:1，低于 3:1。
- **强边界（Strong Boundary）** (#767676)：`line-strong` 与 `control-boundary` 同值，用于未选中 checkbox/radio 与 off 开关轨道、需要可辨边界的场景；它在白、选中灰与渐变最暗端都保持至少 3:1。
- **正文墨（Text Ink）** (#141414)：正文、标题、选中项前景与普通图标。
- **辅助灰（Helper Gray）** (#5F5F5F)：placeholder、描述、元信息、注释、表头次要信息；承载可读文字。
- **装饰灰（Decorative Gray）** (#828282)：只用于装饰图标与禁用例外，不承载需要阅读的信息。
- **状态色**：success `#187646`、warning `#8A5600`、danger `#B42318`；浅底分别是 `#FBF3E4`、`#FCEBE9`。只在小面积表达结果。
- **遮罩（Scrim）** (`rgb(0 0 0 / 0.4)`)：Dialog、Sheet 等模态遮罩。

### Named Rules

**The White-Inside Rule.** 所有内容表面（canvas、surface、panel、card、popover）都是纯白。三停点外壳渐变只通过 `bg-shell` 存在于 AppShell 的外部根容器；不得铺到内容、卡片或弹层后面，也不得随鼠标、滚动或时间运动。

**The Neutral-Action Rule.** UI 动作不使用品牌色。`default` 与显式 `solid` 共用 `#0D0D0D` → `#262626` → `#404040` 的实底三态与白字；链接与按钮/全局焦点环同为 `#0D0D0D`，输入聚焦另用浅中性 `input-focus` / `composer-focus`。蓝色不是动作色。

**The Data-Blue Exception Rule.** `#315FAD` 是系统中唯一的蓝色，只允许出现在 `chart-runs` 数据系列；失败用 `danger`。它不得蔓延到导航、按钮、焦点、徽章或状态。

## Typography

**Display Font:** Inter（`"Inter Variable", Inter, "Inter Fallback", system-ui, "PingFang SC", sans-serif`）
**Body Font:** Inter（同上）
**Label/Mono Font:** JetBrains Mono（`"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "Geist Mono", monospace`）

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

`body` 的起点是 15px/1.5，只作未显式覆盖时的兜底；主要界面与对话分别显式使用 13/20 与 14/22，不能把兜底当作阅读规范。OpenUI TextContent 显式 `small` 13/20 与 `large` 16/24 保留，默认跟随 14/22。

### Named Rules

**The One Reading Size Rule.** Markdown 阅读正文只有 14/22 一档：h1 18/26、h2 16/24、h3–h6 14/22 加 600 字重（以外层字号为下限），任何标题都不小于正文。不要再引入第二个正文尺寸。

**The 13/20 UI Rule.** 可操作控件与界面文字默认 13/20；11px 只留给高密度只读数据，12px 只给元信息与徽章，不用小字去弥补层级不足。

## Layout

桌面端布局，窗口窄于 `lg` 时侧栏改为抽屉，仍按桌面密度，不为触摸新增尺寸。应用外壳由三部分组成：透明的侧栏（展开 224px / 收起 64px）、纯白主壳，以及主壳外上、右、下各 4px 的外壳边距（`mt-1 mr-1 mb-1`），左侧紧贴侧栏。主壳有 16px 圆角与 1px `shell-line` outline，没有 border 与阴影；侧栏在外，透出 `bg-shell` 渐变。上、右、下各 4px 是 2026-10-31 冻结布局的已批准值（[qoder-visual-redesign](../../docs/tasks/qoder-visual-redesign.md)「保持上下右4px外边距」）。

非 chat 内容区水平、底部各 24px（`px-6 pb-6`）；`Page` 默认区块间距 24px，`PageHeader` 单行最小高 56px、不另加顶部或横向 padding，`PageSection` 内部间距 16px、默认顶部 20px。`PageToolbar` 自身 `gap-3`（12px），控件内部 8px 由组内组合决定；搜索桌面 224px 且可收缩，筛选 144px，排序 128px。窗口收窄时允许换行、内部滚动与容器伸缩，但表格只在自身容器内横向滚动，页面不出现横向溢出。

对话阅读轴线 832px，含左右 24px 的外容器最大 880px；聊天没有横跨三栏的外顶栏，历史、消息列与成果栏从工作区顶部并排开始。消息列自带 56px 头部（`px-6`，左右 24px）：历史收起时显示历史开关、搜索、唯一专家选择、标题操作与成果开关；历史展开时只留历史开关、标题操作与成果开关，专家选择与搜索、新建移入历史头部。历史头部同为 56px（`px-3`、`gap-1`）：左侧专家选择，右侧 32px ghost「新建会话」；侧栏不再有新建会话入口。成果面板 400px 从顶部开始；Composer 在消息列之后距底 24px、始终同一位置。会话历史默认收起 0，首次展开 240px，可在 200–360px 间调整并记忆。窄桌面历史 Sheet 同理，Sheet 关闭后回到消息头部。

资源中心工具区固定两行：首行类型导航与管理操作，次行来源/搜索/筛选/排序/数量；专家卡无独立页脚底带。个人模块使用标准 Page / PageHeader / PageSection 骨架，默认个人资料，各分区可直达并提供返回工作区；入口在侧栏底部用户信息，展开与收起行为一致。

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

## Elevation & Depth

系统默认是平的。外壳、卡片、表格、列表都没有投影：卡片用 1px `line` ring 划分边界，外壳用 1px outline。深度只出现在浮层：所有菜单、Select、Popover、Dialog、Sheet、Toast 共用同一个 overlay 阴影。Composer 当前没有阴影。

### Shadow Vocabulary

- **Overlay** (`0 8px 24px -8px rgb(0 0 0 / 0.12)`)：菜单、Select、Combobox、Popover、Dialog、AlertDialog、Sheet、Toast。`shadow-md` 与 `shadow-lg` 都映射到这一值。
- **Modal Scrim** (`rgb(0 0 0 / 0.4)`)：模态遮罩，不是阴影。

### Named Rules

**The One-Shadow Rule.** 浮层只有一种阴影值，内容默认无阴影。不得新增彩色光晕、第二套浮层阴影，或在外壳与卡片上叠阴影。Composer 当前无阴影。

## Shapes

形态是克制的圆角矩形：外壳、卡片、对话输入区与 Dialog 为 16px；常规按钮、输入、页签容器、菜单与侧栏展开条目为 9px。共享 `Button` 的 `size="icon"` 32px / `icon-lg` 36px、紧凑 28/24px 图标按钮、小控件、页签项与侧栏折叠按钮实例均为 7px。徽章、标签与侧栏收起态 32×32 图标块为 6px；头像、胶囊按钮与用户消息为 9999px。Checkbox 保持 4px。

边线宽度全部沿用既有值：1px border/outline、2px 页签指示线与焦点轮廓。只换颜色，不通过新增边框改变控件尺寸。容器用圆角裁切图片与内容，不使用斜切、硬投影或装饰性几何。

## Components

### Buttons

中性的墨色工具，次要动作保持轻。

- **Shape:** 常规高 32px、9px 圆角、13/20 500；紧凑 28px / 7px；大号 36px。图标按钮用 `size="icon"` 32px / `icon-lg` 36px，与 `icon-sm`（28px）、`icon-xs`（24px）同为 7px；侧栏折叠按钮实例也显式 7px。保留 1px 透明边框占位，尺寸不因换色变化。
- **Primary:** `default` 用 `button-primary` 实底、白字，hover `#262626`、active `#404040`；disabled 仅降透明度并禁止交互。
- **Solid:** 发送、登录等显式动作与 `default` 共用同一三态实底；不存在单独的蓝色实底。
- **Outline / Secondary / Ghost / Plain:** outline 白底、1px `line` 边线、`fg` 字，hover 与展开 `#F6F6F6`；secondary 用 `#F6F6F6` 底；ghost 透明，hover 与展开 `#F6F6F6`；plain 保持透明且不加 hover 底。取消、筛选与菜单触发器不因主色改成深色实底。
- **Link:** `#0D0D0D` 文字，保留下划线 hover 与可访问名，不靠蓝色表明可点击。导航与下载入口用原生 `Link` / `<a>` 配 `buttonVariants`，保持链接语义与既有外观，不用 `Button` 强制 `role=button`。
- **Focus:** 实底按钮用单层 2px `ring`，并在实底外留 2px 背景色间隔；invalid 时危险边框与焦点环共存，实底 offset 不消失。不要同时出现边框与光环两层普通态焦点信号。

### Tabs

- **Segmented:** 容器 `#F6F6F6`、9px、3px 内边距、高 32px；项为 7px 圆角、13/20，未选中 `#5F5F5F`、hover `fg`；当前项用 `#EFEFEF` 底 + `fg` + 1px `line` 边框，去掉小阴影。
- **Line:** 列表透明、不铺底；当前项文字 `fg`，底部 2px `primary` 指示线保持原位置与宽度。
- **Focus:** 页签项用单层 2px `ring`，不改变容器尺寸。

### Inputs / Fields

- **Style:** 白底、1px `input` `#E6E6E6` 边框、9px 圆角、高 32px、13/20；placeholder `#5F5F5F`。Input、Textarea、SourceEditor、Select 可编辑触发器、Combobox、InputGroup 与 CodeMirror 搜索输入共用同一默认边线与尺寸；不新增 hover 加深。共享 Input / Textarea 保持 13/20；对话 composer 文本区例外使用 14/22（`base`）。桌面窗口收窄（含 767px）时仍固定 13/20，不再切换 16px 移动端字号。
- **Focus:** 普通输入把既有 1px 边框换成 `input-focus` `#BDBDBD`（PACE 中性近似，不是 Qoder 源码 token），composer 文本控制器聚焦时外框换 `composer-focus` `#DDDDDD`，均不叠加光环；InputGroup 由外框承担焦点，内部输入不再画第二层。Select 关闭键盘态同样使用 `input-focus`。
- **Invalid / Disabled:** invalid 用 `danger` 边框优先，并用真实 `:focus-visible` 的 2px `ring` outline + 2px offset 补焦点；错误边框不能代替焦点。只有真实禁用的输入才使用独立于输入边线的禁用背景与透明度（`control-boundary/50`），空内容只禁用发送按钮。未选中 checkbox/radio 用 `control-boundary`，checked/on 用 `primary` + 白色勾/点/thumb；off 开关轨道用 `control-boundary` 与白 thumb；Toggle 选中态是 `selected` + `fg`，不是深色实底。选中的 checkbox / radio / switch 聚焦时用单层 2px `outline` + 2px offset，不叠加 ring；未选中沿用各原语既有的单层焦点信号；普通字段标签由控件自身表达焦点，卡片式字段标签统一用外圈。真实浏览器已实测选中 Checkbox/Switch/Radio（`outline solid 2px`、`offset 2px`，无可见 ring）、普通标签、卡片标签、独立 invalid 控件，以及卡片 invalid 组合（3 个控件 border `rgb(180,35,24)`，内部 outline none / ring 0，外层 label 单层 2px ring）；forced-colors 系统轮廓保留。

### Menus / Popovers / Overlays

- **Menu / Select / Combobox / Popover:** 白浮层、1px `line` ring、overlay 阴影；菜单与浮层 9px 圆角，菜单项 7px 圆角、`4px 6px` 内边距。普通文字 `fg`、描述 `muted-foreground`；hover 与键盘高亮用 `accent` `#EFEFEF` + `accent-foreground` `#141414`；危险项用 `danger`，不被普通 hover 覆盖。
- **Dialog / AlertDialog / Sheet:** 基础 Dialog 白表面、16px 圆角、1px `line` ring、overlay 阴影、16px 内边距；`DialogShell` 改为 `p-0`，头部 `px-5 py-3.5`、内容区 `px-5 py-4`。Modal 遮罩 `scrim`。基础 Dialog 标题 14/21 500（`leading-normal`），描述 13/20 `muted-foreground`。确认的主操作为深色实底，取消为 outline，危险确认保持 destructive。
- **Tooltip / Toast:** Tooltip 保留既有反色（`fg` 底、白字），不做成白浮层；Toast 白底、1px `line`、overlay 阴影，操作按钮用显式 outline，关闭按钮白底中性 hover。Toast、操作按钮与关闭按钮的焦点都用单层 2px `ring` outline、offset 2；操作按钮只用该 outline，不叠加按钮基类 ring 与焦点阴影，视觉上不出现第二圈光环。

### Cards / Tables / Lists

- **Cards:** 纯白底、16px 圆角、1px `line` ring，默认无阴影。Card 根是带 `py-4` 的纵向 flex，子块间距 16px（`size="sm"` 为 12px），根本身没有水平 padding；Header、Content、Footer 各自承担 16px 水平内边距，Footer 独立 `p-4`，存在 Footer 时根 `pb-0`。因此不能描述成「所有裸 Card 子节点统一 p16」。CardTitle 为 14/22（`text-base`），sm 卡为 13/20（`text-sm`）；描述 13/20 `muted-foreground`。真实浏览器已测量标题行高 22px。
- **Expert card:** 208px（`h-52`）固定高、同列宽、16px 网格 gap 与内边距、40px 头像（「创建数字分身」入口保持 80px）；名称链接与角色分两行，描述最多两行；独立「查看 <名称> 工牌」按钮打开 DialogShell，工牌展示数字员工身份、姓名、角色、启停、完整介绍、员工编号（真实 id）与上岗时间（真实 `createdAt`，含年与时区；缺失或无效显示「未记录」，空介绍显示「未填写介绍」），只读不请求详情。开始对话在描述后 8px、与信息列同左边线，无独立页脚底带或 `mt-auto`；空描述不留固定占位。
- **Tables / Lists:** 纯白底、1px `line` 分隔；表头 12px `muted-foreground`，单元格 13/20；行 hover 与展开用不透明 `hover` `#F6F6F6`，选中用 `selected` `#EFEFEF`；卡片页脚同为 `hover` `#F6F6F6`。真实浏览器已测量表头 12px 辅助色与行/页脚底色。
- **Skeleton / Progress / Separator:** Skeleton 用 `sunken`；Progress 活跃主线用 `primary`，终态走原结果语义；Separator 用 `line`。

### Messages / Code / Charts

- **User message:** 右对齐 `9999` 胶囊、`selected` `#EFEFEF` 底、`fg` 文字、14/22、内边距 8px 16px、最大宽 85%；附件用中性 outline 徽章。助手正文在纯白上无气泡。
- **Code / Shiki:** 代码块表面 `code` `#F6F6F6`、16px 圆角、1px `line` 边线、12/20 等宽；Shiki 背景透明，正文 `fg`，关键字/函数/链接 `primary`，注释/标点 `muted-foreground`。
- **CodeMirror:** selection 与 searchMatch 用 `selected`，gutter `muted-foreground`，搜索面板白底 `fg`，真实可编辑搜索输入使用 `input` 默认边线与 `input-focus` 聚焦边线，按钮仍用 `line`。
- **Charts:** 白底、网格 `line`、坐标与 tooltip 用 `muted-foreground` / `fg`；首系列 `chart-runs` `#315FAD`，其余系列用中性灰阶并叠加虚线/纹理，失败系列 `chart-failed`（即 `danger`）。图表不播放动画。

### Navigation

- **Sidebar:** 透明底，透出 `bg-shell` 渐变；宽 224px / 收起 64px。条目高 32px；展开态 9px 圆角（`rounded-item`），收起态为 32×32 图标块、6px 圆角（`rounded-tag`）。普通文字 `fg`，分组与账号元信息 `muted-foreground`；hover `#F6F6F6`；当前项 `selected` `#EFEFEF` + `selected-foreground` `#141414`，保留 `aria-current`，不加彩色竖条。收起态状态只落在图标块上。工作分组不再包含记忆；个人记忆与历史回顾归入底部用户信息进入的个人模块。
- **New conversation:** 只在会话历史头部出现，32px ghost 图标按钮；侧栏不设新建会话条目。
- **Account / personal entry:** 账号触发器保留紧凑 12px 标签与 7px 圆角；展开时头像与姓名靠左、按账号入口外观呈现，不套用导航选中行；展开与收起状态点击都进入同一「个人」模块（默认个人资料），不直接登出。个人资料只自助编辑显示姓名，username/businessId/角色只读；个人模块包含个人资料、个人记忆、历史回顾、安全与会话、我的分享与使用记录；分享表格标题为「我的会话分享」。专家记忆、定时任务与平台凭据不迁入个人模块。登出保持独立动作。下拉项 hover/键盘高亮统一用 `accent` `#EFEFEF`，不再为单个菜单保留另一套 hover 底色。2026-10-31 在 1492×818 与 1024×768 实屏验证：展开用户入口 200×32、收起 32×32，两种状态点击都直达 `/personal/profile` 且保持原折叠状态；个人资料保存后侧栏姓名同步，dirty 离开有确认；安全与会话撤销另一会话 4→3 且当前会话保留；个人记忆保存、版本回滚与下载成功；我的分享撤销 2→1；使用记录按 UTC 创建窗口显示成本覆盖。样本来自隔离库构造，未调用模型或 worker，最终终审结果以 `docs/tasks/personal-module.md` 为准。

## Do's and Don'ts

### Do:

- **Do** 把三停点渐变只交给 AppShell 外部根容器的 `bg-shell`，内容表面保持纯白。
- **Do** 用 `button-primary` 三态（`#0D0D0D` / `#262626` / `#404040`）承载 `default` 与 `solid`，配白字。
- **Do** 用 `input` `#E6E6E6` 画输入默认边线，用 `line` `#E6E6E6` 只做分组与分隔；checkbox/radio 强边界仍用 `#767676`。
- **Do** 用 `selected` / `accent` `#EFEFEF` 表示当前导航、选中页签、菜单高亮与用户消息。
- **Do** 每个控件只留一层常驻焦点信号：输入类换 `input-focus` / `composer-focus` 边线，按钮类用 2px ring（Toast 使用 outline）；实底按钮外加 2px 背景色间隔。错误态可另用 2px outline 补焦点。
- **Do** 保持 13/20 界面档与 14/22 对话阅读档、16px 图标 / 1.75 线宽与动效；全局 15/26 令牌保留给运行详情等原用途，几何按本页 Layout 当前值。
- **Do** 把 `chart-runs` `#315FAD` 只用于图表首系列；失败用 `danger`。
- **Do** 把 12/16 留给徽章、时间戳与密集元信息，把 11px 留给只读的高密度数据。

### Don't:

- **Don't** 把 `#315FAD` 或任何蓝色用于导航、按钮、焦点、徽章或状态。
- **Don't** 把外壳渐变铺到内容、卡片、弹层或登录页后面，也不要让它随时间、滚动或鼠标运动。
- **Don't** 把默认徽章或 secondary 徽章改成深色填充；它们应是浅中性底配 `fg` 字。
- **Don't** 用 `subtle` `#828282` 承载可读文字，或用非 `control-boundary` 的浅色承担 checkbox/radio 强边界。
- **Don't** 给已经换边线的输入再叠 ring；唯一例外是错误态用 2px outline 补焦点（边框表达错误，outline 表达焦点）。
- **Don't** 为浮层引入第二种阴影、彩色光晕，或给外壳、卡片、表格加投影。
- **Don't** 重新引入深色主题、第二套主题提供器、品牌蓝别名或页面级硬编码色值。
- **Don't** 让 Markdown 标题小于正文，或新增第二个阅读正文字号。
- **Don't** 在已批准布局契约之外临时改变宽高、内边距或断点；几何调整先更新规范与契约，配色、字体、焦点与动效仍按本页主题成果。

## Known Gaps

- 输入默认边线 `#E6E6E6` 对白约 1.25:1、普通聚焦 `#BDBDBD` 约 1.88:1、composer 聚焦 `#DDDDDD` 约 1.36:1，均低于 WCAG 2.2 非文字 3:1。用户已明确 Qoder 视觉优先，这些是接受并公开记录的限制；不得宣称输入边界、焦点或整页 WCAG AA 达标。
- 普通输入聚焦 `#BDBDBD` 是 PACE 中性近似映射，不是 Qoder 源码 token；Select 关闭键盘态未独立取证，采用同一 `input-focus` 适配。
- Qoder 输入 hover、invalid、disabled 与 Select 关闭键盘焦点未取得完整参考；本轮只修实际焦点缺陷，保留现有错误与禁用语义。
- 个人模块（个人资料、个人记忆、历史回顾、安全与会话、我的分享、使用记录）已在本工作树实现并完成 2026-10-31 实屏检查：入口在 1492×818 展开 200×32、收起 32×32，均直达 `/personal/profile` 并保持折叠；1024×768 子导航高 32px、页面无横向溢出且单一 h1。样本来自隔离库构造，未调用模型或 worker；尚未合入 main，最终终审结果以 `docs/tasks/personal-module.md` 为准。
