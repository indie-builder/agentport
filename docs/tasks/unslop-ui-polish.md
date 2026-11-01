# 全项目 unslop 打磨（轻度）

## 目标
用 unslop 技能对 PACE Web 全站做一次诊断与打磨：保留现有 Qoder 浅色体系、Inter 字体、木工品牌与布局契约，只修正审计确认的偏差；不重做视觉、不换栈、不改业务行为。

## 方向（沿用既有品牌，polish mode）
- **Product.** 面向个人/团队的本地智能体平台：用文件系统定义专家，在沙盒里运行并按运行记录回溯。
- **Character.** 沉稳、精确、带一点手作温度。
- **World.** 木工工作台：木材、工具、贴标与工牌；现有木工小狗品牌与插画就是这个世界。
- **Moments.** 运行详情的 trace、专家工牌、趋势图——数据与身份是主要“亮点”，chrome 保持安静。
- **Signature.** 木工小狗 + 工牌/工具意象，只出现在品牌与空态，不铺到每个卡片。

## 基线与范围
- worktree：`<主 checkout>/.claude/worktrees/unslop-ui-polish`，分支 `worktree-unslop-ui-polish`
- 起点：`1cd1205`（`origin/main`），初始 `git status --porcelain` 为空
- 允许改动：`packages/web/src/**` 与 `docs/tasks/unslop-ui-polish.md`
- 不改：`docs/DESIGN-SYSTEM.md` 已规定的固定值（专家卡 208px、列表行高 56–64、字号阶梯等）、依赖、后端

## 审计结论
轻度 slop。无紫色渐变、发光、emoji、渐变文字、`transition-all`、硬编码颜色等典型迹象。问题集中在表格列宽/空列、重复状态表达、数字与时间格式、空态文案、危险操作密度。

## 当前有效决定
- 用户 2026-11-01：「对整个项目做一下」——按 polish mode 执行，保留现有视觉方向。
- 用户 2026-11-01：表格类页面按业务需要支持「表格 / 卡片」切换，多种呈现方式。
- 冲突时以 `docs/DESIGN-SYSTEM.md` 与 `packages/web/CLAUDE.md` 为准，unslop 通用规则不得覆盖项目既定数值。

## 卡片视图范围（2026-11-01 新增）
- 支持：运行、定时任务、运行环境、账户、我的分享、使用记录。
- 保持表格：审计（日志密度高，卡片降低扫描效率）、角色（权限矩阵不是列表）。
- 契约：`view=table|cards` 进 URL；默认 table；共享 `ViewToggle`；卡片保留表格里的全部信息与操作，不删字段。

## 已替代项及原因
无。

## 步骤
- [x] 运行页：错误列截断 + 列宽收敛
- [x] 定时任务 / 审计 / 运行环境：表格按内容收窄，去重复徽章
- [x] 连接器：标题用名称、slug 作次信息；合并重复试连状态
- [x] 技能：分段控件选中态按 §2.3 核对（计算样式已符合）
- [x] 个人资料：身份分组合并
- [x] 使用记录：状态网格列宽、计数与小数格式
- [x] 账户：行内危险操作收敛
- [x] 角色：表头图标可访问名、「已保存」去重
- [x] 健康：相邻分隔线/空分区
- [x] 评估：栏距与规则长句
- [x] 真实渲染核验 + typecheck/build
- [x] 个人模块移除 1024 上限、使用汇总对齐、记忆提案摘要 75ch 上限
- [x] 表格 / 卡片视图切换：运行、定时任务、运行环境、账户、我的分享、使用记录
- [x] 表格 / 卡片视图切换：记忆提案、账号安全（阶段筛选参数改为 `stage`）
- [x] 列设置入口从独立一行并入表头行右侧 32px 操作列
- [ ] 空态文案：本轮未处理（保持现状，不据此认定合规）。多数空态已有下一步动作，但「还没有…」标题与 DESIGN-SYSTEM §10 对复述式空态的要求仍有出入，留作后续单独评估。

