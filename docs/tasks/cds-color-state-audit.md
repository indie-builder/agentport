# CDS 全站色彩与状态只读审计

## 目标与结论

按已批准的 Claude CDS 亮色基线审计颜色字面值、令牌角色、状态一致性与明确的文字可读性偏差。本任务只新增本文，不修改源码、令牌、素材或其他文档。

发现 **12 条明确偏差：P1 1 条、P2 6 条、P3 5 条**。P1 是工具执行 Trace 的状态说明被整体透明度再次淡化；主要 P2 是等待授权借用动作色、知识库正常运行借用警告色、日历选中层、次按钮 hover、Slider 常态边界以及组合输入禁用态不一致。

| 统计口径 | 结果 |
|---|---:|
| 正则覆盖的前端文本文件 | 180（`src` 177、品牌 SVG 2、`index.html` 1） |
| 页面文件 | 29（另覆盖路由、共享组件、OpenUI、编辑器与全局样式） |
| hex 字面值出现次数 | 100（六位 59、八位 24、三位 17；含合法定义、选择器与素材） |
| `rgb()` / `rgba()` 出现次数 | 25 |
| `hsl()` / `hsla()` / `oklch()` / `oklab()` 颜色函数 | 0；`in_oklch` 混色空间不是 `oklch()` 字面色 |
| hex + rgb/rgba 合计 | **125 次，87 个源码行、4 个文件** |
| 上述 125 次中合法定义 / 非 UI 着色 / 品牌例外 | **110 次**（`@theme` 51、品牌 SVG 26、图表选择器 5、alpha mask 28） |
| 上述 125 次中建议令牌化的字面值 | **15 次，15 行**，均在 `styles.css` 的 `@theme` 外；其中 1 次是受保护创建入口关联的装饰阴影，仅建议保持原值归入令牌 |
| `color-mix()` | 11 次，均只混合现有变量与 `transparent`，函数内硬编码颜色 **0** 次 |
| Tailwind 任意值颜色 / 阴影候选 | 40 次；36 次为变量 / 混色 / 阴影引用，4 次为尺寸误报；直接任意色如 `bg-[#…]` **0** 次 |
| Tailwind 原始具名色 | 6 次：深色代码的 `white` 5 次、Slider 的 `bg-white` 1 次；另无默认彩色色板类 |
| 令牌角色 / 状态问题类别 | **6 类**：动作与焦点角色、运行与警告、选中层、hover 层、disabled 层、文字透明度 |
| 后续建议批次 | **8 批**，每批 1–2 文件 |

这里的「125 次」是出现次数，不是独立颜色数，也不是 125 个缺陷；一个阴影声明内的多次 `rgba()` 分别计数。P1/P2/P3 按下文 CS 编号计数，同一根因的跨文件实例合并一条，不与字面值次数相加。

## 基线、范围与有效决定

