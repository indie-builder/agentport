# 修复收起侧栏的菜单悬停

## 目标
收起侧栏时仅鼠标指向的菜单图标显示 hover 背景，其他未选中项透明；当前页面选中态、文字提示、展开与移动导航正常。

## 方案
沿用现有 SidebarLink 与 Tailwind 状态变体，将菜单图标的 hover 作用域从整个侧栏缩到单个链接。先经 Opus 确认最小修复，再由 Sonnet 实现。

## 基线与范围
- worktree 起点：fd23879f0ba1680b3b8bd5db3b442b0f58ab7e5a（远端默认分支；包含资源中心新增功能，与正在运行的预览一致）。
- 本地 main：797edfeaabd39b040d01736c49273da18347ea92；不是本次起点，不回退远端已有功能。
- 初始工作区干净，无其他未提交差异。
- 允许改动：packages/web/src/components/app-shell.tsx、本记录。按需增加真实浏览器回归验证，不增加无法执行 CSS hover 的 jsdom 类名断言。
- 不改业务、路由、依赖、全局 tooltip 和样式令牌。

## 当前有效决定
用户报告菜单收起后 hover 显示问题，按 bug 修复范围执行；用户已明确授权本次 commit、push、创建 PR 并 merge，交付包含全部四步。不触发或等待 CI，不删除分支与 worktree。

## 已替代项及原因
无。

## 步骤
- [x] 阅读研发流程、踩坑和设计规范。
- [x] 真实浏览器复现，并执行失败断言。
- [x] Opus 确认最小修改，Sonnet 实现。
- [x] 浏览器回归、前端类型检查与关联测试。
- [x] Opus 独立 review，通过，无 findings。

## 改动文件
- packages/web/src/components/app-shell.tsx
- docs/tasks/fix-collapsed-menu-hover.md

## 下一步
按用户授权提交这两个文件、推送当前分支、创建 PR 并 merge；合并结果以 PR 实际状态为准。不删除分支与 worktree。

## 验证
- 复现地址：https://worktree-project-motion-opportunities.agentport.localhost/
- 浏览器收起菜单并 hover「对话」，断言未 hover 且非 aria-current=page 的图标背景应透明。
- 修复前断言失败：运行、定时任务、资源中心、评估、健康、审计 6 项均为 rgba(15, 15, 15, 0.043)。实际只有「对话」matches(':hover')。
- 浏览器 taskSpace 69，仅操作本次创建的 p1；未改其他工作区文件。
- 已执行 pnpm install --frozen-lockfile 成功。
- 修复仅一行：图标的非 active 背景条件 group-hover/nav:bg-hover → hover:bg-hover；保留品牌的侧栏 hover。
- 本次修复预览：https://worktree-fix-collapsed-menu-hover.agentport.localhost/，前端进程后台运行，复用原 API；真实登录成功。
- 同样的浏览器断言在该预览修复前 FAIL（6 项错误背景），修复后 PASS：unexpectedHighlights=[]；对话项有 hover 背景，工作台 selected 保持 rgb(235,235,235)。
- 浏览器切换「运行→审计」后 tooltip 文案分别正确，旧项背景消失；最终高亮项仅工作台与审计。移到侧栏空白后仅 selected 项有背景。
- Tooltip 验证使用实际 data-slot=tooltip-content；role=tooltip 不存在，初始定位器等待超时，改用实际组件槽位后通过。
- 浏览器键盘 Tab 聚焦「定时任务」，focus-visible=true；展开宽度 272px、整行 hover 正常；390×844 下移动抽屉打开，有8个导航项，关闭正常。
- pnpm --filter './packages/web' typecheck：通过。
- pnpm test:web packages/web/test/shell-route.test.ts：1 文件、8 测试通过。
- pnpm exec biome check packages/web/src/components/app-shell.tsx：RTK 初次压缩结果显示 1 error 且无法诊断；rtk bypass 原命令返回 Checked 1 file, No fixes applied，退出 0。
- /usr/bin/git diff --check：通过。
- Opus 独立 review：通过，无 findings。
- 未跑全量 E2E/全量测试；该改动只有一个 CSS 状态类，真实 CSS hover 已用浏览器断言覆盖，jsdom 无法验证 CSS 命中，不新增类名快照测试。
- 参考 docs/PITFALLS.md：新 worktree 依赖需安装；基础设施复用，不启动第二套 compose；本地默认域名未注册，实际运行域名如上。
