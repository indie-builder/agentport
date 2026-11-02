# CDS 图标使用审计（只读）

- 日期：2026-11-02
- 基线：`288d6d4beccd7d4ba79ad1a00c52becdccf6edfa`（分支 `cds-redesign`）
- 范围：`packages/web/src` 全部 `.ts` / `.tsx`
- 规范：`docs/DESIGN-SYSTEM.md` §5「图标」、`packages/web/DESIGN.md`（视觉权威）
- 结论：**只新增本文档，未修改任何源码。**

> 说明：任务背景称现有规范未定义 20/24 档与光学基线；当前工作区 `docs/DESIGN-SYSTEM.md` §5 与 `packages/web/DESIGN.md` 已包含五档尺寸和光学基线（这两份文档在本审计开始前已有未提交改动）。本审计按当前工作区内容执行，并保留这些改动。

## 0. 结论摘要

- 扫描 **176** 个 TS/TSX 文件，其中 **65** 个文件从 `lucide-react` 导入图标，直接 lucide JSX 实例 **337** 个；另有 **13** 处数据驱动的动态图标渲染点（不含图表配置）。
- 直接实例的有效尺寸分布：**XS 12px 18 个（5.3%）、SM 14px 63 个（18.7%）、MD 16px 248 个（73.6%）、LG 20px 8 个（2.4%）、XL 24px 0 个**。
- **没有发现非档位尺寸**：没有 `size-[18px]`、`18px`、`size-6`/`size-7`/`size-8` 图标，也没有用 `w-*/h-*` 另写一套；`size` prop 在 lucide 上为 0，全部通过 `className` 声明或继承。
- **没有 `size-5` 滥用**：8 个 20px 图标全部位于 `EmptyState` 主图或 Dialog 顶部 40px 圆底，属于 LG 档。
- **没有 strokeWidth 局部覆盖**：直接 lucide 图标的 `strokeWidth` 覆盖数为 0，全局 `App.tsx:11` 的 `LucideProvider strokeWidth={1.75} size={16}` 生效。`eval.tsx:202` 与 `openui/charts.tsx` 的 `strokeWidth` 属于 Recharts，`agents.tsx:988-1013` 属于品牌插画 SVG，均不按图标规则处理（与 `docs/PITFALLS.md` 一致）。
- **没有硬编码颜色**：直接 lucide 图标中 hex/rgb/oklch 颜色覆盖为 0，全部继承 `currentColor` 或使用 `text-*` 语义 token。
- **主要问题不是“尺寸越界”，而是同一类控件内尺寸不统一**：
  - P1：24/28/32/36px 图标按钮家族的变体默认值与 CDS 档位没有一一对应，且调用方用 `size-4` / `size-3` 局部覆盖，形成 12/14/16 混用。P1 家族共 45 个实例，其中 33 个需要改动。
  - P2：关闭/清除类图标共 13 个，当前 9 个 16px、1 个 14px、3 个 12px；按 CDS 应统一为 XS 12px（10 个需要改动）。另有 3 个 `Button sm` 显式 16px 覆盖需要移除。
  - P3：导航次级项 14px 与主侧栏 16px、滚动按钮 12px 与 `sm` 变体 14px、空态 XL 24 档未使用、图表 tooltip 10px、36/40px 容器内 16px、重复显式 14px、光学基线暂无适用点。

## 1. 尺寸使用汇总

### 1.1 声明方式

| 声明方式 | 次数 | 说明 |
|---|---:|---|
| `size-3`（12px） | 4 | `app-shell.tsx:608`、`chat.tsx:2151`、`chat.tsx:2580`、`servers.tsx:896` |
| `size-3.5`（14px） | 30 | 见附录 A.2；集中在 `Button size="sm"`、密集状态行、折叠触发器 |
| `size-4`（16px） | 49 | 见附录 A.4；标准交互件与菜单项 |
| `size-5`（20px） | 8 | 见附录 A.3；全部位于 EmptyState 主图 / Dialog 顶图 |
| `size-6` 及以上（24px+） | 0 | 无 |
| 任意值 `size-[...]` | 0 | 无 |
| `w-*/h-*` 成对写法 | 0 | 无 |
| lucide `size={n}` prop | 0 | 全部通过 className 或继承 |
| 未声明、继承上下文 | 246 | 由 Button / Badge / 菜单项 / LucideProvider 规则决定 |

### 1.2 有效尺寸分布

有效尺寸按组件真实规则计算：图标自身 `size-*` 优先；`Badge` 的 `[&>svg]:size-3!` 强制 12；`Button` 的 `[&_svg:not([class*='size-'])]` 只在图标没有尺寸类时生效；`Button size` 变体分别给出 12/14/16；`InputGroupButton` 走基础 Button 规则；`Menu/Select/Combobox` 基础规则 16；`PageNote` 不做 svg 尺寸限制，继承 16；`EmptyState` 默认图标 20。