- 日期：2026-11-02。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`，分支 `cds-redesign`。
- 起始 HEAD：`a44ba5131de7d1d5b396170ed6eafa59d5aa0b8d`。
- 初始状态：只有既存未跟踪 `tmp/`，属于此前工作，不读取、修改、清理或提交其中内容。
- 唯一交付文件：`docs/tasks/cds-color-state-audit.md`；未授权 commit/push/PR，本任务不执行。
- 收尾时同树另出现未跟踪 `docs/tasks/cds-radius-focus-audit.md` 与 `docs/tasks/cds-spacing-layout-audit.md`；它们不是本任务产出，本任务未读写，保持原状。已跟踪文件 diff 为空。
- 视觉权威：`packages/web/DESIGN.md`；数值来源：`packages/web/src/styles.css` 的 `@theme`；工程语义与对比口径：`docs/DESIGN-SYSTEM.md` §2、§2.4、§10。
- 已读 `packages/web/CLAUDE.md`、`docs/DEV-WORKFLOW.md` §2、`docs/PITFALLS.md`；图表描边不当作图标问题，既有几何与品牌图形不进入改造建议。
- 仅亮色；不审计字体、布局、动效质量、深色主题或框架替换。
- 品牌 Logo、插画、场景图与受保护的创建入口全部保留。CS-12 只指出外围阴影未走令牌，不建议改变插画色彩、阴影数值或入口结构。
- 已批准的输入发丝边、`control-boundary`、`input-focus`、陶土焦点和主按钮白字对比取舍不重新立项；不宣称整站 WCAG AA 达标。
- `docs/DESIGN-SYSTEM.md:45`、`:51` 已明确批准「运行中」徽章的 `brand` tone 和陶土圆点例外。该例外不扩大到等待审批、普通成功、就绪或全部状态。
- 已替代项：无。本次不推翻上述基线。

## 方法与证据边界

先穷举、再逐项读上下文与调用方。覆盖 `packages/web/src` 的 TS/TSX/CSS、`public` 的文本素材及 `index.html`；补查前端配置、其他包，未发现其他产品 UI 颜色字面值。测试夹具、构建产物、依赖、`.impeccable/design.json` 的工具侧色阶不计入产品源码统计；PNG/JPG/WebP/GIF 不做像素枚举，品牌图像保持例外。

可复跑的主要检索命令（仓库根执行）：

```sh
rg -n --glob '*.{ts,tsx,js,jsx,css,html,svg}' '#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color-mix)\(' packages/web/src packages/web/public packages/web/index.html
rg -n --glob '*.{ts,tsx,css}' '(bg|text|border|ring|fill|stroke|outline|shadow|from|via|to|decoration)-\[[^]]+\]' packages/web/src
rg -n --glob '*.{ts,tsx,css}' 'subtle|chart-runs|button-primary|text-link|bg-link|border-link|text-danger|text-warning|text-success|opacity-(30|40|50|60|70)' packages/web/src
rg -n --glob '*.{ts,tsx,css}' '\b(red|green|blue|yellow|amber|orange|rose|emerald|teal|cyan|indigo|violet|purple|pink|sky|slate|gray|zinc|neutral|stone)-(50|[1-9]00|950)\b|(bg|text|border|fill|stroke)-(white|black)\b' packages/web/src
```

混色函数检索不加 `\bcolor-mix`，否则 `shadow-[…_color-mix(…)]` 中的下划线会使词边界匹配遗漏，漏掉两张授权卡的 4 次混色。统计另用 Python 标准库按每次匹配计数；任意值类人工排除字号、线宽与 ring 宽度。

同时运行 Impeccable 只读检测：`/Users/xbjt/.claude/plugins/cache/impeccable/impeccable/4.8.0/skills/impeccable/scripts/impeccable detect --json packages/web/src`，退出码 0，返回 2 条 advisory：`styles.css:312` 的未登记滚动条色，以及 `styles.css:113` 的弹性曲线。前者纳入 CS-10，后者超出本维度且基线已批准，不立项。检测器没有替代人工令牌语义审查。

本报告是**静态源码审计**。未启动应用、未读取浏览器计算样式、未逐页截图或触发全部状态；CS-01 的 2.91:1 是声明值合成计算，不是浏览器采样。CSS 状态选择器与调用关系可直接确认的偏差纳入清单，复杂级联和真实渲染留作各批验收。只改文档，不新建测试，不运行与文档无关的 build/typecheck。

## 硬编码颜色穷举与归类

本节 `S` 精确指 `packages/web/src/styles.css`。所有 `S:行号` 都是该文件的实际行号，不代表行区间。

### 1. `@theme` 的合法定义：51 次

以下是中央定义本身，不应改成页面局部值，也不计缺陷。

| 位置 | 字面值与用途 | 对应语义令牌 / 结论 |
|---|---|---|
| S:21 | `#fcfcfb` 画布 | `canvas`，合法 |
| S:22 | `#ffffff` 内容面 | `surface`，合法 |
| S:23 | `#ffffff` 面板 | `panel`，合法 |
| S:24 | `#f9f9f7` 下沉层 | `sunken`，合法 |
| S:25 | `#f3f3f0` hover 层 | `hover`，合法 |
| S:26 | `#f6f6f4` 标签底 | `chip`，合法 |
| S:27 | `#eae9e4` 选中层 | `selected`，合法 |
| S:33 | `rgba(0,0,0,.10)` 发丝边 | `line`，合法 |
| S:34 | `rgba(0,0,0,.20)` 强分隔 | `line-strong`，合法 |
| S:35 | `#151515` 正文 | `fg`，合法 |
| S:36 | `#a8482b` 正文链接 | `link`，合法 |
| S:42 | `#8a8a8a` 装饰灰 | `subtle`，合法 |
| S:47 | `rgba(0,0,0,.35)` 控件边界 | `control-boundary`，合法 |
| S:50 | `#2a78d6` 图表首系列 | `chart-runs`，合法 |
| S:54 | `#151515` 中性 primary hover | `primary-hover`，合法；不是陶土按钮 hover |
| S:56 | `#d97757` 主操作常态 | `button-primary`，合法 |
| S:57 | `#cc5a36` 主操作 hover | `button-primary-hover`，合法 |
| S:58 | `#ad4724` 主操作 active | `button-primary-active`，合法 |
| S:65 | `#187646` 成功 | `success`，合法 |
| S:66 | `#e9f3ec` 成功浅底 | `success-soft`，合法 |
| S:67 | `#8a5600` 警告 | `warning`，合法 |
| S:68 | `#fbf3e4` 警告浅底 | `warning-soft`，合法 |
| S:69 | `#b42318` 危险 / 失败 | `danger`，合法 |
| S:70 | `#fcebe9` 危险浅底 | `danger-soft`，合法 |
| S:73 | `#f6f6f6` 行内代码 | `code`，合法 |
| S:74 | `#0d0d0c` 块级代码底 | `code-block`，合法 |
| S:75 | `#e6e6e4` 块级代码前景 | `code-block-fg`，合法 |
| S:78 | `rgb(0 0 0 / .4)` 遮罩 | `scrim`，合法 |
| S:154 | `#151515` 原语映射 | `primary`，合法 |
| S:155 | `#ffffff` 原语反色前景 | `primary-foreground`，合法 |
| S:160 | `#525252` 可读辅助字 | `muted-foreground`，合法 |
| S:162 | `#ffffff` 危险反色前景 | `destructive-foreground`，合法 |
| S:170 | `#bdbdbd` 编辑器焦点线 | `input-focus`，合法 |
| S:171 | `#d97757` 焦点环 | `ring`，合法 |
| S:177 | 黑 `.10/.12/.08`，3 次 `rgba` | `shadow-overlay`，合法 |
| S:178 | 黑 `.04`，1 次 | `shadow-bubble`，合法 |
| S:179 | 黑 `.04`，1 次 | `shadow-2xs`，合法 |
| S:180 | 黑 `.05/.08`，2 次 | `shadow-sm`，合法 |
| S:181 | 黑 `.035/.10`，2 次 | `shadow-composer`，合法 |
| S:182 | 黑 `.06/.20`，2 次 | `shadow-composer-hover`，合法 |
| S:183 | 黑 `.08/.20/.20`，3 次 | `shadow-composer-focus`，合法 |
| S:185 | 黑 `.09`，1 次 | `shadow-panel-hover`，合法 |
| S:186 | `#d97757` + `rgba(217,119,87,.25)`，2 次 | `shadow-focus-glow`，合法且为已批准微光；不因字面值与动作色同值立项 |

