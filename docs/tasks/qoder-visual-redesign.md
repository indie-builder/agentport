# Qoder 视觉重设计（qoder-visual-redesign）

状态：Qoder 主题阶段与追加布局阶段均已实现、通过当前范围验证且未提交（2026-10-30）。布局 L1/L2/L3 定向测试、统一验证与真实浏览器 1440×900 / 1280×800 几何已记录；权威规范已同步新几何。旧主题设计文档审阅的 2 项发现已由 Sonnet 修复；本轮 Opus 复审正式文档仅剩 `docs/DESIGN-SYSTEM.md` 中 PageSection 分隔后顶部间距 24→20 的修正，该修正与源码 `page.tsx` 的 `pt-5`（20px）一致，已由 Opus 点验。本轮代码与规范 review 整体通过，无剩余 finding；下一步为用户查看预览，成果未提交、未合入。

## 目标

以 Qoder CN 桌面应用的真实浅色外观为标准，统一 PACE 的配色、菜单、按钮与全部视觉状态；保留现有布局、结构、功能与控件位置，右侧内容区纯白。

验收：语义令牌、共享组件、编辑器、生成式 UI、浮层与状态一致；文字及控件对比达标；既有几何与行为不变。Qoder 编辑器布局、品牌、素材和本机任务内容不进入 PACE。

## 基线与授权

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/qoder-visual-redesign`
- 分支：`worktree-qoder-visual-redesign`
- 起点：`b683903f8bb6a318815b95993e334aa444fbbb38`，建树时与 `origin/main` 相同；初始 clean。
- 主 checkout 的用户后端未提交差异不属于本任务，不改、不提交、不还原。
- 原服务 `http://localhost:5173`、API `http://localhost:3000` 保持运行；不重启、不改配置、不改用户登录态。实现预览可单独启动本树 Vite `http://localhost:5190`，复用 localhost 已有 cookie；这不构成新端口登录流程已验证的证据。
- 用户已授权以 Qoder 为新视觉标准，覆盖旧 PACE 蓝视觉；无需再次选择方向。未授权 commit / push / merge。
- 先前 Overflow 工作全部废弃，不恢复；A/B/C 临时预览不作为权威。
- 截图仅本地留存，不复制进 repo、不上传、不外发。本文件只记录非个人化的颜色与规则。

## 当前有效决定与不变量

1. **视觉来源**：主会话已通过 Codex CLI 原生 `cua_repl` 实际操作 Qoder CN（`com.qodercn.app`），本轮 Opus 已直接 Read 三张原图，而非根据转述设计。
2. **保持几何**：不改 Inter / JetBrains Mono、字号、字重、行高、宽高、间距、布局、菜单分组、控件位置、图标尺寸和线宽、品牌图片、动效及时长；现有边框/outline 宽度保持。可改变颜色、圆角、阴影、边线颜色与背景呈现。
3. **内容纯白**：外壳内部、页面、会话历史、详情阅读区、卡片和浮层的基底均 `#FFFFFF`。hover、selected、代码块、输入禁用层及状态小面积浅底仍按角色呈现；不能把整页内容染成渐变或灰色。
4. **外壳静态渐变**：仅应用外部画布与透明主导航透出渐变；白内容壳及现有位置、外边距保持。渐变不随鼠标、滚动或时间运动。
5. **视觉适配不改行为**：Base UI / shadcn 原语、ARIA、焦点归还、键盘、表单错误、权限、路由、运行、草稿、流式、数据、门户挂载方式均不变。
6. 不复制截图左上特殊入口的紫色，不引入 Qoder 插画、字体、logo 或模型厂商品牌素材。

## 取证与来源边界

原图均为 2640 × 1600，以下坐标为原图像素；屏幕展示缩放不是 CSS 像素标尺。

| 本地证据 | 实际覆盖 |
|---|---|
| `/tmp/qoder-design-reference/base.png` | 暖黄到蓝灰的侧栏、纯白内容、分段控件、输入区、中性工具栏、黑发送位 |
| `/tmp/qoder-design-reference/menu.png` | 实际打开的更多菜单：白底、中性选中、透明工具栏图标 |
| `/tmp/qoder-design-reference/controls.png` | 实际打开的模型菜单：白底、浅灰选中、细边线与柔影 |

采样方法：系统 `sips -s format bmp <png> --out <bmp>`，再用 `python3 -I` 的 `struct` 读取 BMP（负高度表示从上向下），对无文字区域取像素/频次；没有安装依赖。PNG 中的像素受截图和渲染影响，**这些不是 Qoder 源码 token，也不是从源码恢复的 CSS**。

| 采样结果 | 位置/证据 | 用途判定 |
|---|---|---|
| `#ECEBC9` | base `(250,10)`；上部 `(240,5)-(410,80)` 最频繁颜色 | 外部渐变上端 |
| `#DDE3D4` | base `(250,800)` | 外部渐变中点 |
| `#D1DAE3` | base `(250,1590)` | 外部渐变下端 |
| `#FFFFFF` | base `(600,500)`；内容空白 `(600,120)-(2400,280)` 全部白 | 内容、卡片、输入、浮层基底 |
| `#141414` | base 标题区域深色文字主样本，含抗锯齿邻值 | 正文/标题/选中前景 |
| `#0D0D0D` | base `(2240,1460)`；发送按钮内部主样本 | 深色动作填充 |
| `#F6F6F6` | base 工具栏 chip 内部主样本 | hover/下沉/代码中性层 |
| `#EFEFEF` | menu 浮层中性浅底主样本，含 `#EEEEEE`/`#F0F0F0` 邻值 | selected 的中性化归一值 |
| `#E6E6E6` | base 卡片水平细线主样本 | 普通分隔线 |

以下属于 **PACE 适配设计**，不声称采自 Qoder：渐变方向与停点、hover/active 深色阶、辅助文字/输入边界/焦点色、圆角沿用、阴影参数、数据与状态色。Qoder 截图中的很淡辅助文字、边界与不明显焦点不直接复制；使用下述已计算的可访问值。

## 冻结视觉契约

### 1. 语义令牌与映射

继续在 `packages/web/src/styles.css` 的现有 `@theme` 收口，不引入第二套主题提供器、主题切换器、色板依赖或字体依赖；TSX 仅引用语义令牌。只有亮色主题，保留现有 `.dark` 显式禁用系统深色行为。