| CDS 档位 | 有效实例 | 占比 | 主要来源 | 代表 file:line |
|---|---:|---:|---|---|
| XS 12px | 18 | 5.3% | Badge 2、Button icon-xs 9（含 Combobox chip 移除）、Button xs 3、状态/chip 4 | `data-table.tsx:209`、`chat.tsx:2151`、`app-shell.tsx:608` |
| SM 14px | 63 | 18.7% | Button sm 32（含 render Button）、icon-sm 4、密集状态/折叠/文件树 27 | `states.tsx:79`、`servers.tsx:1302`、`knowledge-citations.tsx:702` |
| MD 16px | 248 | 73.6% | Button default/icon、菜单项、导航、Trace、PageNote、卡片头 | `app-shell.tsx:258`、`chat.tsx:1120`、`agents.tsx:1255` |
| LG 20px | 8 | 2.4% | EmptyState 主图 7、Dialog 顶图 1 | `states.tsx:113`、`channels.tsx:66`、`confirm-dialog.tsx:66` |
| XL 24px | 0 | 0% | — | — |
| 非档位 | 0 | 0% | — | — |

补充：

- 显式声明 91 个（27.0%），继承 246 个（73.0%）。`size-4` 之所以多，是因为多数图标依赖组件继承，而不是逐个写类名。
- 20px 的 7 个 `EmptyState` 主图是：`knowledge-wiki.tsx:179`、`memory-review.tsx:380`、`channel.tsx:449`、`channels.tsx:66`、`chat.tsx:251`、`runtime-environments.tsx:106`，以及 `states.tsx:113` 的默认 `Inbox`。
- 28px 的 `Button icon-sm` 是当前最大的不一致来源：26 个继承 16px、5 个显式 16px、4 个显式 14px。

## 2. 按上下文分类

| 上下文 | 实例数 | 当前尺寸 | 是否符合 CDS | 说明 |
|---|---:|---|---|---|
| 图标按钮 `Button icon`（32px） | 15 | 全部 16px | 符合 MD | `chat.tsx:1120`、`data-table.tsx:510` 等 |
| 图标按钮 `Button icon-sm`（28px） | 35 | 31×16px、4×14px | **部分不符合** | 28px 属密集操作，CDS 对应 SM 14；当前混用 |
| 图标按钮 `Button icon-xs`（24px） | 10 | 8×12px、2×16px | **部分不符合** | 2 个 `size-4` 覆盖了变体 12px |
| 图标按钮 `Button icon-lg`（36px） | 0 | — | 档位缺口 | 变体当前无 svg 规则（会落 16）；CDS LG 为 20，当前无实例 |
| 图标按钮 `InputGroupButton icon-xs`（24px） | 3（清除） | 16px | **不符合** | `input-group.tsx:74` 未设置 svg 尺寸，落基础 16 |
| 导航/侧栏 | 主侧栏 16；账户紧凑 12；频道侧栏 14；资源导航 16 | 混合 | 部分符合 | 主侧栏 `app-shell.tsx:258` 16；收起/展开账户 `:608` 12、`:623` 16；频道 `channel.tsx:608` 14 |
| 徽章/标签 | 2 | 12px | 符合 XS | `chat.tsx:1867`、`chat.tsx:3073`；Badge 的 `!` 规则保证 12 |
| 卡片头部 40px 图标 | 4 | 16px | **受保护基线** | `knowledge.tsx:148`、`plugins.tsx:245`、`servers.tsx:756`、`skills.tsx:309`；40px 容器保留，内层 16 为现状，不建议改 |
| 空态主图 | 7 | 20px | 符合 LG；XL 未使用 | 40px 圆底 + 20px 图标；CDS XL 24 当前无实例 |
| 空态动作按钮 | 5 | 14/16px | 符合 | 由 `Button sm` / `Button default` 决定 |
| 表格行内操作 | 菜单项 16；icon-sm 14/16；icon-xs 12/16 | 混合 | 部分符合 | 同一行内可能出现 12/14/16 三种 |
| 正文内联文字 | 0（真实文本流） | — | 无违例 | 所有图标+文字行均为 `Button` / `buttonVariants` / `DropdownMenuItem` / `CollapsibleTrigger` / `summary` 的 flex 容器；`.align-[-...]` 全站使用 0 次，但当前没有需要它的非 flex 文本流 |
| 按钮内 inline-start/end | `default` 63×16；`sm` 27×14、3×16；`xs` 3×12 | 混合 | 大部分符合 | `agents.tsx:4593/4603`、`servers.tsx:1924` 用 `size-4` 覆盖了 sm 的 14 |
| Dialog / Tool | 关闭 9×16、1×14、3×12；顶图 1×20；其余 16 | 混合 | 关闭不符合 XS | 详见 P2 |
| 菜单 / Select / Combobox | 44 | 全部 16px | 符合 MD | `DropdownMenuItem`、`SelectItem`、`ComboboxItem` 基础规则 |
| Trace | 5 | 全部 16px | 符合 MD | `ui/trace.tsx:48` 的 `TraceIcon` 规则 |
| 图表 | tooltip 10px；图例 12px | 动态 | 图表例外 | `chart.tsx:189`、`chart.tsx:287`；非交互图标 |
| 36px 容器（频道/来源选项） | 3 | 16px | 观察项 | `channels.tsx:123`、`skills.tsx:575`、`knowledge-detail.tsx:3871`；16 是标准 MD，非越界 |