### 2. `@theme` 外的字面值：43 次

| 位置 | 当前用途 / 字面值 | 应否走令牌、建议与归类 |
|---|---|---|
| S:231 | Shiki 注释 `#8b8b86` | 是；提出 `code-syntax-comment` 令牌缺口，保留现有暖灰值；CS-08 |
| S:232 | Shiki string `#cdcdc8` | 是；`code-syntax-string` 缺口；CS-08 |
| S:233 | Shiki string-expression `#cdcdc8` | 是；与 string 共用同一令牌；CS-08 |
| S:235 | Shiki keyword `#e0a48a` | 是；`code-syntax-accent` 缺口；CS-08 |
| S:236 | Shiki function `#e0a48a` | 是；与 keyword 共用；CS-08 |
| S:237 | Shiki parameter `#b8b8b2` | 是；`code-syntax-muted` 缺口；CS-08 |
| S:238 | Shiki punctuation `#8b8b86` | 是；与 comment 共用；CS-08 |
| S:239 | Shiki link `#e0a48a` | 是；与 keyword 共用，不换成亮色页面的深陶土 `link`；CS-08 |
| S:240 | 深色代码作用域的辅助字 `#b8b8b2` | 是；与 parameter 共用深色代码辅助令牌；CS-08 |
| S:295 | 深代码选区 `rgba(217,119,87,.38)` | 是；`color-mix(in srgb, var(--color-button-primary) 38%, transparent)` 等值表达；CS-09 |
| S:296 | 深代码选区前景 `#ffffff` | 是；现有白色反色前景 `primary-foreground`；CS-09 |
| S:307 | 滚动条常态 `rgb(0 0 0 / .16)` | 是；当前没有精确匹配的滚动条语义，建议登记 `scrollbar-thumb` 缺口，保留值；CS-10 |
| S:312 | 滚动条 hover `rgb(60 55 52 / .32)` | 是；`scrollbar-thumb-hover` 缺口，不冒充已有 `line-strong` 同值；CS-10 |
| S:387 | 扇形创建入口图形 chip 阴影 `rgb(12 12 13 / .05)` | 是；现有 `shadow-2xs` 的黑 `.04` 不等值，标记 `shadow-illustration-chip` 缺口。保留受保护入口、图形及数值；CS-12 |
| S:613 | Skeleton 扫光 `rgba(255,255,255,.6)` | 是；现有 `surface` 的 60% 透明度可等值替代；CS-11 |
| S:650 | `-webkit-mask-image` 的 14 个黑色 alpha stop | 否；这是遮罩透明度函数，不是 UI 色板，不应换成动作 / 状态色 |
| S:651 | `mask-image` 的相同 14 个 alpha stop | 否；同上，跨浏览器等价声明，不重复立项 |

S:650 与 S:651 各自依次为：`#0000000d`、`#00000026`、`#0000004d`、`#00000080`、`#000000b3`、`#000000d9`、`#000`、`#000`、`#000000d9`、`#000000b3`、`#00000080`、`#0000004d`、`#00000026`、`#0000000d`。在 alpha mask 模式下黑色 RGB 不决定界面颜色，alpha 才决定透明度。

Shiki 的暖陶土语法、深色代码块和选区都是 `packages/web/DESIGN.md:425` 明确保留的能力。CS-08/09 指向令牌归属，不指控其配色非法，也不要求改成页面正文色。

### 3. 图表兼容选择器：5 次

`packages/web/src/components/ui/chart.tsx:65` 包含 `#ccc` 3 次、`#fff` 2 次。这些值出现在 Recharts DOM 属性选择器 `[stroke='#ccc']` / `[stroke='#fff']` 中，用于识别库默认输出，再通过 `stroke-border` / `stroke-transparent` 覆盖。它们不是给 UI 写入硬编码色；不能把选择器里的字面值改成 CSS 变量，否则可能不再命中库输出。**全部合法，不计偏差。**

### 4. 品牌 SVG：26 次，全部保留

以下两张 Logo / 插画各 13 次，均属于品牌配色例外，不建议换语义令牌。路径 1 为 `packages/web/public/brand/pace-chat-woodworker.svg`，路径 2 为 `packages/web/public/brand/pace-mark.svg`。