| 现有/新增角色 | 确定值或映射 | 来源 |
|---|---|---|
| `shell-start` / `shell-mid` / `shell-end`（新增） | `#ECEBC9` / `#DDE3D4` / `#D1DAE3` | 截图采样 |
| `canvas` / `surface` / `panel` | `#FFFFFF` | 白内容要求；canvas 保持纯色以免公开分享等消费者误用渐变 |
| `background` / `card` / `popover` | `surface` | 现有映射 |
| `sunken` / `hover` / `chip` / `code` | `#F6F6F6` | 采样的中性浅层，角色归一 |
| `selected` / `accent` | `#EFEFEF` | 浮层中性浅底归一 |
| `fg` / `ink` / `foreground` / `selected-foreground` / `accent-foreground` | `#141414` | 文字样本与语义映射 |
| `muted-foreground` | `#5F5F5F` | 可访问适配，用于辅助文字、placeholder、元信息、注释 |
| `subtle` | `#828282` | 仅装饰与禁用例外，不承载可读文字 |
| `line` / `border` / `shell-line` / `code-line` | `#E6E6E6` | 采样，分隔用途不承担可编辑边界 |
| `input` / `line-strong` / `control-boundary` | `#767676` | 可访问适配，覆盖渐变最暗端点与中性选中层 |
| `primary` | `#0D0D0D` | 中性动作色，不再通过 `brand-solid` 蓝色间接提供 |
| `primary-hover` | `#262626` | 中性动作适配 |
| `primary-foreground` | `#FFFFFF` | 白色反色内容 |
| `button-primary` / `button-primary-hover` / `button-primary-active` | `#0D0D0D` / `#262626` / `#404040` | 实底采样 + 两档适配 |
| `ring` | `#0D0D0D` | 可访问焦点适配 |
| `secondary` / `secondary-foreground` | `hover` / `fg` | 保留语义映射 |
| `muted` | `sunken` | 仍为表面角色，不是文字 |
| `success` / `warning` / `danger` | 沿用 `#187646` / `#8A5600` / `#B42318` | 既有结果状态，不是 Qoder 采样 |
| `warning-soft` / `danger-soft` | 沿用 `#FBF3E4` / `#FCEBE9` | 既有状态浅底 |
| `chart-runs` | 独立 `#315FAD`，不再指向 UI 主色 | 数据主线保留蓝，不表示导航、按钮或结果状态 |
| `chart-failed` / `destructive` | `danger` | 保留结果映射 |
| `scrim` | 保留 `rgb(0 0 0 / 0.4)` | 既有遮罩 |

删除不再消费的 `brand-solid`；不要因图表需要蓝而保留“品牌唯一蓝”的注释或别名。不新增无消费者的色阶。

外部渐变确定为 `linear-gradient(180deg in srgb, var(--color-shell-start) 0%, var(--color-shell-mid) 50%, var(--color-shell-end) 100%)`。以一个共享 `@utility bg-shell` 承载该声明：`background-color: var(--color-canvas)` 作纯色底，`background-image` 使用该渐变。**禁止修改 `bg-canvas` 的全局含义**。B 包只给 AppShell 的三个外部根容器增加 `bg-shell`，并保留其他布局类；导航本身透明。公开分享与登录页保留白基底，登录按钮仍采用新中性实底。

### 2. 全部状态规则

| 元素 | normal / hover / selected / pressed / focus 规则 |
|---|---|
| 主导航（展开、收起、运维、账号） | 普通 `fg`，分组/元信息 `muted-foreground`；hover `hover`；当前项 `selected` + `selected-foreground`，保留当前字重与 `aria-current`，不加彩条；收起态仍只落在原图标块；focus 使用 `ring` 的单层外轮廓，不以 selected 代替焦点 |
| 普通主操作 Button `default` | 深色实底 `button-primary` + 白字，hover/active 对应两档；保留现有透明 1px 边框占位、全部尺寸和图标；显式 `solid`（发送/登录）用同一三态。按钮聚焦为单层 2px ring，实底外留 2px 背景间隔；错误态危险边框优先、保留现有取消叠环规则 |
| 次操作 `outline` / `secondary` / `ghost` / `plain` | outline 白底细 `line` 边线、深色字，hover/展开 `hover`；secondary 维持中性浅填充，不转换成深色；ghost 工具栏普通透明、hover/展开中性浅底；plain 品牌按钮仍透明。取消、过滤器、菜单触发器不因主色更改变为黑底 |
| 默认主按钮作用域 | 沿用现有 default/solid 调用语义，不逐页批量改 variant、不把所有按钮染黑；同级多个主操作若本就显式 default，记录实际位置交 review 判断，不能擅自改功能或位置。导出的 `buttonVariants`（Link/分页等）与 Button 本体须一致，次操作已有显式 variant 必须保留 |
| 链接 | `primary` 中性深色，保留现有下划线/hover 下划线、焦点与可访问名；不靠蓝色表明可点击 |
| 分段 Tabs | 容器 `hover`；当前 tab `selected` + `fg` + 现有 1px 边框换 `line`，去掉当前 tab 的小阴影；inactive 文字 `muted-foreground`，hover `fg`；只换已有透明边框的颜色，不能添加新的占位宽度 |
| line Tabs / 二级导航 | 继续透明、不加包裹底；现有指示线变为 `primary` 深色，文字 `fg`；保持指示线 2px 与原位置；focus 独立可见 |
| Dropdown / Select / Combobox / ContextMenu / Command | 白浮层、`line` 边线、overlay 阴影；普通文字 `fg`、描述 `muted-foreground`；hover/键盘高亮 `accent` + `accent-foreground`，勾选/当前项保留原图标/状态属性；危险项 `danger`，不能被普通 hover 覆盖。菜单内搜索等 editable 边界使用 `input` |
| Input / Textarea / InputGroup / Select editable trigger / SourceEditor | 白底，1px `input` 边框；hover 不降对比；placeholder `muted-foreground`；focus 只把现有边框换 `ring`，不再叠光环；invalid `danger` 优先、错误文字可读；仅禁用实际输入时用原禁用规则，空内容只禁用发送，不把整组输入透明化 |
| Checkbox / Radio / Switch / Toggle / Slider | 未选边界 `control-boundary`；checked/on 用深色 `primary` + 白色勾/点/thumb，off switch 用 `input` + 白 thumb；Toggle 的选中为 `selected` + `fg`，不是深色实底；沿用当前错误/焦点优先级与形状、尺寸、状态属性，不扩大命中区；disabled 继续现有透明度并禁止交互 |
| Badge | default 与 secondary 都是安静浅中性底、`fg` 字，不再整枚黑填充；outline 仍白底 `line`；危险/成功/警告继续各自语义，链接 badge 保留焦点。文本不能借用 `subtle` |
| 卡片 / 表格 / 列表 / Skeleton / Separator / Progress | 基底纯白，卡片/表格边线 `line`；hover `hover`，行选中 `selected`，文字 `fg`/`muted-foreground`；空态、加载态原结构不变。Skeleton 用 `sunken`；Progress 活跃深色主线，终态仍走原结果语义 |
| 用户消息 / 助手消息 | 用户气泡由浅蓝改为 `selected` + `fg`，保留现有胶囊形状、对齐与宽度；附件中性 outline；助手仍白基底上无气泡；不改 trace、运行读数和流式处理 |
| Code / Shiki | `code` 浅中性底，正文 `fg`，关键字/函数/链接改为中性 `primary`，注释/标点 `muted-foreground`；透明 Shiki 内底继续由外容器提供背景，不改解析、字体或高亮引擎 |
| CodeMirror | 原生主题仍走相同令牌，selection/searchMatch 为 `selected`，gutter `muted-foreground`；搜索面板白底；真实可编辑搜索 input 的边框由 `line` 改 `input`，其余代码无须重写 |
| OpenUI / chart | OpenUI 共用现有组件令牌，不起第二主题；图表首系列显式使用 `chart-runs`，既有其余中性系列、纹理、虚线、图例与缺失值保留；运行失败 `chart-failed`。数据蓝仅用于数据，不能蔓延回导航。图表背景白、网格 `line`、坐标/tooltip 文字 `muted-foreground`/`fg` |
| Toast | 白底、`line`、`fg`/`muted-foreground`、统一 overlay 柔影；操作按钮用显式 `outline` 中性次操作，清除 App.tsx 里旧蓝描边的 important 覆盖；关闭按钮白底/中性 hover；保留时长、位置、关闭、屏幕阅读器提示及真实 success/error 图标和文案 |
| Dialog / AlertDialog / Sheet / Popover / Tooltip | 白表面/细线/overlay 阴影统一；overlay 遮罩沿用 `scrim`；标题/正文正常文字对比；tooltip 若既有反色使用深底白字则可保留；确认 default 为深色主操作、取消 outline，危险确认保持 destructive，不改变焦点锁定/归还/快捷键/关闭逻辑 |

