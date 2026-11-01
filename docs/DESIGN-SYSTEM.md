---
colors:
  primary: "#151515"
  primary-hover: "#151515"
  primary-foreground: "#FFFFFF"
  ring: "#D97757"
  button-primary: "#D97757"
  button-primary-hover: "#CC5A36"
  button-primary-active: "#AD4724"
  canvas: "#FCFCFB"
  surface: "#FFFFFF"
  panel: "#FFFFFF"
  sunken: "#F9F9F7"
  hover: "#F3F3F0"
  chip: "#F6F6F4"
  selected: "#EAE9E4"
  accent: "#EAE9E4"
  accent-foreground: "#151515"
  selected-foreground: "#151515"
  secondary: "#F3F3F0"
  secondary-foreground: "#151515"
  line: "rgba(0, 0, 0, 0.10)"
  line-strong: "rgba(0, 0, 0, 0.20)"
  input: "rgba(0, 0, 0, 0.10)"
  input-focus: "#BDBDBD"
  link: "#A8482B"
  control-boundary: "rgba(0, 0, 0, 0.35)"
  fg: "#151515"
  muted-foreground: "#525252"
  subtle: "#8A8A8A"
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
  sans:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
  mono:
    fontFamily: '"anthropic-mono", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
  body:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  ui:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  title:
    fontFamily: '"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
    letterSpacing: "-0.01em"
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
---

# PACE 设计规范（Claude CDS 外观 · PACE 布局）

> 配色与控件外观以 Claude Design System（CDS，参考 open-claude-ui）为准，**仅亮色**；布局、尺寸与结构以本文当前值为准：2026-10-30 用户批准的布局契约替代 OpenUI 早期几何基准，OpenUI 仅保留为历史参考。
> 实现产物快照见 [packages/web/DESIGN.md](../packages/web/DESIGN.md)（sidecar `packages/web/.impeccable/design.json` 为生成物，CDS 值已随本轮迁移同步）。
> 信息架构于 2026-10-29 按「工作 / 构建 / 运维」重排。布局数值已同步；此前的浏览器验收覆盖旧外顶栏结构；2026-10-31 已实页验收恢复后的三栏顶部对齐、历史开合、成果与窄桌面抽屉，见 [本任务记录](tasks/chat-history-agent-picker.md)。

---

## 1. 整体结构

```
根容器 #FCFCFB（画布 canvas）
├─ 侧栏（展开 224px / 收起 64px，透明底，直接坐在画布上）
└─ 主区：平铺全幅，表面 #FFFFFF，无外边距、无圆角、无描边、无阴影
   └─ 普通页面：内容左右 24px、底部 24px，顶部 56px 页头
      └─ 聊天：历史／消息列／成果三栏从工作区顶部并排开始
         ├─ 历史：默认收起 0，首次展开 240px（可 200–360px）；展开头部 56px（专家选择 + 新建），下方搜索与列表
         ├─ 消息列：56px 头部（左右 24px）在列内，消息与 Composer 在下；832px 阅读轴线（含左右 24px 的外容器 880px）
         └─ 成果：宽 400px，从工作区顶部开始
```

**硬性规则**

1. **外壳平铺全幅，不再做悬浮白框。** 根容器铺 `canvas` `#FCFCFB`，侧栏透明坐在画布上，主内容区是贴边的 `surface` `#FFFFFF`；没有外层圆角、没有外边距、没有渐变、没有悬浮描边或阴影。分区靠画布与表面的底色差异和留白表达，不靠外壳边框。
2. 侧栏背景透明，透出画布底色，不与主区分隔线——靠留白与底色差异分开。
3. **聊天三栏顶端平齐，消息列自带 56px 头部。** 历史、消息列与成果栏都从 ChatWorkspace 顶部开始并排，没有横跨三栏的外顶栏；ChatTopBar 位于消息列内的 ChatColumn 头部，高 56px、左右 24px。历史收起时头部依次容纳历史开关、搜索、唯一专家选择、当前会话 h1 与操作菜单、右侧成果开关；历史展开时头部只保留历史开关、会话标题与操作、成果开关，搜索与专家选择移入历史栏：历史头部为专家选择 + 新建，其下是既有「搜索全部会话」与列表。窄桌面历史 Sheet 打开时消息头部隐藏搜索与专家选择，Sheet 的 `HistoryHeader` 显示专家选择、新建与关闭，搜索仍在其下；Sheet 关闭后恢复消息头部。专家选择同一时刻只有一处，允许随历史开合切换 DOM 挂载点，不要求前后同一节点或相同 x/y；头部始终位于消息列顶部且高度不变；消息列随分栏开合移动并伸缩，其它子项沿现有 flex 自然排布，不保留空占位。历史默认收起（0），首次展开 240px，可在 200–360px 间拖动并记忆。历史与消息区同用 `bg-surface`（纯白），外部主导航透明并透出 `bg-canvas` 画布底色；登录页保持纯白 `surface`，公开分享页铺 `canvas` 画布。消息区左侧历史按钮使用虚线面板图标 `PanelLeftDashed`，右侧会话成果按钮使用镜像的 `PanelRightDashed`；桌面端（`lg` 起）同时显示「会话成果」文字，窄屏保留图标与无障碍名。两者均为常规 32px ghost 按钮，图形比导航的实线折叠图标更轻。右侧会话成果与专家定义文件不同，不展示 `.claude` 配置树；仅展示服务端真实发布的成果，同路径可选择版本，提供静态阅读/源码与下载、基于此版本修改与固定版本分享。成果属于产生它的对话轮次；分享从对应版本的成果面板发起，链接形如 `/s/<shareId>#<token>`，token 只放 URL 片段。无成果显示真实空态，不从回复猜测文件或伪造卡片。该链路已交付，运行验收证据见 `docs/tasks/agent-output-viewing.md`。窗口收窄时历史面板仍可收起；面板切换不得清空输入、变更专家或重建消息流。始终仅一个 h1。
4. 对话、欢迎态与 Composer 共用同一条 832px 阅读轴线；含左右各 24px 内边距的外容器最大 880px。Composer 在 ChatColumn 内正常流、始终同一位置、距底 24px，不用 `position: fixed` 覆盖消息。

## 2. 色彩

配色与控件外观以 Claude Design System（CDS）为准，仅亮色；全部数值来自 `packages/web/src/styles.css` 的 `@theme`，本文不另造色值。系统是一条暖灰表面阶梯、一层 alpha 发丝边、中性文字与唯一的陶土主操作色；外壳没有渐变，分区只靠画布与表面的底色差异。

根容器铺画布 `canvas #FCFCFB`，侧栏透明坐在画布上；主内容区、页面、会话历史、详情阅读区、卡片与浮层统一为 `surface #FFFFFF`。中性层为暖灰 `sunken #F9F9F7` / `hover #F3F3F0` / `chip #F6F6F4` / `selected #EAE9E4`；正文 `fg #151515`。主操作走陶土 `button-primary #D97757` 三态，焦点环同为陶土 `ring #D97757`；界面不再用墨色承载「可点击」。`chart-runs #2A78D6` 只保留为图表数据系列，仅用于数据，不表示导航、按钮、焦点或结果状态。状态色独立表达结果。

### 2.1 基础角色（六类）

| 基础角色 | 令牌 | 值 | 用途 |
|---|---|---|---|
| 画布 / 表面 | `canvas` / `surface`、`panel` / `sunken`、`hover`、`chip`、`code` | `#FCFCFB` / `#FFFFFF` / `#F9F9F7` / `#F3F3F0` / `#F6F6F4` / `#F6F6F6` | 应用底色与侧栏 / 主区、卡片、浮层、输入基底 / 下沉容器 / 悬停层 / chip 底 / 行内代码 chip |
| 文本 | `fg`、`ink`、`foreground` / `muted-foreground` / `subtle` | `#151515` / `#525252` / `#8A8A8A` | 正文、标题与选中前景 / 辅助信息、占位符、元信息、注释 / 仅装饰与禁用例外，不承载可读文字 |
| 边线 | `line`、`border`、`input`、`code-line` / `line-strong` / `control-boundary` | `rgba(0, 0, 0, 0.10)` / `rgba(0, 0, 0, 0.20)` / `rgba(0, 0, 0, 0.35)` | 分隔线与输入发丝边 / 较强分隔 / checkbox、radio 与 off 开关强边界 |
| 交互 | `hover` / `selected`、`accent` / `chip` | `#F3F3F0` / `#EAE9E4` / `#F6F6F4` | 悬停与中性浅层 / 当前导航、页签、列表选中、菜单高亮、用户消息气泡 / chip 底 |
| 状态 | `success` / `warning` / `danger` | `#187646` / `#8A5600` / `#B42318` | 仅小面积表达结果，不借用动作色或数据蓝 |
| 数据 | `chart-runs` / `chart-failed` | `#2A78D6` / `danger` | 运行图表首系列 / 失败系列；数据蓝只用于图表数据 |

### 2.2 派生颜色

| 派生 | 令牌 | 值 | 用途 |
|---|---|---|---|
| 动作实底 | `button-primary` / `button-primary-hover` / `button-primary-active` | `#D97757` / `#CC5A36` / `#AD4724` | 普通主操作 `default` 与显式 `solid`（发送、登录）共用的陶土三态实底，白字 |
| 动作悬停 | `primary-hover` | `#151515` | 墨色强调元素的悬停，用实色，不用透明度降低对比度 |
| 链接 | `link` | `#A8482B` | 正文链接与 `link` 变体的深陶土；白底 5.79:1、`selected` 4.76:1，保留装饰线下划线 |
| 反色内容 | `primary-foreground` | `#FFFFFF` | 陶土与墨色实底上的文字与图标 |
| 焦点环 | `ring` | `#D97757` | 全局与组件 `:focus-visible` 的陶土环；对 `selected` 仅约 2.57:1，见 §2.4 |
| 选中前景 | `selected-foreground` / `accent-foreground` | `#151515` | 选中项与菜单高亮上的文字及继承文字色的图标 |
| 状态浅底 | `warning-soft` / `danger-soft` | `#FBF3E4` / `#FCEBE9` | 警告与危险的小面积浅底 |
| 数据系列 | `chart-runs` / `chart-failed` | `#2A78D6` / `danger` | 运行系列 / 失败系列；数据蓝只用于图表数据 |
| 输入聚焦（Input / Textarea） | `ring` + `shadow-focus-glow` | `#D97757` + 三层陶土微光 | 普通输入与文本域聚焦用 `.cds-focus-glow`：1px 陶土边 + `--shadow-focus-glow`（白色内环、1.5px 陶土环、6px 微光）；陶土边对白约 3.12:1、对 `selected` 约 2.57:1，见 §2.4 |
| 输入聚焦（其余输入类） | `input-focus` | `#BDBDBD` | SourceEditor 与 CodeMirror 搜索的普通聚焦浅中性线；composer 焦点由 `shadow-composer-focus` 表达；不满足 3:1，见 §2.4 |
| 遮罩 | `scrim` | `rgb(0 0 0 / 0.4)` | 弹层遮罩 |

外壳渐变令牌 `shell-start` / `shell-mid` / `shell-end` 与外壳描边令牌已随平铺外壳删除；当前外壳不再使用描边。

### 2.3 使用规则