## 3. 偏差清单

### P1（系统性，1 项，覆盖 45 个实例 / 33 个需改）

**P1-1 图标按钮变体与 CDS 档位没有一一对应，调用方用局部 `size-*` 互相覆盖。**

现状：

| 控件 | 变体定义 | 当前 svg 尺寸 | CDS 对应 | 结论 |
|---|---|---|---|---|
| `Button size="xs"` 24px | `button.tsx:28` | 12px | XS 12 | 符合 |
| `Button size="icon-xs"` 24px | `button.tsx:32-33` | 12px | XS 12 | 符合 |
| `InputGroupButton size="icon-xs"` 24px | `input-group.tsx:74` | 16px（无 svg 规则，落基础 16） | XS 12 | **不符合** |
| `Button size="sm"` 28px | `button.tsx:29` | 14px | SM 14 | 符合 |
| `Button size="icon-sm"` 28px | `button.tsx:34-35` | 16px（无 svg 规则，落基础 16） | SM 14 | **不符合** |
| `Button size="icon"` 32px | `button.tsx:31` | 16px | MD 16 | 符合 |
| `Button size="icon-lg"` 36px | `button.tsx:36` | 16px（无 svg 规则；当前 0 实例） | LG 20 | 档位缺口 |
| `Button size="lg"` 36px | `button.tsx:30` | 16px | MD 16 | 符合（文本按钮，非图标按钮） |

`button.tsx:6` 的基础规则为 `[&_svg:not([class*='size-'])]:size-4`，所以任何没有 `size-*` 类的图标在 `icon-sm` / `icon-lg` 下都会落 16px；`input-group.tsx:25` 也有同样的基础 16px 规则。

口径：P1 的 45 个实例只统计 `Button` 的图标按钮家族（`icon-sm` 35 + `icon-xs` 10 + `icon-lg` 0）；`Button size="sm"` 的 30 个实例与 `InputGroupButton icon-xs` 的 3 个清除图标分别计入 P2-2 与 P2-1，不重复计数。

具体混用证据：

| 上下文 | 实例 | 当前 | 期望 |
|---|---|---|---|
| `Button icon-sm` | `chat.tsx:1449`、`chat.tsx:1451`、`servers.tsx:1510`、`servers.tsx:1524` | 14px（显式） | 与其余 31 个 icon-sm 统一（建议 14） |
| `Button icon-sm` | `chat.tsx:2558`、`chat.tsx:2560`、`eval.tsx:582`、`eval.tsx:593` | 16px（显式） | 若采纳 SM 14 则移除 `size-4` |
| `Button icon-xs` | `data-table.tsx:195`、`data-table.tsx:510` | 16px（显式 `size-4`） | 12px（让变体生效） |
| `Button sm` | `agents.tsx:4593`、`agents.tsx:4603`、`servers.tsx:1924` | 16px（显式 `size-4`） | 14px（让变体生效） |
| `InputGroupButton icon-xs` | `search-input.tsx:49`、`conversation-search.tsx:148`、`combobox.tsx:42` | 16px（无 svg 规则） | 12px |
| `MessageScrollerButton sm` | `chat.tsx:2580` | 12px（显式 `size-3`） | 14px 或明确记录为滚动按钮例外 |

建议：

- 在 `button.tsx` 的 `icon-sm` 变体补 `[&_svg:not([class*='size-'])]:size-3.5`，在 `input-group.tsx` 的 `icon-xs` 变体补 `[&_svg:not([class*='size-'])]:size-3`；`icon-lg` 在首次出现实例时再补 `size-5`，当前不为 0 实例增加规则。
- 统一后移除 P1 表中的局部 `size-4` 覆盖：`data-table` 的 icon-xs、`agents` / `servers` 的 sm、`chat` / `eval` 的 icon-sm；`chat.tsx:1355` 的关闭 X 目标为 12px，由 P2-1 处理。
- 选择 `icon-sm = 14` 还是 `icon-sm = 16` 需要一次明确决定。建议 14：28px 高度与 `Button size="sm"` 对齐，且能和 32px `icon` 的 16px 形成档位差；若选择 16，则必须把 4 个 14px 的 icon-sm 改成 16，不能继续混用。

风险：

- `icon-sm` 涉及 35 个实例，集中在表格行、工具栏和菜单触发器；改成 14 会整体变小一圈。需要按 1492px 与 1024px 桌面视口检查密集表格行、行高和点击热区，热区尺寸不变（仍由 `size-7` 决定），只改变 glyph。
- `icon-xs` 只影响 2 个表格列设置按钮，风险低。
- `InputGroupButton icon-xs` 只影响搜索/组合框清除按钮，风险低。

### P2（2 项，16 个实例 / 13 个需改）

**P2-1 关闭/清除图标没有统一为 XS 12px（10 个需改，3 个已符合）。**