保留 hover、active、expanded、checked、selected、invalid、disabled、focus-visible 的真实状态；不能用页面级 CSS 把所有 `bg-primary` 强制改白（会破坏 checkbox、switch、进度等）。状态不只依赖颜色，沿用既有文字、勾选、图标与 ARIA。

### 3. 圆角、边线与阴影

- **圆角适配为沿用现值**：shell/card/composer 16px，item/普通按钮/input 9px，icon/小控件/tab 7px，tag/badge 6px，头像/pill 9999px。`--radius` 及 shadcn sm/md/lg/xl/4xl 映射保持；checkbox 现有 4px 不动。来源是 PACE 既有几何，不称作 Qoder 尺寸实测。
- **边线几何不变**：已有 1px border/outline、2px tab indicator/focus 等保留宽度；只换颜色。禁止通过新添 border 改控件尺寸。
- **浮层阴影适配**：`--shadow-overlay: 0 8px 24px -8px rgb(0 0 0 / 0.12)`；`shadow-md` / `shadow-lg` 继续映射 overlay。菜单、Select、Popover、Dialog、Sheet、Toast 统一消费，不新增彩色光晕。
- **composer 阴影适配**：`--shadow-composer: 0 1px 4px 0 rgb(0 0 0 / 0.04)`；移除原有 0.5px spread 模拟描边，真实 input 边框仍在；不加厚边界。内容卡片默认无阴影，外壳仍无阴影。
- 分段 tab 当前项去 `shadow-sm`，用既有透明边框换色形成浅边界；不全局修改 `shadow-sm` 影响其他组件。
- 所有 motion、transition、reduced-motion 逻辑保持；静态渐变无动画。

### 4. 已实算的对比度（声明值，不是浏览器结果）

用 Python 标准库按 WCAG sRGB 相对亮度计算 `(Llighter + .05) / (Ldarker + .05)`；普通文字阈值 4.5:1，非文字可编辑边界 3:1。渐变采用 sRGB 分段线性插值，三个通道从上到下均减小，最差背景为下端，不使用透明文字。

| 前景 / 实际声明背景 | 实算 |
|---|---:|
| `fg #141414` / 白 | 18.42:1 |
| `fg` / `selected #EFEFEF` | 16.02:1 |
| `muted-foreground #5F5F5F`（含 placeholder）/ 白 | 6.39:1 |
| `muted-foreground` / selected | 5.55:1 |
| `muted-foreground` / shell 上端、中点、下端 | 5.26 / 4.87 / 4.52:1 |
| 白 / solid normal、hover、active | 19.44 / 15.13 / 10.37:1 |
| `ring #0D0D0D` / selected | 16.90:1 |
| `input` / `control-boundary #767676` / 白、selected、shell 下端 | 4.54 / 3.95 / 3.21:1 |
| success / selected | 4.91:1 |
| warning / selected | 5.35:1 |
| danger / selected | 5.72:1 |
| `chart-runs #315FAD` / 白 | 6.23:1 |
| `muted-foreground` / code `#F6F6F6` | 5.91:1 |
| danger / danger-soft | 5.70:1 |

普通 `line #E6E6E6` 为分组分隔，不声称满足可编辑边界阈值。曾计算候选 `#828282` / shell 下端只有 2.72:1，故不用于 input；该值仅保留给无阅读职责的 `subtle`。浏览器仍须复测透明度、嵌套底色、焦点及禁用例外，不能以此表冒充实机验证。

## 三个互不重叠的 Sonnet 执行包

三个包在同一任务树并行，不单独建嵌套 worktree；**共享契约为本文，单文件只有一个写入者**。只实现下列主题边界，遇到布局/功能问题先回报 Opus，不扩大范围。执行前加载 `ub-mode`，先读 PITFALLS。

### A：主题与颜色验证

唯一写入清单：

- `packages/web/src/styles.css`
- `packages/web/test/theme-contrast.test.ts`（可新增一个小型颜色行为测试；不新增测试工具/依赖）

产出：实现 §1 与 §3 的 token、`bg-shell` utility、Shiki 映射及注释清理；删除无用 brand 别名；维持全部字体/间距/尺寸/motion。小测试从真实 styles.css 读取声明及别名，计算文字/placeholder/实底/可编辑边界的对比阈值和渐变最差端点，不断言一整份 token 快照，不复制另一份颜色表，不为 CSS 写复杂解析器。若现有测试机制不能诚实解析则用一段临时脚本实算并记录，不能以伪测试替代。

