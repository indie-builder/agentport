# Claude CDS 间距与布局只读审计

## 结论与统计

当前普通页面的主骨架、24px 横向内容边与 16px 卡片网格已经比较统一。确认的问题集中在**异常状态额外增加顶部 padding**，以及**可等价换成 Tailwind 尺度的固定宽高**、**个人模块手写分区骨架**。没有证据支持重排全站布局或改变既定密度。

| 统计口径 | 结果 |
|---|---:|
| 扫描 `packages/web/src` 下 `.tsx` / `.ts` / `.css` | 177 个文件 |
| `pages/*.tsx` 文件（包括嵌入式 `memory-panel.tsx`） | 29 个 |
| 原始 `-\[` 命中 | 568 次，259 行，74 个文件 |
| 间距／尺寸／定位 utility 命中，见 §3 完整清单 | **117 次，92 行** |
| 上述 117 次中的字面量 px/rem | **66 次** |
| 相对单位 vh/dvh/ch/em/% | 33 次 |
| calc/min/max/动态表达式 | 18 次 |
| 字面量 px/rem 中换算后为 4px 整倍数 | 56 次 |
| 字面量 px/rem 中不是 4px 整倍数 | 10 次；均须按控件细节／场景区分，不能直接计为违规 |
| 确认偏差，按问题族计数 | **P1 0、P2 2、P3 2，共 4 项** |
| 后续建议 | **17 批**，每批 1–2 文件；均未执行 |

568 次不是间距违规数，包含 `data-[...]`、`has-[...]`、颜色、圆角、字距、过渡属性等。117 次也不是违规数：像 880px 阅读容器、448px 短字段、3px Tabs 内距都有既定用途。网格模板、容器断点等另外列在 §4，不混进 117 次。

## 1. 任务、基线与判定方法

- **目标：** 只查间距与布局偏差，提供准确源码位置、用途、风险及后续批次。
- **工作树：** `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`，分支 `cds-redesign`。
- **HEAD：** `a44ba5131de7d1d5b396170ed6eafa59d5aa0b8d`。
- **初始差异：** 仅 `?? tmp/`，是已有临时资料，未改动、未纳入交付。
- **唯一写入：** `docs/tasks/cds-spacing-layout-audit.md`。源码、配置、依赖、其他文档与受保护项均未修改。
- **当前有效决定：** 以用户本轮批准基线为准；不改变既定密度／几何，不新增私有间距令牌，不 commit/push。
- **已替代项：** 无。

视觉权威为 `packages/web/DESIGN.md:115` 的间距节奏、`:306` 的 Layout、`:410` 的 Cards / Tables / Lists。工程契约为 `docs/DESIGN-SYSTEM.md:228` 的 §9、`:262` 的全站布局和 `:306` 的 §10。已读 `packages/web/CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`，按 `impeccable` 的只读审计方法执行，不扩展成颜色、字体、交互或移动端设计审计。

### 1.1 正则与统计口径

先执行宽扫描，避免只搜 `p-[...]` 漏掉宽高、变体或嵌套选择器：

```sh
rg -n -- '-\[' packages/web/src
```

再对扫描范围每一行提取以下 utility，保留同一行的重复声明：

```regex
(?<![\w-])-?(?:min-|max-)?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|bottom|left|right|start|end|w|h|size|basis|translate-[xy])-\[[^\]\n]+\]
```

最后人工补查 `grid-cols/rows-[...]`、`@min/max-[...]`、CSS 属性、内联 `style`、标准尺度类、`mt/mb` 与页面组件调用。位置均相对仓库根；§3–§5 表格为避免重复，路径默认加前缀 **`packages/web/src/`**。同一行的基础／`sm:` 重复声明分别计数，表中标记 `×2`；建议替换时必须保留原来的变体、`!` 和条件分支。

### 1.2 节奏与尺寸不能混为一谈

4/8/12/16/20/24px 是结构间距节奏，不是所有宽高只能取这六个数。56px 页头、208px 专家卡、220px 导航列、320px 定时任务侧栏、400px 成果栏、448px 字段、728px 公开分享、880px 对话外容器均保留。

本报告的“4px 整倍数”只用于判断可否等价表达：例如 860px 可写 `max-w-215`，不代表应把它缩成 24px 或改成附近的容器档。对 `ch/em/%/vh` 与计算式不强行套间距节奏。3px 页签内距、6px 字段间隙、10px 控件内距、2px 分段内距等以已批准控件规格为准。

### 1.3 证据限制

本轮为源码审计，**没有启动应用或读取 `getBoundingClientRect()`／计算样式**。表中的 px 是在默认根字号 16px 下的源码换算；不得把它当成浏览器实测。P2 证明的是额外 padding 声明与状态结构差异，没有声称实测了标题坐标、溢出或最终高度。后续真正改几何时按 `docs/PITFALLS.md:132` 与 `:252` 测实际坐标。

## 2. 已批准基线与明确保留项

| 场景 | 当前权威／源码证据 | 结论 |
|---|---|---|
| 普通页面外边 | `components/app-shell.tsx:713`：`px-6 pb-6`；`components/page.tsx:6`：`gap-6` | 左右／底部 24、Page 区块 24；页面不再另包整页 padding |
| 页头／工具栏／分区 | `components/page.tsx:31`、`:58`、`:84` | 页头最小 56，无额外 padding；Toolbar 12，Section 内 16／分隔后顶部 20 |
| 资源中心两行 | `components/resource-page.tsx:67`、`:69`、`:96` | 隐藏 PageHeader + 可见 56px 资源导航行是批准结构，不当成自造页头违规 |
| 搜索／筛选／排序 | `resource-page.tsx:105`、`:118`；`pages/agents.tsx:506`、`:524`、`:546`、`:563` | 224／144／128，Toolbar 外 12、组内 8；无需重做 |
| 卡片组件 | `components/ui/card.tsx:15`、`:30`、`:70`、`:79` | 根 py16、块间16，sm 为12；各子块 px16，Footer 自带 p16、根 pb0；不能再给根统一 p16 |
| 专家与两张创建入口 | `pages/agents.tsx:623`、`:649`、`:683`；`DESIGN-SYSTEM.md:239`、`:241` | 保留 208px 卡高、gap16、40px 头像、分身80px头像与扇形插画；不删除、合并或重排入口 |
| 专家编辑／文件工作面 | `pages/agents.tsx:2765`、`:3856`；`pages/memory-panel.tsx:262`、`:746`、`:1066` | 220px + gap20；详情 px24/py20，FieldGroup20、Field6；`agents.tsx:4061` 的 mt16 是明确批准的组标题间隔 |
| 定时任务编辑 | `pages/ops.tsx:786`、`:817`、`:912`、`:1086` | 1024px Dialog、800px 容器断点、320px 右栏、gap24；sticky 页脚负边距用于抵消 Dialog 内容边，保留 |
| 个人模块 | `DESIGN.md:336`；`personal-profile.tsx:23`、`:24`；`personal-usage.tsx:262`、`:327` | 全宽 Page、448px 短字段、96px 标签、75ch 阅读；首分区无顶线；使用记录 gap12／8 是既定紧凑区，不提议改16 |
| 对话 | `pages/chat.tsx:1669`、`:1856`、`:2322`、`:898` | Page gap0、外容器880含px24、成果400、Composer距底24；标题8em、气泡85%保留 |
| 登录／公开分享 | `pages/login.tsx:87`、`:109`；`routes/s.$shareId.tsx:106` | 登录320宽、gap32、字段20及44高控件；分享728宽独立阅读轴，均为例外 |
| 低于4px／非4倍数的控件细节 | `ui/tabs.tsx:17`、`:54`；`ui/input-group.tsx:29`、`:30`；`ui/switch.tsx:18` | 属底座细节，不借本轮审计调整其密度或位置 |

