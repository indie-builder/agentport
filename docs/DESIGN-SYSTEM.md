# PACE 设计系统

> 产品名 **PACE**。视觉与交互参考 **LangSmith**（智能体观测平台）的信息架构。
> 本文件是前端实现的唯一视觉依据。组件复用 shadcn/ui 的结构与命名，样式由 Tailwind CSS 4 承载。

---

## 1. 品牌

**PACE** — 取自「节奏」。核心价值是让多个智能体以可预测的节奏运行：接入 → 编排 → 执行 → 观测。

- 标识：文字标 `PACE`，全大写，字距 +0.14em；图形标为四段等距竖条（节奏）。
- 语气：克制、精确、可信任。无感叹号，无营销话术。
- 界面语言中文；技术标识（ID、工具名、事件名）保留英文并用等宽字体。

## 2. 参考实现

参考 LangSmith 的智能体观测页，取其**信息架构**而非像素：

- 左侧窄图标栏 + 可展开的二级导航。
- 页面顶部为大标题 + 一行说明，下方是过滤条与视图切换。
- 主体是**高密度表格**，列可显示/隐藏（列可见性模型持久化）。
- 智能体以行呈现，聚合指标并列：最近运行时间、运行次数、成本、错误率、P50/P99 延迟、token 总数。
- 数字列右对齐、等宽、可排序；状态用低饱和标签。
- 详情通过行内展开或右侧抽屉，不跳页。

## 3. 色彩（浅色唯一主题）

2026-10-20 起只保留浅色。理由：这是一台在工作站上整天开着的运维界面，与编辑器、
文档、终端处在同一片环境光下；浅色降低长时间阅读的对比疲劳，也让等宽数据接近纸面报表。

三色族：**暖纸**（纸面层级）、**墨**（文本）、**深青**（主色）。

| Token | 值 | 用途 |
|---|---|---|
| `--color-canvas` | `#F3F0E9` | 页面底 |
| `--color-panel` | `#EFEBE3` | 侧栏、页头、表头 |
| `--color-surface` | `#FFFDF8` | 卡片、面板、输入框 |
| `--color-sunken` | `#EBE6DC` | 悬停行、下沉块、代码底之外的浅槽 |
| `--color-line` | `#DDD6C9` | 常规分隔线 |
| `--color-line-strong` | `#C3BBAB` | 交互边界、悬停描边 |
| `--color-fg` | `#1C1A16` | 主文本 |
| `--color-muted` | `#575147` | 次要文本 |
| `--color-subtle` | `#7A7265` | 占位、表头、辅助 |
| `--color-accent` | `#1C5F66` | 主操作、当前选中 |
| `--color-accent-hover` | `#154C52` | 悬停 |
| `--color-accent-soft` | `#DFEEED` | 选中背景、选区 |
| `--color-accent-line` | `#A9CDCB` | 选中描边、焦点外环 |
| `--color-success` | `#2A6A45` | 成功 |
| `--color-success-soft` / `-line` | `#E3F0E8` / `#B3D5C1` | 成功底色与描边 |
| `--color-warning` | `#855200` | 运行中、警告 |
| `--color-warning-soft` / `-line` | `#F9EDD7` / `#E6C894` | 警告底色与描边 |
| `--color-danger` | `#A3312A` | 失败、删除 |
| `--color-danger-soft` / `-line` | `#FAE7E4` / `#E8BAB4` | 失败底色与描边 |
| `--color-code` | `#F0ECE3` | 代码块底 |
| `--color-scrim` | `rgb(28 26 22 / .36)` | 弹层遮罩（暖墨，不是纯黑） |

规则：

1. **状态色必须成组使用**：`soft` 做底、`line` 做边、实色做文字。不要用 `bg-danger/5` 这类透明度近似。
2. **主色只做交互标记**，不做装饰；大面积使用只允许在选中行与主按钮。
3. **阴影只有三档**：`shadow-panel`（卡片）、`shadow-raised`（登录表单）、`shadow-overlay`（弹层）。禁止 `shadow-2xl`、`shadow-black/*`。
4. **代码高亮**用深色文本色（`#1F4FA8` / `#1F6B47` / `#8A5A00` / `#6B3FA0`），不用 Tailwind 的 `*-300` 系列——那是深色底的值。

## 4. 字体与排版

- 正文：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
- 等宽：`"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`

| 层级 | 字号 / 行高 | 字重 | 用途 |
|---|---|---|---|
| 页面标题 | 22 / 30 | 600 | 每页唯一 |
| 区块标题 | 15 / 22 | 600 | 卡片或分区 |
| 表格正文 | 13 / 20 | 400 | 数据行 |
| 表头 | 11 / 16 | 500 | 大写、+0.06em 字距、subtle 色 |
| 正文 | 14 / 22 | 400 | 说明、表单 |
| 辅助 | 12.5 / 18 | 400 | 提示、时间戳 |
| 代码 / ID | 12.5 / 20 | 400 | 等宽 |

间距基数 4px。页面内边距 32px（窄屏 16px）。内容最大宽 1440（比 LangSmith 略窄，避免超宽屏表格散架）。

## 5. 组件来源（强制）