| 当前 | file:line | 控件 | 说明 |
|---|---|---|---|
| 16px | `components/dialog.tsx:63` | Dialog 默认关闭，`Button icon-sm` | 28px 按钮内 16px X |
| 16px | `components/sheet.tsx:61` | Sheet 关闭，`Button icon-sm` | 28px 按钮内 16px X |
| 16px | `components/dialog-shell.tsx:48` | DialogShell 关闭，`Button icon-sm` | 28px 按钮内 16px X |
| 16px | `components/app-shell.tsx:673` | 移动端历史 Sheet 关闭，显式 `size-4` | 28px 按钮内 16px X |
| 16px | `pages/agents.tsx:4020` | 专家版本 Sheet 关闭，`Button icon-sm` | 28px 按钮内 16px X |
| 16px | `pages/chat.tsx:1355` | 会话列表关闭，`Button icon` 32px + `size-4` | 32px 按钮内 16px X |
| 16px | `components/search-input.tsx:49` | 搜索清除，`InputGroupButton icon-xs` | 24px 按钮内 16px X |
| 16px | `components/conversation-search.tsx:148` | 会话搜索清除，`InputGroupButton icon-xs` | 24px 按钮内 16px X |
| 16px | `components/ui/combobox.tsx:42` | Combobox 清除，`InputGroupButton icon-xs` | 24px 按钮内 16px X |
| 14px | `components/memory-review.tsx:1265` | 记忆提案来源移除（24px 原生按钮） | 24px 按钮内 14px X |
| 12px | `components/ui/combobox.tsx:206` | Combobox chip 移除，`Button icon-xs` | 已符合 XS |
| 12px | `pages/chat.tsx:1878` | 引用取消，`Button icon-xs` | 已符合 XS |
| 12px | `pages/chat.tsx:1914` | 附件移除，`Button icon-xs` | 已符合 XS |

建议：所有关闭/清除 X 统一为 `size-3`（12px），保留 24/28/32px 的外层点击热区。`InputGroupButton icon-xs` 的 svg 规则修好后，`search-input` / `conversation-search` / `combobox` 三处会自动归位；`memory-review.tsx:1265` 需要单独改为 `size-3`。

风险：12px X 在 28px 按钮内会显得更小；需要看一次实际渲染的视觉平衡与焦点环，确认没有变得难以识别。点击热区不变，不影响无障碍尺寸。

**P2-2 `Button size="sm"` 的 3 个显式 16px 覆盖。**

| file:line | icon | 当前 | 期望 |
|---|---|---|---|
| `pages/agents.tsx:4593` | ChevronRight | 16px（`size-4`） | 14px（移除覆盖） |
| `pages/agents.tsx:4603` | RotateCcw | 16px（`size-4`） | 14px（移除覆盖） |
| `pages/servers.tsx:1924` | Plus | 16px（`size-4`） | 14px（移除覆盖） |

建议：删除这三处 `size-4`，让 `Button size="sm"` 的 14px 规则生效。风险低，只影响三个按钮的 glyph，不改变按钮高度。

### P3（7 项，观察 / 文档 / 清理）

**P3-1 导航与侧栏存在 12/14/16 三种尺寸，但没有明确的分层规则。**

- 主侧栏：`app-shell.tsx:258` 的 `<Icon />` 在展开态 `size-4` 包裹层内，16px；收起态外层是 32×32 图标块，glyph 仍 16px。
- 账户入口：`app-shell.tsx:608` 用 `size-3`（12px），外层是 20px 圆；收起态 `app-shell.tsx:623` 用 `size-4`（16px），外层是 32px 圆。前者与 12px 标签一致，可视为紧凑例外。
- 频道侧栏：`channel.tsx:608` 用 14px，文字是 `text-xs`；与主侧栏 16px 不同。
- 资源页类型导航：`resource-page.tsx:83` 受父级 `[&_svg...]:size-4` 约束，16px。

建议：主侧栏与资源导航保持 16px；频道侧栏是否改为 16px 需要看信息密度，若保留 14px 应在文档中注明“频道为次级密集导航”。账户 12px 是 20px 圆内的紧凑例外，建议保留并记录。风险：改频道侧栏会改变列表的视觉重量，属低风险但需目测。

**P3-2 滚动按钮 12px 与 `sm` 变体 14px 冲突。**

- `pages/chat.tsx:2580` 的 `ArrowDown` 显式 `size-3`，外层是 `MessageScrollerButton size="sm"`（28px），该变体默认给 14px。
- 建议：改为 14px；若滚动按钮刻意用更小的 XS glyph，需在 `DESIGN-SYSTEM.md` 或组件注释中记录为例外。风险：低。

**P3-3 XL 24px 档位未使用，空态主图停在 LG 20px。**

- 7 个 `EmptyState` 主图均为 20px，位于 40px `size-10` 圆底内（`states.tsx:112-113` 为默认实现；其余见 §1.2）。
- CDS 写的是“XL 24px（模态/空状态主图）”，但当前 40px 圆底是已批准布局；20px 本身是合法 LG 档，不是 ad-hoc 越界。
- 建议：本批次不改 40px 圆底和 20px 图标；在规范中明确“EmptyState 默认主图为 LG 20，XL 24 仅在 48px 以上容器或模态主图使用”。若未来要升 24，需要连同 40px 圆底一起评估，不应只改图标。风险：无（仅文档）。