## 3. 任意间距、尺寸与定位的完整清单（117 次）

### 3.1 字面量 px/rem（66 次）

“尺度”列给出保持尺寸不变的 Tailwind 4 表达；不是要求实施。`保留` 表示不应为迎合间距节奏改变值。固定宽高超过24px不构成越界；本表只对实际内外距／偏移指出节奏例外。

| file:line | 任意值（次数） | 用途／节奏判断 | 建议尺度或处理 |
|---|---|---|---|
| `components/agent-picker.tsx:124` | `min-w-[16rem]` | 专家选择弹层最小256；尺寸，不是组间距 | `min-w-64` |
| `components/app-shell.tsx:604` | `w-[200px]` | 展开态账号入口宽200；4倍数 | `w-50` |
| `components/app-shell.tsx:661` | `w-[294px]` | 导航 Sheet 宽294；非4倍数，但现有场景宽度 | **保留294**；如仅统一写法可 `w-73.5!`，不取整 |
| `components/dialog-shell.tsx:33` | `max-w-[560px]` ×2 | 默认弹层宽560 | `max-w-140 sm:max-w-140` |
| `components/knowledge-citations.tsx:690` | `max-w-[860px]` ×2 | 引用原文弹层 | `max-w-215 sm:max-w-215` |
| `components/knowledge-faq.tsx:319` | `max-w-[760px]` ×2 | FAQ 创建／编辑弹层 | `max-w-190 sm:max-w-190` |
| `components/knowledge-faq.tsx:932` | `max-w-[720px]` ×2 | FAQ 导入／批次发布弹层 | `max-w-180 sm:max-w-180` |
| `components/knowledge-faq.tsx:1947` | `max-w-[680px]` ×2 | FAQ 历史弹层 | `max-w-170 sm:max-w-170` |
| `components/knowledge-wiki.tsx:552` | `max-w-[860px]` ×2 | Wiki 版本预览 | `max-w-215 sm:max-w-215` |
| `components/knowledge-wiki.tsx:834` | `max-w-[860px]` ×2 | Wiki 版本贡献差异 | 同上 |
| `components/personal-memory-panel.tsx:256` | `min-h-[24rem]` | 个人记忆编辑区最小384 | `min-h-96` |
| `components/ui/input-group.tsx:29` | `ml-[-0.3rem]`、`ml-[-0.15rem]` | 起侧 addon 的 button／kbd 光学补偿：-4.8／-2.4；节奏外 | 保留；没有不改变现状的常用整数／半档替代，不改成 -4／-2 |
| `components/ui/input-group.tsx:30` | `mr-[-0.3rem]`、`mr-[-0.15rem]` | 末侧同样补偿，-4.8／-2.4 | 保留，与起侧对称 |
| `components/ui/switch.tsx:18` | `h-[18.4px]`、`w-[32px]`、`h-[14px]`、`w-[24px]` | default 18.4×32、sm 14×24；18.4／14 是控件几何例外 | 本轮保留；32／24可等价 `w-8`／`w-6`，但不单独开启全站开关尺寸调整 |
| `components/ui/tabs.tsx:17` | `p-[3px]` | 分段轨道内距3；节奏外但 `DESIGN.md:393` 明确批准 | 保留3；可等价 `p-0.75`，本轮不排修复批次 |
| `components/ui/tabs.tsx:54` | `bottom-[-5px]` | line 指示线底部偏移；节奏外、位置契约保留 | 可等价 `-bottom-1.25`；不得改成 -4／0 |
| `pages/agents.tsx:822` | `max-w-[392px]` ×2 | 工牌透明外容器392，配合内卡360和边距 | **受批准工牌场景保护，保留**；数学等价 `max-w-98`，不纳入改动批次 |
| `pages/agents.tsx:979` | `max-w-[360px]` | 工牌卡套宽360 | 保留；数学等价 `max-w-90` |
| `pages/agents.tsx:1015` | `min-h-[480px]` | 工牌卡套最小高480 | 保留；数学等价 `min-h-120` |
| `pages/agents.tsx:4005` | `max-w-[480px]` ×2 | 配置版本历史 Sheet | `max-w-120! sm:max-w-120!`；保留 `!` |
| `pages/channel.tsx:481` | `max-w-[880px]` | 频道输入区上方状态说明轴线 | `max-w-220`，保留宽度 |
| `pages/channel.tsx:824` | `max-w-[880px]` | 频道 Composer 外容器 | `max-w-220` |
| `pages/chat.tsx:206` | `max-w-[880px]` | 对话初始加载容器 | `max-w-220` |
| `pages/chat.tsx:248` | `max-w-[880px]` | 对话初始失败容器 | 同上 |
| `pages/chat.tsx:828` | `max-w-[880px]` | 对话权限／等待数据分支 | 同上 |
| `pages/chat.tsx:849` | `max-w-[880px]` | 对话无专家分支 | 同上 |
| `pages/chat.tsx:864` | `w-[294px]` | 会话历史 Sheet 宽294 | 保留294；等价 `w-73.5!`，不误改成桌面首次展开240 |
| `pages/chat.tsx:898` | `w-[400px]` | 成果 Sheet 宽400 | `w-100!`，不改变400契约 |
| `pages/chat.tsx:1086` | `basis-[11rem]` | 专家选择 flex 初始宽176 | `basis-44`；保留 `shrink min-w-0` |
| `pages/chat.tsx:1734` | `max-w-[880px]` | 附件区 | `max-w-220` |
| `pages/chat.tsx:1856` | `max-w-[880px]` | Composer | 同上 |
| `pages/chat.tsx:2309` | `max-w-[880px]` | 历史加载更多 | 同上 |
| `pages/chat.tsx:2322` | `max-w-[880px]` | 消息流 | 同上 |
| `pages/chat.tsx:2990` | `max-h-[300px]` | 工具内容折叠预览最大高 | `max-h-75`，不顺带改变折叠策略 |
| `pages/eval.tsx:953` | `sm:max-w-[900px]` | 运行对比弹层 | `sm:max-w-225` |
| `pages/knowledge-detail.tsx:1819` | `max-w-[1100px]` ×2 | 文档阅读弹层 | `max-w-275 sm:max-w-275` |
| `pages/knowledge-detail.tsx:3824` | `max-w-[760px]` ×2 | 知识来源创建／编辑 | `max-w-190 sm:max-w-190` |
| `pages/memory-panel.tsx:514` | `min-h-[18rem]` | 专家记忆编辑区最小288 | `min-h-72` |
| `pages/memory-panel.tsx:863` | `min-h-[16rem]` | 项目规则正文最小256 | `min-h-64` |
| `pages/memory-panel.tsx:1201` | `min-h-[16rem]` | 输出风格正文最小256 | 同上 |
| `pages/ops.tsx:786` | `max-w-[1024px]` ×2 | 定时任务1024宽弹层 | `max-w-256 sm:max-w-256`；当前 `max-w-5xl` 也等价1024，本表统一给数值尺度 |
| `pages/personal-profile.tsx:23` | `max-w-[448px]` | 姓名字段尺度常量 | `max-w-112` |
| `pages/personal-profile.tsx:104` | `max-w-[448px]` | 保存操作对齐姓名字段 | 同上；同步替换，不能改变右轴 |
| `pages/personal-security.tsx:50` | `max-w-[448px]` | 密码字段尺度常量 | `max-w-112` |
| `pages/personal-security.tsx:228` | `max-w-[448px]` | 改密操作对齐 | 同上 |
| `pages/servers.tsx:911` | `max-w-[220px]` | 试连结果摘要限宽 | `max-w-55` |
| `pages/servers.tsx:1892` | `min-h-[10rem]` | 连接器多行配置输入最小160 | `min-h-40` |
| `pages/skills.tsx:804` | `min-h-[16rem]` | 技能正文最小256 | `min-h-64` |
| `routes/s.$shareId.tsx:106` | `max-w-[728px]` | 公开分享独立阅读轴 | `max-w-182`；**不改880** |