| 路径 1 的 file:line | 路径 2 的 file:line | 值与用途 |
|---|---|---|
| `pace-chat-woodworker.svg:3` | `pace-mark.svg:6` | `#000` 图形轮廓 |
| `pace-chat-woodworker.svg:5` | `pace-mark.svg:8` | `#C98B4E` 木柄 |
| `pace-chat-woodworker.svg:6` | `pace-mark.svg:9` | `#6B7380` 工具头 |
| `pace-chat-woodworker.svg:7` | `pace-mark.svg:10` | `#6B7380` 工具头局部 |
| `pace-chat-woodworker.svg:8` | `pace-mark.svg:11` | `#3D434C` 工具连接部 |
| `pace-chat-woodworker.svg:11` | `pace-mark.svg:14` | `#F4D9A6` 铅笔木尖 |
| `pace-chat-woodworker.svg:12` | `pace-mark.svg:15` | `#000` 笔芯 |
| `pace-chat-woodworker.svg:13` | `pace-mark.svg:16` | `#F2B600` 笔身 |
| `pace-chat-woodworker.svg:14` | `pace-mark.svg:17` | `#D99A00` 笔身线 |
| `pace-chat-woodworker.svg:15` | `pace-mark.svg:18` | `#B8BEC6` 金属圈 |
| `pace-chat-woodworker.svg:16` | `pace-mark.svg:19` | `#F49AA8` 橡皮 |
| `pace-chat-woodworker.svg:18` | `pace-mark.svg:21` | `#fff` 左侧角色白面 |
| `pace-chat-woodworker.svg:21` | `pace-mark.svg:24` | `#fff` 右侧角色白面 |

`public/brand/scenarios/`、`public/brand/business/`、`src/assets/agents/` 的位图未做颜色迁移建议。

### 5. 混色函数与 Tailwind 任意值

11 次 `color-mix()` 的完整落点：

| file:line | 次数 | 用途与判定 |
|---|---:|---|
| `packages/web/src/styles.css:287` | 1 | 普通文本选区，`button-primary` 22% + transparent；已有中央规则，合法 |
| `packages/web/src/components/ui/button.tsx:18` | 1 | secondary hover 把 `secondary` 与 `foreground` 5% 再混合；没有裸颜色，但产生规约外 hover 层，CS-05 |
| `packages/web/src/openui/components/charts.tsx:77` | 1 | fg 80% + surface，图表后续灰阶；合法 |
| `packages/web/src/openui/components/charts.tsx:79` | 1 | fg 62% + surface，同上 |
| `packages/web/src/openui/components/charts.tsx:80` | 1 | fg 50% + surface，同上 |
| `packages/web/src/pages/channel.tsx:778` | 2 | 等待授权的边环 35% 与外光晕 30%；令牌角色误用，CS-02 |
| `packages/web/src/pages/channel.tsx:784` | 1 | 等待授权徽标 12% 陶土底；CS-02 |
| `packages/web/src/pages/chat.tsx:3252` | 2 | 等待授权的边环 35% 与外光晕 30%；CS-02 |
| `packages/web/src/pages/chat.tsx:3257` | 1 | 等待授权徽标 12% 陶土底；CS-02 |

40 次任意值类的核对清单（每个位置存在的匹配均纳入，重复匹配次数见括号）：

| file:line | 任意值类型 | 判定 |
|---|---|---|
| `packages/web/src/components/code-block.tsx:22`、`:76`、`:115` | `code-block-fg` 文字、`code-block` 底（合计 4 次） | 现有令牌，合法 |
| `packages/web/src/components/knowledge-citations.tsx:521`、`:532` | `link`（2 次） | 合法 |
| `packages/web/src/components/markdown.tsx:155`、`:165`、`:204` | `link`、`code-block`、`code-block-fg`（4 次） | 合法 |
| `packages/web/src/components/memory-review.tsx:1585`、`:1594`、`:1809` | `link`（3 次） | 合法 |
| `packages/web/src/components/ui/badge.tsx:18` | `link`（1 次） | 合法 |
| `packages/web/src/components/ui/button.tsx:12`、`:14`、`:18`、`:23` | 两个 `shadow-2xs`、secondary 混色、`link`（4 次） | 混色见 CS-05，其余合法 |
| `packages/web/src/components/ui/combobox.tsx:172` | 聚焦边 `button-primary`、`shadow-focus-glow`（2 次） | 真实焦点，合法 |
| `packages/web/src/components/ui/input-group.tsx:16` | 聚焦边与微光（2 次） | 焦点合法；禁用问题另见 CS-07 |
| `packages/web/src/components/ui/input.tsx:11`、`packages/web/src/components/ui/select.tsx:43`、`packages/web/src/components/ui/textarea.tsx:9` | 聚焦边（3 次） | 合法 |
| `packages/web/src/pages/channel.tsx:778`、`:784` | 边、阴影、底与字（4 次） | 无硬编码色，但见 CS-02 |
| `packages/web/src/pages/chat.tsx:2407`、`:3252`、`:3257` | 气泡阴影与授权卡（5 次） | 气泡令牌合法，授权卡见 CS-02 |
| `packages/web/src/pages/memory-panel.tsx:122`、`packages/web/src/pages/personal-shares.tsx:46` | `link`（2 次） | 合法 |
| `packages/web/src/components/ui/calendar.tsx:75`、`:81`、`:175` | `text-[0.8rem]` 两次、`ring-[3px]` 一次 | 3 次尺寸误报，不是颜色字面值；不扩成字号 / 焦点几何审计 |
| `packages/web/src/components/ui/chart.tsx:207` | `border-[1.5px]` | 1 次线宽误报，不是色值 |

另外 6 次原始 `white` 类：