## 改动文件
- `packages/web/src/pages/accounts.tsx`：行内只留「编辑」，重置密码/停用启用/分配角色/删除认证收进「更多」菜单。
- `packages/web/src/pages/personal-profile.tsx`：姓名/用户名/角色合并为「身份」组。
- `packages/web/src/pages/personal-usage.tsx`：状态 6 列对齐 + `tabular-nums`；`15 次中 N 次已记录`；Token 用精确整数千分位。
- `packages/web/src/pages/runs.tsx`：错误列单行省略 + `title`。
- `packages/web/src/pages/ops.tsx`（SchedulesPage）：改用共享 Table 组件、满宽，列宽 34/16/18/16/16%，操作列右对齐；保留停用「未安排」与窄窗口合并列。
- `packages/web/src/pages/audit.tsx`：目标/耗时列收窄，请求 ID 吸收余宽。
- `packages/web/src/pages/runtime-environments.tsx`：改回满宽 Table，列宽 50/25/25%，更新时间右对齐；默认徽章去重。
- `packages/web/src/pages/servers.tsx`：标题用目录可读名、slug 作次信息；试连状态只留一处。
- `packages/web/src/pages/skills.tsx`：分段控件按 §2.3 补 1px `line` 边线。
- `packages/web/src/pages/roles.tsx`：表头齿轮补 `title`；去掉常驻「已保存」。
- `packages/web/src/pages/status.tsx`：去掉多余分区分隔线。
- `packages/web/src/pages/eval.tsx`：两栏间距 20→24；判定规则拆两行。
- `packages/web/src/components/view-toggle.tsx`：共享表格/卡片切换（ToggleGroup）。
- `packages/web/src/components/data-table.tsx`：列设置入口并入表头右侧 32px 操作列，上方只留弱化行数；`template`/`colSpan`/`minWidth` 同步。
- `packages/web/src/routes/-search.ts` 与 `_shell/{accounts,schedules}.tsx`：`view=table|cards` 进 URL 的契约。
- `packages/web/src/pages/{runs,ops,runtime-environments,accounts,personal-shares,personal-usage}.tsx`：卡片视图，等量呈现表格字段与操作。
- `packages/web/src/pages/{personal-memory,personal-security}.tsx` 与 `components/memory-review.tsx`：记忆提案 / 账号安全卡片视图；阶段筛选参数改名 `stage`。
- `packages/web/src/routes/_shell/personal.tsx`：移除个人模块 1024px 上限。
- `packages/web/src/components/memory-review.tsx`：提案摘要 75ch 上限。
- `packages/web/test/{personal-module,account-rbac,accounts-ui-hardening,server-readonly-audit,resource-navigation,servers-test-identity}.test.ts`：同步文案与菜单操作路径。
- `packages/web/test/{runs-view-toggle,runtime-environments,personal-module,schedule-timezone}.test.ts`：视图切换、卡片字段与既有行为断言。

## 下一步
- 已完成打磨与验证；未获授权不 commit/push。空态文案与「个别表格行内操作是否常驻」留待后续判断。

## 验证
在 worktree 启动独立 Vite（`localhost:5173`，复用当前登录态），逐页真实渲染截图（`/tmp/unslop-wt/*-after.png`）：

1. `pnpm --filter @agentport/web typecheck` → exit 0。
2. `pnpm --filter @agentport/web build` → `built in 986ms`，只有既有的 chunk 体积警告。
3. `pnpm test:web` → `Test Files 149 passed (149)`、`Tests 1855 passed (1855)`。
4. `pnpm lint:focus` → 通过；`pnpm lint:contract` → `project contract OK`；改动 30 个文件 `biome check` 无问题。
5. 浏览器核验 13 条路由：`overflow=0`、`h1=1` 全部通过；六个卡片视图在 1024px 窄桌面 `overflow=0`。
6. 关键页截图对比：运行页错误列单行省略、行高一致；定时任务/运行环境改为共享 Table 满宽（34/16/18/16/16% 与 50/25/25%）；账户行操作收敛；个人资料身份组合并；个人模块六页与普通页面同宽；使用记录状态列成行对齐；技能分段控件计算样式为 `#EFEFEF` + `#141414` + `#E6E6E6`。
7. 表格/卡片：六页 `?view=cards` 均真实渲染卡片，字段标签、操作与表格等量；URL 切换保留筛选/游标。卡片→详情→返回保持 `view=cards`；表格错误「展开全文」键盘可达。
8. 独立 Opus 终审（卡片视图）：首轮不通过（详情返回丢卡片视图、错误全文鼠标依赖、部分卡片缺标签），三项修复后聚焦复核通过；测试名误导一处已改准确。
7. 独立 Opus 终审：首轮发现「连接器显示可读名后搜索仍只匹配 slug」的功能缺口，已修复并补行为测试（搜索 `Hugging Face` 与 `huggingface` 命中同一卡片，无关词 0 张）；聚焦复核结论为通过。

未覆盖：登录页与公开分享页（需要未登录态/有效分享链接）。已知遗留：空态「还没有…」文案未处理；连接器弹窗标题仍用 slug；定时任务超长名称在窄桌面会出现页面级横向溢出（既有问题，非本次引入）。