66 次中有 56 次是4px整倍数，但包括工牌保护项与 Switch 宽度，不全部归入建议改动。其余10次为两处294、四处 addon 补偿、Switch 两个非4倍数高度、Tabs 内距及指示线偏移；**没有把这10次直接升级为10个偏差**。

### 3.2 相对单位（33 次）

这些值表达可用视口、文本阅读长度或列比例，不能换成固定 px 来“统一”。本表建议统一为**保留现值**，不存在无损的固定 `p/gap/w/h-N` 替代。

| file:line | 任意值 | 用途／节奏判断 |
|---|---|---|
| `components/conversation-outputs.tsx:337` | `max-h-[50vh]` | 成果图片高度上限；视口约束 |
| `components/conversation-outputs.tsx:343` | `h-[50vh]` | 成果 PDF 预览；视口约束 |
| `components/conversation-search.tsx:93` | `top-[14vh]` | 会话搜索浮层顶部位置 |
| `components/dialog-shell.tsx:33` | `top-[10dvh]`、`max-h-[80dvh]` | 标准弹层动态视口约束 |
| `components/knowledge-citations.tsx:582` | `h-[60vh]` | 引用原文 PDF 预览 |
| `components/knowledge-faq.tsx:1958` | `max-h-[50vh]` | FAQ 版本列表内部滚动 |
| `components/memory-review.tsx:422`、`:489` | 各 `max-w-[75ch]` | 提案卡片／列表摘要阅读长度 |
| `components/page.tsx:41` | `max-w-[60ch]` | 页头描述阅读长度 |
| `components/personal-memory-panel.tsx:303` | `max-w-[60ch]` | 空态说明阅读长度 |
| `components/personal-memory-panel.tsx:325` | `max-w-[75ch]` | 个人记忆阅读长度，已批准 |
| `pages/agents.tsx:1316`、`:3626` | 各 `max-w-[70ch]` | 详情描述／内置工具安全说明 |
| `pages/channel.tsx:389` | `max-w-[14em]` | 频道标题截断宽，不等同对话8em标题 |
| `pages/chat.tsx:1098` | `max-w-[8em]` | 对话标题，明确批准 |
| `pages/chat.tsx:2407` | `max-w-[85%]` | 用户气泡相对宽，明确批准 |
| `pages/knowledge-detail.tsx:1819` | `max-h-[85dvh]` | 文档弹层高度上限 |
| `pages/ops.tsx:366`、`:369`、`:372`、`:375`、`:378` | `w-[34%]`／`w-[16%]`／`w-[18%]`／`w-[16%]`／`w-[16%]` | 定时任务表五列，合计100%；列宽分配，不是间距 |
| `pages/plugin-detail.tsx:212` | `max-w-[60ch]` | 插件描述阅读长度 |
| `pages/plugin-detail.tsx:252`、`:366`、`:394` | 各 `max-w-[75ch]` | 插件简介／文件正文／说明阅读长度 |
| `pages/plugin-detail.tsx:455` | `max-h-[40vh]` | 窄桌面文件列表上限 |
| `pages/runtime-environments.tsx:143`、`:144`、`:145` | `w-[50%]`／`w-[25%]`／`w-[25%]` | 原生表格三列，合计100% |
| `routes/s.$shareId.tsx:276` | `max-h-[70vh]` | 分享图片高度上限 |
| `routes/s.$shareId.tsx:286` | `h-[70vh]` | 分享 PDF 高度；独立公开阅读场景，不能机械对齐成果50vh |