- `packages/web/src/components/code-block.tsx:22` 的 `text-white/55`（JSON null）、`:71` 的 `text-white/45`（行号）：不是低对比正文实证，但绕过代码文字令牌，纳入 CS-08。
- `packages/web/src/components/code-block.tsx:115` 的 `border-white/10`，以及 `packages/web/src/components/markdown.tsx:165` 两处 `border-white/10`：`DESIGN.md:425` 已明确规定深色代码块白色 10% 边线，保留，不计缺陷。
- `packages/web/src/components/ui/slider.tsx:46` 的 `bg-white`：应使用同值 `bg-surface`，与 CS-06 一并处理。

## 状态一致性与令牌角色核对

| 状态 / 内容 | 已统一的实现证据 | 偏差或边界 |
|---|---|---|
| 主按钮 normal / hover / active | `components/ui/button.tsx:12`、`:14` 共用陶土三态；登录 / 发送通过同一按钮变体 | 未发现页面另写 hex、覆盖出第二套主按钮三态；主按钮白字已批准对比取舍不重提 |
| secondary / outline / ghost hover | `components/ui/button.tsx:16`、`:20` 使用 `hover` | secondary 单独混色，CS-05 |
| 导航 / 页签 / Toggle / 列表选中 | `components/app-shell.tsx:245`、`components/ui/tabs.tsx:53`、`components/ui/toggle.tsx:6`、`components/ui/table.tsx:43`、`components/plugin-file-tree.tsx:95` 使用中性 selected | 日历仍用墨色实底白字，CS-04；资源页白 thumb 是 `DESIGN.md:394` 明确例外 |
| 角色矩阵变更 | `pages/roles.tsx:1009` 用 `selected`，基底 `surface` | 符合 `DESIGN.md:350` 的中性变更提示，不误判为状态借用动作色 |
| checked / on | `components/ui/checkbox.tsx:10`、`components/ui/radio-group.tsx:20`、`components/ui/switch.tsx:18` 使用墨色 primary，白色勾 / 点 / thumb | 已批准控件形态，不要求改陶土，也不等同日历选中例外 |
| 输入 invalid | `components/ui/input.tsx:11`、`textarea.tsx:9`、`select.tsx:43`、`input-group.tsx:16` 保留 danger 边与独立焦点 | 未发现页面硬编码红色或错误态借用 chart-runs |
| disabled | Button / Input / Textarea 等使用 `.35` 透明度；Input / Textarea 用 `control-boundary/50` 底 | InputGroup 改用 muted 底且父子重复透明度，CS-07；SourceEditor `.50` 等真实 disabled 例外只记录差异，不当作正文 AA 违例 |
| 排队 / 运行 / 完成 / 失败 | `lib/format.ts:96` 的 default / brand / success / danger / outline；`components/run-status-badge.tsx:7`、`pages/eval.tsx:93`、`:783` 复用 | 知识库映射另用 warn 表示 running / processing，CS-03 |
| 频道成员状态点 | `pages/channel.tsx:859`、`:860`、`:861`、`:862`、`:863`：断开 / 暂停 / 空闲装饰灰，等待审批 warning，运行 fg | 同时保留文字，非徽章和非主操作；运行 fg 不自行判为非法，待审批 warning 可作 CS-02 的就近一致性依据 |
| 成功 / 警告 / 错误提示 | `components/status-badge.tsx:12`、`:13`、`:15` 共用独立色与浅底；`components/states.tsx:68` 用 danger-soft；`components/confirm-dialog.tsx:65`、`:78` 用 danger 与 destructive | OpenUI Callout 的 `border-success/warning/danger` 与 `text-*` 属同一语义，小面积形式不同不算另造色板 |
| 启用 / 停用 | `pages/knowledge-detail.tsx:342` 为 success / outline；`pages/accounts.tsx:219`、`:251` 两状态均 default；专家停用 `pages/agents.tsx:742` 用 default | 存在中性展示与结果色展示两种方式，但无硬性要求所有「启用」均染成功色，文字可区分；列为观察，不增加明确偏差数 |
| Toast | `App.tsx:14`、`:24`、`:25` 使用亮色白底与可读文字；`lib/toast.ts:4`、`:8` 统一错误 / 成功入口 | 未要求每种 toast 整块着色；中性表面不是状态缺失的充分证据 |
| `chart-runs` | `pages/overview.tsx:307`、`pages/eval.tsx:168`、`openui/components/charts.tsx:76`，以及唯一中央定义 | **非图表使用 0 处**；图表后续灰阶与纹理是批准方案，不要求新分类色板 |
| `danger` | 失败、错误、破坏性动作、字段必填标记和差异删除行 | 未发现把 danger 当普通标题 / 品牌强调的明确实例；`pages/servers.tsx:1194` 位于删除影响范围，不能脱离上下文误报 |
| `subtle` | `components/states.tsx:112` 空态图标、`components/page.tsx:122` 行内装饰图标、`pages/chat.tsx:3319` 待处理图标；另有灰状态点 | **直接承担可读文字 0 处**；相关正文实际用 fg / muted-foreground。Trace 的透明度绕过了这一保障，见 CS-01 |
| 深色代码 / CodeMirror | `components/source-editor-inner.tsx:38` 的颜色均引用现有变量，selection / searchMatch 用 selected；深代码按 `DESIGN.md:425` 保留暖灰 / 浅陶土 | 不把深代码当暗色主题重引入；字面值归属见 CS-08/09 |

## 明确偏差清单

P1：声明值可证明的阅读障碍；P2：违反既定角色或跨控件状态契约；P3：颜色表现基本合理，但绕过语义令牌。风险同时说明现状影响与建议实施时须保留的行为。

### CS-01 · P1 · Trace 的 pending 状态把需阅读的说明淡化到低对比

