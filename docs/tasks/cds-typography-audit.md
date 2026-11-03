# Claude CDS 全站重设计：维度 1 · 排版只读审计

## 目标、范围与结论

对 `packages/web/src` 全量扫描字号、字重、字距、行高与标题入口，再按实际组件职责和调用链归类。只记录相对已批准排版体系的偏差，不重新设计字阶。本次唯一交付文件为本文，源码、测试、配置与其它文档均不修改。

- 审计日期：2026-11-02。
- 工作区：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`，分支 `cds-redesign`。
- 固定基线：`a44ba5131de7d1d5b396170ed6eafa59d5aa0b8d`。
- 开工状态：仅有既存未跟踪 `tmp/`，不归本审计处理；保留原状。
- 覆盖：`src` 共 195 个文件；177 个 TS/TSX/CSS 文件（21 TS、155 TSX、1 CSS）进行全文正则扫描。其余为资源文件，不把字体、图片二进制当源码解码。29 个 `pages/*.tsx` 文件及全部路由入口纳入标题检查。
- 方法：穷举声明 → 区分字号与颜色 → 检查共享组件默认值、调用方覆盖与继承 → 按语义记录根因。统计是源码声明次数，包含变体、条件分支和后代选择器；不等于运行时 DOM 节点数，不按组件复用次数倍增。
- 结果：`text-[…]` 共 **19 处，其中字号 2 处、颜色 17 处**。另有 **4 处裸数字字号声明**：图表 2 处、skip link 1 处、已批准 body 兜底 1 处；前 3 处建议令牌化，body 保留。未发现 `text-4xl`–`text-9xl` 或额外的 px/rem 任意字号。
- 明确偏差按根因计 **23 项：P1 0、P2 14、P3 9**。同一位置涉及不同维度时注明交叉项，不把每个出现位置算成一个缺陷。
- 建议 **28 批**，每批 1–2 个文件，先处理局部、低风险事项，再处理共享原语。

本次为静态审计。未启动应用，未读取计算样式、实际 AX 树或截图；没有把潜在换行、裁切或 200% 缩放问题升级为已发生的 P1。标题检查结论是源码及组合链路结论，不能替代各状态的浏览器验收。

## 当前有效决定：已批准、受保护，不作为偏差

权威为 `packages/web/DESIGN.md` 与 `docs/DESIGN-SYSTEM.md`，本轮用户给定基线优先。排版技能仅辅助检查，不应用其通用 16px 正文、移动端输入或无单位行高建议去覆盖项目决定。

| 令牌 | 已批准字号 / 行高 | 角色 |
|---|---|---|
| `text-2xs` | 11 / 16 | 高密度只读数据、trace 次要读数、版本历史 |
| `text-xs` | 12 / 16 | 元信息、徽章、表头 |
| `text-sm` | 13 / 20 | 界面默认、导航、控件、表格主单元格、说明 |
| `text-base` | 14 / 22 | 列表与卡片标题、对话标题、对话正文与输入、普通分区标题 |
| `text-md` | 15 / 26 | 运行详情、评估、记忆与插件详情等原有用途 |
| `text-lg` | 16 / 24 | 普通页面 h1；Markdown 二级标题；OpenUI 显式 large |
| `text-xl` | 18 / 26 | Markdown 一级标题 |
| `text-2xl` | 20 / 28 | 对话欢迎标题；明确的工牌视觉例外见下文 |
| `text-3xl` | 24 / 32 | 主统计数字 |

令牌定义证据为 `packages/web/src/styles.css:119`（sans 字体）、`:120`（mono 字体）、`:123`–`:142`（九档字号与配对行高）。角色依据为 `packages/web/DESIGN.md:289`、`:293`、`:298`、`:302`、`:304` 及 `docs/DESIGN-SYSTEM.md:112`。

保护边界：

- 13/20 界面档、14/22 阅读档，以及项目现有 rem 阶梯均保留；不改成参考项目 11/17、13/17、14/20、15/20。
- 15/26 的全部 10 处消费保留：`packages/web/src/pages/agents.tsx:4010`、`:4058`；`pages/eval.tsx:559`、`:861`、`:1001`；`pages/memory-panel.tsx:484`、`:804`、`:1127`；`pages/plugin-detail.tsx:363`；`pages/run-detail.tsx:596`。这里及后续同一表格内的短路径相对 `packages/web/src/`。不能仅因它们不同于普通 14px 分区标题就统一缩小。
- `packages/web/src/styles.css:264` 的 body 15px/1.5 是明确记载的兜底，不是遗漏的 `text-md`，不能替换成 15/26 或全局 13/20。
- `packages/web/src/styles.css:270` 已全局 `pretty`，`:273`–`:277` 已给 h1–h3 设置 `balance` 与 -0.01em。组件不重复声明不构成缺失。
- Markdown `packages/web/src/components/markdown.tsx:135`–`:140` 的 600 字重、18/26 → 16/24 → 14/22 层级及 `:114` 的 `max(1em, var(--text-base))` 下限均保留；这是令牌驱动的已批准层级保护，不是任意字号。
- `packages/web/src/openui/components/content.tsx:10` 的 small/default/large 与显式 heavy 变体保留；`openui/components/shared.tsx:110` 的内容 bold 映射到 semibold 不作为默认标题字重问题。
- 品牌 Logo、艺术字、工牌、插画与受保护创建入口不做一般 UI 归一化：`packages/web/src/pages/agents.tsx:1022` 的 PACE 600 / 0.18em、`:1035` 的工牌姓名 20/28；`packages/web/src/styles.css:417` 的扇形创建入口标签；扇形「新建专家」与「创建数字分身」卡均保留。工牌姓名不是第二个普通页面 h1，也不是误用欢迎标题档。
- `.align-*`、SVG 图标尺寸与图标光学基线继续沿用图标规范；本审计不提出改动。
- 12/20 等宽代码档的 `text-xs leading-5` 是明确的配对例外，如 `packages/web/src/components/code-block.tsx:142`，不因为覆盖了 xs 默认 16px 行高就报错。
- 普通页面各一个 h1 的要求不意味着所有 h1 都必须 16px；对话标题 `packages/web/src/pages/chat.tsx:1098` 的 14/22 是已批准例外。

## 字号穷举：任意值与直接声明

### `text-[…]` 的 19 处逐项归类

| 位置 | 声明 / 用途 | 判断与建议 |
|---|---|---|
| `packages/web/src/components/ui/calendar.tsx:75` | `text-[0.8rem]`，星期表头，基准 16px 根字号下为 12.8px | T01；表头映射 `text-xs`，不保留近似 13px 私有档 |
| `packages/web/src/components/ui/calendar.tsx:81` | `text-[0.8rem]`，周序号 | T01；元信息映射 `text-xs` |
| `packages/web/src/components/memory-review.tsx:1585`、`:1594`、`:1809` | `text-[var(--color-link)]` | 3 处颜色，不是字号 |
| `packages/web/src/components/knowledge-citations.tsx:521`、`:532` | 同上 | 2 处颜色 |
| `packages/web/src/pages/personal-shares.tsx:46` | 同上 | 1 处颜色；同时存在的 `text-sm` 才是字号 |
| `packages/web/src/pages/memory-panel.tsx:122` | 同上 | 1 处颜色 |
| `packages/web/src/components/code-block.tsx:22`、`:76`、`:115` | `text-[var(--color-code-block-fg)]` | 3 处代码前景色 |
| `packages/web/src/components/markdown.tsx:155`、`:165`、`:204` | link 或 code-block 前景色 | 3 处颜色，包括后代选择器中的 1 处 |
| `packages/web/src/pages/channel.tsx:784`、`packages/web/src/pages/chat.tsx:3257` | link 前景色 | 2 处颜色；旁边 `text-2xs` 的角色问题另见 T05 |
| `packages/web/src/components/ui/button.tsx:23`、`packages/web/src/components/ui/badge.tsx:18` | link 变体前景色 | 2 处颜色 |

### 其它字号声明

| 位置 | 当前声明与用途 | 判断 |
|---|---|---|
| `packages/web/src/styles.css:264` | `font-size: 15px`，body 兜底 | 已批准，不动 |
| `packages/web/src/styles.css:329` | `font-size: 14px`，键盘 skip link | T16；只替换为 `var(--text-base)`，不变更视觉大小 |
| `packages/web/src/openui/components/charts.tsx:500` | `tick: { fontSize: 12 }`，笛卡尔图表公共轴配置 | T15；使用现有 `--text-xs`，维持 12px |
| `packages/web/src/openui/components/charts.tsx:727` | 雷达图角轴 `fontSize: 12` | T15；同上 |
| `packages/web/src/components/source-editor-inner.tsx:67` | `fontSize: 'var(--text-sm)'`，搜索面板 | 已使用令牌 |
| `packages/web/src/components/source-editor-inner.tsx:71` | `fontSize: 'inherit'`，搜索输入与按钮 | 合理继承 |
| `packages/web/src/components/markdown.tsx:114` | `max(1em, var(--text-base))` | 已批准的标题下限，保留 |
| `packages/web/src/styles.css:424` | `font-size: var(--text-sm)`，受保护创建卡标签 | 合规且受保护 |

任意字号 2 处与其它裸数字 4 处合计 6 个源码位置；其中需要处理 5 个位置，按 calendar、chart tick、skip link 三个根因记录。没有建议新增字号，也没有把 token 定义本身计为偏差。

## 九档令牌使用分布

| 令牌 | 总次数 | UI 原语 | 应用组件 | pages | OpenUI | routes | 主要场景与判断 |
|---|---:|---:|---:|---:|---:|---:|---|
| `text-2xs` | 122 | 0 | 43 | 79 | 0 | 0 | 知识详情 22、专家 15、对话 12、连接器 11、检索/FAQ 各 10；trace/版本历史有正当用途，但已扩散到字段标签、提示和常规徽章 |
| `text-xs` | 382 | 9 | 123 | 226 | 22 | 2 | 元信息、表头、Badge；连接器 34、专家 32、FAQ 28、知识详情 26；部分被用于正文说明、按钮和表格主内容 |
| `text-sm` | 265 | 41 | 66 | 133 | 24 | 1 | 界面主档；专家 24、记忆提案组件 20、评估 15；按钮/输入/页签默认基本一致 |
| `text-base` | 60 | 4 | 20 | 25 | 11 | 0 | 提案分区 13、对话 6、Markdown 5、OpenUI content 5；普通卡片及 PageSection 基准 |
| `text-md` | 10 | 0 | 0 | 10 | 0 | 0 | 原有详情、评估、记忆阅读/标题档，保护 |
| `text-lg` | 12 | 0 | 2 | 1 | 6 | 3 | PageHeader、频道页 h1、分享页 h1、Markdown 二级、OpenUI large/数值/卡片标题 |
| `text-xl` | 1 | 0 | 1 | 0 | 0 | 0 | Markdown 一级标题映射，合规 |
| `text-2xl` | 2 | 0 | 0 | 2 | 0 | 0 | 欢迎区与工牌姓名；均保留 |
| `text-3xl` | 1 | 0 | 0 | 1 | 0 | 0 | 概况主数字 `pages/overview.tsx:569`，合规 |
| **合计** | **855** | **54** | **255** | **477** | **63** | **6** | 一次声明可有多个运行时消费者 |

### 同角色对照

| 角色 | 稳定基准证据 | 不一致证据与处理 |
|---|---|---|
| 普通页头 | `components/page.tsx:35`：lg/500；分享页 `routes/s.$shareId.tsx:116`、`:121`、`:187` 同档 | 未发现普通页面另起私有字号；对话 base 已批准 |
| 普通分区 | `components/page.tsx:89`、`pages/personal-profile.tsx:60`、`pages/personal-security.tsx:384`：base/500 | 会话成果、Wiki/文档侧栏、频道侧栏、授权范围使用 sm/500，见 T09；更深层 h3 小于 h2 不自动算偏差 |
| 卡片/列表标题 | `components/ui/card.tsx:42`：base/500，显式 sm 卡变体 sm/500；`pages/agents.tsx:693` 同档 | 知识/插件/技能卡把 22px 行高改成 19.25px，T13；OpenUI 普通卡片标题 16/600、其它标题 14/600，T11 |
| 按钮/页签 | `components/ui/button.tsx:6`、`:29`、`components/ui/tabs.tsx:51`：sm/500 | Button xs 12px、调用方把 sm 按钮改为 xs、个别正文内折叠入口用 xs，T02/T03；`font-normal` 用于模拟字段/文件列表的选择器不一律改回 500 |
| 表格主内容 | `components/ui/table.tsx:11`：sm；`:56` 表头 xs；`:68` 单元格继承表格 | 图表数据表整体 xs、处理记录主类型/对象 xs，T12；时间/ID 等 xs 与密集诊断数据 2xs 保留 |
| 徽章 | `components/ui/badge.tsx:7`：xs/500；Combobox chip `components/ui/combobox.tsx:193` 同档 | 常规待授权、内容类型、筛选计数、提案证据类型手写 2xs，T05 |
| 辅助说明 | `components/page.tsx:41`、`:91`，以及 FieldDescription 基本字号：sm | xs/2xs 被用于权限限制、文件说明、FAQ 策略、授权规则、替换失败等；按 T07/T08 区分提示正文与元信息 |
| 数值/代码 | 概况 3xl/500，代码 xs/20，数字常见 mono/tabular | OpenUI Metric 16/600 为内容组件数值层级，不直接按普通标题统一；xs/relaxed 代码实际 19.5px 行高见 T20 |

## 字重盘点

| 字重 | 声明总数 | UI 原语 | 应用组件 | pages | OpenUI | routes | 判断 |
|---|---:|---:|---:|---:|---:|---:|---|
| `font-normal` | 41 | 5 | 15 | 16 | 5 | 0 | 字段值、只读信息、选择器与文件行等正常用途 |
| `font-medium` | 151 | 20 | 47 | 75 | 6 | 3 | 普通标题、按钮、页签、标签主档 |
| `font-semibold` | 23 | 0 | 6 | 6 | 11 | 0 | Markdown、显式 heavy、内容强调及原有 md 标题有批准用途；普通 OpenUI 标题与来源标题另见 T11/T21 |
| `font-bold` | 0 | 0 | 0 | 0 | 0 | 0 | 未发现 700 误用 |

未发现 `font-thin/light/extrabold/black`、任意 `font-[…]` 或内部直接 `fontWeight` 声明。`styles.css:425` 的 500 是受保护创建入口标签。23 处 semibold 的归属已全部核对：Markdown 6、TextContent heavy 1、OpenUI data 3、OpenUI layout 6、OpenUI shared 内容强调 1、专家 3（品牌 1 + 原有 md 标题 2）、记忆面板 3。不把原有记忆文件名、工牌艺术字或用户要求加重的内容当成默认标题错误。

## 明确偏差清单

P1：已证实阻断阅读或内容不可用；P2：明确违反现有角色映射或跨页面层级；P3：孤立令牌化、细微行高或局部一致性问题。以下各项建议均只用既有令牌。

### P2：14 项

| ID | 位置 | 现状 | 建议 | 风险 |
|---|---|---|---|---|
| T01 | `packages/web/src/components/ui/calendar.tsx:75`、`:81` | 星期表头和周序号使用 0.8rem（12.8px），脱离九档 | 两处改 `text-xs`；日期按钮继续 sm | 低；表头缩约 0.8px，需核对七列对齐 |
| T02 | `packages/web/src/components/ui/button.tsx:28`；对照 `components/ui/input-group.tsx:69` | Button 的 xs 变体使用 12/16，但 InputGroup 的 xs 按钮仍是 13/20；控件字阶随封装不同 | xs 高度保持 24px，文字统一 `text-sm`；不要改 icon-xs 的图标档。调用方举例：`components/knowledge-search.tsx:156`、`:282`，`pages/overview.tsx:258`、`:288`，`pages/knowledge-detail.tsx:4569` | 中；共享变体影响所有 xs 文字按钮，20px 行盒与既有内边距需实测 |
| T03 | `packages/web/src/components/run-outputs.tsx:45`；`pages/chat.tsx:2541`、`:3004`；`pages/personal-security.tsx:484`；`pages/personal-shares.tsx:61`；`pages/agents.tsx:4130`、`:4824`；`pages/knowledge.tsx:863`；`components/knowledge-wiki.tsx:616`；`openui/components/charts.tsx:367` | sm 按钮/折叠入口/源码正文入口在调用方改成 12px；如成果文件、展开消息、展开会话、来源、文件配置和图表数据视图 | 动作文字恢复 sm；RunOutputs 状态尾标 `:52` 用 xs。图标、时间、版本读数继续 xs；这与 T02 的共享变体是不同来源 | 中；文件名和较长动作可能更早换行，需检查局部容器 |
| T04 | `packages/web/src/components/knowledge-search.tsx:60`、`:67`、`:76`、`:139`、`:529`、`:538`；`components/knowledge-faq.tsx:1370`、`:1374`；`pages/agents.tsx:2656`；`pages/servers.tsx:2237`、`:2261` | 检索开关/选项用 xs，阈值 FieldLabel 用 2xs；专家启用标签 xs；连接器来源 legend xs，选项说明 2xs/15.125 | 控件标签统一 sm；连接器来源 legend 可用现有 FieldLegend 的 base/500 或 `variant="label"` 的 sm/500；来源选项说明用 sm/400。保留主次字重区别 | 中；筛选工具栏、来源卡选项高度可能变化 |
| T05 | `packages/web/src/components/knowledge-search.tsx:127`、`:238`；`components/memory-review.tsx:1777`；`pages/channel.tsx:784`；`pages/chat.tsx:3257` | 常规筛选计数、结果类型、证据类型、待授权徽章为 11px；共享 Badge 为 12px | 按徽章角色改 xs，既有 500 或 400 随具体角色保留；不把 trace 行内类型读数批量当徽章升级 | 低；胶囊宽度略增 |
| T06 | `packages/web/src/components/conversation-search.tsx:201`；`components/knowledge-settings.tsx:697`；`components/knowledge-faq.tsx:1731`、`:1736`、`:1742`；`components/knowledge-search.tsx:247`、`:258`；`components/knowledge-wiki.tsx:160`；`pages/agents.tsx:1639`、`:1725`、`:1813`、`:3862`；`pages/knowledge-detail.tsx:1086`、`:1853`、`:2006`、`:2895`、`:2976`、`:3391`；`pages/memory-panel.tsx:1091`；`pages/ops.tsx:399` | 常规搜索时间、模型端点、列表状态、账号 ID/分组标签等使用 2xs；这些入口不是 trace/多列数值诊断 | 常规元信息映射 xs；纯分组标签同 xs。高密度诊断/版本差异保留，完整 2xs 位置见后文 | 低至中；列表的截断和第二行宽度需抽查 |
| T07 | `packages/web/src/components/knowledge-documents.tsx:96`；`components/knowledge-faq.tsx:507`、`:599`、`:1117`、`:1121`、`:1125`；`components/knowledge-citations.tsx:647`；`pages/agents.tsx:2670`、`:4410`；`pages/chat.tsx:3097`、`:3107`、`:3225`；`pages/roles.tsx:881`、`:1112`、`:1152`；`pages/servers.tsx:1331`、`:2261`；`pages/knowledge-detail.tsx:2980` | FAQ 替换约束、错误/警告、未保存、截断说明和配置说明使用 11px；属于用户需要理解并据此行动的信息 | 说明、错误及约束正文改 sm；“未保存”若保留为短状态用 xs。FAQ 导入列表中行号/机器码可 xs，问题描述 sm；不把整个 trace 数据区改大 | 中；错误和说明换行会改变表单/列表高度；T04 的来源说明为同一位置的交叉项 |
| T08 | `packages/web/src/pages/agents.tsx:755`、`:1311`、`:3394`、`:3511`、`:3516`、`:3537`、`:3626`、`:4388`、`:4393`；`pages/chat.tsx:1411`、`:1996`、`:3261`；`pages/channel.tsx:481`、`:776`；`pages/servers.tsx:1006`、`:1140`、`:1196`、`:1198`、`:1203`、`:1214`、`:1314`、`:2450`；`pages/runtime-environment-detail.tsx:494`、`:530`；`pages/knowledge-detail.tsx:565`、`:951`、`:2019`；`components/knowledge-search.tsx:252`、`:254`、`:273`；`components/knowledge-faq.tsx:1748`；`components/knowledge-citations.tsx:695`（行高）、`:704`；`components/share-dialog.tsx:74`；`components/blob-image.tsx:49`；`components/blob-pdf.tsx:24`；`components/conversation-outputs.tsx:320` | 普通描述、权限原因、授权有效期、失败说明、引用摘要和正文上下文经常降到 xs；与共享说明的 sm 不一致。引用正文 `:695` 已是 sm，仅行高问题见 T19 | 普通说明/引用摘要恢复 sm/20；对话的实际消息正文仍 base/22；文件名、时间、ID、成本、图注等真正元信息继续 xs。不要全量替换 `text-xs` | 中；专家卡固定 208px、摘要截断行数、授权条和弹窗高度需定点验收；不改受保护创建卡 |
| T09 | `packages/web/src/components/conversation-outputs.tsx:140`；`components/knowledge-wiki.tsx:121`；`pages/knowledge-detail.tsx:748`；`pages/channel.tsx:653`、`:674`；`pages/roles.tsx:1116` | 独立面板/区块 h2 使用 sm/500，弱于 PageSection 和个人模块同角色 base/500 | 普通区块标题统一 base/500；仍保留紧凑行高、边距和现有容器宽度。嵌套 h3、菜单分组标签不在此项中 | 低至中；面板标题约增加 2px 行盒高度 |
| T10 | `packages/web/src/pages/servers.tsx:1744` | 工具编辑/添加表单标题 h3 为 xs/400/辅助色，弱于其下 13px/500 字段标签 | 改 base/500/fg，与其它表单分区标题一致，保持 h3 语义层级 | 低；局部表单头高略变 |
| T11 | `packages/web/src/openui/components/layout.tsx:214`、`:229`、`:347`、`:378`；`openui/components/data.tsx:583`；对照 `openui/components/content.tsx:71` | 普通 CardHeader 为 lg/600；InlineHeader、展开 SectionBlock、步骤标题及信息卡标题为 base/600；同角色 Callout 与全站 CardTitle 为 base/500 | 普通卡片/区块/步骤标题归 base/500；保持 heading 的 h2/h3 语义。显式 TextContent heavy、内容强调及 Metric 数字不动 | 中；生成式 UI 覆盖面广，需要不同组件组合与长标题验收 |
| T12 | `packages/web/src/openui/components/charts.tsx:371`；`pages/knowledge-detail.tsx:4564`、`:4569`、`:4577`、`:4587` | 图表“数据视图”整表为 xs；处理记录的任务类型/对象/步骤正文也为 xs，与通用表格主单元格 13px 不同。TableCell 本身没有固定字号，确会继承整表 xs | 数据表主内容用 sm，表头仍 xs；处理记录类型/对象/自然语言步骤或错误用 sm，创建时间/耗时/进度等元信息可 xs。`:4569` 的对象按钮还受 T02 影响 | 中；长对象/步骤需检查表格容器横滚和行高，保留现有最小列宽 |
| T13 | `packages/web/src/pages/knowledge.tsx:152`；`pages/plugins.tsx:255`；`pages/skills.tsx:315` | 资源卡标题 base 搭 `leading-snug`，声明值 14/19.25；共享 CardTitle 和连接器/专家卡为 14/22 | 删除标题上的 `leading-snug`，让 `text-base` 恢复配对 22px 行高 | 中；三类资源卡标题行盒变化，核对头像、徽章及卡头几何 |
| T14 | `packages/web/src/components/ui/label.tsx:9`；`components/ui/field.tsx:86`、`:97` | Label 的 `leading-none` 把 sm 设为 13/13；FieldLabel 改成 `leading-snug` 后为 13/17.875。FieldContent 还向未显式设字号的子内容提供独立行高 | 标签恢复 sm 配对 20px；FieldContent 不再为整组强加与字段角色无关的行高，让子节点使用自身令牌。先核对多行标签、checkbox/radio 布局 | 中；共享表单影响最大，必须后置验证，不能只看单一表单 |

### P3：9 项

| ID | 位置 | 现状 | 建议 | 风险 |
|---|---|---|---|---|
| T15 | `packages/web/src/openui/components/charts.tsx:500`、`:727` | 轴标签 `fontSize: 12` 绕过字体令牌 | 仍用 xs，SVG tick style/prop 引用 `var(--text-xs)`；不要用只对字号为 number 有效的计算去引入新常量 | 低；需确认 Recharts 最终 SVG 样式中的 CSS 变量生效 |
| T16 | `packages/web/src/styles.css:329` | skip link 直接 14px | 改为 `var(--text-base)`；先保持当前继承行高，避免把纯令牌化扩成布局修改 | 很低；像素效果不应变化 |
| T17 | `packages/web/src/components/source-editor-inner.tsx:41`；对照 `components/source-editor.tsx:48`、`:70` | CodeMirror `.cm-scroller` 强制 1.5；默认 13px 为 19.5px，加载前 textarea 继承 sm/20；传入 xs 的编辑器变成 12/18 | 编辑态与 fallback 共用外壳的字号/行高，优先 `lineHeight: 'inherit'`；保留 mono 字体。调用方若确有代码 12/20，用已有 xs + leading-5 明示 | 中；CodeMirror 行高与滚动量有关，要实测编辑器加载前后及行号 |
| T18 | `packages/web/src/components/ui/field.tsx:124` | FieldDescription 的 sm/`leading-normal` 是 13/19.5，而不是令牌 13/20 | 移除 `leading-normal`，使用 text-sm 配对行高；横向布局的条件 text-balance 只在确有长说明换行问题时再改，不凭静态搜索定为缺陷 | 低至中；全站说明高度可能有细小变化 |
| T19 | `packages/web/src/components/confirm-dialog.tsx:69`；`components/memory-review.tsx:1761`；`components/knowledge-citations.tsx:654`、`:695`；`components/knowledge-search.tsx:410`；`pages/eval.tsx:562`、`:875`、`:1005`；`pages/status.tsx:69` | 普通 sm 说明/问答/评估内容叠 leading-relaxed，得到 13/21.125，旁边同角色用 13/20；还形成不必要的第三种说明行高 | 普通说明去掉 relaxed，回归 sm/20；若是实际对话阅读内容，按既有 base/22。已批准 md/26 不动 | 低至中；核对多行文本长度；不把更松行高本身说成不可读 |
| T20 | `packages/web/src/pages/run-detail.tsx:311`；`pages/runtime-environment-detail.tsx:314`、`:510`、`:527`；`pages/runtime-environments.tsx:348` | JSON、Dockerfile、构建日志等用 xs/relaxed，即 12/19.5，而已批准代码为 12/20 | 纯代码视图统一既有 `text-xs leading-5`；如果是可编辑 SourceEditor，结合 T17 保持内外一致 | 低至中；行数多时总高度和滚动位置变化，日志截断行为保留 |
| T21 | `packages/web/src/openui/components/layout.tsx:179`、`:184`；对照 `components/markdown.tsx:155` | 来源条普通标题/链接为 600，Markdown 链接为 500，非显式 heavy 内容却更重 | 来源标题/链接用 medium，保持下划线、来源信息和交互；与 T11 同文件但不同角色 | 低；仅字重改变，不改变链接行为 |
| T22 | `packages/web/src/pages/ops.tsx:913` | “执行计划” legend 为 base/leading-8，14/32，偏离配对 22px；把对齐需求放进文字行高 | 文字用 base/22；需要 32px 占位时由现有容器高度/对齐维持，不引入新字号 | 中；与左侧编辑区对齐相关，先量现有几何再改，保持批准的双栏布局 |
| T23 | `packages/web/src/components/ui/chart.tsx:223` | Tooltip 文本组 leading-none，xs 常见为 12/12，和普通图表 tooltip/元信息 12/16 不同 | 文本组恢复现有 xs 配对行高；保留图例标记的独立几何。未实测裁切，不升 P1 | 低至中；tooltip 高度变化，需核对长序列名与嵌套标签 |

P1 为 0 表示本次未证实严重阅读故障，不代表全站无障碍或缩放验收通过。

## `text-2xs` 全量位置复核台账

下面覆盖全部 **122 次声明**；每行文件内的数字均为行号。“保留”指符合高密度只读/trace/版本用途或艺术表现，不意味着所有该页 11px 都获豁免。实际说明、错误、字段和常规徽章仍按前述条目处理。

| 文件 | 次数 | 全部行号及分类 |
|---|---:|---|
| `packages/web/src/components/conversation-search.tsx` | 1 | 201：常规搜索时间，T06 → xs |
| `packages/web/src/components/knowledge-citations.tsx` | 5 | 330、334、356、378：trace 引用类型、页码、分组/计数，保留；647：FAQ 策略说明，T07 → sm |
| `packages/web/src/components/knowledge-documents.tsx` | 3 | 85、90：批处理结果新文档/任务 ID，密集结果内保留；96：可行动错误，T07 → sm |
| `packages/web/src/components/knowledge-faq.tsx` | 10 | 507、599、1117、1121、1125：策略/导入约束/结果说明，T07；1374：阈值字段标签，T04；1731、1736、1742：搜索结果元信息，T06；1972：版本历史时间，保留 |
| `packages/web/src/components/knowledge-search.tsx` | 10 | 76、538：阈值字段标签，T04；127、238：计数/类型徽章，T05；247、258：常规结果元信息，T06；255：匹配问句为内容，宜 sm，与 T08 同组；318、338：多列检索分数诊断，保留；406：直接答案诊断计数，保留 |
| `packages/web/src/components/knowledge-settings.tsx` | 1 | 697：模型/端点，T06 → xs |
| `packages/web/src/components/knowledge-wiki.tsx` | 10 | 160：常规列表状态，T06；438：版本时间，保留；621、651：链接分组标签 → xs，623、653 空态及 629 目标不存在说明 → sm，归 T07 的说明规则；852、867、877：版本行/来源差异，保留 |
| `packages/web/src/components/memory-review.tsx` | 2 | 1777：证据类型徽章，T05；1780：紧随其后的证据文件/行号，普通提案详情元信息宜 xs，T06 |
| `packages/web/src/components/run-outputs.tsx` | 1 | 52：成果操作内结果短状态，T03 → xs |
| `packages/web/src/pages/agents.tsx` | 15 | 1639、1725、1813：成员/所有者候选 ID，T06；2670：未保存短状态，T07 → xs；2982、3081、3170、3255、3408：配置区数量读数，保留；3862：文件分组标签，T06 → xs；4410：文件说明，T07 → sm；4580、4585、4615、4622：版本历史中的标记、时间、无差异和字段差异，保留 |
| `packages/web/src/pages/channel.tsx` | 3 | 568、659：24px 头像首字母，属于图形内文字，保留，不推导成普通说明档；784：待授权徽章，T05 |
| `packages/web/src/pages/chat.tsx` | 12 | 1891、1897、3063、3069：消息/trace 次要标识与时间，保留；3097、3107：截断提示/notice，T07；3225：运行错误，T07；3257：待授权徽章，T05；3397、3407：trace 参数/结果分组，3403、3419：同一区域紧凑空值状态，保留 |
| `packages/web/src/pages/knowledge-detail.tsx` | 22 | 552：专家使用关系的配置说明 → sm，T07 说明规则；1086、1853、2006、2895、2976、3391：普通列表元信息，T06；2050、2066：分块序号/数值读数，保留；2980：来源错误，T07；3382：同步范围分组标签宜 xs；4231、4239、4247、4251、4270、4280：连接诊断/空态信息宜 xs；4286：失败项内容宜 sm；4334：同步记录标题宜 sm/500；4335、4342：加载/空态宜 xs；4347：紧凑同步历史，保留。后半组按 T06/T07 的角色规则纳入该文件批次，不另计根因 |
| `packages/web/src/pages/memory-panel.tsx` | 2 | 545：版本回滚记录，保留；1091：常规当前状态，T06 → xs |
| `packages/web/src/pages/ops.tsx` | 1 | 399：紧凑窗口的调度状态元信息，T06 → xs；不新增移动适配 |
| `packages/web/src/pages/roles.tsx` | 3 | 881：角色错误，1112：权限约束，1152：保存生效说明，T07 |
| `packages/web/src/pages/run-detail.tsx` | 10 | 355、401、429、444、501、522、569、571、575、581：运行 trace / 上下文的读数、序号、类型与 ID，保留。短类型标记位于密集 trace 行，不扩大 T05 到所有只读诊断标记 |
| `packages/web/src/pages/servers.tsx` | 11 | 921、926、932、941、948：连接测试紧凑读数/诊断结果，1458、1464、1469、1473：工具能力表的描述/标记/字段，保留；1331：Token 风险说明，T07；2261：来源选项说明，T04/T07 |
| **合计** | **122** | 43 次应用组件 + 79 次 pages |

源码可证明角色和声明，但“密集”仍有视觉条件：后续若发现某个保留处已脱离多列/trace/版本上下文，应按规则改为 xs，而不是继续扩大 2xs 豁免。

## 字距、行高与换行的完整检查

### 字距：12 次显式 tracking

| 声明 | 次数 | 全部位置 | 结论 |
|---|---:|---|---|
| `tracking-[-0.01em]` | 7 | `components/page.tsx:35`；`pages/channel.tsx:389`；`pages/chat.tsx:1098`；`pages/agents.tsx:4058`；`routes/s.$shareId.tsx:116`、`:121`、`:187` | 与标题规范一致；虽全局 h1–h3 已有同值，显式重复不等于视觉偏差，不专门为去重开批 |
| `tracking-[-0.02em]` | 1 | `pages/chat.tsx:2953` | Display 欢迎标题已批准 |
| `tracking-[0.06em]` | 3 | `components/knowledge-citations.tsx:356`；`pages/chat.tsx:3397`、`:3407` | 同一类 trace 小分组标签，局部一致；属于 ad-hoc 数值，但没有与项目字距角色明确冲突，不报修复项 |
| `tracking-[0.18em]` | 1 | `pages/agents.tsx:1022` | 品牌 PACE 艺术字，保护 |

除了全局 -0.01em 外未发现独立 `letterSpacing`/`letter-spacing` 声明；未发现禁用 kerning、手写 wght/opsz 或局部字体平滑声明。未核验实际字体加载与光学轴，不能从字体栈推断浏览器实际命中了哪个字形。

### 行高：53 次有效 utility + 1 次注释提及

有效项：relaxed 39、snug 6、none 3、normal 2、leading-5 2、leading-8 1，共 53 次。`components/status-badge.tsx:7` 中的 `leading-none` 只是说明不要覆盖行高的既存注释，未计为运行代码。源码直接声明另有 body `line-height: 1.5`、九档 token 配对行高，以及 CodeMirror `lineHeight: '1.5'`。

下表覆盖全部 39 次 `leading-relaxed`。数字为同文件行号；不因为它是 override 就一概报错，而按文字角色判断。

| 文件 | 行号 | 判断 |
|---|---|---|
| `components/blob-image.tsx` | 49 | xs 错误/说明，T08 |
| `components/blob-pdf.tsx` | 24 | 同上 |
| `components/confirm-dialog.tsx` | 69 | sm 说明 21.125px，T19 |
| `components/conversation-outputs.tsx` | 320 | xs 说明，T08 |
| `components/knowledge-citations.tsx` | 654、695、704 | 前两处 sm 问答/摘录，T19；最后 xs 说明，T08 |
| `components/knowledge-faq.tsx` | 1748 | 搜索摘要 xs，T08 |
| `components/knowledge-search.tsx` | 252、275、410 | 摘要/上下文 xs 为 T08；sm FAQ 答案为 T19 |
| `components/memory-review.tsx` | 1761 | sm 提案理由，T19 |
| `components/share-dialog.tsx` | 74 | xs 分享说明，T08 |
| `components/ui/trace.tsx` | 126 | 包裹层的 relaxed 可被子节点字号令牌重设；保持为诊断组件局部用途，未从此断言所有后代继承该行高 |
| `pages/agents.tsx` | 2957、3537、3602、3626、4012、4388、4393 | 2957/3602 为源码编辑区，应结合 T17 判断外层与 CodeMirror；其它为提示/说明，其中 3537/3626/4388/4393 纳 T08，4012 为版本历史 Sheet 的说明也宜 sm/20，保留标题 md |
| `pages/chat.tsx` | 1411、3261 | xs 空态/授权说明，T08 |
| `pages/eval.tsx` | 562、875、1005 | sm 说明/详情，T19；md 标题不动 |
| `pages/knowledge-detail.tsx` | 2070 | chunk 摘录 xs，可按 T08 的摘要内容角色改 sm；序号/分数保留 2xs |
| `pages/run-detail.tsx` | 311 | xs 代码，T20 |
| `pages/runtime-environment-detail.tsx` | 314、510、527 | xs Dockerfile / 错误 / 日志，T20；自然语言错误可按 T08 分开 |
| `pages/runtime-environments.tsx` | 348 | xs Dockerfile，T20 |
| `pages/servers.tsx` | 1006、1112、1140、1314、1331、2450 | 1112 等宽错误细节可与代码档对齐 12/20；其余描述/风险说明按 T07/T08；不保留 11px 风险说明 |
| `pages/status.tsx` | 69 | sm 状态说明，T19 |

其它 14 次有效行高 utility：

| 声明 | 全部位置 | 判断 |
|---|---|---|
| `leading-snug` ×6 | `components/ui/field.tsx:86`、`:97`；`pages/knowledge.tsx:152`；`pages/plugins.tsx:255`；`pages/skills.tsx:315`；`pages/servers.tsx:2261` | T14、T13、T04；sm/snug 为 13/17.875，base/snug 为 14/19.25，2xs/snug 为 11/15.125 |
| `leading-none` ×3 | `components/ui/label.tsx:9`；`components/ui/calendar.tsx:175`；`components/ui/chart.tsx:223` | Label T14、Tooltip T23；日历日期按钮是固定格单行数字，保留，未证明裁切 |
| `leading-normal` ×2 | `components/ui/dialog.tsx:82`；`components/ui/field.tsx:124` | Dialog 14/21 为 `DESIGN.md:407` 明示例外，保留；FieldDescription T18 |
| `leading-5` ×2 | `components/code-block.tsx:142`；`pages/status.tsx:60` | 前者批准的代码 12/20；后者 sm/20，与令牌相同，不作偏差 |
| `leading-8` ×1 | `pages/ops.tsx:913` | T22 |

行高精确换算以 Tailwind 默认值为准：`leading-snug` 是 **1.375**，因此 base/snug 为 **14/19.25**，sm/snug 为 **13/17.875**，2xs/snug 为 **11/15.125**；`leading-relaxed` 是 1.625，xs 为 19.5、sm 为 21.125；`leading-normal` 是 1.5。T13 的卡片偏差为 **14/19.25 对 14/22**。报告中的换算值均为声明推导，未读取实际计算样式。

### 换行与标题层级

- body 的 `pretty` 可继承；没有发现全局撤销。组件只写 `text-sm/base` 并不会自动撤销它。
- h1–h3 已全局 balance。`truncate`、`nowrap` 的单行标题属于显式截断设计，不能机械补 `text-balance` 期待产生换行。
- 唯一显式 `text-balance` 在 `components/ui/field.tsx:124` 的横向 FieldDescription。它可能用于短说明，不以“出现在 p 上”就判定违反；需要真实长说明样本再决定是否改回 pretty。
- Markdown H3–H6 实际渲染 h4–h6；项目只要求 h1–h3 全局 balance，没有证据说明必须给所有 Markdown 深层标题补 balance，因此不报缺失。
- 需要语义调整的是 T10 的表单标题视觉弱于字段、T09/T11 的同角色层级不一致；没有发现必须新增第二个 h1 的情形。

## 每页 h1 / 标题入口检查

普通 PageHeader 的 h1 在 `packages/web/src/components/page.tsx:35`。以下每个入口的正常内容、源码中显式加载/错误分支均沿共同页头或互斥分支提供一个 h1；表中的“1”是静态组合检查结果。资源页不能只 grep 页面文件后判定没有 h1；CardTitle 内的 h2 也不能因未写字号而判定继承失败。

| 页面 / 路由 | h1 来源证据（相对 src） | 静态结论与标题差异 |
|---|---|---|
| 账号 | `pages/accounts.tsx:133` | 1；PageHeader lg/500 |
| 专家列表 | `pages/agents.tsx:447` | 1；卡片 h2 在 687，内链 base/500 |
| 专家详情 | `pages/agents.tsx:1135`、`:1146`、`:1154`、`:1168`、`:1203` 为互斥状态 | 各 1；md/600 原有节标题保留，嵌套 sm/500 h3 不强行放大 |
| 审计日志 | `pages/audit.tsx:158` | 1；PageHeader |
| 频道列表 | `pages/channels.tsx:36` | 1；列表主信息 base/500 |
| 频道详情 | `pages/channel.tsx:72`、`:80`、`:387` 互斥 | 各 1；侧栏 h2 见 T09 |
| 对话 | `pages/chat.tsx:207`、`:249`、`:829`、`:850`、`:1096` 分属互斥状态/组件路径 | 各 1；正常对话 h1 base/500，欢迎标题是 h2，20/28 保护 |
| 评估 | `pages/eval.tsx:398` | 1；PageSection base/500，结果 md/500 保护 |
| 知识库列表 | `components/resource-page.tsx:68`，页面 `pages/knowledge.tsx` | 1，sr-only；卡片行高 T13 |
| 知识库详情 | `pages/knowledge-detail.tsx:329` 常驻于 Page | 1；文件夹 h2 见 T09 |
| 登录 | `pages/login.tsx:88` | 1，sr-only；品牌区域不另算普通页头 |
| 404 | `pages/not-found.tsx:10` | 1 |
| 定时任务 | `pages/ops.tsx:272` | 1；卡片 h2 经 CardTitle 继承 base/500；执行计划 T22 |
| 平台概况 `/operations` | `pages/overview.tsx:498`；路由 `routes/_shell/operations.tsx:5` | 1；PageSection base/500；统计 3xl/500 保护 |
| 个人记忆 | `pages/personal-memory.tsx:24` | 1；阅读正文与文件编辑组件单独承担内容标题 |
| 记忆提案 | `pages/personal-memory.tsx:60` | 1；`components/memory-review.tsx:407` 卡片 h2 继承 CardTitle；详情 h3 base/500 |
| 个人资料 | `pages/personal-profile.tsx:57` | 1；h2 身份 base/500 |
| 账号安全 | `pages/personal-security.tsx:107` | 1；修改密码与会话分组 h2 base/500 |
| 我的分享 | `pages/personal-shares.tsx:216` | 1 |
| 使用记录 | `pages/personal-usage.tsx:259` | 1；汇总/运行 h2 base/500 |
| 插件列表 | `components/resource-page.tsx:68`，页面 `pages/plugins.tsx` | 1，sr-only；卡片行高 T13 |
| 插件详情 | `pages/plugin-detail.tsx:92`、`:102`、`:118`、`:188` 互斥 | 各 1；文件内容标题 md/500 保护 |
| 角色 | `pages/roles.tsx:470`、`:478`、`:492` 互斥 | 各 1；授权范围 h2 T09 |
| 运行列表 | `pages/runs.tsx:283` | 1；卡片 h2 `:170` 通过 CardTitle 继承 |
| 运行详情 | `pages/run-detail.tsx:163` 的共享 header | 各状态 1；步骤 h2 base/500、正文 md/26 保护 |
| 运行环境列表 | `pages/runtime-environments.tsx:70` | 1 |
| 运行环境详情 | `pages/runtime-environment-detail.tsx:165`、`:174`、`:229` 互斥 | 各 1；PageSection base/500 |
| 连接器 | `components/resource-page.tsx:68`，页面 `pages/servers.tsx` | 1，sr-only；卡片 h2 包含 base/500 按钮；工具表单 T10 |
| 技能 | `components/resource-page.tsx:68`，页面 `pages/skills.tsx` | 1，sr-only；卡片行高 T13 |
| 系统状态 | `pages/status.tsx:328` | 1；PageSection h2 base/500，内部 h3 sm/500 为下一级 |
| 公开分享 | `routes/s.$shareId.tsx:110`、`:116`、`:121`、`:187` 互斥 | 各 1；加载 sr-only，成功/失效/错误 lg/500 |

补充边界：

- `pages/memory-panel.tsx` 是专家详情内的内容面板，不是独立路由；没有自己的 h1 是正确的。
- 根首页、`/personal` 索引是跳转入口；`routes/__root.tsx`、`_shell.tsx`、`personal.tsx` 是组合布局，不要求各自再生成 h1。
- shell 认证加载/失败的 h1 为 `components/app-shell.tsx:468`、`:489`；拒绝访问分支为 `:301`，与已授权路由内容互斥。
- Markdown 已由 `components/markdown.tsx:135` 把 Markdown h1 映射到 h2；OpenUI 本轮扫描的标题从 h2/h3 起，不会因嵌入内容再制造页面 h1。
- Dialog/Sheet 通常 portal 到页面外，标题原语不是页面 h1；不能把其 h2 与正文页 h2 的嵌套关系只按源码缩进判断。
- 未运行各权限账号、加载/重试、所有 tabs 的实际 DOM，故不声称这张表已经证明全部渲染状态的 AX 树合规。

## 文档与实现的冲突及处理边界

1. `docs/DEV-WORKFLOW.md:45` 仍将配色/控件外观写成 Qoder CN；与根规则、`packages/web/CLAUDE.md:8`、`packages/web/DESIGN.md:224` 的 Claude CDS 权威冲突。本审计以本轮用户指定 CDS 基线为准。用户只授权本文，故在此记录，不改该流程文档。
2. `packages/web/DESIGN.md:412` 写 CardTitle 14/22；`pages/knowledge.tsx:152`、`pages/plugins.tsx:255`、`pages/skills.tsx:315` 覆盖为 snug，实际声明推导 14/19.25。这是 T13，不应反过来修改权威数值去适应偶然覆盖。
3. `packages/web/DESIGN.md:304` 与 `docs/DESIGN-SYSTEM.md:112` 规定控件 13/20、普通说明 13/20、常规元信息/徽章 12/16；源码存在 T02–T08 的 11/12px 角色扩散。按角色修消费点，保留已批准的密集只读例外。
4. `packages/web/DESIGN.md:291`、`:412` 的普通标题 14/500 与 OpenUI 普通卡片/区块标题 16/600 或 14/600 不一致，记为 T11。显式内容 heavy、Markdown 600、原有 md 标题与工牌不属于此冲突。

这些冲突都记录于本文；未创建第二份待决策文档，未扩大本轮写入范围。没有需要重设字阶的待决策项。

## 验证方法与真实结果

已执行以下范围的只读扫描：

```sh
rg -n 'text-\[|fontSize|font-size|fontWeight|font-weight|letterSpacing|letter-spacing|lineHeight|line-height|text-wrap' packages/web/src
rg -n 'text-(4xl|5xl|6xl|7xl|8xl|9xl)|font-\[|text-\(|font:|font-size=|fontSize=|fontWeight=' packages/web/src
```

令牌与字重计数使用 Python 标准库，边界排除 `--text-*` 变量声明、`text-smaller` 等非完整类名，保留 variant 中的完整类名。可复跑：

```sh
python3 -I - <<'PY'
from pathlib import Path
from collections import Counter
import re
files = [p for p in Path('packages/web/src').rglob('*') if p.suffix in ('.ts', '.tsx', '.css')]
sizes = Counter(m[1] for p in files for m in re.finditer(r'(?<![\w-])text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl)(?![\w-])', p.read_text()))
weights = Counter(m[0] for p in files for m in re.finditer(r'(?<![\w-])font-(?:normal|medium|semibold|bold|light|thin|black|extrabold)(?![\w-])', p.read_text()))
print(len(files), sizes, weights)
print('arbitrary text:', sum(p.read_text().count('text-[') for p in files))
PY
```

真实输出要点：177 文件；2xs=122、xs=382、sm=265、base=60、md=10、lg=12、xl=1、2xl=2、3xl=1；normal=41、medium=151、semibold=23、bold=0；`text-[`=19。行高位置按全文扫描再剔除注释中的一次 `leading-none`，有效 53 次。标题检索覆盖 29 个 page 文件、共享 Page/ResourcePage/AppShell、全部 routes 及 Markdown/OpenUI 标题生成器。

交付复核已实际运行并通过：

- 重算字号/字重并断言上述预期值，字号合计 855。
- 对照源码校验 2xs 台账：18 个文件、122 次声明，行号无遗漏。
- 校验本文 201 个显式 `file:line` 引用均存在且未超出文件长度；T01–T23、B01–B28 连续且唯一，未发现行尾空白。简写连续行号另外按各处读取的源码上下文复核。
- 核对已安装 `packages/web/node_modules/tailwindcss/theme.css:391`–`:394`：tight=1.25、snug=1.375、normal=1.5、relaxed=1.625。
- `git diff --name-only` 输出为空，跟踪源码未修改；本任务只新增本文。收尾状态同时出现其它并行任务的未跟踪审计文档，均未读取、修改或纳入本任务。

没有运行 typecheck、build 或测试：本轮仅新增审计文档，不改运行代码。未写单元/集成测试。浏览器计算样式、真实字体命中、窗口缩放、长标题与多行说明均 **未验证**；尤其不能仅凭声明换算声称裁切、对齐或无障碍通过。

## 分批建议：28 批，每批 1–2 文件

按局部先行、共享原语后置排序。表中只给后续实施建议，本轮全部未执行。每批均保留既有 DOM 语义、权限、错误与焦点行为；修改源码后按范围跑 web typecheck，涉及真实排版/几何再做浏览器验证。相同文件集中处理其已列偏差，避免逐个令牌跨页扫改。

| 批次 | 文件（相对 `packages/web/src/`） | 内容 / 关联项 | 验收重点 |
|---|---|---|---|
| B01 | `styles.css` | T16；仅 skip link 引用令牌 | Tab 显示，大小与原值一致；不动 body、@theme 和创建卡 |
| B02 | `components/ui/calendar.tsx` | T01 | 星期/周序号 xs；七列、选择范围与键盘交互 |
| B03 | `openui/components/charts.tsx` | T15、T12、T03 | 轴字号保持 12；数据表主文字 13；触发器 13 |
| B04 | `components/run-outputs.tsx`、`components/conversation-outputs.tsx` | T03、T08、T09 | 两处文件入口字号一致；成果面板标题/错误说明；长文件名 |
| B05 | `pages/personal-security.tsx`、`pages/personal-shares.tsx` | T03 | 展开会话/来源入口；姓名、IP/时间元信息维持 xs |
| B06 | `pages/plugins.tsx`、`pages/knowledge.tsx` | T13、T03 | 卡片标题 14/22；保留卡片与弹层几何 |
| B07 | `pages/skills.tsx` | T13 | 卡片标题及长名称；编辑器中的代码字号不顺带改 |
| B08 | `components/knowledge-search.tsx`、`components/knowledge-faq.tsx` | T04–T08、T19 | 筛选标签、阈值、徽章、摘要和导入约束；分数诊断/版本时间保留 |
| B09 | `components/knowledge-citations.tsx`、`components/knowledge-documents.tsx` | T07/T08/T19 | 正文/错误易读；trace 引用读数保持密度 |
| B10 | `components/knowledge-settings.tsx`、`components/knowledge-wiki.tsx` | T03/T06/T07/T09 | 端点元信息、Wiki 面板/链接说明；版本差异 2xs 保留 |
| B11 | `components/memory-review.tsx`、`components/conversation-search.tsx` | T05/T06/T19 | 证据类型与文件行号、搜索时间、理由行高 |
| B12 | `pages/roles.tsx` | T07/T09 | 错误/约束、授权范围；矩阵列头与 checkbox 几何 |
| B13 | `pages/chat.tsx`、`pages/channel.tsx` | T03/T05/T07/T08/T09 | 待授权条、短状态、正文提示和侧栏；base/22 消息与 20/28 欢迎保护 |
| B14 | `pages/agents.tsx` | T03/T04/T06/T07/T08 | 普通配置与文件说明；208px 卡预算、两张受保护创建卡、工牌与 md 标题全保留 |
| B15 | `pages/servers.tsx` | T04/T07/T08/T10 | 来源类型与说明、工具表单标题；高密度能力表/测试读数保留 |
| B16 | `pages/knowledge-detail.tsx` | T06/T07/T08/T09/T12 | 来源/处理记录/文件夹区；检查长对象名与局部横滚 |
| B17 | `pages/memory-panel.tsx` | T06 | 常规“已启用”元信息；保留原 md 标题、历史读数 |
| B18 | `openui/components/layout.tsx`、`openui/components/data.tsx` | T11/T21 | 普通卡片/步骤/分区/来源标题；保留内容 heavy 与 Metric 数字 |
| B19 | `components/confirm-dialog.tsx`、`components/share-dialog.tsx` | T08/T19 | 描述 13/20；不改变批准的 DialogTitle 14/21 |
| B20 | `components/blob-image.tsx`、`components/blob-pdf.tsx` | T08 | 加载失败长说明；预览与重试不受影响 |
| B21 | `pages/eval.tsx`、`pages/status.tsx` | T19 | 说明回令牌行高；md 评估标题、状态数字保持原用途 |
| B22 | `pages/runtime-environment-detail.tsx`、`pages/runtime-environments.tsx` | T20/T08 | Dockerfile/日志 12/20；自然语言说明 13/20 |
| B23 | `pages/run-detail.tsx` | T20 | 代码 12/20；trace 2xs 和正文 md/26 保留 |
| B24 | `pages/ops.tsx` | T06/T22 | 元信息 xs；执行计划 14/22，双栏对齐用容器维持 |
| B25 | `components/ui/chart.tsx` | T23 | Tooltip 12/16；长名称、嵌套标签 |
| B26 | `components/source-editor-inner.tsx` | T17 | lazy fallback/CodeMirror 行高一致；编辑、行号、搜索与滚动 |
| B27 | `components/ui/label.tsx`、`components/ui/field.tsx` | T14/T18 | 单行/多行标签、横向字段、checkbox/radio、错误说明；共享变更后跨表单抽查 |
| B28 | `components/ui/button.tsx` | T02 | xs 文字与 InputGroup 一致；24px 高按钮、长标签、icon 档与所有调用方覆盖 |

下一步：按以上批次实施需另行明确源码改动范围；本轮目标已完成，源码未改，未 commit/push/合入。静态审计范围可接受（Approve，仅指报告覆盖）；浏览器与真实状态验收未完成，不作全站视觉通过结论。