验证：`pnpm exec vitest run --project web packages/web/test/theme-contrast.test.ts`（如创建）；`pnpm --filter @agentport/web build` 在 B 合并后由主会话执行。A 不改任何 TSX、不改 B 的 focus 测试。

### B：共享组件与特殊消费者

唯一最小写入清单：

- `packages/web/src/components/app-shell.tsx`：仅三个外部根容器加 `bg-shell`，保留白壳与所有结构。
- `packages/web/src/components/ui/button.tsx`：default/solid 同一中性实底三态与单层 offset focus；其余变体保持职责；helper 与本体一致。
- `packages/web/src/components/ui/tabs.tsx`：分段选中浅底/细线、去小阴影；line variant 仅中性化。
- `packages/web/src/components/ui/badge.tsx`：默认改中性浅底深字，不改状态变体及结构。
- `packages/web/src/components/source-editor-inner.tsx`：CodeMirror 搜索 input 1px 边界改 input token，button 边界保留 line。
- `packages/web/src/openui/components/charts.tsx`：首系列 `primary` → `chart-runs` 并改旧品牌注释，保留其他图表逻辑。
- `packages/web/src/App.tsx`：Toast 操作按钮显式 outline；仅保留 Sonner 特异性确实需要的中性覆盖，toast 加既有 shadow-overlay；不改通知行为。
- `packages/web/test/ui-focus-states.test.ts`：主题 fixture 同步真实语义/色值，主按钮旧描边断言改为实底 + 透明占位边框 + offset focus；保留错误优先级、checkbox/radio/switch/Toggle 单层焦点与 helper 合并验证。

已经经 token 覆盖、不需要预先修改：input、textarea、input-group、select、combobox、checkbox、radio-group、switch、toggle、slider、table、card、dropdown-menu、popover、dialog、sheet、tooltip、Markdown 与业务页面。B 要实际检查这些消费者的 computed style；若发现具体漏色/样式优先级，报告文件与原因后再扩大清单，不能先做全目录 TSX 重写。

验证：`pnpm exec vitest run --project web packages/web/test/ui-focus-states.test.ts packages/web/test/source-editor.test.ts packages/web/test/openui-chart-ui.test.ts packages/web/test/shell-route.test.ts packages/web/test/chat-ux.test.ts packages/web/test/openui-form-ui.test.ts`；`pnpm --filter @agentport/web typecheck`。若是 TSX/焦点行为的新改动，先红后绿更新对应现有行为测试；纯视觉令牌用真实样式证据，不写镜像断言。

### C：规范同步

唯一写入清单：

- `CLAUDE.md`
- `docs/DESIGN-SYSTEM.md`
- `docs/DEV-WORKFLOW.md`

产出：CLAUDE 的「优先级 §2 UI 基准」与「前端视觉」两段明确 Qoder 为配色/控件外观权威，OpenUI 只保留既有布局几何来源，移除“唯一蓝/普通蓝描边/只有发送登录实底”等失效约束。DESIGN-SYSTEM frontmatter 与 §1/2/3/5/6/7/8/9 中的所有旧色值、蓝色描述、按钮/焦点/消息/图表/代码规则同步本契约，保留字体、布局、图标、功能与 §10 信息表达。DEV-WORKFLOW 只在现有「参考 UI 实际操作」条款补明参考维度：Qoder 外观、PACE 既有几何；不增加审批或门禁。其他工程/模型/安全规则不动。本文由主会话协调更新，C 不改本文。

明确新旧冲突与替代原因：旧蓝色规范是代码当前实现的历史约束，被用户 2026-10-30 最新授权覆盖；不是“仍保持蓝规范但临时例外”。只更新活跃权威，不重写历史任务文档。不创建全新 DESIGN.md，完成实现后再从实际产物记录最终设计。

验证：检索三个文档中的 `#315FAD`、`#426FBD`、`#FBFCFE`、`#F0F2F5`、`浅蓝`、`品牌蓝`、`蓝描边`、`唯一品牌色`，仅独立图表数据蓝及明确历史说明可保留；人工对照本文确认无失效的视觉命令。

## 合并后验证与独立 review

A/B/C 可并行，因为写入文件不重叠；主题与组件真实计算样式依赖 A+B 同时完成，故以下串行验收由主会话执行。设计文档最终数值复核依赖实现产物，不能先声称已验收。

1. 按上述范围运行 Vitest、web typecheck/build；`pnpm lint:focus`、`pnpm lint:contract` 检查受影响规则，记录真实结果，不增加 CI 或常驻脚本。
2. 本树 Vite 5190 共享现 API；不动 5173/API 配置及认证。对比实施前/后同一 viewport 的 `getBoundingClientRect()`：侧栏展开/收起、白壳、页面 toolbar、Tabs、主次按钮、聊天输入、发送、菜单 trigger 的位置与宽高不变；边框宽度不变。不要凭类名认定几何相同。
3. 浏览器验证至少：专家列表、资源/表单、对话欢迎/用户消息/历史/编辑器、运维图表、公开成果、登录页外观（不提交登录）、账户菜单、模型/专家下拉、Dialog/Sheet、Toast。使用真实可用数据，不为了展示造后端数据。
4. 读取 computed style：渐变只在外部根、内容纯白；主按钮三态、outline/ghost、分段/line tabs、菜单键盘高亮、placeholder/输入边界、checked/off、错误与 disabled、badge、Shiki/CodeMirror/OpenUI、图表、浮层/Toast；实算实际背景上的对比，键盘 Tab 验证单层焦点。禁用例外不能影响仍可编辑输入。
5. 固定 diff 基线 `b683903…`，Opus 独立 code review；重点查作用域、无障碍与几何不变、旧蓝残留、状态色/数据蓝、docs 对齐。问题修复后定点复核；review 未过不提交。

## 已替代项及原因

- `docs/tasks/qoder-ui-integration.md` 的「沿用既有令牌、不复制渐变」：被用户最新授权覆盖；现使用 Qoder 渐变/中性视觉，仍保留 PACE 布局与功能。
- `CLAUDE.md` 与 DESIGN-SYSTEM 原“PACE 蓝为唯一交互色、冷灰画布、清白表面、普通主操作蓝描边”：由 C 同步为上述视觉契约。
- Overflow 改动全部废弃；A/B/C 临时浏览器方案不是规范；不恢复、不据此定色。
- 原文“第二轮取证未完成、任何色值未定”：已由本次直接读图、采样、对比度计算和冻结契约替代。