- **file:line**：`packages/web/src/components/ui/trace.tsx:34`、`:64`；真实调用 `packages/web/src/pages/chat.tsx:3354`、`:3374`、`:3385`。
- **现状**：工具未收到结果时 `lineStatus = 'pending'`，整条 TraceLine 应用 `opacity-60`。TraceDescription 的 `muted-foreground #525252` 也一起淡化，不是 disabled 控件；用户必须阅读「未收到结果」、耗时与引用数。
- **依据 / 影响**：按 §2.4 白底 alpha 合成，单通道 `82 × .6 + 255 × .4 = 151.2`，对比约 **2.91:1**，低于普通文字 4.5:1。`subtle` 本身未误用，但整行透明度产生了更浅的可读文字。
- **建议令牌**：保留原本 `text-muted-foreground`、正文 `text-fg`，去掉 pending 对整行的透明度；如需弱化仅作用于装饰图标，保留图标形状与「未收到结果」文字。
- **风险**：现状使诊断状态难读；修复不得把未收到结果误标为运行 / 成功，不能移除原 Trace 折叠、焦点和状态描述。浏览器背景与实际输出需复测。

### CS-02 · P2 · 等待授权借用运行中的陶土徽标与常驻焦点光晕

- **file:line**：`packages/web/src/pages/chat.tsx:3252`、`:3257`；`packages/web/src/pages/channel.tsx:778`、`:784`。
- **现状**：审批仍在等待时，用 `button-primary/50` 边、两个陶土混色阴影、陶土 12% 徽标底与 `link` 字；它们在没有焦点时常驻。两页正文底还分别是 chip 与 surface。图标却使用 warning，频道成员同一等待审批状态在 `channel.tsx:861` 也用 warning。
- **建议令牌**：等待标识用已有 `warning-soft` + `warning`（或 `StatusBadge` 的 `warn` tone）；卡片边用 `line`，需要风险强调时用 `warning`，移除常驻焦点光晕。批准按钮继续保留真正动作的陶土三态；实际焦点使用共享 `ring` 规则。
- **风险**：现状把「需要用户决定」与「正在运行」混淆，并削弱真正焦点的辨识；只换状态配色，不修改批准作用域、等待判断、时限、按钮权限、ARIA 或提示内容。运行中 brand 例外不涵盖等待授权。

### CS-03 · P2 · 知识库把正常处理中 / 运行中映射成警告

- **file:line**：`packages/web/src/components/knowledge-shared.tsx:23`、`:39`；落点 `packages/web/src/pages/knowledge-detail.tsx:1092`、`:1883`、`:4349`、`:4583`。
- **现状**：`documentStatusTone.processing` 与 `jobStatusTone.running` 均为 `warn`，正常执行与真实警告共用黄褐色。同期通用运行和评估在 `lib/format.ts:98`、`:126` 使用明确批准的 brand tone。
- **建议令牌**：文档「解析中」回到中性 `default`（`sunken` + `fg`）；同名「运行中」使用既有 `brand` tone（`button-primary/12` + `link`，属于明确例外），与全站运行徽章一致。不要把所有 pending / processing 泛化成 brand。
- **风险**：现状容易让正常任务看起来存在异常；复测文档列表、文档详情、来源同步记录和处理记录，保留 failed danger、ready success、queued default、cancelled outline。

### CS-04 · P2 · Calendar 的选中日期仍是墨色实底白字

- **file:line**：`packages/web/src/components/ui/calendar.tsx:92`、`:97`、`:175`；真实入口 `packages/web/src/openui/components/forms.tsx:346`、`:357`。
- **现状**：单选与 range 两端用 `bg-primary text-primary-foreground`，区间中部及端点衔接用 `bg-muted`。与已批准 selected 中性层及其他选中控件不一致；checkbox/radio/switch 的深色 checked 例外不能自动扩展到日历。
- **建议令牌**：选中日期与端点采用 `selected` + `selected-foreground`；中段用 `selected` 或现有中性层按区间结构统一，保留开始 / 结束形状与文字。hover 仍走 `hover`。
- **风险**：修改需检查选中 + hover + focus 的交集、单日、完整范围与未完成范围；保留 DayPicker modifiers、范围连通、禁用日期和键盘导航。本项不改焦点宽度或日期机制。

### CS-05 · P2 · secondary hover 产生独立的第三套中性层

- **file:line**：`packages/web/src/components/ui/button.tsx:18`。
- **现状**：secondary 常态 / expanded 用 `secondary`（即 hover），hover 却混入 5% foreground，生成比批准 `hover #F3F3F0` 更深的自定义底。outline、ghost hover 都使用同一个 `hover`。
- **建议令牌**：使用现有 `hover` / `secondary`，删除局部混色，保持 expanded 与 hover 的统一底色；不改普通主按钮陶土三态。
- **风险**：共享按钮影响所有 secondary 调用，需同时验 hover / expanded / disabled；这是状态层一致性，不是字面 hex 问题，不应另外新增 hover 颜色令牌。

### CS-06 · P2 · Slider 的常态边界借用陶土 ring，白底绕过令牌