**P3-4 图表 tooltip 图标 10px，低于 XS 12px。**

- `components/ui/chart.tsx:189` 的 tooltip `[&>svg]:h-2.5 w-2.5` = 10px；图例 `chart.tsx:287` 为 `h-3 w-3` = 12px。
- 这些图标由 `openui/charts.tsx` 的 `chartConfig.icon` 动态传入，属于图表子系统，不是交互图标。
- 建议：若严格对齐 XS 下限，把 tooltip 改为 12px；否则在规范中记录“图表 tooltip 10px 为数据可视化例外”。风险：低，图表密度可能略变。

**P3-5 36px / 40px 容器内的 16px 图标。**

- 40px 资源卡片头部：`knowledge.tsx:148`、`plugins.tsx:245`、`servers.tsx:756`、`skills.tsx:309`，容器 `size-10`，内层图标 16px；**受保护，不改**。
- 36px 容器：`channels.tsx:123`、`skills.tsx:575`、`knowledge-detail.tsx:3871`，容器 `size-9`，内层 16px；16 是标准 MD，不是越界。
- 建议：记录为“容器尺寸与 glyph 尺寸是两个维度”，不纳入图标尺寸批次。风险：无。

**P3-6 重复的显式 14px 声明（无视觉差异，可顺手清理）。**

- `components/run-outputs.tsx:47`、`components/states.tsx:79`、`pages/servers.tsx:1302/1324/1344`、`pages/overview.tsx:533` 已在 `Button size="sm"` 内显式写 14px，和变体默认值相同。
- 建议：只在与这些文件的其他图标改动同批时删除，不为清理单独开批。风险：无。

**P3-7 光学基线规则当前没有适用点。**

- `packages/web/src` 中 `.align-[-0.125em]` / `.align-[-0.075em]` 使用数为 **0**。
- 逐项核对后，没有发现“图标与文字同处一个非 flex 文本流”的实例：所有候选都位于 `Button`、`buttonVariants` 链接、`DropdownMenuItem`、`CollapsibleTrigger`（render Button 或自带 flex）、`summary`（`flex items-center`）或 `span/div` 的 flex 行内。`items-center` 已经完成盒对齐。
- 建议：不要把 `.align-*` 机械加到 flex 容器内的图标；仅当未来在 `<p>`、纯文本 `<a>` 或 Markdown 正文中插入图标时，按 §5 使用 `.align-[-0.125em]`（14–16px）或 `.align-[-0.075em]`（11–12px）。风险：无。

## 4. 受保护项与明确不建议修改的内容

以下内容在本审计中只记录、不建议改动：

1. **找专家页两张创建入口卡**：`pages/agents.tsx:626-645` 的扇形「新建专家」入口卡，以及 `pages/agents.tsx:647-673` 的「创建数字分身」卡（含 80px 头像与 `agents.tsx:988-1013` 的插画 SVG）。这两张卡是用户明确要求保留的创建入口。
2. **40px 资源卡片头部图标**：`knowledge.tsx:148`、`plugins.tsx:245`、`servers.tsx:756`、`skills.tsx:309`。40px 容器与内层 16px 现状保留，不因本审计改成 20/24。
3. **空态业务插画 96/64/144**：`components/business-illustration.tsx:2-4` 的 `size-24`（96）、`size-16`（64）、`size-36`（144）。它们是图片插画，不是 lucide 图标。
4. **品牌 Logo 尺寸**：登录页 96px、展开侧栏 32px、收起侧栏 32px 木工标记；`app-shell.tsx:161-175` 的 32px 品牌区保留。
5. **不换图标库、不加 duotone 双层色**：继续使用 lucide + `strokeWidth 1.75`；Phosphor 只是 CDS 参考，不引入第二套图标库。
6. **不把 Recharts / 品牌插画 SVG 的 strokeWidth 当图标违例**：`eval.tsx:202`、`openui/charts.tsx`、`agents.tsx:988-1013` 均不按 §5 处理。

## 5. 分批建议

原则：先改“一个规则源”，再清理局部覆盖，最后做纯视觉观察项；每批 1–2 个文件，单独验证。