## 步骤与当前产出

- [x] 核对基线、工作树隔离与用户最新授权。
- [x] 主会话用 Codex CLI computer use 实际打开 Qoder 并操作模型/更多菜单。
- [x] Opus 实看三张截图，读取像素、计算声明对比度，确定最小完整视觉契约。
- [x] 三个互不重叠执行包及验收命令已写入本文。
- [x] Sonnet A/B/C 并行实现。
- [x] 按改动范围验证并在真实浏览器读取样式/几何。
- [x] Opus 独立 review 与必要定点复核。
- [x] 将实际结果补入本记录，交付未提交差异。
- [x] Toast 按钮 focus 最终修复后的消费者复测。
- [x] 设计文档（`packages/web/DESIGN.md` 与 sidecar）落盘与格式核验。
- [x] 旧主题设计文档审阅（a8827…）的 2 项发现已由 Sonnet 修复；本轮 Opus 复审正式文档，仅发现 PageSection 分隔后顶部间距应为 20px（`page.tsx` `pt-5`，契约未改 PageSection）。
- [x] PageSection 20px 修正已由 Opus 点验：修正与源码 `page.tsx` 的 `pt-5`（20px）一致，finding 关闭；结合前序 L1/L3/chat 与规范 review，本轮代码与规范 review 整体通过，无剩余 finding。

实现与收尾改动均在 worktree；未提交、推送或合并。设计系统快照已生成于 `packages/web/DESIGN.md`，sidecar 为 `packages/web/.impeccable/design.json`（仅该文件从 `.impeccable/` 忽略规则中例外保留）；布局阶段后两份规范已同步新几何。

## 下一步

布局三包已完成并通过定向与统一验证；PageSection 20px 文档修正已由 Opus 点验，本轮代码与规范 review 整体通过、无剩余 finding。下一步为用户查看预览；全部成果未提交、未合入。未启 worker，真实发送/停止/审批、成果文件预览/下载/分享与登录重定向仍未实页验证。

## 已批准布局阶段（2026-10-30）

### 授权、基线与既有差异归属

用户已明确回复「按你的建议来给我调整一下」，授权以下布局调整，不能再次停在候选探索或要求选择方向。此节替代前文 §2「保持几何」、几何不变验收和旧「后续布局探索」中与新布局冲突的部分；Qoder 配色、字体字号、图标、圆角、业务、权限与既有动效原逻辑继续保留。不是照搬 Qoder 编辑器，不新增 credits、编辑器或遥控功能。

继续使用同一 worktree、同一 HEAD `b683903f8bb6a318815b95993e334aa444fbbb38`。开工核对的全部未提交差异属于已完成 Qoder 主题阶段，必须原地保留：`.gitignore`、`CLAUDE.md`、`docs/DESIGN-SYSTEM.md`、`docs/DEV-WORKFLOW.md`、`packages/web/src/App.tsx`、`components/app-shell.tsx`、`components/markdown.tsx`、`components/source-editor-inner.tsx`、`components/status-badge.tsx`、`components/ui/{badge,button,card,combobox,dialog,dropdown-menu,popover,select,tabs}.tsx`、`openui/components/charts.tsx`、`styles.css`、`test/{openui-renderer,ui-focus-states}.test.ts`，以及未跟踪的本任务记录、`packages/web/DESIGN.md`、`packages/web/.impeccable/`、`packages/web/test/theme-contrast.test.ts`（以上 components/openui/styles/test 路径均相对 `packages/web/src` 或 `packages/web` 对应目录）。不能整文件 restore、覆盖或用主题前基线重写这些文件。本阶段只增量应用布局 patch。

服务保持 `5190` 预览 / `3000` API，用户原 `5173` 不动；不改认证、环境配置与用户数据，不提交、推送、合并。源码完成后规范已同步：`docs/DESIGN-SYSTEM.md` 与 `packages/web/DESIGN.md` 按本阶段几何更新；本轮 Opus 复审正式文档仅发现 PageSection 分隔后顶部间距应为 20px（`pt-5`），已修正并经 Opus 点验（与源码一致，finding 关闭），本轮 review 整体通过。

### 冻结布局参数与共享契约

> **局部替代（2026-10-31，第二次纠正）**：下表「chat顶栏」「chat历史」及后续实施/验收条目中的聊天顶部结构已失效。不再有横跨历史/消息/成果三栏的外顶栏；三栏从工作区顶部并排，ChatTopBar 位于消息列内部，历史收起时头部含历史开关/搜索/专家/标题操作/成果，历史展开时头部只留历史开关/标题操作/成果，专家与新建在历史头部、搜索在其下，成果从顶部开始。因此“唯一 56px 顶栏在分栏上方”“桌面历史开合前后顶栏控件同一 DOM 且 x/y 不变”“展开历史时顶栏仍有搜索/专家”均不适用。后加的 56px/24px、浅线配色、历史 200–360px、成果 400px、832px 阅读轴线、单实例 Composer 及业务/焦点行为保留；Composer/草稿/成果验收继续有效。本轮实现、实页测量与独立评审均已完成，不沿用下列旧证据。详见 [chat-history-agent-picker.md](chat-history-agent-picker.md)。