- **file:line**：`packages/web/src/components/ui/slider.tsx:46`；真实入口 `packages/web/src/openui/components/forms.tsx:401`。
- **现状**：thumb 常驻 `border-ring`，没有焦点也显示陶土边；hover / active / focus 又使用 ring。普通边界与焦点使用同一颜色，且底色为原始 `bg-white`。
- **建议令牌**：常态边界使用 `control-boundary`，底用同值 `surface`；焦点保留 `ring`。保持现有 Indicator 的中性 `primary`、轨道 `sunken`，不把滑杆数值当主操作。
- **风险**：必须确认 Thumb 内部原生 range input 的真实键盘焦点仍可见，不能因换边框删掉焦点环；不改变数值、拖动、disabled 或 ARIA。

### CS-07 · P2 · InputGroup 禁用态换了底色且重复降低透明度

- **file:line**：`packages/web/src/components/ui/input-group.tsx:16`、`:109`、`:122`；对照 `packages/web/src/components/ui/input.tsx:11`、`textarea.tsx:9`。
- **现状**：组外壳 disabled 使用 `bg-muted opacity-50`；内部 Input / Textarea 只覆盖为透明底，没有覆盖其继承的 `disabled:opacity-[0.35]`。文字实际同时受父层 .50 与子层 .35 影响（有效 .175），独立输入则只有 .35，禁用背景也不同。
- **建议令牌**：外壳按同一输入契约用 `control-boundary/50`；禁用透明度由一个层级负责，内部控制器与外层不要相乘。复用现有数值，不新增私有 disabled 色。
- **风险**：禁用控件有对比豁免，本项按状态一致性而非 AA 缺陷立项；需检查带 addon 的 InputGroup、Combobox 及 composer 的真实 disabled，不能把空内容或 readonly 自动等同 disabled，也不能淡化仍可操作的附件按钮。

### CS-08 · P3 · 深色代码语法及辅助文字绕过中央令牌

- **file:line**：`packages/web/src/styles.css:231`、`:232`、`:233`、`:235`、`:236`、`:237`、`:238`、`:239`、`:240`；`packages/web/src/components/code-block.tsx:22`、`:71`。
- **现状**：Shiki 9 处固定色在 `@theme` 外；JSON null 和行号另用 `text-white/55`、`text-white/45`。这些颜色服务正确的深色代码场景，问题是无法从语义令牌维护。
- **建议令牌**：保持现有 4 个 Shiki 实色，登记并集中 `code-syntax-comment/string/accent/muted`（均为建议名，尚不存在）；JSON 辅助字也引用中央代码文字语义。现有 `code-block` / `code-block-fg` 继续承担底色与正文；白 10% 边线是已批准例外，不顺手删除。
- **风险**：不能把深代码注释改成亮色页面 `muted-foreground`，也不能直接把浅陶土换深 `link`；验证 Markdown / OpenUI 代码与 JSON 输出，保留当前语法区分和可读性。未认定当前 null / 行号存在对比失败。

### CS-09 · P3 · 深代码选区重复写陶土与白色字面值

- **file:line**：`packages/web/src/styles.css:295`、`:296`。
- **现状**：选区使用固定 `rgba(217,119,87,.38)` 与 `#ffffff`，会与中央动作色 / 白色值脱离。
- **建议令牌**：陶土 38% 用 `button-primary` 混透明；白字用现有反色前景 `primary-foreground`。这是批准的选区效果，不取消深代码的独立选区规则。
- **风险**：复测 `.cds-code-surface` 与 Streamdown 两种容器的选择高亮，保持当前覆盖范围与透明度，不改全局普通选区。

### CS-10 · P3 · 滚动条 normal / hover 仍是独立字面色

- **file:line**：`packages/web/src/styles.css:307`、`:312`。
- **现状**：常态黑 .16、hover 暖灰 .32 都未走 `@theme`，hover RGB 还不在 DESIGN 的语义色板内；Impeccable 亦返回该 hover advisory。
- **建议令牌**：登记 `scrollbar-thumb` / `scrollbar-thumb-hover` 语义缺口，优先把当前值等值集中。现有 `line` / `line-strong` 的 alpha 不等值，不声称可无损替换；不为此变更已经批准的全站色板。
- **风险**：影响全部内部滚动面，验证代码、列表和对话滚动区；保持 thumb 的可拖动范围、透明边与 background-clip，不扩成滚动机制重做。

### CS-11 · P3 · Skeleton 扫光直接写白色 rgba

- **file:line**：`packages/web/src/styles.css:613`。
- **现状**：骨架底已使用 sunken，但中间扫光仍为 `rgba(255,255,255,.6)`。
- **建议令牌**：用 `surface` 60% 混透明，等值替换，不新增颜色。
- **风险**：只处理颜色引用，保留当前动画、梯度角度、stop、时间与减少动态效果分支；本审计不重开动效设计。

### CS-12 · P3 · 受保护创建入口外围的 chip 阴影未走令牌

- **file:line**：`packages/web/src/styles.css:387`。
- **现状**：`.agent-create-fan__chip` 的 `box-shadow` 固定 `rgb(12 12 13 / .05)`，与中央阴影变量分离。
- **建议令牌**：登记 `shadow-illustration-chip` 缺口并保留原值；不要拿数值不同的 `shadow-2xs` 或层数更多的 `shadow-panel` 直接替换。
- **风险**：该项与受保护扇形创建卡相邻，风险在误把治理扩成重设计；只允许令牌归属建议，不动入口、插画配色、叠放、尺寸、动效或品牌素材。本次未作任何修改。

## 对比与文档冲突核对