- **平铺外壳，只靠底色分层。** 根容器铺 `canvas` `#FCFCFB`，侧栏透明坐在画布上，主区贴边铺 `surface` `#FFFFFF`；外壳没有渐变、圆角、描边或阴影。`bg-canvas` 的全局含义就是 `#FCFCFB`；登录页保持纯白 `surface`，公开分享页铺 `canvas` 画布。
- **导航只标记位置，不上色。** 普通导航文字 `fg`，分组与元信息 `muted-foreground`；hover 用 `hover`；当前项用 `selected` 底 + `selected-foreground`，保留当前字重与 `aria-current`，不加彩色竖条。收起态选中仍只落在原图标块。
- **主操作走陶土三态。** 普通主操作 `default` 与显式 `solid`（发送、登录）共用 `button-primary` `#D97757`、hover `#CC5A36`、active `#AD4724` 的实底与白字；保留现有透明 1px 边框占位、全部尺寸和图标。次操作 `outline`（白底细 `line` 边线、深色字）、`secondary`（`hover` 中性浅填充）、`ghost`（透明，hover/展开中性浅底）与 `plain` 保持各自职责；取消、过滤器、菜单触发器不因主操作换色而变成陶土实底。链接用 `link` 深陶土 `#A8482B`，保留现有下划线、hover 与可访问名。焦点为陶土微光：普通输入与文本域用 `.cds-focus-glow`（1px 陶土边 + `--shadow-focus-glow`），Select / Combobox / InputGroup 同样用 `.cds-focus-glow` 陶土微光；仅 SourceEditor 与 CodeMirror 搜索用 `input-focus` 浅中性线，按钮类用 `ring` `#D97757`，composer 用 `shadow-composer-focus`；状态允许小面积呼吸点（见 §11）；除「运行中」状态徽章与状态圆点用陶土 `button-primary`（`brand` tone，见 §2.3）外，状态与数据不借用动作色。
- **分段与 line 页签。** 资源页分段控件为 CDS 胶囊轨道：容器 `sunken` 底 + `rounded-pill`、`p-0.5`；当前项为 `surface` 白 thumb + `fg` 字 + `shadow-sm`，非当前项 `muted-foreground`、hover `fg`，不再叠加 hover 底。页签类分段控件容器仍用 `hover`；当前 tab 用 `selected` + `fg`，1px 边框换 `line`，去掉当前 tab 的小阴影。line 页签与二级导航继续透明、不铺底，现有 2px 指示线改为 `primary` 深色，文字 `fg`，位置与宽度不变，focus 独立可见。
- **卡片、表格与列表。** 基底纯白，卡片与表格边线用 `line`；行 hover `hover`、行选中 `selected`，文字 `fg` / `muted-foreground`。所有卡片常驻 `.cds-card-surface`（`--shadow-panel`：1px `line` 环 + 1px/3px 轻投影）；可交互卡再加 `.cds-card-interactive` 做 hover 上浮 1.5px 并换 `--shadow-panel-hover`，键盘聚焦不位移，纯展示卡不加上浮。Skeleton 用 `sunken`；Progress 活跃主线用 `primary` 深色，终态仍走原结果语义；空态与加载态结构不变。
- **可编辑边界单独可访问。** 输入框、Textarea、InputGroup、Select 可编辑触发器与 SourceEditor 使用白底 + 1px `input`（`rgba(0, 0, 0, 0.10)`，等同 `line`）边框；不新增 hover 加深。普通输入与文本域聚焦用 `.cds-focus-glow`：1px 陶土边 + `--shadow-focus-glow` 三层微光；Select 触发器、Combobox 与 InputGroup 同样用 `.cds-focus-glow` 陶土微光；SourceEditor 与 CodeMirror 搜索仍把边线换成 `input-focus` `#BDBDBD`；composer 文本聚焦由 InputGroup 外框保持 `input` 并换 `shadow-composer-focus`（1px 内环 + 外阴影），不叠加 2px 光环。invalid 保留 `danger` 边框，并用真实 `:focus-visible` 的 2px `ring` outline + 2px offset 补足焦点，错误边框不能代替焦点。未选中的 checkbox/radio 用 `control-boundary`（`rgba(0, 0, 0, 0.35)`），checked/on 用墨色 `primary` 配白色勾/点/thumb，off switch 用 `control-boundary` 与白 thumb。`subtle #8A8A8A` 不承担可编辑边界；发丝边、`control-boundary` 与 `input-focus` 均低于 3:1，是已接受并公开记录的视觉限制；陶土微光边对白约 3.12:1。错误、禁用、焦点优先级与形状、尺寸、状态属性不变。
- **消息。** 用户消息由浅蓝底改为 `selected` 中性浅底 + `fg`，保留现有胶囊形状、对齐与宽度；附件用中性 `outline`。助手正文仍在白底上无气泡。
- **浮层与菜单。** 白表面、`line` 边线、统一 overlay 阴影；菜单项 hover/键盘高亮用 `accent` + `accent-foreground`，危险项用 `danger` 且不被普通 hover 覆盖；菜单内搜索等可编辑边界用 `input`。Dialog、AlertDialog、Sheet、Popover、Tooltip、Toast 共用同一表面与阴影，遮罩用 `scrim`；tooltip 若既有反色则保留深底白字。确认框的 default 为深色主操作、取消用 `outline`，危险确认保持 `destructive`。Toast 操作按钮用显式 `outline` 中性次操作；Sonner 自带规则特异性更高，允许 toast 根与操作按钮用中性语义令牌做必要的 `!important` 覆盖，不保留旧的蓝色专用覆盖；关闭按钮白底、中性 hover，保留时长、位置、关闭与屏幕阅读器提示。
- **状态与数据不借用动作色。** 成功、警告、失败继续用独立状态色；运行图表首系列用 `chart-runs` 数据蓝，失败用 `chart-failed`（即 `danger`）。OpenUI 图表只把首系列映射数据蓝，其余系列保留既有中性层级与纹理，不扩展分类色板；数据蓝不能蔓延回导航、按钮或焦点。唯一例外：「运行中」状态徽章用 `brand` tone（`button-primary` 12% 底 + `link` 字）配陶土 `button-primary` 圆点表达「正在运行」，仍保留状态文字，不只依赖颜色。
- **代码。** 围栏/块级代码为深色面：表面 `code-block` `#0D0D0C`，正文与语法用浅色 `code-block-fg` `#E6E6E4`，关键字/函数/链接用暖陶土调的浅色，注释、参数与标点用暖灰层次，复制反馈 2.5s 后衰减回初始态。行内 `code` 仍是浅 chip `#F6F6F6` 配 `fg` 正文。深色代码块内选区用陶土半透明底配白色文字，不沿用全局近黑前景。CodeMirror 原生主题走浅色令牌，selection/searchMatch 用 `selected`，gutter `muted-foreground`，搜索面板白底，真实可编辑搜索 input 用 `input` 默认边线与 `input-focus` 聚焦边线。
- **徽章。** default 与 secondary 都是浅中性底、`fg` 字，不再整枚深色填充；outline 仍白底 `line`；危险/成功/警告继续各自语义，链接 badge 保留焦点。文本不借用 `subtle`。
- 所有控件只引用语义令牌（`primary`、`primary-hover`、`button-primary` 三态、`ring`、`selected`、`selected-foreground`、`accent`、`accent-foreground`、`muted-foreground`、`input`、`input-focus`、`link`、`control-boundary`、`shadow-focus-glow`、`chart-runs` 等），不逐页写色值。字体、尺寸、布局与品牌素材不随配色调整改变。
- 保留 hover、active、expanded、checked、selected、invalid、disabled、focus-visible 的真实状态；不能用页面级 CSS 把所有 `bg-primary` 强制改白。状态不只依赖颜色，沿用既有文字、勾选、图标与 ARIA。

### 2.4 对比度

以下按 §2.1–2.2 的声明值用 WCAG sRGB 相对亮度计算（普通文字 ≥ 4.5:1，非文字边界 ≥ 3:1）；半透明边线先按白色或 `selected` 合成再计算。数值是声明值而不是浏览器实测：

| 前景 / 背景 | 实算 |
|---|---:|
| `fg #151515` / 白 | 18.26:1 |
| `fg` / `selected #EAE9E4` | 15.02:1 |
| `muted-foreground #525252`（含 placeholder）/ 白 | 7.81:1 |
| `muted-foreground` / selected | 6.43:1 |
| `muted-foreground` / `sunken #F9F9F7` | 7.41:1 |
| `muted-foreground` / `chip #F6F6F4` | 7.22:1 |
| `muted-foreground` / `hover #F3F3F0` | 7.03:1 |
| `muted-foreground` / 行内 `code #F6F6F6` | 7.23:1 |
| 白 / `button-primary` normal、hover、active | 3.12 / 4.13 / 5.67:1 |
| `fg` / `button-primary` | 5.85:1 |
| `ring #D97757` / selected | 2.57:1（已知限制，低于 3:1） |
| `ring #D97757` / 白（Input / Textarea 聚焦边） | 3.12:1 |
| `control-boundary` `rgba(0,0,0,.35)` / 白、selected | 2.43 / 2.00:1（已知限制，低于 3:1） |
| 输入默认 `input` `rgba(0,0,0,.10)` / 白 | 1.25:1（已知限制，低于 3:1） |
| `line-strong` `rgba(0,0,0,.20)` / 白 | 1.61:1（仅作较强分隔） |
| `link #A8482B` / 白、selected | 5.79 / 4.76:1 |
| `input-focus #BDBDBD` / 白（SourceEditor / CodeMirror 搜索聚焦） | 1.88:1（已知限制，低于 3:1） |
| success / selected | 4.65:1 |
| warning / selected | 5.06:1 |
| danger / selected | 5.41:1 |
| `chart-runs #2A78D6` / 白 | 4.42:1 |
| danger / danger-soft | 5.70:1 |

正文 `fg` 与辅助文字 `muted-foreground` 在 `surface`、`canvas`、`sunken`、`selected` 上均不低于 4.5:1；状态色在 `surface`、`canvas` 上不低于 4.5:1。陶土 `button-primary` 上的白字约 3.12:1，只适合图标或大号文本，不用于小号正文；hover/active 档升至 4.13/5.67:1。`ring` 陶土环对 `selected` 约 2.57:1、`control-boundary` 对白约 2.43:1、`input-focus` 对白约 1.88:1、输入发丝边对白约 1.25:1，都是 CDS 视觉下用户已接受的限制，**不得宣称整页 WCAG AA 达标**。发丝边只做分组，不单独承担可编辑语义；输入可编辑性仍由位置、标签与焦点变化共同表达。输入/聚焦/错误态与几何的实页复测记录见 [本任务记录](tasks/visual-baseline-claude-cds.md)；源码再变时须重跑对应页。

## 3. 圆角（实测值）

| 元素 | 半径 |
|---|---|
| 外壳 | 无外框圆角（平铺全幅） |
| 卡片 / 线程容器 / 建议卡 | **12px** |
| 对话输入区（Composer） | **20px** |
| 用户消息气泡 | **18px** |
| 建议入口 | 沿用共享按钮圆角 |
| 侧栏条目（展开） | **8px** |
| 32px 图标按钮 | **8px** |
| 紧凑图标按钮（28/24px）/ logo / 折叠按钮 | 8px |
| 侧栏收起态图标块 / 小标签 | 6px |
| 头像 / 圆形按钮 / 模型选择器 | 9999px |
| Dialog / AlertDialog | **16px**（`--radius-dialog`） |
| Popover / Select / Combobox / DropdownMenu | **10px**（`--radius-popover`） |

32px 图标按钮使用 8px；共享 `Button` 的 `size="icon"` 32px / `icon-lg` 36px、紧凑图标按钮与侧栏折叠按钮实例一致。不能用更小的标签圆角替代图标按钮圆角。

边线宽度保持既有值（1px border/outline、2px tab indicator/focus），只换颜色，不通过新增 border 改变控件尺寸；checkbox 现有 4px 圆角不动。

- **浮层阴影**：CDS 双环 popover `--shadow-overlay: inset 0 0 0 1px rgba(0, 0, 0, 0.10), 0 0 0 1px rgba(0, 0, 0, 0.10), 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)`；`shadow-md` / `shadow-lg` 继续映射到此值，菜单、Select、Popover、Dialog、Sheet、Toast 统一消费。
- **Composer 阴影三态**：默认 `--shadow-composer: 0 4px 20px rgba(0, 0, 0, 0.035), inset 0 0 0 1px rgba(0, 0, 0, 0.10)`；hover `--shadow-composer-hover: 0 4px 24px rgba(0, 0, 0, 0.06), inset 0 0 0 1px rgba(0, 0, 0, 0.20)`；文本聚焦 `--shadow-composer-focus: 0 4px 24px rgba(0, 0, 0, 0.08), inset 0 0 0 1px rgba(0, 0, 0, 0.20), 0 0 0 1px rgba(0, 0, 0, 0.20)`。
- **焦点微光**：`--shadow-focus-glow: inset 0 0 0 1px #ffffff, 0 0 0 1.5px #d97757, 0 0 6px 1px rgba(217, 119, 87, 0.25)`，普通输入与文本域经 `.cds-focus-glow` 使用（同时把边框换成陶土 1px）；无边框按钮类仍用单层 2px `ring`。
- **卡片浮起**：`--shadow-panel: 0 0 0 1px var(--color-line), 0 1px 3px rgba(0, 0, 0, 0.04)`；hover `--shadow-panel-hover: 0 0 0 1px var(--color-line-strong), 0 4px 16px -2px rgba(0, 0, 0, 0.09)`，配合 `translateY(-1.5px)`。
- 卡片用 `--shadow-panel` 取代单独 ring；外壳无阴影；分段 tab 当前项去 `shadow-sm`，用既有透明边框换 `line` 形成浅边界；资源页胶囊分段当前项用 `surface` + `shadow-sm`；不全局修改 `shadow-sm` 影响其他组件。