| 批次 | 文件 | 改动 | 风险 / 验证 |
|---|---|---|---|
| B1 规则源 | `components/ui/button.tsx`、`components/ui/input-group.tsx` | `icon-sm` 28px → 14；`InputGroupButton icon-xs` 24px → 12；`icon-lg` 0 实例暂不补 | 影响 35 个 icon-sm、3 个清除按钮；检查表格行、工具栏、搜索框；按钮热区不变 |
| B2 显式覆盖 | `components/data-table.tsx`、`pages/agents.tsx` | 移除 `data-table.tsx:195/510` 的 `size-4`；移除 `agents.tsx:4593/4603` 的 `size-4`；`agents.tsx:4020` 关闭 X 改 12 | 表格列设置、专家折叠行、版本 Sheet；低风险 |
| B3 显式覆盖 | `pages/servers.tsx`、`pages/eval.tsx` | 移除 `servers.tsx:1924` 的 `size-4`；移除 `eval.tsx:582/593` 的 `size-4` | 连接器添加按钮、评估行操作；低风险 |
| B4 聊天密集区 | `pages/chat.tsx` | 移除 `2558/2560` 的 `size-4`；`2580` 的 `size-3` → 14；`1355` 的 X → 12；保留 `1878/1914` 的 12 | 对话头部、附件、滚动按钮；高流量页面，重点目测 |
| B5 关闭图标 | `components/ui/dialog.tsx`、`components/ui/sheet.tsx` | 默认关闭 X → 12 | Dialog/Sheet 视觉平衡、焦点环；热区不变 |
| B6 关闭图标 | `components/dialog-shell.tsx`、`components/app-shell.tsx` | DialogShell 关闭 X → 12；移动端历史 Sheet 关闭 X → 12 | DialogShell、窄桌面历史 Sheet |
| B7 清除图标 | `components/search-input.tsx`、`components/conversation-search.tsx` | `InputGroupButton icon-xs` 修复后自动 12；如仍需显式则统一 `size-3` | 搜索框清除、会话搜索清除 |
| B8 清除图标 | `components/ui/combobox.tsx`、`components/memory-review.tsx` | Combobox 清除自动 12；chip 移除已 12；`memory-review.tsx:1265` X → 12 | 组合框 chip 与记忆提案 chip |
| B9 P3 视觉 | `pages/channel.tsx`、`components/ui/chart.tsx` | 频道侧栏 14 → 16（或记录例外）；图表 tooltip 10 → 12（或记录例外） | 信息密度与图表 tooltip；低风险 |
| B10 文档 | `docs/DESIGN-SYSTEM.md`、`packages/web/DESIGN.md` | 写入映射表：icon-xs 12、icon-sm 14、icon 16、icon-lg 20、close 12、EmptyState 20/XL 24 缺口、图表例外、光学基线适用条件 | 无代码风险；与当前未提交文档改动合并时注意冲突 |

建议顺序：B1 → B2/B3 → B5–B8 → B4 → B9 → B10。B1 是根因，先落规则可以避免后续每批反复改回；B4 放在关闭图标之后，避免聊天页一次改动过多。

## 6. 验证方式

本审计为只读，未改源码，因此未运行 typecheck/build/test。统计与证据的验证方式：

- 用 Babel AST 解析 `packages/web/src` 全部 176 个 TS/TSX 文件，按 `lucide-react` 导入表识别直接图标实例，读取 JSX 的 `className`、`size`、`strokeWidth`、`color`、`fill`、`style` 与祖先组件链；不依赖纯 grep 计数。
- 对多行 `className` 与 `cn(...)` 表达式按源码 token 解析，再按组件规则计算有效尺寸；`Badge` 的 `!` 与 `Button` 的 `:not([class*='size-'])` 已在计算中体现。
- 抽查了本文引用的代表性 file:line 与源码一致，包括 `button.tsx:28-36`、`input-group.tsx:72-75`、`dialog.tsx:63`、`sheet.tsx:61`、`dialog-shell.tsx:48`、`app-shell.tsx:608/623/673`、`data-table.tsx:195/510`、`chat.tsx:1449/1451/2558/2560/2580`、`servers.tsx:1510/1524/1924`、`eval.tsx:582/593`、`agents.tsx:4593/4603/4020`、`chart.tsx:189/287`。
- 未做浏览器渲染测量；12px 关闭图标、14px icon-sm 等视觉平衡项需要在实施批次中用真实渲染复核。`docs/DEV-WORKFLOW.md` 要求几何/对齐类改动读实际 `getBoundingClientRect()` 或计算样式，不要只凭类名判断。

## 附录 A：显式尺寸清单

### A.1 12px 显式（4）

| file:line | icon | 上下文 |
|---|---|---|
| `components/app-shell.tsx:608` | User | 账户入口紧凑态（20px 圆 / 12px 标签） |
| `pages/chat.tsx:2151` | RefreshCw | 聊天状态 chip |
| `pages/chat.tsx:2580` | ArrowDown | MessageScrollerButton sm |
| `pages/servers.tsx:896` | LoaderCircle | 连接器测试中状态 |

### A.2 14px 显式（30）