### 3.3 计算式与动态值（18 次）

| file:line | 任意值（次数） | 用途／节奏判断 | 建议 |
|---|---|---|---|
| `components/conversation-search.tsx:93` | `max-h-[min(70vh,36rem)]` | 搜索结果最大视口70%／576px | 保留计算式；576上限等价144尺度，但整体不能用固定高度替换 |
| `components/dialog-shell.tsx:33` | `w-[calc(100%-2rem)]` | 弹层两侧各16px空间 | 保留；不叠加另一个 p/m 补偿 |
| `components/ui/combobox.tsx:106` | `min-w-[calc(var(--anchor-width)+--spacing(7))]` | chips 模式在锚点宽上加28px | 保留动态锚点约束，不把28当组间距违规 |
| `components/ui/combobox.tsx:121` | `max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))]` | 列表高度扣除搜索区域，采用既有尺度与可用高 | 保留，不替换成统一 max-h 固定值 |
| `components/ui/combobox.tsx:193` | `h-[calc(--spacing(5.25))]` | chip 高21px，底座细节 | 保留21；如后续单纯整理可 `h-5.25`，不改20／24 |
| `components/ui/dialog.tsx:52` | `max-w-[calc(100%-2rem)]` | 原语对视口的最大宽度 | 保留，与 DialogShell 不同职责，不视为重复 padding |
| `components/ui/switch.tsx:25` | `translate-x-[calc(100%-2px)]` ×2 | thumb 根据自身尺寸移动并扣2px边界 | 保留，checked 的两尺寸分支均保留 |
| `components/ui/tabs.tsx:51` | `h-[calc(100%-1px)]` | 页签项扣除1px边界 | 保留，与3px轨道内距配套 |
| `components/ui/toggle-group.tsx:45` | `gap-[--spacing(var(--gap))]` | ToggleGroup 的 spacing 属性映射到现有尺度 | 保留；是现有 spacing 机制，未发现本轮需新增令牌的缺口 |
| `components/ui/tooltip.tsx:46` | `translate-y-[calc(-50%-2px)]` | 箭头定位补偿 | 保留，不按内容间距节奏取整 |
| `components/ui/trace.tsx:126` | `ml-[calc(--spacing(2)-1px)]` | 执行轨迹竖线对齐图标中心，8减1px | 保留，是1px线宽补偿 |
| `openui/components/shared.tsx:176` | `basis-[calc((100%_-_var(--openui-card-gap))/2)]` | 两卡各让半个 gap，避免轮播实际卡宽减少 | 保留；`--openui-card-gap` 为既有局部共享计算，不新增全局令牌 |
| `pages/agents.tsx:822` | `max-h-[calc(100dvh-32px)]`、`w-[calc(100vw-32px)]` | 工牌短视口留边 | 保留，受批准场景保护 |
| `pages/knowledge-detail.tsx:1832` | `max-h-[calc(85dvh-9rem)]` | 文档阅读内容扣除外围控制区 | 保留；实际高度是否足够只列实测候选 |
| `pages/plugin-detail.tsx:248` | `max-h-[calc(100dvh_-_12rem)]` | 插件简介滚动上限 | 保留；12rem 是现状扣除量，不按本轮缩改 |
| `pages/plugin-detail.tsx:399` | `h-[max(28rem,calc(100dvh_-_12rem))]` | 插件文件工作面最低448与视口剩余高 | 保留；短视口双滚动风险见 §7，未实测不确认为缺陷 |

原始扫描中没有发现直接的 `p/m/gap/space/inset/size-[固定正px/rem]` 内容间距散落：实际此类命中是 Tabs 3px、InputGroup 四个负补偿和动态 ToggleGroup gap；没有 `space-x/y-[...]`、`inset-[...]`、`size-[...]` 命中。常规 `px-3.5`／`gap-1.5` 等是标准尺度，但仍须按场景审查，不能因为没带方括号就自动判合规。

## 4. 任意网格模板、容器断点与非 utility 几何补查

### 4.1 带固定长度的任意网格模板

这些是布局轨道，不是可替换成 `gap-4` 的间距。没有同义的命名模板时保留，不新建私有网格令牌。

| file:line | 模板 | 用途／处理 |
|---|---|---|
| `components/conversation-outputs.tsx:174` | `@2xl:grid-cols-[320px_minmax(0,1fr)]` | 成果文件列表与预览，320px目录；不等同400px成果栏总宽 |
| `components/knowledge-wiki.tsx:118` | `md:grid-cols-[220px_minmax(0,1fr)]` | Wiki目录工作面；保留 |
| `pages/agents.tsx:1561` | 同上 | 专家相关配置列表；保留220与gap20 |
| `pages/agents.tsx:2765`、`:3856` | 同上 | 配置分区／完整文件，批准几何 |
| `pages/agents.tsx:4622` | `grid-cols-[6.5rem_minmax(0,1fr)]` | 版本字段差异的104px标签列，不是Section间距 |
| `pages/knowledge-detail.tsx:745` | `md:grid-cols-[220px_minmax(0,1fr)]` | 文档文件夹栏，批准几何 |
| `pages/knowledge-detail.tsx:1825` | `md:grid-cols-[320px_minmax(0,1fr)]` | 文档详情列表／阅读；保留 |
| `pages/memory-panel.tsx:262`、`:746`、`:1066` | `md:grid-cols-[220px_minmax(0,1fr)]` | 记忆／项目规则／输出风格，三处一致 |
| `pages/ops.tsx:817` | `@min-[800px]:grid-cols-[minmax(0,1fr)_320px]` | 批准的定时任务侧栏总宽，含其左内距，不额外相加 |
| `pages/personal-profile.tsx:24` | `grid-cols-[96px_minmax(0,1fr)]` | 身份标签列，批准96px |
| `pages/personal-security.tsx:433`、`:491` | `grid-cols-[64px_minmax(0,1fr)]` | 会话详情的短标签列；不是448/96的编辑表单，不能机械改96 |
| `pages/personal-usage.tsx:279` | `grid-cols-[96px_minmax(0,1fr)]` | 使用汇总标签列，保留 |

其余任意模板不含固定 px/rem：