## 4. 字体

- 字体：**AnthropicSans → Inter → 中文回退**（`"anthropic-sans", "AnthropicSans", "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", sans-serif`）。等宽：**AnthropicMono → JetBrains Mono**（`"anthropic-mono", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`）。
- `body` 的起点是 15px/1.5，只作未显式覆盖时的兜底；主要界面与对话分别显式使用 `sm` 13/20 与 `base` 14/22，不能把兜底当作阅读规范。
- `body` 使用 `text-wrap: pretty`；`h1`、`h2`、`h3` 使用 `text-wrap: balance` 并加 `letter-spacing: -0.01em`，改善换行与标题字距。字号与布局几何不做全局 rem 缩放，避免缩小全站。
- 2026-10-31 用户批准的对话字号收紧是 PACE 适配，字号阶梯不随 CDS 外观迁移而改变：会话标题、默认对话/Markdown/OpenUI 正文与输入使用 `base` 14/22，欢迎标题使用 `2xl` 20/28；全局 `md` 15/26 令牌保留给运行详情等原有用途。
- **字号阶梯固定在 `styles.css` 的 `--text-*`，按语义唯一取值，不在页面里写硬编码字号。** 相邻档至少差 1px 或一个可见字重差：

  | Token | 尺寸 / 行高 | 唯一用途 |
  | --- | --- | --- |
  | `2xs` | 11 / 16 | 密集只读数据的次要行列：trace 时间戳、ID、分组小标签；**不用于可点击控件或正文** |
  | `xs` | 12 / 16 | 常规元信息：时间、ID、表格副信息；所有徽章 |
  | `sm` | 13 / 20 | 界面默认：导航、控件、表格单元格、说明 |
  | `base` | 14 / 22 | 列表与卡片标题、会话标题、对话/Markdown/OpenUI 默认正文、对话输入 |
  | `md` | 15 / 26 | 运行详情、评估、记忆与插件详情等页面保留的原有正文/标题用途 |
  | `lg` | 16 / 24 | 普通页面标题（h1） |
  | `xl` | 18 / 26 | Markdown 一级标题 |
  | `2xl` | 20 / 28 | 对话欢迎标题 |
  | `3xl` | 24 / 32 | 主统计数字 |

- `2xs` 只出现在高密度只读视图（运行 trace、连接器表格、版本历史）；同一类信息在常规页面上用 `xs`。判断标准是「这一屏是否需要在同样高度里塞下多列数值」，不是信息本身的性质。

- **Markdown 标题不小于正文**：H1 `xl` 18/600、H2 `lg` 16/600、H3–H6 `base` 14/600，并以外层字号为下限（`max(1em, var(--text-base))`），在显式 `large` 16px 正文中不缩到正文以下。默认正文只有一级（`base` 14/22），H3 以下靠 600 字重与间距区分，不再往下缩字号——小于正文的标题会比它概括的内容还弱。
- 对话默认正文（`base`）使用 22px 行高；用户气泡与助手正文共用同一个行高，不再各自覆盖 `leading-*`。运行详情等保留 `md` 15/26。
- **对话欢迎区仅一行标题「今天想完成什么？」**：标题 `2xl`（20/28），500 字重，左侧配小幅木工插画。
- 对话输入框 14px（`base` 14/22）；建议入口使用共享 sm outline 按钮，不另做大卡片。
- 侧栏条目 13px；分组标题 12px。
- 说明文字 13px，弱色。

> 对话欢迎区以一行问题与紧凑插画形成阅读区，Composer 固定在其下方；不再堆叠两行同等字号的问候。

## 5. 图标

- **lucide**，`stroke-width: 1.75`，尺寸 **16px**（次级 14px，最小 12px）。
- 图标继承所属文字与状态色：普通图标跟随文字，当前导航与选中项随 `selected-foreground`（`#151515`），危险动作与错误用 `danger`；不单独给图标上色，也不把所有图标染成强调色。
- 品牌：采用用户确认的 A 版艺术字组合——木工小狗双手搭在大写 `PACE` 上，像在亲手打造字标。字母为白底黑色轮廓，清理粗重黑块和装饰细节，嘴与舌头为黑白，工具保留少量木色、灰色和黄色，不添加红色装饰。完整 Logo 为 `public/brand/pace-wordmark.webp`（透明，768×568，约 51KB），登录页居中显示高 96px，展开侧栏显示高 32px；导航品牌区相应高 32px，与同排折叠按钮共用水平中心线，收起侧栏仍使用原 32px 木工矢量标记 `public/brand/pace-mark.svg`。本次完整艺术字是图片版，并非矢量路径；透明 PNG 母版与生成记录保存在 `docs/brand/`。人物头像、人物卡片动效、对话布局与现有 favicon 保持原样；界面配色统一遵循 §2。

登录页及展开侧栏的品牌 Logo 点击切换 `public/brand/scenarios/` 中下一张小狗图：采用用户选定的「轻推接力」：先解码图片，旧图向左轻退并淡出，新图同时从右侧淡入到位，全程 300ms、缓出曲线；96px 展示下位移为 8px，导航尺寸按比例缩小。两个图层叠放在同一固定占位中，不旋转、不弹跳。品牌区固定正方形占位，Logo 按钮使用 plain 透明变体，悬停和按压不添加底色；保留键盘焦点提示。点击不导航、不自动轮播，刷新恢复原 Logo；转场期间连点不重复触发。遵循系统减少动态效果设置，减少动态效果时直接换图。业务页面不插入这些场景图。

- **业务空态插画。** 业务页面的空态使用 `public/brand/business/<name>.webp` 的统一插画（`knowledge`、`documents`、`tools`、`search`、`schedule`、`runs`、`memory`、`outputs`、`agents`、`review`、`sharing`、`not-found`），统一经 `BusinessIllustration` 渲染。尺寸只有 `standard` 96px、`compact` 64px、`error` 144px 三档，固定 `width`/`height`、`shrink-0 object-contain`，`alt=""`、`aria-hidden="true"`；全部是纯装饰图、画面无文字，无动画与交互，不接受任意 `className`。`EmptyState` 传 `illustration` 时替换原 40px 圆底图标，未传保持原样；行内 `PageNote` 复用 `icon` 槽。有真实下一步动作的空态仍保留原按钮与无障碍语义。`public/brand/scenarios/` 的六张场景图仍只用于品牌 Logo 切换，不进入业务空态。

## 6. 对话页（核心）

### 空态

```
三栏从工作区顶部并排：
历史（默认收起 0，可 200–360px；展开头部：[选择专家 ▾] [新建]，下方「搜索全部会话」与列表）│ 消息列 56px 头部（历史收起：[历史] [搜索] [选择专家 ▾] [会话标题/操作] [成果]；历史展开：[历史] [会话标题/操作] [成果]）│ 成果 400px
──────────────────────────────────────────────────────────────
会话列表                        │ [小幅木工小狗] 今天想完成什么？
                                │
                                │ [梳理思路] [制定计划] [整理内容] [分析问题]
                                │ ┌────────────────────────────────┐
                                │ │ 描述你想完成的事…               │
                                │ │ Enter 发送 · Shift+Enter 换行 [↑]│
                                │ └────────────────────────────────┘
                                │ 距底 24px；建议入口在 Composer 上方 8px
```

- 欢迎区、消息与 Composer 共用 832px 阅读轴线；含左右 24px 内边距的外容器最大 880px。Composer 始终在 MessagePane 之后的 `shrink-0` 正常流、距底 24px，只渲染一次；MessagePane 独立滚动，欢迎内容不再纵向居中包裹输入。窗口收窄时自然换行与滚动。
- 木工 SVG（`public/brand/pace-chat-woodworker.svg`）宽 96px，保持原比例；嘴和舌头黑白，工具配色保留。仅空白对话欢迎态显示，开始对话后隐藏，不添加新动效。
- 输入区由 InputGroup + InputGroupTextarea + 底部 InputGroupAddon 组成，20px 圆角，默认 `shadow-composer` 与一层 `input` 发丝边；hover 换 `shadow-composer-hover`，文本控制器真实聚焦时外框保持 `input` 边线并换 `shadow-composer-focus`，不叠加 2px 光环。欢迎态文本区最小 80px，对话态最小 56px，均可随内容增高至 160px 后在文本区内部滚动。
- 发送按钮显式使用 `solid` 实底变体（`button-primary` 陶土三态 `#D97757` / `#CC5A36` / `#AD4724`，32px），与普通主操作共用同一实底；空输入仅禁用发送按钮，不能把仍可编辑的整组控件变淡。只有输入控件本身禁用时，InputGroup 才显示禁用背景和透明度。
- 快捷键提示放在输入区左下角，发送放右下角。运行详情链接保留在操作行。
- 四个短任务入口使用 sm outline 按钮，单行排列，位于 Composer 上方 8px；只有欢迎态且已选专家时显示。点击只填写通用提示词并把焦点交还输入框，不自动发送，不宣称专家拥有未经配置的数据或工具能力。
- 不显示「绑定 server / 权限 / 最近运行」等元信息，不在建议按钮重复当前专家名称。

### 对话态