| 区域 | 参数与唯一落点 |
|---|---|
| 主导航 | `styles.css` 现有 `--sidebar-width: 224px`、`--sidebar-collapsed: 64px`；展开 padding 仍 `16px 12px`，收起改 `16px 16px`，32px 图标块居中。沿用160ms侧栏动效、标签淡出、悬停展开、localStorage与全部业务/运维/账号入口。不改 lg 断点，不新增 compact/mobile 规则。 |
| 白壳 | 保持上下右4px外边距、现有圆角与outline；不新造外壳顶栏。 |
| 普通页面横向内容 | AppShell 的非 chat Outlet wrapper 从12px改为24px（`px-6`），底部24px（`pb-6`）；顶部不另加24px，首个56px页头自己负责垂直居中。去掉该处旧12px实测注释。chat 分支仍零 shell padding。 |
| Page | 仍是既有 `Page`，默认区块 gap20→24（`gap-6`），不承担 padding；显式 `gap-0` 的 chat 与 `gap-8` 的 login 必须继续覆盖默认值。不给 Page 添加全局最小高度、顶栏、背景或路由判断。 |
| PageHeader | 现有组件默认 `min-h-14`、移除 `pt-3`，单行时56px、内容自然换行可增高，不使用固定高度裁切。仅无 sr-only 的可见页头占空间；sr-only header必须仍完全脱离正常流。PageHeader 不新增横向padding，避免 wrapper叠加；description、leading、eyebrow、actions不删除。 |
| PageToolbar | 保持现有 flex-wrap/gap-3，不再加padding或高度，不做sticky；搜索、筛选、排序和列表共享wrapper的24px起止边。控件内部gap8、分组gap12，区块gap24。 |
| 资源页面 | ResourcePage继续统一技能/市场、连接器、插件、知识库四类页面。第一行56px：资源类型导航居左、管理actions居右；隐藏h1继续保持一个。第二行PageToolbar按DOM顺序为leadingFilters → 搜索（224px，允许收缩）→ filters → 排序 → 数量（右侧）；工具组8px、组间12px，普通桌面同排、实在放不下自然wrap，不横向溢出、不隐藏控件。去掉当前搜索位于首行和filters独占`w-full`的结构，不改各页面传入插槽、URL、hideSort或市场榜单条件。导航ul移除多余3px外层padding以对齐列表边。 |
| 专家卡 | 仅 AgentsPage 的卡片组合调整，不改共享ui/card。卡片内部16pxpadding，头像40px，名称/角色/描述结构保持，描述最多两行但移除空内容`min-h-10`；开始对话操作放在描述后8px、与信息列同一左边线。移除独立CardFooter、`mt-auto`和底带；保留CardHeader/CardAction及现有CardContent组合、全部名称链接/菜单/停用/导入禁用语义。不固定卡片高度、不为齐底新增占位，网格gap16和现有列数逻辑保留。 |
| chat顶栏（已失效，见上） | 唯一56px顶栏放在整个聊天分栏上方、位于ChatWorkspace内正常流，横padding24px；包含历史开关、稳定的搜索入口、唯一专家选择、现会话h1/操作菜单、右侧成果开关。展开任意面板都不改变这些控件的DOM节点或x/y。必须把顶栏从ChatColumn移到分栏上方；只取消historyVisible条件不足以固定位置。 |
| chat历史（专家选择与头部结构部分已失效，见上） | 复用现有Group/Panel/Separator/useDefaultLayout/panelRef，默认收起0，首次展开240px，min200/max360，用户拖拽记忆照旧。桌面HistoryHeader只保留新建会话等历史动作，不再放专家选择；专家选择只在固定顶栏。历史拖宽时仍受当前可用宽度约束。 |
| chat成果 | 选定400px，属于此前360–480px建议范围内的确定值；本轮不新增右侧拖拽/宽度持久化。保留现有Motion宽度开合、WORKSPACE参数、inert、aria-hidden、成果子树保留和深链自动打开；inline宽400、收起0，去掉会把400压成更小值的`max-w-[40%]`。现有chat Panel在wide且成果打开时minSize由400变800（主消息最少400 + 成果400），其余仍400，由已装分栏库约束历史宽度；这样1280桌面不因历史拖宽把消息列挤没。既有WIDE/desktop断点与Sheet分支保留，不新增断点。窄桌面成果Sheet采用400px及既有max-w-full。 |
| chat输入与阅读轴线 | 实际输入框/正文最大宽832px，两侧各24px；含padding的外容器max880px，使用既有Tailwind间距尺度，页面宽度不足则自然收缩。MessageScrollerContent、加载更早消息、WelcomeState和Composer全部对齐同一832px轴线，删除旧760/728双限宽残留。 |
| chat欢迎/输入 | Composer在ChatColumn里始终同一位置、只渲染一次，位于MessagePane之后的shrink-0正常流，距底24px，不用position:fixed覆盖消息。MessagePane独立滚动，欢迎插画/标题保留在上方阅读区；建议入口移到composer上方8px，只有欢迎且已选专家才显示，点击仅填草稿并focus，不自动发送。欢迎区不再嵌入Composer，不再整块含输入纵向居中。保留现有80/56px textarea最小高度与160px上限。 |

布局实质影响：所有AppShell内普通列表/详情/运维页面继承24px内容边与56px PageHeader；专家列表额外改卡片，四类资源额外改工具行，chat改独立顶栏、输入和成果宽度。登录虽使用Page，已有gap覆盖与sr-only标题保证其原几何；公开分享不经过AppShell；Dialog/Sheet/Popover由门户与现有组件控制，不加全局CSS选择器影响这些场景。

**已失效（2026-10-31，第二次纠正）：** 不再有跨三栏顶栏，专家选择归属与三栏顶部对齐见上；以下为旧行为记录。保留窄桌面既有Sheet行为：历史Sheet打开时主顶栏因模态而不可操作，唯一专家选择可按现有条件临时出现在Sheet的HistoryHeader里；关闭后回到同一主顶栏位置。此为保留现有行为，不增加移动端适配。桌面inline历史无论开合都不能复制、移动或卸载顶栏专家选择。

发现的现有局部几何：knowledge-detail与run-detail把返回按钮放在PageHeader外的`items-end`行；本阶段不重组这些详情页。56px页头可能让外置按钮落在底边，浏览器验收必须确认入口未被裁切；不能借此重写所有详情页。

### 三个 Sonnet 执行包（同树并行，单文件单写者）

下列三个包在本工作树并行，显式 `model: sonnet`。执行前加载ub-mode、读PITFALLS与本节；不能改另一个包的文件。共享接口只有现有Page/ResourcePage行为及上表参数，设计已定，不再发散备选方案；如遇无法满足的不变量先报回Opus。

**L1：全局shell/page/resources**

唯一源码写入：`packages/web/src/styles.css`（仅侧栏4个变量与对应旧注释）、`packages/web/src/components/app-shell.tsx`、`packages/web/src/components/page.tsx`、`packages/web/src/components/resource-page.tsx`。唯一测试写入：`packages/web/test/shell-route.test.ts`、`packages/web/test/resource-navigation.test.ts`、`packages/web/test/resource-count.test.ts`。不改业务资源页、chat/agents、ui原语、主题测试或任何文档。

验收：侧栏展开/收起/刷新记忆和导航可达、页面单一h1、资源全部路由/筛选/排序/来源/数量/市场入口不丢；复用已有行为用例，必要时补一条真实渲染ResourcePage后操作search/filter/actions的用例。不写min-h、px、class字符串快照或jsdom假几何。几何通过最终真实浏览器测量。

命令：`pnpm exec vitest run --project web packages/web/test/shell-route.test.ts packages/web/test/resource-navigation.test.ts packages/web/test/resource-count.test.ts packages/web/test/resource-states.test.ts packages/web/test/resource-forms.test.ts`。共享typecheck/build由主会话等三个包完成后统一运行，执行包不并行生成构建产物。