- `grid-cols-[auto_minmax(0,1fr)_auto]`：`pages/agents.tsx:684`、`pages/knowledge.tsx:146`、`pages/plugins.tsx:243`、`pages/servers.tsx:754`、`pages/skills.tsx:307`。
- `grid-cols-[minmax(0,1fr)_auto]`：`pages/accounts.tsx:248`；`grid-cols-[auto_minmax(0,1fr)]`：`pages/agents.tsx:4737`、`pages/audit.tsx:98`、`pages/ops.tsx:534`、`pages/runs.tsx:181`、`pages/runtime-environment-detail.tsx:465`、`components/memory-review.tsx:426`。
- `grid-cols-[max-content_minmax(0,1fr)]`：`components/memory-review.tsx:1396`、`pages/personal-usage.tsx:85`、`:480`。
- 2:3功能分栏：`pages/eval.tsx:456`（xl起）与 `pages/run-detail.tsx:397`（lg起）。用途和内容不同，断点不同本身不算偏差。
- 底座自适应模板：`components/ui/card.tsx:30` 的 `grid-cols-[1fr_auto]`、`grid-rows-[auto_auto]`。保留；这是同一组件的 action／description 槽布局。

### 4.2 任意容器断点

| file:line | 断点 | 结论 |
|---|---|---|
| `components/memory-review.tsx:1703`、`:1736` | `@min-[800px]` | 内容／索引差异两列；桌面容器伸缩，不扩展到手机设计 |
| `openui/components/layout.tsx:405` | `@min-[481px]` | CarouselItem 随容器换列；与≤480单列契约一致 |
| `openui/components/shared.tsx:174` | `@max-[30rem]` | Overview轮播≤480时200px，批准例外 |
| `openui/components/shared.tsx:176`、`:206`、`:208` | `@min-[481px]` | 响应式双卡、奇数末卡跨列；保留 |
| `pages/ops.tsx:817`、`:912`（后者4次） | `@min-[800px]` | 两栏启用、边线与pl24一同出现；批准几何 |

这些断点不应按4px节奏取整为480或改成视口断点；`481px`表达“宽于480”。

### 4.3 CSS 与内联 style：没有漏作 Tailwind 任意值

| file:line | 现状／用途 | 判定 |
|---|---|---|
| `components/knowledge-wiki.tsx:151`、`pages/knowledge-detail.tsx:779` | `paddingLeft = 8 + depth × 12` | 文件树层级缩进，根8／每层12均在节奏；动态深度保留 |
| `pages/roles.tsx:781`、`:798` | `depth ×16`、`(depth-1)×16+32` | 权限树父子层级；批准矩阵结构，非任意卡片间距 |
| `components/app-shell.tsx:507`、`:508`；`styles.css:105` 至 `:108` | 224／64宽，padding16×12／16×16 | 既有外壳令牌，保留；不新增私有间距令牌 |
| `components/source-editor-inner.tsx:43`、`:45`、`:54`、`:66`、`:77` | CodeMirror内容p8/10、最小64，gutter p0/4/0/8和min24，搜索p4/8，输入p2/6 | 编辑器API样式，不是普通Page；10／2／6为内部控件密度，保留 |
| `openui/components/shared.tsx:162`、`:168`、`:203` | 显式gap来自组件prop；默认12，轮播轨道仅一处gap、item pl0／track ml0 | 已消除双间距；生成式显式gap是输入契约，不能静态限制成一个值 |
| `openui/components/content.tsx:254`；`openui/components/data.tsx:320`、`:733` | Avatar显式尺寸、数据列显式宽、复合卡图片默认192 | 内容契约，非页面间距；保留 |
| `pages/chat.tsx:971` | 成果面板Motion宽400／0 | 与Sheet400一致，保留 |
| `components/data-table.tsx:383`、`:390`、`:441`、`:576` | 列模板由列配置生成，列gap12、左右px12、行min56，末尾操作轨32 | 共享机制统一；列最小宽与行数宽度不按Section尺度缩改 |
| `pages/audit.tsx:34`、`pages/eval.tsx:78`、`pages/overview.tsx:65`、`pages/personal-shares.tsx:179`、`pages/personal-usage.tsx:215`、`pages/runs.tsx:71` 起各列定义 | 列配置含130／90／78／86／110px及minmax等 | 数据宽度，不是任意外距；无全站列宽必须相等的契约，不归偏差 |
| `pages/eval.tsx:177`、`pages/overview.tsx:352` | 图表margin top/right/left8、bottom0 | 一致；图表内部坐标不改 |
| `openui/components/charts.tsx:274`、`:425` 等 | tooltip max-width视口计算、显式图高与320初始测量宽 | 图表子系统，不按卡片gap规则改 |
| `styles.css:300`、`:301`、`:321`、`:325` | 滚动条10、skip-link定位16和padding8/12 | 浏览器／无障碍辅助，不是业务布局漂移 |
| `styles.css:370` 至 `:458` | 扇形卡片68×86、绝对定位及hover位移、label gap8 | **受保护创建入口插画**，原样保留，不能因为68/86/1px偏移改掉 |
| `styles.css:536`、`:540`、`:574`、`:648`、`:649` | 等待点gap3.5／size3、状态点size6、上下滚动渐隐28 | 已有状态／遮罩细节；不按页面留白取整 |

补查没有发现需要另造一套 spacing token 的问题。`styles.css @theme` 原有侧栏几何，以及 Card／OpenUI 局部变量均不在本次任务新增范围内。

## 5. 页面边距、网格、表单与骨架一致性

### 5.1 横向 padding 与页面顶部

普通页统一经 `AppShell` 的 `px-6 pb-6`，资源页、专家页、运维列表、个人模块没有又套一层整页 `px-6`。`Page` 自身只管flex与gap，不提供padding；`PageHeader`亦不另加padding。`ReaderToolbar`、表格单元格、Card子块和Dialog内容padding是**组件内距**，不能算成页面重复内距。

对话／频道属于 `app-shell.tsx:415` 的 immersive 分支，shell无padding，内部自带px24合理。确认例外是 `channel.tsx:71`、`:79` 的整页 `py-4`；正常频道头 `:378` 从容器顶部开始，异常态却整体下移，详见P2-01。`app-shell.tsx:300` 的拒绝态 `pt-6` 是另一处顶部偏差，详见P2-02。

### 5.2 页面级 mt/mb 检查

已对 `pages`、`routes` 的 `mt/mb` 命中逐类核对。**未发现 Page／PageHeader／顶层 PageSection 直接以 `mt-*`／`mb-*` 拼主骨架间距的确定案例。** 不把“页面文件里出现mt”与“页面级外距”混同。