- 消息流最大宽 832px，居中。每轮消息以 `.message-fade-up` 入场（0.4s 上浮淡入，`--ease-overshoot`）；减少动态效果时直接显示。每一轮用户消息是一个独立 `selected` 中性浅底胶囊（右对齐，`fg` 正文），助手回复紧随其后、按轮次成组；轮与轮之间只靠间距分开，不画横线——横线是重复信号，结构已经由胶囊、正文与读数行表达。仍在排队或运行、尚未产出回复的轮次显示「等待回复…」，不留空白；已到终态的轮次显示实际结果或失败原因，不显示等待。
- 运行读数（完成 · 轮次 · 耗时 · token · 成本 · 查看详情）是该轮的自然收尾：最新一轮常驻显示，更早的轮次常驻占位、默认透明，指到或键盘聚焦该轮时显影（`opacity` 150ms）；完整完成时刻放在 `title` 里。读数来自会话详情按 `run_id` 批量带回的指标，不逐条查。
- 运行中的状态沿用同一条读数行的位置与字号：脉冲圆点 +「等待回复／正在调用 X」+ 等宽计时，中断时追加重连。它跟在最后一轮回复下方，**不做成横跨整列的工具栏**；停止入口放在输入框发送位（运行中发送位换成停止），用户不必到消息流里找。
- 用户消息：右对齐，**`bg-selected` 暖灰底胶囊配 `fg` 正文**（radius 18px，padding 12px 16px），附件使用普通 `outline` Badge 与 `muted-foreground` 小字；助手消息不套用实底。
- 助手消息：左对齐，无气泡，`base` 14px 正文；可含标题、列表、卡片。
- 生成式 UI（智能体 `uiFormat=openui`）：围栏内程序使用项目组件与令牌，块间距16px；围栏外散文照常走Markdown，按出现顺序排列。`@ToAssistant` 才发新用户消息，原生变量/查询/修改由OpenUI运行时执行，不覆盖输入草稿。每段的查询错误、重试、保存失败与待批入口就近显示，不能把会话级OpenUI审批指到运行审批页。批准工具时明确显示工具名、8小时会话范围；运行级审批仍沿用原语义。补丁输出期间保留上轮完整界面，不把半个root合并成新界面。
- 生成式内容采用OpenUI官方shadcn示例的组件组合，官方chat库补足示例未覆盖的指标卡等。底层仍是Base UI与本项目令牌，不引入Radix或第二主题；组件契约不为视觉调整而改名/改字段。
- CardBlock随消息容器宽度响应：480px以下单列，更宽两列；奇数末卡跨满。主图与复合卡内图分别按256px/192px默认空间表达主次，显式height优先。Carousel 复用 shadcn 轨道；`responsive=false` 时按官方固定卡宽 small 280 / medium 320 / Overview 240（容器 ≤30rem 时 200），不做视口推断。数字列右对齐且不折断，长描述列允许换行，横滚仅在表格内部。
- TextContent 的字号与行高由外层 `size` 档决定：显式 `small` 13/20、`large` 16/24 保留，默认跟随对话正文 `base` 14/22；Markdown 继承容器字号，普通Text常规字重、BoldText加强。Markdown 与 OpenUI 共用真实 `streaming` 状态：流式中允许调度器跳过中间渲染，终态直接渲染完整文本；只有外层渲染树稳定，Streamdown 在模式切换时会重挂内部代码块等节点。表单用官方 Field/FieldGroup 组合，invalid 经 Base UI `Field.Root` 传到真实控件。普通图片保留3:2占位并用 contain 完整容纳，ImageBlock 保原图比例，不统一固定高度裁切。
- 工具调用按轮分层：每轮的正常工具调用集中到该轮一个可折叠的「执行过程」区，使用按官方 shadcn `Trace` 源码落地的 `TraceCollapsible` / `TraceLine` / `TraceIcon` / `TraceTitle` / `TraceDescription`，不另写自绘折叠行；折叠头保留单行摘要，展开项沿用单行「图标 + 名称 + 状态 + 耗时」，点击展开参数/结果，不用厚边框。官方 registry 没有独立 Thinking 组件，reasoning 也归 `Trace`；只有事件流实际提供 thinking 数据时才渲染，不伪造。顶层正文的内容与顺序不变，不把正文并入折叠区。审批、原生澄清提问、失败工具、缺失结果与 `error` 始终在折叠区外可见且只出现一次，不从折叠区重复渲染；失败与超时原因常驻显示，不依赖展开。
- 任务清单：当本轮有模型确认的步骤清单时，在助手正文与工具项之后、该轮运行读数之前追加一块紧凑清单，独立于执行过程折叠、不随折叠隐藏，也不复用工具行的展开结构，不做成卡片。标题行只有 16px `ListChecks` 图标与等宽 `xs` 的 `已完成/总数` 计数（常规元信息档），可见计数只出现这一次（屏幕阅读器可另读完整句子），不再另起一行写共 N 项；下面按原顺序列步骤，行距 `gap-1`，步骤文字用 `base` 正文档（14/22）。每步固定 16px 图标 + 文字：已完成用 `CircleCheck` 与成功色、进行中用 `LoaderCircle`（沿用既有旋转）、待处理用 `Circle` 与 `subtle`；完成与待处理文字用 `muted-foreground`，进行中文字用 `fg` 并显示 `activeForm`。状态靠图标形状、文字色与屏幕阅读器的状态前缀共同表达，不只靠颜色。本轮没有确认清单或清单已被清空时不渲染，保留原运行/工具状态行，不出现空态或占位。清单只陈述模型报告的进度，不使用「已完成任务」「全部完成」等质量结论，也不因运行结束改写步骤状态；失败或超时原因仍在该轮常驻显示，不以清单状态掩盖；不新增字号、色值、圆角或间距令牌。
- Composer 在 ChatColumn 内常驻同一位置，沿用分层输入与底部操作布局，保持原有流式跟随、分支、停止和历史恢复逻辑；它位于 MessagePane 之后、距底 24px，不用固定定位覆盖消息。发送是明确动作：新的一轮用户消息出现时视图直接回到最新，即使此前已向上翻看历史；阅读历史期间的流式增量不会抢滚动。
- 输入区提供“添加资料”常规 ghost 图标按钮与多选文件框，已选文件在输入框上方显示名称、大小和移除；类型/数量/合计超限时在输入区内用 `role="alert"` 明确说明，不弹独立面板。正文与附件至少一项即可发送。用户消息把附件显示为紧凑标签（名称、大小，有服务端 id 时整枚可下载）；附件读取/上传失败保留本次选择。不要另做资料云盘、PDF 预览器或拖放/粘贴入口。
- 会话头部参考用户截图：标题只占约 8 个中文字符宽度（`max-w-[8em] truncate`），完整标题保留在 `title` 与可访问文本中，紧随一个常规 32px「会话操作」更多菜单；不把标题拉满整行、不把菜单推到右边。菜单复用重命名、Fork，删除需确认且排队/运行中的会话不可删；未保存的新会话禁用菜单。消息区与会话历史头部都不画底部横线，靠一致的对齐与留白形成整体。历史头部不再显示「对话」等重复标签；桌面展开时左侧为唯一专家选择、右侧为新建会话等历史动作，窄桌面抽屉另有关闭按钮，搜索与列表紧随其下；此时消息列头部只保留历史开关、会话标题与操作、成果开关。专家选择同一时刻仅一处，桌面收起或 Sheet 关闭时回到消息列头部；聊天没有横跨三栏的外顶栏。
- 历史搜索使用居中浮层，跨全部专家检索会话标题、会话 ID 与消息正文；每条结果同时给出专家、标题、时间与命中的正文摘要，定位信息不另起一行重复。上下方向键移动选中项、Enter 打开，输入法组合期间的 Enter 不触发；Esc、关闭按钮与外部点击走同一关闭路径并把焦点还给触发器。关闭浮层或发起新查询时取消上一轮未完成请求；结果分页使用游标。打开结果后进入目标专家的目标会话并保留当前未发送草稿；只定位到会话，不承诺跳转或高亮正文中的具体命中消息。
- 专家选择在欢迎态与已有消息/历史会话中仍可用，同一时刻唯一：桌面历史收起或窄桌面 Sheet 关闭时在消息列 56px 头部内，桌面历史展开时在 HistoryHeader 左侧、与「新建会话」同排；历史开合只切换归属，不复制控件。未发送输入按会话隔离保存到当前标签页的 sessionStorage，刷新可恢复；切换会话不串草稿，新建会话不继承旧会话；切换到另一位专家表示进入该专家的新对话：历史列表按新专家刷新，清空当前视图的旧消息、运行与审批上下文，URL 去掉旧 conversation，回到欢迎态；原会话保留在原专家历史中，未发送输入带过去并继续保留。再次选择同一位专家不清空会话。切换只解除旧事件流订阅，不自动取消后台运行。
- 桌面会话列表默认收起 0；首次展开 240px，之后可在 200–360px 间调整；使用 react-resizable-panels 的 `collapsible`、`panelRef.collapse/expand` 和现有 `useDefaultLayout` 记住布局，收起为 0px，不另建宽度存储。历史与内容使用同一 `bg-surface`，只有 1px 竖向分隔；隐藏时分隔不再占位、历史控件不可聚焦，展开与收起按钮正确交接焦点。标题只在当前可见位置出现，始终一个 h1。

## 7. 侧栏

导航分组固定为：

- **工作**：找专家（`/agents`，工作区首个入口；`/` 按账户权限落到第一个可用入口，无业务权限时进入个人资料）、对话（`/chat`）、定时任务（`/schedules`）。
- **构建**：资源（`/skills`，四类资源：技能 / 连接器 / 插件 / 知识库）、评估（`/eval`）。
- **运维**：底部独立入口 `/operations`。进入后使用独立导航——概况（原 `OverviewPage`）、运行、运行环境、健康、审计，并提供「返回工作区」；运维不占业务分组。
- **个人**：底部用户信息即入口，不占业务分组。展开显示头像与姓名，收起保留头像入口；两种状态点击都进入 `/personal/profile`，不触发登出，底部入口的可访问名为「个人资料」。进入个人模块后，主导航在 `AppShell` 内把「工作 / 构建」替换为按目的分组的个人六项——**与专家协作**：个人记忆（`/personal/memory`）、记忆提案（`/personal/reviews`）；**工作记录**：我的分享（`/personal/shares`）、使用记录（`/personal/usage`）；**账号**：个人资料（`/personal/profile`）、账号安全（`/personal/security`）——展开 224px、收起 64px 不变。侧栏底部依次为「返回工作区」、独立「退出登录」与账号入口，退出沿用现有登录跳转，不占页头。`/personal` 默认转个人资料。用户可见名称为记忆提案、账号安全；历史 API 术语与路由（`/personal/reviews`、`/personal/security`）保持不变。我的分享表格标题为「我的会话分享」，只列本人会话下未撤销的链接。原 `/memory` 页面已删除，功能迁入个人模块。专家记忆、定时任务与平台凭据仍留原入口；权限不因整合扩大，管理员个人页也只显示本人数据。

参数来源：2026-10-21 CDP 实测；展开宽度与收起内边距按 2026-10-30 用户批准布局更新，浏览器复测已在覆盖的桌面范围内完成，未覆盖项见 [本任务记录](tasks/visual-baseline-claude-cds.md)。

- **展开 224px**，内边距 `16px 12px`，分组间距 18px；过渡 `160ms cubic-bezier(.22,1,.36,1)`，同时过渡 width / height / transform / background-color / box-shadow。
- **收起 64px**，内边距 `16px 16px`；条目变成 32×32 图标块并居中，文字标签 `opacity 0 / width 0`（90ms 过渡），悬停/选中态落在图标块本身而不是整行。
- 顶部：展开品牌区高 32px，显示完整艺术字组合，与右侧折叠按钮同高同中心线；收起为 32×32 木工矢量标记。收起状态保持原逻辑：悬停时标记淡出，同位置换成展开按钮（32×32，radius 8，140ms），点击展开侧栏，不触发 Logo 切图。
- 「新建会话」位于对话历史头部，为常规 32px ghost 图标按钮；侧栏不设新建会话入口。
- 分组条目高 32px：展开态 radius 8（`rounded-item`）；收起态为 32×32 图标块，radius 6（`rounded-tag`）。
- 普通导航文字用 `fg`；分组标题与账号等辅助入口用 `muted-foreground`。底部用户信息作为个人模块入口，保持现有紧凑样式，展开时头像与姓名靠左，按账号入口而非导航选中行呈现；展开与收起行为一致。账号入口不因个人上下文改外观与可访问名，独立「退出登录」另占一项。
- 侧栏**没有**分隔线，直接坐在 `canvas` 画布上，不套外层白框。
- 选中态 = `selected` 中性浅底 + `selected-foreground` 深色文字与图标，**没有彩色竖条**。

## 8. 其他页面