| file:line | icon | 上下文 |
|---|---|---|
| `components/knowledge-citations.tsx:702` | ChevronDown | 详情摘要（text-xs） |
| `components/knowledge-wiki.tsx:617` | Link2 | 链接折叠触发器（text-xs） |
| `components/memory-review.tsx:1265` | X | 记忆提案来源移除 |
| `components/run-outputs.tsx:47` | FileText | Button sm |
| `components/run-question.tsx:76` | MessageCircleQuestion | 提问卡片标题（text-xs） |
| `components/run-question.tsx:181` | MessageCircleQuestion | 提问卡片标题（text-xs） |
| `components/states.tsx:79` | RefreshCw | Button sm |
| `openui/renderer.tsx:389` | CircleAlert | OpenUI 状态行 |
| `openui/renderer.tsx:399` | RefreshCw | OpenUI 重试 |
| `openui/renderer.tsx:433` | CircleCheck | OpenUI 成功状态 |
| `openui/renderer.tsx:435` | CircleAlert | OpenUI 警告状态 |
| `openui/renderer.tsx:484` | CircleAlert | OpenUI 错误状态 |
| `pages/agents.tsx:4131` | ChevronRight | 折叠触发器（text-xs） |
| `pages/agents.tsx:4826` | ChevronRight | Dialog 内折叠触发器 |
| `pages/channel.tsx:608` | Hash | 频道侧栏 |
| `pages/channel.tsx:782` | ShieldAlert | 警告行 |
| `pages/chat.tsx:1449` | LoaderCircle | Button icon-sm |
| `pages/chat.tsx:1451` | MoreHorizontal | Button icon-sm |
| `pages/chat.tsx:3255` | CircleAlert | 警告行 |
| `pages/knowledge-detail.tsx:789` | FolderOpen | 文件树 |
| `pages/knowledge-detail.tsx:791` | Folder | 文件树 |
| `pages/knowledge.tsx:865` | ChevronRight | Dialog 内折叠触发器 |
| `pages/overview.tsx:533` | Plus | PageNote 动作（Button sm 链接） |
| `pages/servers.tsx:914` | CircleCheck | 连接器状态 |
| `pages/servers.tsx:916` | CircleAlert | 连接器状态 |
| `pages/servers.tsx:1302` | RefreshCw | Button sm |
| `pages/servers.tsx:1324` | RefreshCw | Button sm |
| `pages/servers.tsx:1344` | KeyRound | Button sm |
| `pages/servers.tsx:1510` | Pencil | Button icon-sm |
| `pages/servers.tsx:1524` | Trash2 | Button icon-sm |

### A.3 20px 显式（8）

| file:line | icon | 上下文 |
|---|---|---|
| `components/confirm-dialog.tsx:66` | AlertTriangle | Dialog 顶部 40px 圆底 |
| `components/knowledge-wiki.tsx:179` | BookOpen | EmptyState 主图 |
| `components/memory-review.tsx:380` | Search | EmptyState 主图 |
| `components/states.tsx:113` | Inbox | EmptyState 默认主图 |
| `pages/channel.tsx:449` | MessageSquare | EmptyState 主图 |
| `pages/channels.tsx:66` | Hash | EmptyState 主图 |
| `pages/chat.tsx:251` | Bot | EmptyState 主图 |
| `pages/runtime-environments.tsx:106` | Box | EmptyState 主图 |

### A.4 16px 显式（49）

| file:line | icon | 上下文 |
|---|---|---|
| `components/agent-picker.tsx:97` | Bot | ComboboxTrigger |
| `components/agent-picker.tsx:117` | Bot | ComboboxTrigger |
| `components/agent-picker.tsx:137` | Bot | ComboboxItem |
| `components/app-shell.tsx:177` | PanelLeftOpen | Button default |
| `components/app-shell.tsx:202` | PanelLeftClose | Button default |
| `components/app-shell.tsx:623` | User | 账户收起态 |
| `components/app-shell.tsx:673` | X | Sheet 关闭 |
| `components/data-table.tsx:195` | GripVertical | Button icon-xs（应 12） |
| `components/data-table.tsx:510` | Columns3 | Button icon-xs（应 12） |
| `components/states.tsx:70` | CircleAlert | ErrorState |
| `components/ui/calendar.tsx:118` | ChevronLeftIcon | 日历导航 |
| `components/ui/calendar.tsx:122` | ChevronRightIcon | 日历导航 |
| `components/ui/calendar.tsx:125` | ChevronDownIcon | 日历下拉 |
| `components/ui/combobox.tsx:29` | ChevronDownIcon | ComboboxTrigger |
| `components/ui/select.tsx:50` | ChevronDown | SelectTrigger |
| `openui/components/forms.tsx:342` | CalendarDays | 日期字段 |
| `pages/agents.tsx:1255` | Trash2 | DropdownMenuItem |
| `pages/agents.tsx:2739` | Copy | DropdownMenuItem |
| `pages/agents.tsx:2744` | Download | DropdownMenuItem |
| `pages/agents.tsx:2754` | Trash2 | DropdownMenuItem |
| `pages/agents.tsx:2979` | Plug | 区块标题（flex） |
| `pages/agents.tsx:3075` | LibraryBig | 区块标题（flex） |
| `pages/agents.tsx:3167` | Sparkles | 区块标题（flex） |
| `pages/agents.tsx:3252` | Puzzle | 区块标题（flex） |
| `pages/agents.tsx:3405` | Bot | 区块标题（flex） |
| `pages/agents.tsx:3496` | FileText | 区块标题（flex） |
| `pages/agents.tsx:4593` | ChevronRight | Button sm（应 14） |
| `pages/agents.tsx:4603` | RotateCcw | Button sm（应 14） |
| `pages/chat.tsx:1120` | MoreHorizontal | Button icon（32px） |
| `pages/chat.tsx:1355` | X | Button icon（32px） |
| `pages/chat.tsx:1403` | Search | Button default |
| `pages/chat.tsx:2558` | LoaderCircle | Button icon-sm（若 icon-sm=14 则应移除） |
| `pages/chat.tsx:2560` | GitBranch | Button icon-sm（若 icon-sm=14 则应移除） |
| `pages/chat.tsx:3289` | ListChecks | 任务清单标题 |
| `pages/chat.tsx:3312` | CircleCheck | 任务清单行 |
| `pages/chat.tsx:3314` | LoaderCircle | 任务清单行 |
| `pages/chat.tsx:3319` | Circle | 任务清单行 |
| `pages/eval.tsx:582` | Pencil | Button icon-sm（若 icon-sm=14 则应移除） |
| `pages/eval.tsx:593` | Trash2 | Button icon-sm（若 icon-sm=14 则应移除） |
| `pages/ops.tsx:1172` | ShieldAlert | 运维警告行 |
| `pages/ops.tsx:1194` | CircleAlert | 运维错误行 |
| `pages/overview.tsx:528` | Bot | PageNote 图标 |
| `pages/personal-usage.tsx:436` | Activity | PageNote 图标 |
| `pages/run-detail.tsx:308` | CircleAlert | 运行错误行 |
| `pages/run-detail.tsx:336` | CircleAlert | 运行警告行 |
| `pages/runtime-environment-detail.tsx:268` | Trash2 | DropdownMenuItem |
| `pages/runtime-environment-detail.tsx:348` | Hammer | PageNote 图标 |
| `pages/servers.tsx:1924` | Plus | Button sm（应 14） |
| `pages/status.tsx:245` | LoaderCircle | 检查中状态行 |