| 命中位置 | 实际层级／处理 |
|---|---|
| `pages/agents.tsx:4061` | 分组标题到内容mt16，`DESIGN-SYSTEM.md:248`明确批准；保留 |
| `pages/agents.tsx:2977`、`:3073`、`:3165`、`:3250`、`:3403`、`:3625`、`:3626` | 配置子组标题／说明mb8；局部内容，不能机械替换成PageSection |
| `pages/agents.tsx:1564` | 文件目录分组mb12；局部列表，不是Page间距 |
| `pages/personal-security.tsx:388`、`:396` | SessionGroup标题到列表mt12；属于已批准组内12，保留数值 |
| `pages/personal-profile.tsx:142` | 账号详情展开内容mt8；局部折叠区 |
| `pages/chat.tsx:1996`、`:2513`、`:2530`、`:2533`、`:2549`、`:3397`、`:3407`、`:3414` | 输入权限提示、消息操作与工具IO内部；不是页面级外距 |
| `pages/channel.tsx:828` | Composer提及候选弹层与输入区mb8；局部浮层 |
| `pages/agents.tsx:755`；`pages/knowledge.tsx:216`；`pages/plugins.tsx:341`；`pages/skills.tsx:386` | 卡片 `mt-auto` 对齐底部；自动布局，不是手写区块间距 |
| `pages/agents.tsx:1015`、`:1063` | 工牌连接处负mt4／底部mt-auto；批准工牌几何，保留 |
| `pages/ops.tsx:1086` | Dialog sticky footer的-mb16／mt16；属弹层内，不改Page骨架 |
| `pages/eval.tsx:172`、`:562`、`:565`、`:875`、`:978`、`:1005`、`:1048` 等 | 图表／评估行／对比Dialog内容间距；不是Page直属分区 |
| `pages/run-detail.tsx:601`、`:612`；`pages/memory-panel.tsx:316`、`:346`、`:590`、`:608`；`pages/servers.tsx:691`；`pages/plugins.tsx:733`；`pages/agents.tsx:958` | 检查器、子表单与Dialog局部操作间距；保留既定密度 |
| `routes/s.$shareId.tsx:127` | 分享页脚mt-auto推底，公开页独立骨架；保留 |
| `mt-0.5`／`mt-1` 图标、时间戳及 `scroll-mt-*` | 光学对齐／滚动定位，均不算页面间距 |

### 5.3 网格／列表／表格

| 同类场景 | 跨页证据 | 判断 |
|---|---|---|
| 四类资源卡片 | `skills.tsx:303`、`servers.tsx:435`、`plugins.tsx:239`、`knowledge.tsx:486` | 均gap16，1/2/3/4列；一致 |
| 专家卡 | `agents.tsx:623` | 同样gap16及1–4列；208高按独立契约 |
| 可切换业务卡片 | `accounts.tsx:244`、`ops.tsx:327`、`runs.tsx:381`、`runtime-environments.tsx:185`、`personal-shares.tsx:275`、`personal-usage.tsx:465`、`personal-security.tsx:388`、`components/memory-review.tsx:390` | 均gap16、sm两列／xl三列；一致 |
| 概况指标 | `overview.tsx:543` | gap16／xl四列；指标不是业务记录卡，不要求三列 |
| 技能市场 | `skills.tsx:568`；`components/states.tsx:20` | 列gap24／行gap2，窄容器单列；骨架同样，符合轻量列表例外 |
| 共享DataTable | `components/data-table.tsx:441`、`:576` | 表头／数据列gap12、px12；行min56；业务页按字段定义宽度 |
| 定时任务原生Table | `ops.tsx:366` 起 | 比例列宽34/16/18/16/16，无必要迁成与DataTable相同列宽 |
| 频道列表 | `channels.tsx:119` | px16／py8，双行内容、36px图块；实测前不把其行高断言成56或判定低于56 |

没有确认“同类卡片网格gap不一致”的问题。不要把市场gap24／2、OpenUI默认gap12、表格gap12统一改成16，它们是不同类型的布局。

### 5.4 Section 之间的距离与骨架覆盖

- 29个 `pages/*.tsx` 中，24个直接使用Page、4个通过ResourcePage使用Page；余下 `memory-panel.tsx` 是专家详情内嵌编辑器，无需再嵌Page。`personal-memory.tsx` 包含个人记忆／提案两个页面出口；组件调用次数不等同路由数。
- 普通状态走 `Page gap-6`；运行详情在 `run-detail.tsx:397` 用网格组合步骤和检查器，知识详情在 `knowledge-detail.tsx:398` 用任务Tabs，专家配置在 `agents.tsx:2765` 用导航＋详情卡，均为功能工作面，不机械增加PageSection卡壳。
- 个人资料 `personal-profile.tsx:59`、`:127` 和安全 `personal-security.tsx:128`、`:318` 手写section，几何符合当前密度，但重复了共享分区能力，列为P3-02；只收敛组件，不改gap／首分区线。
- `status.tsx:343` 的第一分区有顶线，不能套用个人模块“第一分区无顶线”的专属规则去删除；其后健康指标按自身分组布局。
- `channel.tsx:378` 的正常频道头是自有header；`chat.tsx:1058` 的56px头与 `:1669` 的gap0是immersive工作面，不机械套普通PageHeader以免破坏控件归属。
- 公开分享 `routes/s.$shareId.tsx:106` 在shell外，不使用Page是批准例外；登录保留 `Page gap-8`。

### 5.5 FieldGroup 与表单