1. 同一个外壳：侧栏贴画布、主区平铺全宽 `surface` 底，无外边距、无圆角、无描边。
2. 普通页面顶部为 PageHeader：单行 56px（`min-h-14`，不另加顶部或横向 padding），名称在左、主操作在右；内容自然换行可增高，不用固定高度裁切。
3. 一般列表用行：行高 56–64px，1px `line` 分隔线，悬停 `hover`。技能、连接器、插件、知识库四类资源共用资源中心：类型导航与管理操作在首行，来源、搜索、筛选、排序与数量在第二行，排列参考用户指定的 https://www.workbuddy.cn/app/experts，视觉仍使用本规范令牌。专家不再属于资源中心，改为业务入口「找专家」（`/agents`）。
4. 资源中心沿用 `ResourcePage` 的顶层布局，类型入口使用有名称的导航与真实路由链接，当前项通过 `aria-current="page"` 表达，保留 line 页签外观；页内任务切换仍使用 Base UI Tabs。资源操作区固定两行，与列表共享 24px 内容边：首行 56px，类型导航居左、创建/导入等管理操作居右；次行 PageToolbar 按 DOM 顺序为来源切换（`leadingFilters`）→ 搜索（224px，可收缩）→ 筛选 → 排序 → 结果数量（右侧）。PageToolbar 自身 `gap-3`（12px），组内 8px 由内部组合决定；普通桌面同排，放不下自然换行，不横向溢出、不隐藏控件。技能「内部 / 市场」用 `sunken` 胶囊分段控件（`surface` thumb + `shadow-sm`）区别于资源导航；市场保留既有「总榜 / 趋势 / 新热」榜单切换，搜索时隐藏榜单切换、只展示搜索结果。内资源继续使用卡片：网格间距 16px，随可用宽度显示 1–4 列。技能市场使用轻量两列条目，窄桌面降为一列；每条只呈现名称、真实来源与真实安装数，安装使用描边按钮，不添加宣传区、推荐语或无数据支持的热度、市场与分类。专家入口（`/agents`）有 `agents.create` 权限时，专家网格始终先显示两张入口卡（扇形「新建专家」卡 + 「创建数字分身」卡），均打开同一创建 Dialog；工具栏「新建专家 / 导入」保留。这两张入口卡为用户刻意要求保留的创建入口，不得删除、合并或改为仅页头入口。专家配置使用独立路由页 `/agents/$agentId`（页头头像 + 名称/描述 + 返回/删除），不再用右侧抽屉；技能与连接器的编辑仍用弹层或抽屉，插件与知识库详情使用独立路由页并执行 §9「阅读工具栏」契约。
5. 表格：表头使用 `xs` 12px 弱色，常规单元格沿用共享 Table 的 `sm` 13px，数字右对齐 + 等宽；`base` 14px 用于列表与卡片标题，不覆盖表格数据字号。列设置入口固定在表头行最右侧的 32px 操作列，用 `Columns3` 图标按钮打开，不再单独占一行；行数只保留为表格上方一行弱化文字。
6. 主按钮：普通主操作 `default` 使用陶土实底 `button-primary` `#D97757` 配白字，悬停 `#CC5A36`、按下 `#AD4724`，保留透明 1px 边框占位；取消与次操作使用 `outline` / `secondary` / `ghost` 中性变体。发送与登录的显式 `solid` 使用同一陶土三态实底。常规 32px 高、8px 圆角；紧凑操作 28px 高、8px 圆角。链接用 `link` 深陶土 `#A8482B`，选中用墨色 `primary`，用户消息为 `selected` 中性浅底配 `fg` 正文。
7. 账号入口采用整页 `surface` 底与无外框窄表单，最大宽 320px；Logo 居中显示高 96px，与表单间隔 32px。去掉可见「登录」标题，保留屏幕阅读器用的单一 h1「进入 PACE」，文档标题为 PACE。账号、密码和主按钮高 44px；字段组间距 20px，按钮文案为「登录」/「正在登录…」/「重试」；登录成功回到工作区（`/` 按账户权限落到第一个可用入口，无业务权限时进入个人资料）。不加宣传文案、额外入口或装饰性卡片，保留完整校验、错误提示与提交保护。
8. 个人模块进入后由侧栏个人上下文提供六项真实路由，内容顶部不放横向 chip；六页与普通页面同宽、左对齐的 Page，PageHeader 与内容同宽，不再嵌套 768/896 的次级宽度轴；整页不再限制 1024px，长文本阅读宽度仍按 75ch、短字段仍按 448px；六页都从单行 56px PageHeader 开始，恰好一个 h1。PageHeader 下第一个顶层分区不画顶部分隔线，其后的顶层分区用 1px 分隔线加 20px 上内距隔开（折叠/条件区块按当前渲染顺序判断谁在第一）。组内间距 8/12、子组 16、区块 24；分区标题 14px medium、正文 13px、元信息 12px（个人模块列表的主信息用 14px、次要 13px、元信息与表头 12px，不套用 §8.5 的表格数据字号）；局部操作贴内容边界，全页动作 32px。个人资料先呈现姓名与用户名，角色用于确认当前身份，业务 ID 收进按需展开的「账号详情」；短字段最大宽 448px、横向标签列 96px，字段值与取消 / 保存右对齐，只有姓名可编辑，个人资料与账号安全表单共用同一字段尺度。个人记忆以当前已保存正文为阅读态首要内容，并在内容行说明每轮对话会带入这些长期信息；空态、阅读、编辑与版本历史共用同一条内容轴；阅读正文限 75ch 以便长文阅读，编辑区与版本历史用整条内容宽；空态左对齐任务轴；「编辑」进入 SourceEditor，保存 / 取消与未保存状态就近出现，版本历史经「版本历史」入口按需展开、与正文同一内容带，不设常驻版本侧栏；「从对话整理」连接记忆提案创建，下载为次操作。记忆提案列表以待审核优先，生成中与已处理可切换；创建按来源（最多 10 段本人会话）→ 目标 → 执行专家 → 确认摘要分步展开；列表中目标与决策状态为主、摘要为次、成本为元信息；详情在单个 Dialog 内竖向滚动，先呈现目标与完整修改前后（含索引变化），再呈现理由与证据，最后是采用 / 拒绝 / 重新生成与「查看目标」，长段落完整换行不截断。我的分享只在表格处显示一处行数，文件名为主信息，来源会话摘要两行、可显式展开全文并保留来源跳转；显式提供「查看分享」「复制链接」，撤销为次要危险动作并在确认弹层内显示失败，游标分页放在表格之后；表格标题为「我的会话分享」，只列未撤销链接，不承诺来源文件仍存在。使用记录统计窗口与汇总合并为紧凑区，运行明细更早进入首屏；汇总为无卡片三行 dl（运行 / Token / 已记录成本），状态以小网格呈现并保留全部计数（含 0），成本保留已记录次数与 UTC 窗口；主表保留专家、来源、状态、时间与去向五列，动作在同一视野可见，耗时/成本/Token 折入 DataTable 展开详情，运行 ID 降为次信息，显式提供「回到对话」「审核提案」「查看运行」及复用 status 过滤的「只看失败」，不改变查询、汇总或权限。账号安全先呈现当前会话与其他会话，当前会话独立分组且不提供撤销；其他会话主行显示最近活动时间、IP 与撤销动作，完整 UA、登录时间与到期按需展开全文；「修改密码」是独立入口、按需展开，表单与个人资料同尺度，提交前说明撤销全部会话。会话列表受 Better Auth 默认鲜度限制，登录态过旧时在会话区提示重新登录但不自动登出，不使用无法从现有字段得出的地理位置、设备名或风险等级。管理员个人页同样只显示本人数据。
9. 公开分享页 `/s/<shareId>#<token>` 不经过应用外壳与登录态：纯 `canvas` `#FCFCFB` 底、最大宽 728px（公开分享独立阅读宽度，不是聊天 832 轴线）、顶部品牌标记，正文复用阅读/源码/图片（仅 PNG/JPEG/GIF/WebP）与 PDF（与会话成果共用 `BlobPdf` 原生 iframe，支持与 header 门槛一致）预览与下载，其余格式沿用既有行为，只有单一 h1 与「由 PACE 分享」页脚。无效或已撤销统一显示「链接无效或已撤销」，不暴露分享对象是否存在。
10. 表格 / 卡片切换：运行、定时任务、运行环境、账户、我的分享、使用记录、记忆提案、账号安全在业务适合卡片浏览时提供统一切换（`view=table|cards` 进 URL，默认 `table`，刷新与分享保持同一视图）；记忆提案的阶段筛选使用独立参数 `stage`，不占用 `view`。切换控件用共享 `ViewToggle`，放在筛选行或页头动作区右侧。卡片必须等量呈现表格字段（字段标签不可省）与全部操作，网格 `gap-4`，`sm` 起 2 列、`xl` 起 3 列。审计日志与角色权限矩阵保持表格，不提供卡片；个人记忆的版本历史保持折叠列表。

## 9. 组件与交互契约

本节是同类 UI 的唯一约定。开发中发现缺口时在此补齐，同时更新共享组件与现有调用方；并行任务沿用相同契约。官方原语负责交互和无障碍，项目令牌负责视觉。**文案与信息密度不在这里逐条规定，统一遵守 §10「信息表达」硬性规约。**