**L2：chat**

唯一源码写入：`packages/web/src/pages/chat.tsx`、`packages/web/src/components/conversation-outputs.tsx`（仅为适配面板布局确有需要的类，不改成果数据/选择/预览/分享逻辑；不需要则不动）。唯一测试写入：`packages/web/test/chat-ux.test.ts`、`packages/web/test/chat-interactions.test.ts`、`packages/web/test/chat-outputs.test.ts`。不改store、stream、queries、ui原语、全局styles/Page/AppShell、其他chat测试或任何文档。

实施顺序（**已失效，第二次纠正**）：以下“同一DOM节点”和“把顶栏从ChatColumn提升到ChatWorkspace”不再适用；稳定渲染Composer、建议入口、阅读宽度与成果约束继续有效。先红测顶栏专家选择在desktop历史开关前后是同一DOM节点且不属于历史aside，欢迎首发前后textarea仍是同一DOM节点且保留焦点；再把顶栏从ChatColumn提升到ChatWorkspace、清理无用props、稳定渲染Composer、搬建议入口、更新阅读宽度与成果约束。现有`focusHandoff`及其effect/prop只为欢迎切换卸载服务，稳定渲染后删除这条死逻辑，先grep全部调用；`welcome`若仍用于textarea高度则保留，不能机械删除全部相关参数。

修改旧测试中“专家跟随历史移动”“首发textarea必须重建”的断言，替换为新契约而保留其用户目的：专家可搜索/切换、URL与草稿正确、单一h1、首发焦点不丢、不抢其他控件焦点。窄桌面既有Sheet切换/焦点用例保留。成果收起仍inert、aria-hidden，输入草稿/附件/引用不丢。已有chat-scroll、drafts、attachments、questions、history-pages、branch和outputs回归覆盖不能删除。

命令：`pnpm exec vitest run --project web packages/web/test/chat-ux.test.ts packages/web/test/chat-interactions.test.ts packages/web/test/chat-outputs.test.ts packages/web/test/chat-scroll.test.ts packages/web/test/chat-drafts.test.ts packages/web/test/chat-attachments.test.ts packages/web/test/chat-questions.test.ts packages/web/test/chat-history-pages.test.ts packages/web/test/chat-branch.test.ts`。不得为了通过jsdom而断言Panel类名代表像素宽度。

**L3：agents**

唯一源码写入：`packages/web/src/pages/agents.tsx`（仅AgentsPage列表工具行/卡片及必需import清理；不重构AgentEditor/CreateAgentDialog/详情行为）。唯一测试写入：`packages/web/test/agents-ui.test.ts`。不改ui/card、Page、ResourcePage、styles、chat、其他测试或任何文档。

产出：搜索/过滤与列表共享24px内容边，去掉过滤器组强制w-full但保留flex-wrap；只在本页面组合CardHeader/CardContent紧凑放置开始对话；删除失去唯一引用的CardFooter import，保留角色、描述、停用禁用和配置/删除菜单。无独立footer底带、无描述空白占位、无卡片固定高。不把资源卡的共享footer一并删除。

命令：`pnpm exec vitest run --project web packages/web/test/agents-ui.test.ts packages/web/test/agents-lifecycle.test.ts packages/web/test/agents-files-on-demand.test.ts packages/web/test/agents-preview-on-demand.test.ts`。纯间距不新增镜像测试；现有开始对话URL、停用、导入/新建/删除与编辑回归必须通过，缺失的可测业务入口才补行为断言。

### 合并验证、浏览器证据与未验风险

三个执行包无文件重叠，可并行。统一构建、几何与独立review依赖三包全部完成，因此串行执行；各包只汇报真实定向命令结果，不更新本文，本文由协调者单写。

1. 三包结束后统一跑 `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web build`、`pnpm lint:focus`、`pnpm lint:contract`，并对本阶段新增源码范围跑 `pnpm exec biome check <实际改动文件>`、`git diff --check`。不是固定全套测试或CI门禁。
2. 固定同一浏览器viewport 1440×900，对实施前后均记录页面与可见数据、nav状态、URL；另在1280×800检查桌面可用空间。ego-browser负责实际操作/读`getBoundingClientRect()`与computed style，不凭class判完成，不新增Playwright/截图测试依赖。只在5190操作，不修改用户原5173。
3. 专家、四类资源/市场、记忆/运维各取至少一页：aside展开224/收起64，白壳外边距4；可见首行56，内容左右24（轮到自然滚动条边时说明测量基准）；导航、搜索、过滤和列表起止边一致，无页面级横向溢出。空描述/长名称专家卡验证操作紧邻信息、未被裁切，停用不能发起对话。
4. **已失效（第二次纠正）：** 旧“主顶栏56、专家触发器x/y不变”不再适用；改验三栏顶部平齐、消息列头部56/24、专家同一时刻唯一。chat欢迎/已有历史同viewport对照：开/关历史与成果时所有开关、会话操作可达。成果实际400，历史首次240且可200–360内拖动，但受消息最小400约束；1280时允许分栏库缩小历史到可用宽度，不强求不可能的三栏固定宽之和。拖拽与Motion结束后再测，不把动画中间态判失败。
5. 输入框、消息与欢迎文本最大832，左右边线一致；欢迎切换首发前后textarea同节点/焦点保留，建议入口距composer8、点击仅填充。用现有长历史真实滚动验证顶栏和输入框不被卷走，消息区域不被输入覆盖；在现有可用数据内验证附件、引用、停止、审批、重命名、Fork、删除确认和深链成果入口。没有可用数据/worker的部分明确标未验，不造业务数据。
6. 登录仅检查外观，不提交登录；公开分享有可用真实链接时测，否则标缺口；Dialog/Sheet/菜单打开时检查无额外24px套层。保持原sm/lg/WIDE行为，不把320px手机测试或新移动适配加入本阶段。
7. Opus独立review固定基线为“布局前已完成Qoder主题 + 此节指定文件的新增布局patch”，不能把原主题差异当作待删除的布局范围；复核单一h1、模态焦点、节点稳定性、草稿/附件、隐藏面板不可聚焦、页面padding作用域及零死代码。未通过不提交，当前也没有提交授权。