| 场景 | file:line | 现状／判断 |
|---|---|---|
| FieldGroup底座 | `components/ui/field.tsx:43` | 默认20；嵌套组16；checkbox-group12，不应一律抹平 |
| Field底座 | `components/ui/field.tsx:51` | 默认gap8；业务明确 `gap-1.5` 时为6；专家页的6是批准规格 |
| 账户多字段表单 | `pages/accounts.tsx:666`、`:856`、`:961`、`:1069` | 20一致 |
| 运行环境 | `runtime-environments.tsx:322`；`runtime-environment-detail.tsx:283`、`:499` | 默认20 |
| 专家配置 | `agents.tsx:2795`、`:2892`、`:3548`、`:3694` | 20；创建／克隆 `:4732`、`:5004` 为12网格，创建与长期配置不是同一任务密度，保留 |
| 资源创建／知识设置 | `skills.tsx:727`；`knowledge.tsx:826`、`:977`、`:1139`；`components/knowledge-settings.tsx:211`、`:384`、`:870`；`components/knowledge-faq.tsx:342`、`:396`、`:479`、`:1059` | 12网格反复使用，是现有紧凑资源表单；无批准改密度的证据，不列违规 |
| 个人安全／资料 | `personal-security.tsx:143` 与 `personal-profile.tsx:70` | 安全16／资料默认20，但各自448宽、96标签一致；安全为多密码编辑组，不能只因差4就改成20 |
| 定时任务 | `ops.tsx:818`、`:914` | 左编辑面16、右计划20；对应各自契约，保留 |
| 评估创建／知识离线评估 | `eval.tsx:1160`；`components/knowledge-evaluations.tsx:85` | 16与20；用途不同，后者两列不折叠另列实测候选 |
| 内嵌规则／输出风格 | `memory-panel.tsx:829`、`:1161` | 默认20，与专家编辑契约一致 |
| 生成式表单 | `openui/components/forms.tsx:841`、`:842` | 原生OpenUI表单运行时，FieldGroup16；不是平台资源编辑表单，保留 |
| 简单局部表单 | `channels.tsx:193`、`chat.tsx:1260`、`knowledge-detail.tsx:1373`；`components/memory-review.tsx:960` | 局部flex gap16或20；是机制／结构差异，但不凭此扩大spacing审计为表单重构 |

## 6. 确认偏差清单

按**问题族**编号，不按每个重复类名计一条。P1需有明显任务阻断或实测严重几何缺陷，本轮未发现足够证据；P2为可确认的布局契约差异；P3为保持几何不变的维护一致性整理。

| ID／严重度 | file:line | 现状与依据 | 建议 | 风险／验收 |
|---|---|---|---|---|
| **P2-01** 频道加载／失败态额外顶部内距 | `packages/web/src/pages/channel.tsx:71`、`:79`；对照`:378` | 两个Page加`px-6 py-4`；正常头从工作面顶部开始，异常态在PageHeader前先加16px。immersive shell不提供padding，因此px24合理，py16不符合状态沿同一顶部骨架的要求 | 保留px24，把异常态整页padding改为`px-6 pb-6`，不再加顶部padding；按需共用现有状态布局，不动正常频道工作面 | 低；用加载、初次失败、正常三态测页头区域顶部／高度；不能只截图猜y坐标；不顺带改频道头结构 |
| **P2-02** 权限拒绝态整页多出顶部24 | `packages/web/src/components/app-shell.tsx:300`；对照`:713`与`components/page.tsx:31` | AccessDenied在普通shell内另加`Page pt-6`，正常普通页没有该顶部padding；独立56px页头因此不从内容顶部开始 | 普通页拒绝态去掉额外pt24；保留权限文案、刷新、返回与退出动作；同时核对immersive路由拒绝态是否应有自身px24／pb24，避免修一处丢另一处边距 | 低到中；同一个AccessDenied供chat／频道和普通页复用，按实际调用分支调整，不能盲删后宣布所有拒绝态一致 |
| **P3-01** 同一职责混用固定任意值与现有尺度 | §3.1逐条位置；典型`components/dialog-shell.tsx:33`、`pages/chat.tsx:1856`、`pages/personal-profile.tsx:23` | 560／880／448等可精确表达成140／220／112尺度，但散写方括号；与w56、gap4等既有尺度写法不一致。**数值本身不错误** | 按§8分批等价替换；不改值、不改响应式变体、不引入令牌；排除工牌、控件底座的例外整理 | 低；26个主要替换尺度已用安装版Tailwind编译确认可生成；更改后比较计算宽高，rem换算随根字号保持一致 |
| **P3-02** 个人页面重复实现共享section骨架 | `packages/web/src/pages/personal-profile.tsx:59`、`:127`；`packages/web/src/pages/personal-security.tsx:128`、`:318` | 手写flex section／border-t pt5，与PageSection职责重复；当前gap3／4和条件分隔线是既定值，不能称为几何错误 | 复用已有PageSection并显式保留`gap-3`或`gap-4`、原有标题与条件`divided`，不新建组件、不把既有间距改成另一档 | 低到中；确保首个实际可见分区无线、改密展开后会话区才加线；保留标题层级、折叠生命周期与所有表单状态 |

**统计：P1 0、P2 2、P3 2。** 本报告没有把控件光学补偿、不同业务表单密度、工牌／创建卡与相对阅读宽度计入偏差。

## 7. 待实测候选与文档冲突

以下不计入已确认偏差数，也不建议直接改源码：

1. **插件短视口工作面高度。** `pages/plugin-detail.tsx:399` 最低28rem，加外部页头、页签与描述后可能出现shell与正文双滚动。要在窄桌面和短高视口记录main／阅读容器的clientHeight、scrollHeight、边界矩形；未实测不能定P1/P2，更不能取消既有保留阅读位置的DOM机制。
2. **文档弹层扣除高度。** `pages/knowledge-detail.tsx:1819`、`:1832` 使用85dvh与减9rem；标题换行、工具栏变高时，检查实际scroll容器是否都可达。不是看到calc就认定错误。
3. **离线评估固定两列。** `components/knowledge-evaluations.tsx:85` 为`grid-cols-2`，没有像其他表单一样窄容器堆叠；应测查询／期望目标的可用宽和是否横向溢出。未确认问题前保留当前密度与列数。
4. **权限拒绝态的immersive横向边距。** `app-shell.tsx:635` 与`:709`显示同一AccessDenied进入无shell padding分支；修P2-02时须覆盖这一分支，不能只验证普通页。

发现的文档／实现或权威冲突：

- `docs/DEV-WORKFLOW.md:45` 仍说参考配色与控件外观以Qoder CN为准；本轮用户批准基线、根规则与 `packages/web/DESIGN.md:224` 已指定Claude CDS。**按当前CDS执行**，不回退Qoder；任务只授权本文，因此只记录此冲突，未改流程文件。
- `components/app-shell.tsx:712` 的现有源码注释说顶部内距由PageHeader负责；实际 `components/page.tsx:31` 只有min-h56，无padding。正确描述是“PageHeader提供56px头部占位”，不是“PageHeader提供顶部padding”。本轮不改源码注释。
- `docs/DESIGN-SYSTEM.md:266` 说“登录表单是唯一居中窄表单”，`:225`及 `DESIGN.md:316`之外的分享规则／源码 `routes/s.$shareId.tsx:106` 同时保留728px居中公开阅读页；两者分别是表单与阅读场景，**不是要求删掉分享页居中**。这是措辞边界，未计为冲突缺陷。