明确对比违例只有 CS-01。未发现用 `subtle` 直接写正文、表头、时间、帮助文字、错误恢复说明或可操作标签的实例；不用图标的装饰灰推导文字不合格。没有重新计算全部令牌或将禁用、品牌、mask、已批准边界取舍重复列为 P1。

发现以下文档内部或文档 / 实现表述冲突，遵循既定视觉权威，本任务只在本文记录，不修改其他文档：

| 位置 | 冲突 | 本次处理 |
|---|---|---|
| `docs/DEV-WORKFLOW.md:45` | 实现流程还写 Qoder CN 配色；同文件 `:14`、`packages/web/DESIGN.md:224` 与当前实现已为 Claude CDS | 采用 CDS，不据此回滚；属于既有文档待同步 |
| `docs/DESIGN-SYSTEM.md:50` | 写「确认框 default 为深色主操作」，与同文件 `:45` 及 `DESIGN.md:385` 的陶土主操作冲突 | 采用陶土三态，非危险按钮不恢复墨色实底 |
| `packages/web/DESIGN.md:268` | 状态色浅底说明列出 warning / danger 值，却遗漏 frontmatter `:34` 的 success-soft，句式也未逐一对应三种状态 | 以 frontmatter 及 `styles.css:65`、`:66` 的成功色 / 浅底为准，不把 success-soft 判为未批准颜色 |
| `docs/DESIGN-SYSTEM.md:51` 与 `packages/web/DESIGN.md:277` 的概括 | 工程文档明确批准运行中 brand 例外，视觉文档其他段落仍笼统说状态不借用动作色 | 按任务已批准的现行例外处理，运行中 brand 合法；不将其扩大到等待审批。此为表述待对齐，不是新增设计决定 |

## 验证与完成状态

- [x] 记录现有工作树、基线与未提交差异归属。
- [x] 穷举 hex、rgb/rgba、hsl/oklch、混色及任意值类，人工归类品牌、图表选择器、mask、中央定义与实际样式。
- [x] 沿共享原语及 29 个页面的颜色 / 状态命中检查实际用途，核对 OpenUI、代码、表单、运行、个人模块、知识库、导航与数据表格。
- [x] 只读设计检测退出码 0；颜色 advisory 与手工结论对应。
- [x] 声明值核对 CS-01：辅助灰 .60 白底合成通道 151.2，对比 2.91:1。
- [x] 统计及所有 file:line 引用按当前源码校验；只交付本文件，未改源码、素材、测试或其他文档。
- [x] 不提交、不推送、不创建 PR；成果尚未合入。

下一步：审计交付完成；以下是后续实施建议，不代表本任务已经修改或验收这些状态。

## 分批建议（低改动风险优先，每批 1–2 文件）

按文件聚合，避免两批同时写同一个文件。优先处理最小且能直接证明的改动，再处理共享控件与跨页面状态；批次 1 的 P1 同时最优先。若新增语义变量，先核对上述缺口，仅集中既有值，不扩展色板。

| 批次 | 文件 | 覆盖项与建议 | 后续可执行验证 |
|---|---|---|---|
| 1 | `packages/web/src/components/ui/trace.tsx` | CS-01；取消 pending 整行透明度，可保留装饰图标弱化 | `pnpm --filter @agentport/web typecheck`；在真实对话触发无结果工具行，读取状态说明计算样式与对比，验证折叠及焦点 |
| 2 | `packages/web/src/styles.css`、`packages/web/src/components/code-block.tsx` | CS-08/09/10/11/12；一次集中既有语法、选区、滚动条、骨架与 chip 阴影数值；JSON 辅助字改走代码令牌；保留受保护图形和数值 | `pnpm --filter @agentport/web build`；抽查 Markdown / JSON / 代码选区 / 滚动条 / 加载态，扇形入口仅核对未改变 |
| 3 | `packages/web/src/components/ui/button.tsx` | CS-05；secondary hover 回到已有中性层，不改陶土主按钮 | `pnpm --filter @agentport/web typecheck`；核对 secondary hover/expanded/disabled 及 default/solid 三态 |
| 4 | `packages/web/src/components/ui/slider.tsx` | CS-06；常态边与 surface 令牌归位，真实焦点保留 ring | `pnpm --filter @agentport/web typecheck`；OpenUI 中拖动与键盘聚焦，读取常态 / hover / focus / disabled 样式 |
| 5 | `packages/web/src/components/ui/input-group.tsx` | CS-07；统一 disabled 底色并让透明度由单层负责 | `pnpm --filter @agentport/web typecheck`；InputGroup / Combobox / composer 对比 enabled、disabled、readonly、invalid+focus |
| 6 | `packages/web/src/components/knowledge-shared.tsx` | CS-03；处理中中性，运行中复用已批准 brand | `pnpm --filter @agentport/web typecheck`；核对文档列表 / 详情、同步记录与处理记录全部状态，失败与排队不受影响 |
| 7 | `packages/web/src/components/ui/calendar.tsx` | CS-04；统一单选和范围选中语义层 | `pnpm --filter @agentport/web build`；OpenUI 单日 / 范围，含 selected+hover+focus、范围端点和键盘导航 |
| 8 | `packages/web/src/pages/chat.tsx`、`packages/web/src/pages/channel.tsx` | CS-02；等待授权采用 warning 语义，去常驻陶土光晕，保留真正批准按钮动作色 | `pnpm --filter @agentport/web typecheck`；两页各检查等待、提交中、已批准、等待已结束，确认权限 / 文案 / 真实焦点不变 |