- [x] 读取真实Page/AppShell/ResourcePage/AgentsPage/ChatWorkspace/ChatColumn/Composer/WelcomeState和现有行为测试，核对库尺寸参数按数字像素处理。
- [x] 冻结已批准参数、文件单写者与三个Sonnet执行包。
- [x] 三包并行实现与真实定向验证（L1 88、L3 108、L2 196 项通过；主会话统一 19 files / 392 tests 全通过）。
- [x] Opus独立review及必要修复（L1/L3 通过；chat 代码通过）。
- [x] 规范 PageSection 20px 修正已由 Opus 点验：修正与源码 `page.tsx` 的 `pt-5`（20px）一致，finding 关闭；结合前序 L1/L3/chat 与规范 review，本轮代码与规范 review 整体通过。
- [x] 同viewport浏览器几何/交互验收，记录实际矩形与未覆盖项（见「布局阶段验证记录」）。
- [x] 后续同步权威规范中的旧272/68、760/728、欢迎内嵌输入、专家选择位置等几何（历史主题 272/68 基线保留不改；PageSection 20px 修正已由 Opus 点验通过）。

布局阶段已完成实现，并在已覆盖范围内完成真实浏览器几何/交互验收；未覆盖项见下节「布局阶段验证记录」。主题阶段既有结果仍记录在更下方，不能当作布局阶段证据。

## 验证记录

- 已直接 Read `/tmp/qoder-design-reference/base.png`、`menu.png`、`controls.png`；原图 2640×1600。`menu.png` 实际是更多菜单，`controls.png` 实际是模型菜单；仅作视觉参考，不是 Qoder 原生 token。
- 系统 sips 转 BMP + Python 标准库取色成功，BMP 顶向下存储已校正；没有安装 Pillow 或其他依赖。
- Python sRGB 对比度实算结果见上表；尚非 PACE 浏览器渲染结果。
- 实现后 `@agentport/web` 全套 120 files / 1418 tests 通过；先前 1 个图表旧断言失败已随实现同步。主题对比度 6 项 + 焦点 7 项共 13 项通过。
- `pnpm --filter @agentport/web typecheck`、build、`lint:focus`、`lint:contract`、17 个源码文件 biome 与 diff 检查均通过。
- Opus code review 的 3 项发现（Toast 根焦点、ring 线、文档重要项）已修复并由 Opus 点验；Toast 按钮 focus 的最终修复已由最终消费者复测确认。
- 浏览器后置 3 处消费方修正（status 默认前景、account accent、`.cm-panels` 白底）已执行，定向 102 项通过。
- finish reviewer 结论为 ship，限 7 张桌面截图与抽样源码。未验：登录自动跳转、公开分享（无可用 id，未造数据）、未发消息且未启 worker、checkbox 等全部状态未实页。
- 主 5 页几何与基线一致：aside 272、main x=272/y=4、nav 248×32、主按钮 94×32；收起 68、恢复 272；5 页无水平溢出。chat 前后专家选择不同，整体位置不能精确对比。
- 最终消费者复测通过：Badge 默认前景 `#141414`、account accent `#EFEFEF`、`.cm-panels` 白底；Toast root/action/close 键盘焦点为单层 2px `#0D0D0D`、offset 2，root 保留 overlay 柔影，action 为 0 spread 且无可见 ring（非字面 `none`，不计缺陷），dismiss 无残留；侧栏收起 68、恢复 272。
- 最终 5 个文件 115 项测试通过；build、`lint:focus`、`lint:contract` 通过；typecheck 在最后一次 `App.tsx` 改动后通过。
- browser agent（space73）完成 `http://localhost:5190/agents`（admin）核对并交还用户；预览服务 `by9jy0ix5` 保持运行。旧 5173 / API 3000 继续运行，`codeRoot` 与 head `configApi` 沿用主 checkout `.env`，未更改。
- `packages/web/DESIGN.md` 与 `.impeccable/design.json` 已落盘且格式通过；旧主题文档审阅（a8827…）的 2 项发现已由 Sonnet 修复，本轮 Opus 复审正式文档仅剩 PageSection 间距修正（已改为 20px，并经 Opus 点验通过）。
- 当前全部未提交、未合入，主 checkout 原差异未碰。

### 布局阶段验证记录（2026-10-30）

- 定向：L1 88 项、L3 108 项、L2 196 项通过；主会话统一 19 files / 392 tests 全通过；`typecheck`、`build`、`lint:focus`、`lint:contract`、8 文件 Biome 与 `git diff --check` 通过。
- 独立 review：L1/L3 经 Opus 通过；chat 代码通过；`docs/DESIGN-SYSTEM.md` PageSection 间距修正已由 Opus 点验通过，本轮代码与规范 review 整体通过、无剩余 finding。
- 1440×900 普通页：sidebar 224、main x=224/y=4、页头 56、内容左 24；出现纵向滚动条时右 24 加 10px gutter；专家卡空描述高 94、无 footer；四类资源、记忆与运维页单一 h1、无横向溢出；1280 资源页 searchGroup 224 且单行。
- **已失效（第二次纠正，仅顶栏/专家几何部分）：** 1440×900 chat：顶栏 56；专家触发器 x=328/y=16/176×32，历史与成果开关开合两态同一 DOM、同一 x/y；textarea 同一 DOM；输入 group 832、外 form 880、距底 24；成果 400，收起时 Motion 外层 0、`inert=true`、`aria-hidden=true`；历史 239.8（比例舍入），可拖至 319.3，键盘 ArrowLeft 为 258.8；1280 双开历史 208.1、成果 400、无横向溢出；建议点击只填草稿并聚焦，gap 8，未发送，清空。
- 主会话实测真实滚动（仅此一例）：已有报告会话展开 Write，1280×800 下消息 region 高 598 / scrollHeight 730 / scrollTop 132，向上滚到 0 后 expertY 16 / inputY 671 不变。不声称覆盖所有长历史。
- 视觉 finish reviewer 仅依据 5 张 desktop 截图（未读源码），结论为 ship、无 material fixes。预览已 handOff：73 欢迎页、draft 为空；撤销仿真真实 1480×840。
- 运行详情返回按钮完整；新建专家 Dialog 宽 560，Esc 返回新建按钮，未创建数据。
- 截图：`/tmp/qoder-layout-after-agents.png`、`/tmp/qoder-layout-after-resources.png`、`/tmp/qoder-layout-after-chat.png`、`/tmp/qoder-layout-chat-both-panels.png`、`/tmp/qoder-layout-after-welcome.png`。
- 未验：未启 worker，未做真实发送/停止/审批；首发同节点焦点只由行为测试覆盖；现有报告会话成果返回空，文件预览/下载/分享未在实页验证；登录重定向未验。
- 服务 5190 / 3000 / 5173 保持运行；布局改动未提交、未合入。主题阶段的 272/68 等实测保留在上方历史记录，不改写；布局阶段实测 sidebar 224。