## 8. 分批建议（17 批，每批1–2文件，低风险优先）

本节只是后续实施建议，当前所有批次都未执行。A01–A13只整理同值写法；A14–A15收敛已有骨架；A16–A17才改异常状态几何。每批完成后只验证相应页面／组件，涉及几何必须记录真实矩形和计算样式。

| 批次 | 文件（相对`packages/web/src/`） | 内容／对应问题 | 建议验收 |
|---|---|---|---|
| **A01** | `components/agent-picker.tsx`、`components/personal-memory-panel.tsx` | min-w256→64尺度、min-h384→96；P3-01 | 选择弹层宽、个人记忆编辑区最小高相等 |
| **A02** | `pages/personal-profile.tsx`、`pages/personal-security.tsx` | 448→112尺度，字段和操作行一起换；P3-01 | 两页字段最大宽448、标签96、操作右轴一致 |
| **A03** | `pages/memory-panel.tsx`、`pages/skills.tsx` | 最小高18／16rem等价换72／64；P3-01 | 三种专家子编辑器与技能编辑区高度相等 |
| **A04** | `pages/servers.tsx`、`pages/eval.tsx` | 220→55、160→40、900→225；P3-01 | 摘要、编辑器、对比弹层宽高不变 |
| **A05** | `components/knowledge-citations.tsx`、`components/knowledge-wiki.tsx` | 860→215，保留sm变体；P3-01 | 引用、Wiki预览与贡献差异弹层上限相等 |
| **A06** | `components/knowledge-faq.tsx` | 760／720／680→190／180／170；P3-01 | 创建、导入、历史三类弹层分别等宽 |
| **A07** | `pages/knowledge-detail.tsx` | 1100／760→275／190；不动calc／网格；P3-01 | 文档与来源弹层宽度不变、表格容器独立横滚 |
| **A08** | `pages/ops.tsx`、`routes/s.$shareId.tsx` | 1024→256、728→182；P3-01 | 定时任务800断点／320右栏保持；公开分享轴保持728 |
| **A09** | `components/dialog-shell.tsx` | 560→140，保留sm覆盖；P3-01 | 默认弹层最大宽560，专项覆盖仍生效 |
| **A10** | `pages/channel.tsx` | 两处880→220；P3-01 | 状态说明和Composer与消息阅读轴不偏移 |
| **A11** | `pages/chat.tsx` | 880→220、400→100、294→73.5、11rem→44、300→75；P3-01 | 对话加载／错误／无专家／欢迎／消息、历史Sheet及成果Sheet计算宽高相等 |
| **A12** | `pages/agents.tsx` | **只**版本历史Sheet480→120，`:4005`；P3-01 | 版本Sheet宽480；不触碰工牌／受保护创建卡的任何样式 |
| **A13** | `components/app-shell.tsx` | 账号200→50、导航Sheet294→73.5；P3-01 | 展开／收起账号入口与窄桌面导航Sheet宽不变 |
| **A14** | `pages/personal-profile.tsx` | 使用现有PageSection，保留gap12／首分区无线；P3-02 | 编辑／保存／展开账号详情，首后分区线与当前坐标一致 |
| **A15** | `pages/personal-security.tsx` | 使用现有PageSection，保留gap16与条件divided；P3-02 | 改密收起／展开、当前／其他会话、表格／卡片均保持顺序与间距 |
| **A16** | `pages/channel.tsx` | 去掉两异常态顶部16，保留px24／pb24；P2-01 | 控制加载／失败／正常态，测顶部矩形，标题区域不再额外下移 |
| **A17** | `components/app-shell.tsx` | 普通拒绝态去pt24，同时按调用上下文处理immersive内容边；P2-02 | 普通页／chat／频道拒绝态分别测顶部与左右边；保持刷新权限／返回／退出可用 |

没有为Tabs、Switch、InputGroup、工牌、扇形创建卡、CSS动画、任意网格模板或生成式显式gap安排清理批次：这些不属于本轮确定问题。若后续只做低风险一致性整理，可停在A13；A14以后需结合实际状态验证，不能用类名等价代替几何证据。

## 9. 验证、完成状态与下一步

- [x] 读取权威、模块规则、流程与踩坑记录，记录起始HEAD和已有差异。
- [x] 全量正则穷举；逐类核对117次间距／尺寸／定位命中，并补查网格、断点、内联style及CSS。
- [x] 比较页面骨架、横向padding、网格、表格和FieldGroup，保留批准例外。
- [x] 给出P1/P2/P3统计、风险与17个每批1–2文件的后续建议。
- [x] 使用已安装Tailwind真实编译26个主要建议尺度，全部生成成功；实际输出：“已安装 Tailwind 生成全部 26 个建议等价尺度；--spacing 为 0.25rem。”
- [x] 自动核验117次／92行命中在文档中全覆盖，190处完整源码位置存在且行号有效，17批编号唯一。
- [x] `git diff --name-only -- packages/web docs`无输出；目标文档状态为`?? docs/tasks/cds-spacing-layout-audit.md`，既有源码与文档无差异。`git diff --check`通过（只覆盖已跟踪差异，目标新文档由上述专门核验覆盖）。

可复查的扫描命令：

```sh
rg -n -- '-\[' packages/web/src
rg -n -- '\b-?m[tyb]-[0-9a-z.\[]+' packages/web/src/pages packages/web/src/routes
rg -n '<(?:Page|ResourcePage|PageHeader|PageToolbar|PageSection|FieldGroup)\b' packages/web/src/pages
rg -n '(padding|margin|gap:|rowGap|columnGap|width:|height:|minWidth:|maxWidth:|minHeight:|maxHeight:|inset:)' packages/web/src/pages packages/web/src/components packages/web/src/openui packages/web/src/styles.css
rg -n -- '--spacing:|--container-' packages/web/node_modules/tailwindcss/theme.css
```

Tailwind验证直接调用已安装包的`compile`，输入其`theme.css`加`@tailwind utilities`，对26个建议utility的输出逐一断言。无新增脚本、依赖、单元测试或集成测试；源码未改，不运行typecheck/build冒充UI验证。

**下一步：** 本次只读审计已完成；实施批次等待后续任务授权。成果为未提交文档差异，未合入main，未commit/push。未启动浏览器，未对真实渲染几何、溢出或焦点做验收；§7候选均保留为未验证。