**组件库是 shadcn/ui，不是自建样式表。**

- `packages/web/components.json` 声明 shadcn 配置（new-york、stone、`src/components/ui`）。
- 基础组件来自 shadcn/ui，交互原语是 **Radix**（`radix-ui` 单包，v1.8.1）：
  `Dialog`、`Tabs`、`Select`、`Popover`（MultiSelect 用）。
- 其余基础件（Button / Badge / Input / Textarea / Label / Card / Table / Skeleton）
  沿用 shadcn 的 API 形状与 cva 变体，但样式由本项目令牌驱动。

**为什么之前不是**：早期为了少装依赖，手写了 Dialog/Tabs/Select。代价是焦点陷阱、
aria 关联、portal 裁剪、空值处理都要自己维护，且已经出现过浮层被卡片裁切的问题。
现在的规则是：**能用 Radix 的交互原语，就不自己实现。**

新增组件的流程：

```bash
pnpm dlx shadcn@latest add <component>   # 生成到 src/components/ui
```

生成后把颜色类换成本项目令牌（`bg-surface` / `text-fg` …），不要保留 shadcn 的
`bg-background` / `text-foreground` 命名——那套变量本项目没有定义。

## 6. 页面骨架与间距

页面**不自行拼间距**，统一用 `components/page.tsx`：

| 组件 | 用途 | 间距 |
|---|---|---|
| `Page` | 页面根容器 | 子项之间 20px |
| `PageHeader` | 唯一 h1 + 说明 + 主操作 | 标题下 4px |
| `PageToolbar` | 筛选、搜索、批量操作 | 子项 8px |
| `PageSection` | 区块（标题 + 内容） | 标题与内容 12px |
| `SectionHeader` | 兼容旧调用的小标题 | — |

规则：

1. **一个页面只有一个 h1**（`PageHeader`）。
2. 页面里禁止出现 `mb-3` / `mb-5` / `mt-8` 这类页面级外边距——它们属于骨架。
3. 卡片内部统一 `Card` + `CardContent`（`p-4`）；不要再传 `className="p-5"` 覆盖。
4. 表格与卡片之间的间距由 `Page` 的 gap 提供，不在表格上加 margin。

## 7. 布局

```
┌──────┬────────────────────────────────────────────────┐
│ 图标  │ 顶栏 52（面包屑 / 列设置 / 用户）                │
│ 56   ├────────────────────────────────────────────────┤
│      │ 页面头：标题 22 + 说明                           │
│      │ 工具条：搜索 · 筛选 · 视图切换 · 主行动           │
│      │ 内容：表格 / 卡片 / 表单，最大宽 1440            │
└──────┴────────────────────────────────────────────────┘
```

- 主侧栏为 **56px 图标栏**（实现为 `w-14` 的窄栏，可收起到同一宽度），可展开为 224px（`w-56`）；展开用 flex 布局挤压内容，不是浮层。
- 窄屏（< 1024px）隐藏侧栏，改为顶部菜单按钮打开的抽屉；表格横向滚动。
- 页头、工具条、内容区的左右内边距对齐。

## 8. 核心页面

| 页面 | 内容 |
|---|---|
| 概览 | 四个统计卡（servers / agents / runs / running）+ 最近运行表 |
| MCP Servers | 行 = server；列：名称、类型、工具数、最近测试、状态；行内展开工具列表 |
| 智能体 | **行 = 智能体**；列：名称、最近运行、运行次数、成本、错误率、P50、P99、tokens、创建时间、ID；列可见性；行内展开配置摘要与文件预览 |
| 对话 | 左：会话列表（按 agent 过滤）；右：消息流 + 工具调用卡片 + 输入区 |
| 审计 | 行 = 事件；列：时间、动作、目标、状态、耗时、请求 ID |

## 9. 交互规则

| 场景 | 规则 |
|---|---|
| 异步操作 | 按钮 pending（禁用 + spinner），完成 toast |
| 表格 | 列头可排序；列可见性可切换并持久化到 localStorage；空态给主行动 |
| 行详情 | 展开行或右侧抽屉；切换时保留滚动位置 |
| 表单 | 失焦校验；提交时定位第一个错误；未保存离开时提示 |
| 删除 | Dialog 二次确认，确认按钮 danger |
| 流式 | 文本逐字追加；工具调用为可折叠卡片（参数 / 结果，JSON 高亮）；运行中 warning 色 |
| 滚动 | 对话到底自动跟随；用户上滚后暂停并显示「回到底部」 |
| 键盘 | Esc 关浮层；Enter 提交；Tab 顺序符合视觉顺序；表格行可 Enter 展开 |
| 动效 | ≤ 200ms；`prefers-reduced-motion` 下关闭位移与淡入 |

## 10. 代码组织

```
packages/web/src/
├─ styles.css            # @theme 令牌（唯一允许出现十六进制的地方）
├─ components/ui/        # shadcn 结构组件
├─ components/           # 业务公共组件（shell、states、code-block、data-table）
├─ pages/                # 路由页面
├─ lib/                  # api、queries、format、cn
└─ App.tsx
```

组件只通过语义 token 取色。新增颜色必须先加到 `styles.css` 的 `@theme` 并同步本文件。