| 场景 | 统一约定 |
|---|---|
| Input / Textarea / Select / Combobox / 搜索 | 单行高 32px，圆角 8px；多行与多选可随内容增高。默认 1px `input` 发丝边（`rgba(0, 0, 0, 0.10)`，等同 `line`），无 hover 加深、无投影；字段布局通过 Field / FieldGroup 表达 |
| 焦点与边框（统一规则） | 每个控件只允许一层常驻焦点信号，错误态可另加独立 outline：① **有既有边框的输入类**（Input / Textarea / Select 触发器 / Combobox / InputGroup / SourceEditor）→ Input / Textarea 普通聚焦用 `.cds-focus-glow`：1px 边框换成陶土并叠 `--shadow-focus-glow` 三层微光；Select 触发器、Combobox、InputGroup 普通聚焦同样用 `.cds-focus-glow` 陶土微光；仅 SourceEditor 把那条 1px 边框换成 `input-focus`（`#BDBDBD`）；composer 文本控制器聚焦由 InputGroup 外框保持 `input` 并换 `shadow-composer-focus`；**均不加 2px 光环**。错误态保留危险边框，并用真实 `:focus-visible` 的 2px `ring` outline + 2px offset 补焦点（错误边框不等于焦点）。② **无边框或边框透明的按钮类**（Button / TabsTrigger / Toggle / Switch / Checkbox / Badge / 折叠触发 / 拖拽手柄等）→ 用单层 `focus-visible:ring-2 ring-ring`，并且必须带 `focus-visible:outline-none`（避免叠加全局 `:focus-visible` 的 2px outline）；invalid 时危险边框与焦点环共存，不吞焦点。③ 全局 `:focus-visible` 只作兜底。**例外：已选中的填充控件**（选中的 checkbox / radio / switch 等）填充本身已是深色 `primary`，换边框无法表达焦点，改用单层 `data-checked:focus-visible:outline-2 outline-ring outline-offset-2`（2px 背景色间隔的外轮廓，仍算一层焦点信号）；未选中时沿用各原语既有的单层焦点表达。普通字段标签由控件自身表达焦点，卡片式字段标签统一由外层标签的单层焦点表达。同类填充控件出现时沿用此例外，不得改用 `ring` 叠层。错误边框与焦点外轮廓可同时存在（各表达一种语义，不算叠层）。原则：**输入类的聚焦边界（陶土微光或 `input-focus` 浅线）算同一焦点信号**；其余控件边框与光环二者取其一，唯一例外是错误态用 outline 补焦点。实底主按钮（`default` 与 `solid`）聚焦时用单层 `focus-visible:ring-2 ring-ring`，并留 `ring-offset-2` + `ring-offset-background` 的 2px 背景色间隔，invalid 时该 offset 不消失。InputGroup / Combobox 由外框承担焦点，内部输入不重复画框。自动校验：`pnpm lint:focus`（已接入 CI，检查输入类原语无 `ring-2`、`focus-visible:ring-2` 必配 `outline-none`）。 |
| 错误 / 禁用 | 错误使用危险色边框与字段提示；输入类错误态保留危险边框并用 2px `ring` outline 补焦点，不叠 ring；Field 的 data-invalid 与控件 aria-invalid 同步；禁用同步 data-disabled 与 disabled，保持可读，提交中关闭按钮与取消均不可丢弃请求 |
| 按钮 | 常规操作 32px / 8px 圆角；紧凑操作 28px / 8px；普通主操作为陶土实底 `default` 按钮（保留透明 1px 边框占位），工具栏创建使用常规主按钮，卡片内操作用 ghost（更轻），危险/主操作除外，专家卡使用名称链接与「开始对话」主操作，取消与次操作使用中性 outline，删除与放弃使用 destructive；发送与登录等明确动作显式使用同一陶土实底 `solid` 三态。沿用现有 default/solid 调用语义，不逐页批量改 variant；次操作已有显式 variant 必须保留，导出的 `buttonVariants` 与 Button 本体保持一致 |
| 卡片 | 技能、连接器、插件、知识库四类资源的卡片视图共用 40px 头部图标、标题与描述的横向头部；描述最多两行；能力/标识放内容区，辅助信息与配置/编辑动作放页脚；标题与显式操作可打开同一编辑入口，删除统一放操作菜单；技能、连接器、插件与知识库使用中性图标；卡片统一常驻 `.cds-card-surface`（`--shadow-panel`）；可交互卡再加 `.cds-card-interactive` 做 hover 上浮 1.5px 并换 `--shadow-panel-hover` |
| 专家卡 | 所有已创建专家卡与两张创建入口卡统一 208px（`h-52`）高、同列宽、16px 网格 gap 与 16px 内部 padding；40px 圆形插画头像（「创建数字分身」入口保持 80px）。已创建卡的 208px 固定为：上下内边距各 16px（合计 32px）、48px 身份头部、12px、72px 中部、12px、32px 操作行。身份头部内名称链接与角色标签分两行，停用徽章与角色同行，右上角只保留「更多」操作菜单；中部为全宽、最多两行的介绍与最多两行的权限原因，空介绍保留中部空间且不造占位文案；底部为独立操作行，左侧「开始对话」，右侧带 `IdCard` 图标的 outline「工牌」按钮。每张已有专家/分身卡提供可访问名为「查看 ${name} 工牌」的按钮，打开工牌专用的插画式实体证件：沿用 Base UI Dialog 的焦点、Esc/外部点击关闭与关闭后返回原触发器，但作为明确例外使用透明 DialogContent，不套标准头部或白色弹框外壳，标题「${name} 的工牌」仅 sr-only，关闭按钮保持可达，且不改动全局 DialogShell 契约。视觉为居中的 96px 挂绳装饰与扣环连接 360px 宽竖式卡套，内含 96px 原插画头像；卡套以真实 DOM 展示身份「数字员工」、姓名、岗位、启停、完整介绍、员工编号（真实 id）与上岗时间（创建时间，使用真实 `createdAt`，含年与时区；缺失或无效显示「未记录」，空介绍显示「未填写介绍」）。短视口整体单层滚动，长姓名与介绍不截断；白底中性 token，现有插画配色例外沿用，不新增动效。工牌只读使用列表摘要，不请求专家详情，不展示提示词、成员资料、二维码等虚构统计；无创建或配置权限仍可查看已有工牌。「开始对话」使用常规主操作并直接选中该专家进入 `/chat`；无使用权限时在卡片内显示可见的权限原因，并以 `aria-describedby` 关联「开始对话」；停用专家与无使用权限都不提供可执行的「开始对话」，但工牌仍可查看。不设 CardFooter、底带或分隔线；卡片不显示连接器/技能计数与 slug，技术信息只留在配置页。角色标签用 `bg-chip` 弱色胶囊；删除统一放操作菜单。网格列数逻辑不变 |
| 创建专家 | Dialog 前置名称、角色、职责与工作方式；模型与 slug 收进「高级设置」；保留导入专家包与 `agent.md`；数字分身既是角色选项，也有独立入口卡 |
| 专家创建入口卡 | 有 `agents.create` 权限时与专家卡同网格常驻在最前：扇形「新建专家」卡六张插画叠放、悬停/聚焦按次序展开；「创建数字分身」卡用 80px 专属头像 + 描边按钮。两卡与专家卡统一 208px（`h-52`）高、同列宽、16px gap；导入中禁用，无创建权限不显示 |
| 专家头像 | 标准岗位直接对应固定插画头像，显式岗位优先于名称与描述；只有历史数据尚无标准岗位时，才使用名称关键词或 slug 散列。数字分身使用专属双人轮廓头像。卡片用 40px，独立配置页页头用 44px，均圆形 `rounded-full object-cover`，纯装饰 `alt=""`。插画的低饱和背景是图形色彩例外 |
| 标准岗位 | 角色来自 `packages/shared/src/agent.ts` 的 `AGENT_ROLES` 单一目录；创建与编辑用 Select，列表与详情显示相同角色标签。空角色统一为「通用助手」，不根据名称猜测并写入岗位。专家列表的工具栏在「启用状态」之外并列「角色」筛选（选项即 `AGENT_ROLES`），两者都写入 URL `search`；空态「清除筛选」同时清空关键词、状态与角色。扩展岗位在同一目录登记，并同步头像映射与验证；不允许随手输入未登记岗位。历史岗位可原样显示，修改时选择标准项 |
| 数字分身 | 数字分身是 `AGENT_ROLES` 中的标准角色之一，使用专属双人轮廓头像；创建时在角色选择器中选择，工作背景存为系统提示词，沿用现有模型与专家保存能力。网格保留独立入口卡，创建时预填「数字分身」角色。参考项目的记忆学习、资料导入、平台连接与记忆可见范围尚未实现时，不显示假进度、假数据或不可用的设置项 |
| 搜索 / 筛选 / 排序 | 搜索可清除，输入 replace URL；筛选排序 push URL；下拉列表统一在触发器下方展开。空结果给出清除筛选动作，错误给重试，加载用共享骨架 |
| 弹层 | DialogShell 管理标准标题、描述、关闭按钮与可滚动内容；Sheet 保留复杂配置与版本历史。右侧操作顺序为取消、主操作；dirty 状态下取消、Esc、外部点击、关闭按钮使用同一放弃确认；请求中禁止关闭；关闭后返回实际触发器 |
| 专家配置页 | 独立路由页而非抽屉：PageHeader 左侧 44px 头像、标题、角色标签，右侧「返回列表」、次级链接「查看运行」与主操作「开始对话」；描述紧跟页头（同一 `flex flex-col gap-2` 组），仅非空时显示，不另占 Page 的 24px 区块间距。其下为**任务页签**（配置 / 专家记忆 / 项目规则 / 输出风格 / 完整文件），任务、当前分区与选中文件写入 URL search；「查看运行」进入按该专家筛选的运行列表，不再设运行统计页签。用 line 页签且不换行（固定 32px，避免多行溢出）。**配置**任务为两栏（`md:grid-cols-[220px_minmax(0,1fr)]`）：左栏只列五个配置分区（身份/行为/能力/权限/运行限制），不加模型、权限枚举或计数摘要；右栏是**一张 `surface` 底详情卡片**（`rounded-card bg-surface px-6 py-5 ring-1 ring-line`），只渲染当前分区。配置工具栏只在配置任务显示（启用、未保存、去修正、保存更改、版本历史、更多），保存范围就是五个分区；版本入口命名为「配置版本历史」。克隆、导出与删除都放「更多」菜单。**完整文件**任务才展示按根文件 / 技能 / 子智能体 / 规则 / 输出风格分组的文件目录与只读预览；记忆、规则、输出风格直接使用各自的列表 + 编辑器，不再外套第二层导航。短字段（模型、推理强度、权限模式、运行限制、回复格式等）使用横向设置行：标签在左、控件在右，控件宽度按内容收敛；长提示词与文件内容仍用纵向 `Field`，标签在上。不把所有字段统一成标签上方。靠 `FieldGroup` 的 `gap-5` 编码结构；**不逐字段标注落盘路径（`→ …`）或「仅运行时」**，分区标题单独一行、不加摘要不用分割线；能力分区用加粗子分组（MCP Servers / 技能 / 子智能体）+ 右侧计数。行为分区顺序为模型 / 推理强度 → 系统提示词 → 折叠草稿预览。校验失败先切到配置任务与出错分区再聚焦字段；切换任务、切换配置分区与文件切换都保留主配置草稿。离开页面与切换任务受合并后的 dirty/pending 保护，子面板保存不借用配置保存按钮 |
| 专家配置页间距 | 以实屏为准的固定档位，全部取自现有 `gap-*`/`px-*`/`py-*`，不新增令牌：页头与描述 8（`gap-2`）；AgentEditor 主块之间 20（`gap-5`）；任务/操作行组间 12、操作按钮间 8，行下方留 12（`pb-3`）并保留 1px 底线；配置与完整文件两栏 220px + 20 间距、顶部对齐；分组标题到内容 16（`mt-4`）、组内子组 16（`gap-4`）；字段 grid 20（`FieldGroup gap-5`）、纵向字段标签到控件 6（`gap-1.5`）、横向设置行标签与控件同一行并保持 12（`gap-3`）；详情/子面板卡片内容内边距 `px-6 py-5`（24/20）；记忆、规则、输出风格内部列表 + 编辑器同样 220px + 20、顶部对齐 |
| 专家编辑控件 | 主配置、记忆、规则和输出风格共用控件语义：保存为常规 32px `default` 主按钮（陶土实底、白字，非描边），未修改时禁用，不单独改禁用颜色；返回、子面板新建和取消使用常规 `outline`；历史与更多使用 32px `ghost` 图标按钮；删除使用 `destructive` 并有可访问名称。并列操作 `gap-2`（8px）、工具栏分组 `gap-3`（12px）；带文字的图标用 `data-icon="inline-start"`，尺寸由共享组件管理。子编辑器统一标题左、操作右（次操作在前、主保存在后）、字段在下；字段用 `FieldGroup gap-5` 和 `Field gap-1.5`，每项有可见且关联控件的标签；短字段用横向设置行、控件宽度按内容收敛，长文本与文件字段纵向排列、控件填满字段宽度。标识和 Markdown 可等宽，但不覆盖共享输入字号（13px），不单独覆盖控件的高度、圆角、颜色或焦点。权限工具使用共享 Toggle 的 `selected` 中性选中态与 `fg` 前景，安全警告另行保留。保存期间字段和冲突操作一并禁用，错误或失败保留草稿，各编辑器继续只保存自身资源 |
| 阅读工具栏 | 插件详情、知识库详情与会话成果共用 `ReaderToolbar`：阅读/源码切换、复制、下载保持同一顺序与同一控件身份；业务差异留在工具栏之外（插件文件树与面包屑、知识库文件侧栏与文档元信息、成果版本选择）。插件与知识库的文件侧栏可收起。会话成果右侧栏保持 400px；chat 分栏内联宽 400、收起 0，不用 `max-w-[40%]` 把 400 压小；窄桌面 Sheet 也用 400px 与既有 `max-w-full`，不因统一工具栏加宽。共享 chat Panel 在 wide 且成果打开时最小 800px（主消息至少 400 + 成果 400），其余 400px；本轮不新增右侧拖拽或宽度持久化 |
| 会话成果预览 | 会话成果面板按真实 `mediaType` 选择预览方式：Markdown 阅读/源码，其他文本源码，图片仅 PNG/JPEG/GIF/WebP，PDF 用浏览器原生查看器预览，Office 等其余二进制只下载；HTML/SVG 只显示源码，不执行。公开分享页图片仅 PNG/JPEG/GIF/WebP，PDF 与会话成果共用 `BlobPdf`，其余格式沿用既有行为。PDF 先判断 `navigator.pdfViewerEnabled === true`，并只把前 5 字节为 `%PDF-` 的文件交给查看器（仅 header 门槛，不是结构或安全完整验证）；不支持、header 不符、读取失败分别提示并始终保留下载，iframe 的 load/error 不作为解码成功判据，对象 URL 随换版与卸载释放。两处图片一律经鉴权下载取 Blob，浏览器 decode 成功后才显示；解码失败显示「图片无法解码，请下载原件查看。」并保留下载。同一路径有多版时显示版本菜单：`DropdownMenuRadioGroup`/`DropdownMenuRadioItem` 单选，`value=runId`，标签按倒序位置为「最新 · 时间」「上一版 · 时间」「前 N 版 · 时间」，触发器显示当前项同一标签；列表分页外的旧版先按 `runId + path` 取真实元数据，取到前不猜类型、不预取正文，未加载到列表的版本只显示真实时间、不编造位置 |
| 知识库卡片 | 整卡可打开详情：详情链接铺满整张卡片并覆盖标题与内容区，操作菜单浮在覆盖层之上，点菜单不跳转；不出现嵌套交互元素，链接保留指向知识库的可访问名称 |
| 知识库创建与详情 | 创建前置名称、描述，模型与 slug、分块等低频项进入「高级设置」；唯一可用向量模型默认选中，多个时要求明确选择，高级字段出错自动展开。创建成功在草稿保护结算后进入文档页。详情采用标准页头，返回、名称和启停状态在左，专家使用关系与设置在右；任务顺序为「文档 / 来源 / 检索测试 / Wiki / 处理记录」，对应原有 URL `panel` 值不变。关系弹层只读显示有权确认的专家，绑定仍经专家能力配置保存；不能确认的关系不当作空关系 |
| 知识库处理记录 | 文档失败可进入按 `document` 定位的处理记录，记录列出真实文档/来源对象与错误，分页追加且保留已加载行；首次失败无成功版本时不提供无效的重新解析。内容管理、来源管理、执行、Wiki 发布、库设置按既有叶权限分别显示动作；设置更换模型不自动重建，未保存草稿不能执行重建，整库重建明确人工分块不会带入新版本 |
| 知识库文档工具栏 | 「上传文件」是工具栏主操作；上传文件夹、手写文档、导入网址收进相邻的次级「导入」下拉，不与主操作并列。上传进度、单文件限制与逐项失败提示沿用现有行为 |
| 知识库来源 | 新建来源为「选择 provider → 配置」两步，编辑直接进入配置且来源类型只读；创建与编辑共用同一表单。来源行显示 provider、目标范围、cron 与最近同步状态。配置字段分为「连接」（名称、地址、凭证）与「同步范围」（范围行、cron、删除策略） |
| 个人模块 | 侧栏展开与收起状态点击用户信息都进入同一模块，默认个人资料，不触发登出；进入后主导航替换工作/构建为按「与专家协作（个人记忆、记忆提案）/ 工作记录（我的分享、使用记录）/ 账号（个人资料、账号安全）」分组的六项，侧栏底部依次为返回工作区、独立退出登录与账号入口，账号入口保持 ghost 左对齐与独立可访问名；内容顶部不放横向 chip，六页与普通页面同宽、左对齐，而不限制整页 1024px，PageHeader 与内容同宽并从 56px 开始。个人资料先显示姓名与用户名，角色用于确认身份，`businessId` 收进按需展开的「账号详情」，只有姓名可编辑；短字段最大宽 448px、横向标签列 96px，与账号安全表单同尺度。个人记忆阅读态优先展示当前已保存正文并说明每轮会带入，「编辑」复用 SourceEditor，空态左对齐内容轴，阅读/编辑/版本历史共用内容宽度，版本历史按需展开、不设常驻版本栏，「从对话整理」连接记忆提案创建；保留编辑、保存、下载、版本与回滚，保存使用 `revision` 乐观锁并保留冲突草稿。记忆提案按处理状态组织，创建按来源（最多 10 段本人会话）→ 目标 → 执行专家 → 确认摘要分步展开；列表以目标与决策状态为主、摘要次、成本为元信息，详情在单个 Dialog 内竖向滚动，先完整修改前后（含索引变化）、再理由与证据、最后采用/拒绝/重新生成与查看目标，长内容完整换行，保留 `scope=own`、幂等键与无变化状态。我的分享跨会话只列本人会话下未撤销的链接，文件名为主动信息，来源会话摘要两行并可显式展开全文、保留来源跳转，提供查看分享、复制链接与次要的撤销，失败在确认弹层内可见，表格标题为「我的会话分享」，只在表格显示一处行数与表后游标分页。账号安全先显示当前会话与其他会话，当前会话独立分组且不可撤销，其他会话主行显示最近活动时间、IP 与撤销，完整 UA/登录时间/到期按需展开；修改密码为独立入口、按需展开，改密撤销全部会话；列表受 Better Auth 默认鲜度限制，鲜度不足提示重新登录但不自动登出，不猜测设备、位置或风险等级。使用记录按 `initiatedBy` 固定本人，管理员也只本人；汇总窗口与统计合并为紧凑区，状态以小网格呈现并保留全部计数，成本区分「未记录」与 0、按运行创建时间的 UTC 日界；主表保留专家、来源、状态、时间与去向五列，落点动作同视野可见，耗时/成本/Token 折入 DataTable 展开详情，运行 ID 降为次信息，显式提供回到对话/审核提案/查看运行与「只看失败」，不改变查询、汇总或权限。专家记忆、定时任务与平台凭据不迁入，权限不因整合扩大 |
| 定时任务创建与编辑 | `DialogShell` 最大宽 1024px，沿用现有 20px 内边距与共享控件规格；表单容器 ≥800px 时两栏：左栏自适应，与右栏之间 gap 24，右栏总宽固定 320px（含 1px 竖分隔与 24px 左内边距，不额外累加）且 `self-start` 自然高；更窄的桌面窗口顺序堆叠。左侧是开放编辑面而非分区卡：名称常态无边框（边框透明）、14/22 medium，占位「任务名称」，关联标签 sr-only；下方 16px 为可见「任务内容」标签与 Textarea；Textarea 常态透明边框、最小高 160px（约 8 行）、随内容自然增高，聚焦与错误态仍用共享边线。专家紧接正文下 12px，做成轻工具行：左侧标签「执行专家」、右侧内容宽 Select（最大 240px），不设大分区、不 `mt-auto` 贴底。右栏顶部为「执行计划」标题，频率与时间（UTC）同行；weekly 用七个 Toggle 多选星期且必须至少选中一天，custom 直接编辑五段 cron 并原样回填；启用开关在执行计划后 20px，不贴底。页脚右对齐：取消（outline）在前，创建任务 / 创建中… 或保存更改 / 保存中…（常规主操作）在后；短视口下页脚 sticky，始终可达。五段 cron 始终是后端唯一存储值，编辑复杂表达式时原样回填 custom，不擅自改写为 daily/weekly；保存中禁用关闭与提交，dirty 的取消、Esc 与外部点击沿用共享放弃确认。编辑已有任务时专家不可更换。用户仅在云端执行，不提供位置或时区选择；不添加到期、输出方式、执行授权、模型或附件等后端不支持项 |