## 附录 B：动态图标渲染点（13 处，不含图表配置）

| file:line | 渲染方式 | 当前有效尺寸 | 说明 |
|---|---|---|---|
| `components/app-shell.tsx:258` | `<Icon />`（`item.icon` / `bottomEntry.icon`） | 16px | 主导航与底部入口 |
| `components/resource-page.tsx:83` | `<Icon />`（`visibleSections[].icon`） | 16px | 资源类型导航，父级 `[&_svg...]:size-4` |
| `pages/chat.tsx:1743` | `<Icon />`（`welcomeSuggestions[].icon`） | 14px | 位于 `Button size="sm"` 内 |
| `components/view-toggle.tsx:61` | `<option.icon />` | 16px | `ToggleGroupItem` 高 28px，未改 Toggle 的 sm 变体 |
| `openui/components/layout.tsx:64` | `<Icon />`（`resolveIcon`） | 16px | OpenUI Icon 渲染器 |
| `pages/runtime-environment-detail.tsx:85` | `<Icon className={...} />` | 14px | 构建状态标签 |
| `pages/run-detail.tsx:432` | `<Icon />`（`stepIcons[step.kind]`） | 16px | 步骤列表，位于 Button 内 |
| `pages/overview.tsx:565` | `<Icon className="size-4" />` | 16px | 统计卡片 |
| `pages/status.tsx:50` | `<Icon className="size-3" />` | 12px | 状态徽章 |
| `pages/status.tsx:73` | `<Icon className="mt-0.5 size-4" />` | 16px | 状态提示行 |
| `pages/servers.tsx:756` | `<ServerIcon />` | 16px | 40px 卡片头部（受保护） |
| `pages/knowledge-detail.tsx:3872` | `<OptionIcon className="size-4" />` | 16px | 36px 来源类型图标块 |
| `openui/components/charts.tsx:213/757/929` | `chartConfig.icon` → `chart.tsx` | tooltip 10px / 图例 12px | 图表数据系列图标，走图表子系统 |

另外，`components/copy-button.tsx:54/62` 的 `Button size={showLabel ? 'sm' : 'icon-sm'}` 与 `components/ui/carousel.tsx:197/227` 的 `Button size={size}` 是运行时条件尺寸，按默认 `icon-sm` 计 16px、按 `sm` 计 14px；本次不将其归入固定偏差。

## 附录 C：统计口径与限制

- **直接实例**：JSX 中直接使用从 `lucide-react` 导入的图标组件；不含 `chartConfig.icon`、`option.icon`、`item.icon` 等数据驱动渲染点，后者单列附录 B。
- **动态图标**：按渲染点的 className 或所在组件规则估算；运行时条件尺寸（copy-button、carousel）给区间，不强行归一。
- **自定义 SVG**：`pages/agents.tsx:988-1013` 的插画、`openui/charts.tsx` 的 series mark、品牌 Logo、业务插画、头像图片均不计入 lucide 图标统计。
- **有效尺寸**：按当前组件的 CSS 规则与优先级计算，而不是只数源文件里的 `size-*`；`Badge` 的 `!`、`Button` 的 `:not([class*='size-'])`、`InputGroupButton` 的基础 16px 都已计入。
- **未做渲染测量**：本阶段没有启动浏览器；12px 关闭图标、14px icon-sm 等视觉平衡项需要在实施批次中按 `docs/DEV-WORKFLOW.md` 读实际几何或截图复核。
- **规范冲突**：任务背景称 §5 未定义 20/24 与光学基线，当前工作区文档已定义；本审计以当前文档为准。若这两份文档的未提交改动被回退，需要重新核对 §5 后再执行批次 B10。
