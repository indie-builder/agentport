# 插件详情与真实文件查看

## 目标

从插件名称进入只读详情，让管理员看清插件真实能力与文件内容，再决定是否绑定到专家。只读；不扩展到内容编辑、安装机制或运行权限。

## 当前有效方案：页内「简介 / 内容」Tabs（用户最新确认）

- 移除全部 Sheet/抽屉与弹层；紧凑身份头下用 shadcn Tabs 切换简介与内容，页面恰好一个 `h1`。
- 简介只展示根 README，不展示能力索引、来源或能力入口；无 README 时给简洁空态并指向「内容」页签，不编写介绍、不拿首个技能冒充说明。
- 内容：页内真实目录树 + 当前正文；桌面左右可拖动分栏，窄屏同一页内折叠目录；默认文件 README → 技能 `SKILL.md` → 首个真实文件，阅读/源码与可执行位保留。
- URL `{tab?:'intro'|'content',file?:string,mode?:'read'|'source'}`，默认 `intro` 且无 `file`；不保留旧「有 file 即打开抽屉」的兼容语义。切简介保留 `file`/`mode`，切回内容恢复上次选择与滚动位置；显式选新文件回阅读模式。
- README 内真实文件链接直接切内容页签并定位文件（阅读模式）。
- 页签使用原生关联与键盘导航；非活动面板不可聚焦但保持挂载，切回保留各自阅读滚动位置。
- 不新增 API/DB/运行时能力，不提供编辑、绑定或安装操作。

## 当前 UI 审计修正（用户最新要求）

- 简介移除右侧全部能力索引与来源，只保留实际 README；无 README 时用简洁空态及内容页签入口。
- 实测内容分隔线 x=526.99、正文 x=526.99，正文与分隔线间距为 0px；页签底到路径只有 8px。桌面补 24px 阅读内边距，路径工具栏与模式切换同一行，工具栏到正文 16px；窄屏按现有间距 token 收紧，建立路径工具栏、标题/描述、正文的层级。
- 移除索引后删除确认无其他用途的 `lib/plugin-entries`、`components/plugin-entry-list`、`components/ui/item` 及对应测试，不保留死代码；保留全部真实文件、URL/阅读状态与页签行为。
- 本轮验证：前端 40 文件 388 项通过（详情 25 项），全包 typecheck、web build、Biome 与焦点/项目规约、diff check 通过；桌面/窄屏实测完成，独立 Opus 复核 Approve。

## 已替代方案

- 介绍页 + 宽幅 Sheet 检查器（已作废）：主页面为身份头与「浏览文件/导出」，README 为主阅读区、右侧较窄能力索引；点击条目、README 链接或「浏览文件」打开 Sheet，窄屏在 Sheet 内折叠目录。
- 主页面目录树版（已作废）：真实目录树直接占满主页面，桌面左树右正文，窄屏用 Sheet 打开同一棵树。
- 「概览 / 能力 / 完整文件」三视图（已作废）：不保留 `view` / `type` 兼容分支。

## 范围与基线

- 基线 HEAD `915c4b6`，分支 `worktree-plugin-details`；全部差异仅在 worktree。用户于 2026-10-26 明确授权提交 PR 并合并，提交前已重新获取 origin/main，基线未变化。不改安装（任务 33/34）、API/DB/worker、运行时注入与授权。
- 允许改动：插件详情前端、`Markdown` 静态选项、core 展示解析子路径、相关文档与测试；最终布局已验证，并经独立 Opus 复核通过。

## 步骤

- [x] 明确共享契约（含两轮方案替代，第三版改为页内 Tabs）
- [x] core 展示解析、前端查询与路由状态、Markdown 静态阅读
- [x] 旧目录树版与抽屉版的组件、页面、测试、验证与 Opus 评审
- [x] 页内 Tabs 改版（简介 / 内容、移除全部抽屉）
- [x] 删除索引前的验证与 Opus 评审（历史；不代表删除索引后状态）
- [x] 简介移除能力索引与来源，删除无引用辅助文件，补齐内容区内边距并重新验证；独立 Opus 复核 Approve

## 改动文件

- 新增：`packages/core/src/plugin-display.ts`、`packages/web/src/components/plugin-file-tree.tsx`、`plugin-document.tsx`、`ui/breadcrumb.tsx`、`pages/plugin-detail.tsx`、`routes/_shell/plugins.index.tsx`、`plugins.$pluginId.tsx` 及对应测试。
- 修改：`packages/core/package.json`、`components/markdown.tsx`、`app-shell.tsx`、`plugins.tsx`、`api.ts`、`queries.ts`、`routeTree.gen.ts`、`routes/-search.ts`、相关既有测试；Tabs 改版另需 `pages/plugin-detail.tsx`、`routes/-search.ts` 与对应测试。
- 文档：本文件、`plugin-details-redesign-contract.md`、`docs/ARCHITECTURE.md`、`docs/USER-STORIES.md`；验证 JSON 由主会话最后更新。

## 验证

- 删除索引前的历史结果：页内 Tabs 版 `pnpm test:web` 41 文件 408 项通过，typecheck、build、Biome 与浏览器交互通过；这些结果不代表删除索引后的当前状态。
- 本轮通过：前端 40 文件 388 项（详情 25 项）、全包 typecheck、web build、Biome、焦点/项目规约与 diff check；独立 Opus 审计修正复核 Approve。
- 桌面最终实测阅读 inset 24px、页签到面板 16px，路径与模式同排，主滚动容器无额外溢出。320px 内容无横向溢出、单一 h1；目录选择后焦点回文件按钮；750×420 短屏阅读滚动73px往返保留，RTL 无横向溢出。
- 截图已检查：`/tmp/plugin-ui-audit-final-desktop.png`、`plugin-ui-audit-intro-after.png`、`plugin-ui-audit-mobile-stable.png`。未实测真实200%浏览器缩放或完整本地化压力；普通不可执行文件工具栏仍有一个无内容的操作容器（非阻断，右侧最多留12px）。
- 2026-10-26 提交前复验：前端 40 文件 388 项、全包 typecheck、web build、23 个实现/测试文件 Biome、焦点/项目规约通过；按用户授权创建 PR 并合并。不触发 CI，不开启 PR 监控；`.vitest/json/output.json` 排除在提交之外。
- 本轮不跑后端全集或执行插件。预览继续在本 worktree 的 3316，使用独立库。