对话输入区采用 §6 的多行 InputGroup 形态；代码/标识可用等宽字体。除此之外，页面不单独覆盖同类控件的边框、焦点、圆角和高度。

### 全站页面布局契约

以资源中心（技能·连接器·插件·知识库）与「找专家」页为组件尺寸、间距与操作区基准，以下规则覆盖所有页面。页面按功能组织内容，不另定同类元素的标准。

- AppShell 的非 chat 内容水平 24px、底部 24px，全宽内容与独立纵向滚动；chat 分支保持零 shell padding。对话阅读轴线为 832px（外容器 880px），登录表单是唯一居中窄表单。
- Page 默认区块间距 24px，不承担 padding；显式 `gap-0` 的对话与 `gap-8` 的登录继续覆盖默认值。PageHeader 单行最小高 56px（`min-h-14`）、不另加顶部或横向 padding，左侧标题，右侧常规 32px 操作，操作间距 8px；sr-only 页头完全脱离正常流。指标、说明、筛选另放下一行，不把多层读数塞进标题行。
- PageToolbar 控件内部间距 8px、组间 12px、可换行，不额外加 padding、高度或 sticky；搜索桌面 224px 且可收缩、筛选 144px、排序 128px。使用正常布局间距，不写负外边距补偿。
- PageSection 内部间距 16px，区块分隔后顶部 20px（`pt-5`）；资源网格间距 16px。运维·概况用于摘要与异常定位，运行默认数据表并支持切换卡片，审计保持数据表，评估与健康按功能分区，详情保留步骤与检查器，不机械卡片化。
- 运维·概况只保留一套日常概览：统计窗口说明放在指标组标题处一次，概况、专家指标和趋势统一使用最近 7 个 UTC 自然日（含今天）；四张卡片为运行次数、运行成本、专家、连接器，连接器数量只含资源中心可管理项，卡片内不再重复窗口；不再另设任务总数看板或快捷入口。待处理事项（审批与失败运行）合并为唯一入口，空态给下一步动作，不写“暂无”。正常健康指标不占业务入口，仅当前队列积压/等待、指标缺失或刷新失败时显示一行并链接健康页；队列历史 failed 是保留计数，只在健康页解释。主区展示带整数运行次数刻度的运行趋势与最近运行；趋势提供可键盘展开的同源数据表，日期、运行、失败、成本与 token 均可读取，表格仅在容器内横向滚动。完整专家数据放下方，专家名称直接链接对应详情。概况数字不与导航按钮混排，长列表不得把关键入口挤出首屏。
- 窗口收窄时保持无页面横向溢出；两列功能区在空间不足时顺序堆叠，表格必要时只在表格容器内水平滚动。所有加载、错误、空态与正常态沿用同一骨架，始终一个 h1。
- 页头操作使用常规 default/outline，区块与行内操作使用 sm；应用页面不为同种按钮覆盖圆角、高度与焦点。聊天输入区的页面级规格只采用 §6 已定义值。

### 固定视觉值与场景例外

- §1–8 的尺寸、圆角与间距以本文当前值为准；色彩以本规范 §2 为准，调整统一从 styles.css 的语义令牌进入。
- `subtle`（`#8A8A8A`）保留给装饰细节、次要状态图标与禁用例外；表头、时间、计数、帮助文字、错误恢复说明与可操作标签使用 `muted-foreground`（`#525252`，见 §2）或 `fg`。`subtle` 不用于承载需要阅读的信息；`muted-foreground` 辅助文字保持至少 4.5:1 对比度（见 §2.4）。禁用状态保留其既有例外。
- 控件沿用桌面字号：Input / Textarea 使用共享 13px 语义字号；多行代码编辑器可保留等宽排版，但不关闭浏览器缩放。
- 聊天继续使用 832px 阅读轴线与多行输入区；运行默认数据表并支持卡片切换，审计、评估结果使用数据表；资源中心的内资源使用卡片，技能市场使用轻量条目列表。统一的是令牌、控件与状态反馈，不是这些场景的布局形态。

### 可访问交互与异步状态

- 表格保留可识别的行、列与表头关系；排序暴露当前方向，长值可换行或在详情中完整读取。窗口收窄时只滚动表格容器；列排序同时提供拖拽、键盘与点击调整路径，锁定列不能被历史偏好隐藏。
- 页面标题、弹层标题、说明和下拉选项允许长文本换行。弹层头部保持可达，内容区受动态视口高度约束并隔离滚动。Popover（包括表格列设置）通过 Base UI 的 `--available-height` / `--available-width` 限制可用空间，超长内容内部滚动并设置 `overscroll-contain`；这是短视口适配，不改变固定控件尺寸与圆角。
- 保存期间禁用受该请求影响的表单字段及冲突操作，字段同步 `data-disabled`。同一 pending 标识只能管理一个在途请求；要么串行禁用，要么按对象分别跟踪。乐观更新不得通过卸载/重建确认框清除请求保护。拥有弹窗或编辑子树生命周期的父层在真正卸载前结算 pending 与阻塞导航 resolver，不依赖子组件卸载清理或 per-call mutation 回调。已有缓存数据时，后台刷新失败保留同一编辑子树并提供真实错误与重试；只有首次无数据失败才整块替换。
- 校验在提交时明确显示字段错误并关联控件；数字显示数值边界，列表显示项数，文本显示字符数。键值与 JSON 编辑不得静默丢弃无效内容；必填错误需给出补全路径。
- 原生澄清提问放在对应工具调用位置，以问题、选项与回答动作组织；复用单选、复选与文本输入，提供「其他」及「暂不回答」。已回答/关闭状态只读；运行详情复用同一组件。提问回答不表达业务工具已获批准，不与审批动作混用。
- 状态不只靠颜色表达；消息需提供发言者语义，审批需准确对应连接器与工具。辅助数据失败也应显示重试入口，缺失指标不得伪装成零；ResourcePage 的资源数量仅在列表请求成功时显示，加载或失败时显示相应状态。等待提示只属于仍在排队或运行、尚未产出回复的任务；已失败或已超时的任务保留实际结果与失败原因，不得提示仍在等待。
- 会话切换使旧请求与事件流失效，晚返回响应不得覆盖新会话；历史尚未加载完成时不能追加发送。连接中断不是任务终态，保留运行标识与停止入口，并从服务端状态收尾。输入法组合输入的 Enter 不触发发送。
- 错误 toast 保留到主动关闭；复制失败提供手动复制说明。焦点提示不得被页面覆盖移除，关闭弹层返回实际触发器，触发器消失才使用后备入口。
- 登录状态检查期间的全局骨架与失败分支也保留当前路由的单一 `PageHeader`（可视觉隐藏）和文档标题；未知路由明确命名为「页面不存在」。
- `DialogShell` 中的表单提交校验失败后，等待字段错误渲染，再聚焦内容区首个 `aria-invalid` 控件并滚动到该字段；复杂专家 Sheet 继续由分区导航定位错误，避免把隐藏分区当作可见表单。
- 强制颜色模式下，控件阴影焦点会被系统移除，统一恢复系统 `Highlight` 的 2px 轮廓；这是系统可访问性适配，不改变普通模式的陶土 `ring` 与既有布局值。
- 多选 Combobox 的已选项区域有分组名称，每个移除按钮明确命名「移除 + 项目名」；Chip 与输入提供 Base UI 的方向键、Backspace / Delete 操作说明，不能只给外层 Chip 命名。
- 编辑草稿必须与打开时的版本基线绑定。409 冲突不得自动用最新版本号重发旧草稿；提供明确的重新加载动作并确认放弃旧草稿。dirty 或保存中也保护路由离开与刷新，不能只保护弹层关闭。
- 键值编辑拒绝重复键并指出行号；环境变量区分大小写，HTTP Header 不区分大小写。后端不支持清空的可选配置不得显示可保存的「恢复默认」或把空值伪装成保存成功。
- 历史会话重开需等待最新历史并恢复最近运行与审批上下文；运行进入终态时最后刷新一次审批，再停止轮询。发送被接收后刷新服务端会话列表；只保存批准的按钮命名为「批准」，不承诺自动继续运行。
- 评估跑批中断原因与已完成结果同时显示，部分通过不得掩盖未完成用例；登录凭据错误与会话失效分别提供恢复说明。

- 页面身份按实际匹配路由确定；命中 `$` 的未知地址即使带有已知路径前缀，也统一显示「页面不存在」文档标题和加载/失败标题。
- 专家回滚与常规保存共用 pending 生命周期；回滚确认明确说明未保存草稿会丢弃，等待期间不可关闭历史、继续编辑或离开路由。版本差异须完整显示目标文本与数组内容，导入返回的提示须可逐条阅读。
- 专家配置的任务切换与路由离开共用同一份 dirty/pending：主配置草稿与当前子面板（记忆 / 规则 / 输出风格）的未保存内容都算数。主配置随页面常驻，切换任务保留草稿；子面板草稿会随任务卸载，切换前确认放弃。路由离开两种草稿都要保护，保存中不得切换或离开。各子面板的保存只负责自身资源，配置保存按钮不跨任务保存。
- 聊天离开页面保留未发送输入，清理会话和运行上下文；历史终态恢复结果与失败原因，未被服务端接收的发送不显示指向旧运行的「本次运行」。连接器名称缺失时审批显示其 ID。
- 运行列表沿用当前接口的最近 100 条范围；达到上限时明确说明范围及列排序只作用于当前记录，不承诺接口尚未提供的完整历史分页。

