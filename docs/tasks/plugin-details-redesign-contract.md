# 插件详情最终共享契约

本文件只保留当前有效接口。旧「概览 / 能力 / 完整文件」三视图、主页面目录树版、介绍页 + 宽幅 Sheet 检查器版均已作废，不保留 `view` / `type` / 抽屉兼容分支。

## 边界

- 只读展示，复用 `GET /api/plugins/:id` 返回的 `plugin.files`；不新增接口、不改 DB/API/运行时权限、不改原生插件安装（任务 33/34）。
- 不执行文件内容，不把 Markdown 当 HTML 注入；可执行文件只读，HTML 显示为文本。安全外链仍可由用户打开，插件内链接只能定位真实文件；不提供编辑、绑定、安装操作。
- 目录树与正文只展示真实文件，不另建能力索引；能力判断以真实存在的文件路径为准。

## 主页面

- 紧凑身份头：名称、版本、简介，操作为「导出」；页面恰好一个 `h1`。
- 身份头下是 shadcn Tabs 的两个页内页签：「简介」「内容」；不使用 Sheet、抽屉或弹层。
- Tabs 使用原生关联（`aria-controls` / `aria-labelledby`）与键盘导航；非活动面板保持挂载但 `hidden` 且不可聚焦，切回时保留各自阅读滚动位置。

## 简介

- 只展示根 README；不展示能力索引、来源或能力入口。
- 无 README 时给简洁空态并指向「内容」页签，不编写介绍、不拿首个技能冒充插件说明。
- README 内真实文件链接切到内容页签并定位文件（阅读模式）。

## 内容

- 页内完整真实目录树 + 当前文件正文；桌面左右可拖动分栏，窄屏目录在正文上方同页折叠，全部在页签内完成。
- 默认文件：无选择时 README → 技能目录内 `SKILL.md` → 首个真实文件。
- 目录树：真实文件/目录名，目录优先、可折叠；只有当前文件铺选中底色；统一箭头槽位与分支线；选中文件自动展开祖先；技能目录内 `SKILL.md` 排在首位；全部真实文件（manifest、hooks、MCP、支持文件、空文件）可达。
- 正文：实际路径 breadcrumb；Markdown 默认阅读、可切源码，其余文件直接源码；空文件、bad frontmatter、加载/404/错误均有明确状态。
- 桌面阅读区补 24px 内边距，路径工具栏与模式切换同一行，工具栏到正文 16px；窄屏按现有间距 token 收紧，分隔线与正文不再 0px 贴合。
- 正文内真实文件链接与 README 文件链接切到对应文件并回到阅读模式；显式选择新文件同样回阅读模式。

## URL 与选择

- search 为 `{ tab?: 'intro' | 'content', file?: string, mode?: 'read' | 'source' }`，默认 `tab=intro` 且无 `file`；不保留旧「有 `file` 即打开抽屉」的兼容语义。
- 页签切换、文件选择与模式写浏览器历史，刷新和前后退可恢复。
- 切到简介保留 `file` / `mode`，切回内容恢复上次选择与滚动位置。
- `file` 不属于真实文件时显示说明并回退，不通过 effect 回写 URL；非 Markdown 忽略 `mode`。

## 复用

- 树与文档复用 `plugin-file-tree`、`plugin-document`；分栏用现有 `react-resizable-panels`；不保留能力索引组件。
- `@agentport/core/plugin-display` 的 `readPluginMarkdown`（browser-safe）；`Markdown` 的 `staticContent`、`CodeBlock`、`Tabs`、`Breadcrumb`、`Button`；颜色与间距只用现有 token。