## 10. 信息表达（设计规约·硬性）

> **一句话：删掉标语、辅助文案和次级标签。"Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout."** 界面必须靠这些文字才看得懂时，先改布局，而不是补文字。
>
> 这是每个页面、区块、卡片、弹层的**默认约束**，不是建议。视觉做得再对，只要靠一堆次级标签和说明文字来解释结构，就算没遵守本规约。评审 UI 时先过这一节。
>
> 布局与文案调整同时遵守 [CLAUDE.md「决策标准」](../CLAUDE.md#决策标准) 的 UX/DX/AX 原则，并保留现有功能。

### 10.1 核心规则

1. **结构先由布局承担。** 先用分组（group）、对齐（alignment）、间距（spacing）、层级（字号/字重/底色）表达关系。若当前布局表达不了某个关系，**先改布局**（分组、对齐、间距、标题层级、容器边界），不要用加文字当补丁跳过这一步；确认布局确实无法承载后，才补必要的文字（见 10.2）。
2. **不重复解释。** 页面标题、分区标题、字段标签、占位符、徽章、计数、可见控件已经表达的信息，不得再用副标题、行内说明或第二次标签重复一遍。
3. **文字只为「新信息」存在。** 一段可见文案必须二选一：给出布局无法表达的新信息，或指导下一步操作。两者都不满足就删掉。
4. **信息层级 = 层级信号，不是满屏小字。** 用少量强信号（容器边界、一级标题字号/字重、两列对齐）分层；不要给每个字段都挂一行灰色小字，那会把层级摊平成噪音。
5. **空态/错误/加载也遵守。** 空态说明「这里是什么 + 下一步做什么」，不复述「暂无/还没有」；错误给可恢复动作；加载给共享骨架。不写承诺式废话。
6. **删词不等于删信息。** 实现细节类信息（落盘路径、字段映射到哪个文件）**一次讲清即可**——放进「完整文件」页签、展开区或 tooltip，不在主界面逐项重复。

### 10.2 允许保留的文字（不可为"精简"而删除）

- 表单字段标签、必填标记、格式/约束提示（如「创建后不可修改」）。
- 校验错误、禁止/危险操作说明（如「此操作不可撤销」「放行内置工具会扩大攻击面」）。
- 影响决策的安全/权限信息、状态与结果（步骤、状态、耗时、工具 IO、审批与实际执行对应关系）。
- 无障碍名称、`aria-*`、`sr-only`、按钮/链接文案、placeholder。
- 空态里的**下一步动作**与其按钮。

> 精简可见文案时，交互原语的无障碍契约（标签、名称、状态播报）仍须满足，见 §9 与「可访问交互与异步状态」。

### 10.3 优先做法（用这些代替加文字）

| 想表达 | 用布局 | 不要用 |
|---|---|---|
| 字段属于哪一组 | 分区标题 + `FieldGroup` + 间距 | 每个字段旁贴分组名/路径标签 |
| 谁更新、什么时间、什么状态 | 对齐的列/徽章/时间戳 | 行内叙述「该记录于…更新为…」 |
| 数量/汇总 | 徽章、计数、列、指标卡 | 另起一行「共 N 个…」重复 |
| 层级关系 | 容器边界（卡片 vs 画布）、字号/字重 | 到处加同色小号说明字 |
| 空态引导 | 标题 + 一个主操作按钮 | 「这里还没有任何内容，请先去 X 添加」 |

### 10.4 反模式（出现即改）

- 页面级副标题只是把路由名/标题再说一遍。
- 卡片/行下方再挂一行复述可见控件、类型或数量的小字。
- 逐字段 `→ 某文件路径`、`仅运行时` 之类落盘/实现标签贴在表单上。
- 空态写「还没有/暂无…」+ 一大段说明，却不给下一步按钮。
- 同一个计数既在徽章又在旁边文字里出现。
- 用次级说明去弥补层级不足，而不是改分组/间距/标题字重。

### 10.5 提交前检查清单（逐条对照）

- [ ] 删掉任意一行可见说明后，界面是否仍然清楚？是 → 删掉。
- [ ] 每个可见副标题/说明是否都在提供**新**信息或**下一步**？否 → 删掉。
- [ ] 层级是否靠分组/对齐/间距/字号区分，而不是靠更多灰色小字？
- [ ] 空态是否「是什么 + 下一步动作」，没有复述「暂无」？
- [ ] 实现细节（路径、文件映射）是否只讲了一次（放完整文件/展开区/tooltip）？
- [ ] 删除文案后，字段标签、`aria-*`、`sr-only`、错误与危险提示是否完整？否 → 补回。

## 11. 动效

- CDS 缓动曲线全部在 `@theme`：`--ease-swift` `cubic-bezier(0.16, 1, 0.3, 1)`、`--ease-expand` `cubic-bezier(0.19, 1, 0.22, 1)`、`--ease-enter` `cubic-bezier(0.22, 1, 0.36, 1)`、`--ease-out` `cubic-bezier(0.165, 0.84, 0.44, 1)`、`--ease-snap` `cubic-bezier(0.32, 0.72, 0, 1)`、`--ease-overshoot` `cubic-bezier(0.34, 1.3, 0.64, 1)`、`--ease-pop` `cubic-bezier(0.34, 1.56, 0.64, 1)`、`--ease-pulse` `cubic-bezier(0.4, 0, 0.2, 1)`；`--ease-out-soft` 等同 `--ease-enter`。
- 时长阶梯：`--dur-fast` 60ms、`--dur-snap` 120ms、`--dur-base` 200ms、`--dur-sheet` 300ms、`--dur-slow` 450ms。只过渡实际变化的属性，禁止 `transition-all`。
- 按钮按压走 15 阶物理弹簧 `--btn-spring`（`linear(0, 0.2459, … 1)`），active 时 `scale(0.975)`；`.cds-btn-squish` 把 `transform` 绑定到 `--dur-slow` + `--btn-spring`，颜色/边框走 60ms。弹簧按压允许出现在所有共享 `Button`。
- 侧栏宽度过渡 160ms；标签淡出 90ms；展开状态 Logo 切图为 300ms 轻推接力；收起状态保留 Logo 与展开按钮互换的 140ms 过渡。
- 允许的动效：局部交互与状态反馈（悬停背景、展开折叠、浮层显隐、流式光标、复制/安装结果）、消息入场 `message-fade-up`（0.4s、`--ease-overshoot`）、卡片 hover 上浮 1.5px（200ms、`--ease-out-soft`）、执行过程展开 `timeline-expand`（200ms、`--ease-expand`）、滚动遮罩 `scroll-fade-y`（上下 28px 渐隐）、等待点 `quiet-dots`（1.9s、`--ease-pulse`）与状态呼吸点（陶土 `dot-pulse` 1.2s、`clay-breathe`）、普通输入焦点微光 `--shadow-focus-glow`。
- 浮层（Dialog / Sheet / Popover / 菜单 / 选择器 / Combobox / Tooltip）统一由 `.cds-overlay-enter` 驱动 `opacity` + `scale(.96)` → `1` 的过渡（200ms、`--ease-out`），Base UI 的 `data-starting-style` / `data-ending-style` 在动画结束后卸载；Positioner、Portal、焦点与关闭保护保持不变。
- Sheet 保留各 side 的定位与尺寸，仅淡入淡出，不做位移；Switch、加载/运行状态等控件必要状态保留其原有位移或颜色过渡。
- 骨架屏允许 `cds-skeleton-sweep` 扫光；消息滚动按钮只做可见性淡入淡出，不位移、不缩放。
- 减少动态效果（`prefers-reduced-motion: reduce`）下全局把动画/过渡时长设为 `0.01ms`、延迟 `0ms`、迭代 1 次，`scroll-behavior: auto`；JS Motion 仍由各调用方读取 `useReducedMotion` 自行收敛。

## 12. 实现技术栈（硬性）

视觉由上文的数值决定，交互与结构由下列库决定。**不得手写这些库已经提供的东西**：

| 需求 | 唯一实现 | 约束 |
|---|---|---|
| 控件、表单、浮层 | shadcn/ui（`base-nova`）+ Base UI | 先复用或安装官方组件，共享视觉由 `@theme` 语义令牌控制 |
| 图标 | lucide | `LucideProvider` 在 `App.tsx` 统一设 `strokeWidth={1.75}`、`size={16}`，组件里不要再逐个传 |
| 动效 | Motion（`motion/react`）+ Base UI 状态过渡 | 局部交互与状态反馈用 CSS transition（常用 150ms，60–200ms 阶梯、`--ease-out-soft`；浮层用 `data-starting-style` / `data-ending-style`）。需要布局开合时用 Motion：`duration` 沿用 §11 与现有实现的固定值（折叠/浮层 0.15、侧栏 0.16、品牌切图 0.3），缓动 `--ease-out-soft` 或 `easeOut`，并读 `useReducedMotion`；消息入场 0.4s 只使用现成工具类，不扩散到布局开合 |
| 可拖拽分栏 | react-resizable-panels v4 | `Group` / `Panel` / `Separator`；用 `useDefaultLayout` 持久化；分隔条就是 1px `border-line`，不加把手 |
| 拖拽排序 | dnd-kit | 必须带 `KeyboardSensor`，拖拽手柄有可访问名称 |
| 客户端状态 | Zustand | 只放**跨组件、非服务端**的状态；服务端数据一律 TanStack Query |
| 路由与 URL 状态 | TanStack Router | 筛选、分页、选中的 tab 走 `validateSearch`，不要塞进组件 state |
| 类名合并 | `cn`（`lib/cn.ts`） | 唯一实现，不引入 clsx / tailwind-merge 的第二份 |
| 生成式 UI 渲染 | `@openuidev/react-lang` 的 `<Renderer>` | 组件实现全部映射到 shadcn/ui；官方解析、响应式、表单与Query/Mutation运行时负责交互。业务不加载 `@openuidev/react-ui` 的视觉层，该包仅作开发期契约对照。围栏外散文仍走Markdown |

- 项目圆角：卡片 12 / Composer 20 / 用户消息气泡 18 / 行与常规控件 8 / 32px 图标按钮 8（共享 `size="icon"` 32px / `icon-lg` 36px 与紧凑、侧栏折叠实例一致）/ 紧凑图标按钮 8 / 标签 6；外壳平铺、无外框圆角。底座内部细节沿用官方结构；`--radius` 为 8px，InputGroup 的内部按钮经 `calc(var(--radius) - 3px)` 推导为 5px。共享映射见 `styles.css`。
- shadcn 原语的语义色（`bg-popover`、`text-muted-foreground`、`bg-accent` 等）已全部映射到统一语义令牌，**不要在组件里改回具体色值**。
- shadcn 定制顺序：内置 variant → 局部布局 → 源码中的语义 variant → 有实际复用需求的应用组合。底座组件放 `components/ui/`，应用组合放 `src/components/`（如 `ConfirmDialog`）。允许改源码，但保留原语的 `aria-*`、焦点管理与键盘交互，只改外观 token；安装/更新前对比 git diff，`--overwrite` 会覆盖既有定制。

## 13. 禁止

- 卡片套卡片、彩色边框、彩色左边条。
- emoji 当图标。
- 一页多个同等权重标题。
- 在组件或页面里写死 hex、rgba 或第二套颜色表；所有颜色只从 `styles.css` 的 `@theme` 语义令牌取。
- 把 Logo 的黄色或木色铺成高饱和度的大面积页面、按钮或选中态；不得为各页面另造强调色。主操作只走陶土三态，数据蓝只用于 `chart-runs`。
- 把普通图标、正文或整片界面染成陶土或数据蓝；陶土只属于主操作、焦点、状态呼吸点与「运行中」状态徽章/圆点，数据蓝只属于图表数据。
- 用次级标签/说明文字去重复布局、标题或控件已经表达的信息（违反 §10）。
- 除 CDS 双环浮层阴影、Composer 三态阴影与陶土焦点微光外，再新增第二套浮层阴影、彩色光晕或给内容卡片/外壳叠阴影；大面积装饰渐变与玻璃同样禁止（滚动遮罩、骨架扫光等状态渐变除外）。
