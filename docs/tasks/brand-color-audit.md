# 全站品牌配色审计与调整

## 目标

按 `docs/DESIGN-SYSTEM.md` 的纸白与工具灰主题审计全部前端路由与共享组件，修复颜色角色、辅助文字对比度与状态色的一致性问题。保留 Logo、角色插画的既有图形配色例外及全部业务行为。

用户已明确要求审计后直接调整，并按项目 Opus 探索设计、Sonnet 并行执行、Opus review 的流程推进。

## 方案

- 以既有 `styles.css` 语义令牌为唯一颜色来源；优先修复共享组件，避免逐页另造色板。
- Opus 进行全站源码审计，另一 Opus 独立复核状态色与危险操作的真实颜色组合；主会话负责浏览器审计与验证环境。
- 探索结论固定后按不重叠文件域并行派发 Sonnet，实现后交 Opus 独立 review。
- 复用现有 shadcn/Base UI、Tailwind 4，不新增依赖、不改变布局规格、不改后端。
- 按 `docs/PITFALLS.md` 使用主 checkout 的既有 API/基础设施，worktree 只启动独立前端；编辑前核对 HEAD 与 main。

## 步骤

- [x] 读取设计规约、研发流程与踩坑记录。
- [x] 浏览器初审全部顶级路由、技能市场、专家配置、运行详情与新建弹窗。
- [x] 汇总 Opus 审计、固定共享契约与并行文件域。
- [x] Sonnet 并行实施。
- [x] Opus review 并修复发现。
- [x] 范围内校验与浏览器复测，记录实际结果。

## 审计覆盖

浏览器初审：工作台 `/`、对话 `/chat`、专家 `/agents`、专家配置 `/agents/$agentId`、技能内部与市场 `/skills`、连接器 `/servers`、运行 `/runs`、运行详情 `/runs/$runId`、定时任务 `/schedules`、评估 `/eval`、健康 `/status`、审计 `/audit`、登录 `/login`、未知路由。附加新建专家 Dialog、390px 窄屏对话。

初审实测：资源导航未选中文字（正文色 60% 透明度叠纸白）4.04:1；健康页成功 Badge（绿色叠浅绿底）4.47:1，均低于小字号文字要求的 4.5:1。对应统一修法与复测结果已在下文记录，初审未修改业务数据。

## 实施契约

- `styles.css` 的失败图表改为 `--color-chart-failed: var(--color-danger)`，成功色按下条加深；其余基础色不动。无引用的旧代码色、状态边线与成功浅底令牌回收。
- 未选中资源标签、配置分组标题、工具功能图标使用 `muted-foreground`；当前项用 `fg`。
- 独立 Opus 确认 success 直接用于 canvas / selected 也不足 4.5:1。故共享成功色小幅加深至 `#187646`，同步设计规范，状态语义不变；成功 Badge 采用中性表面，warning/danger 不改。
- 危险按钮纸白底默认及 hover 实测通过，不改成更重的实底红。Badge 的红色焦点覆盖在独立 review 中一并核对。
- 普通启用/放行用 `selected`，关闭用 `chip`；`warning` 只表达警告。
- 状态区边框用 `line`，失败图表用 `danger`；不以彩色边框表示普通状态。
- JSON 与 Markdown 代码统一中性文字；弹层移除玻璃模糊并复用 `scrim`。
- 不改 Logo、角色插画、favicon，不动尺寸、排版、业务行为和后端。
- 文件域：① 共享基础 `components/ui/tabs.tsx`、`dialog.tsx`、`sheet.tsx`、`components/code-block.tsx`、`status-badge.tsx`、`states.tsx`；② 资源 `pages/agents.tsx`、`servers.tsx`；③ 运行会话 `pages/chat.tsx`、`overview.tsx`、`run-detail.tsx`。

## 改动文件

- `docs/tasks/brand-color-audit.md`
- `packages/web/src/styles.css`
- `packages/web/src/components/ui/tabs.tsx`、`dialog.tsx`、`sheet.tsx`
- `packages/web/src/components/code-block.tsx`、`status-badge.tsx`、`states.tsx`
- `packages/web/src/pages/agents.tsx`、`servers.tsx`、`chat.tsx`、`run-detail.tsx`
- `docs/DESIGN-SYSTEM.md`、`docs/PITFALLS.md`

其余页面只通过共享组件继承调整，不制造逐页改动；`overview.tsx` 既有消费图表令牌，故无需改文件。

## 下一步

无实施待办。Opus 独立 review 及 P3 修复后的定向复核均已完成，未发现新代码问题；三项 P3 清理与最终范围验证均已落实。用户已要求提交 PR 并合并，不触发、等待或监控 CI；配色与本地登录配置分别提交，合入同一 PR。预览 `http://localhost:5174`。

## 审计结果与调整

| 问题 | 调整 | 影响页面 |
| --- | --- | --- |
| 未选中资源标签使用正文 60% 透明色，纸白底仅 4.04:1 | 统一 `muted-foreground` | 专家、技能、连接器及共享 Tabs |
| 配置导航分组使用 38% 装饰弱色 | 改钢灰辅助文字 | 专家配置 |
| 成功文字在浅绿底 4.47:1，画布/选中底也可能不足 | 成功色微调为 `#187646`；Badge 使用中性底 | 健康、运行、审计、对话等状态反馈 |
| 失败图表使用钢灰辅助色 | 失败系列映射到现有 `danger` | 工作台 |
| JSON 多色词法与中性代码主题不一致 | 深石墨与钢灰两种文字，删除无引用旧代码色 | JSON/文件/工具结果预览 |
| 状态区彩色边线 | 回收为统一 `line`，保留状态文字、图标和局部语义底色 | 错误状态、审批、删除影响范围、状态徽章 |
| 工具放行普通选中态使用 warning | 改 `selected` 与 `fg`，真实安全警告保留 | 专家权限配置 |
| Dialog/Sheet/代码复制按钮毛玻璃 | 移除模糊；弹层遮罩复用 `scrim` | 全站弹层与移动导航 |

未发现独立问题的页面通过共享组件继承修正。Logo、角色插画、favicon、尺寸、排版、焦点和业务逻辑未调整。

## 验证

- 主 checkout 开始前 `git status --short --branch`：`main...origin/main`，工作区干净。
- `pnpm --version`：12.14.0；`node --version`：v24.22.0。
- shadcn `info -c packages/web --json` 确认 base-nova / Base UI / Tailwind 4 / neutral；在 monorepo 根调用 info 需显式指定前端工作区。
- 浏览器实际颜色计算：资源 tab 4.04:1；健康成功 Badge 4.47:1；390px 对话 `scrollWidth === innerWidth === 390`。
- worktree `git rev-list --left-right --count HEAD...main`：`0 0`。
- `pnpm install --frozen-lockfile`、shared/core build 成功；独立 Vite 预览 `http://localhost:5174`，共用已有 API，不新启 compose。
- `pnpm lint:focus`：焦点/边框规约校验通过；`pnpm lint:contract`：project contract OK。
- `pnpm --filter @agentport/web typecheck`：`tsc -b` 退出 0。
- `pnpm test:web`：28 个文件、263 个测试通过。
- `pnpm --filter @agentport/web build`：成功（4907 modules）；Vite 提示若干 chunk 超过 500 kB，本次不扩展至性能重构。
- `pnpm exec biome check <10 个改动 TSX 文件>`：Checked 10 files，No fixes applied。
- `git diff --check`：通过。
- 浏览器：所有主路由、技能市场、专家详情、运行详情正常；桌面无页面横向溢出；390px 下专家/连接器/运行/健康/对话/登录 `scrollWidth === innerWidth === 390`。
- 资源 Tabs 与配置分组标题实际为 `rgb(95,103,112)`；资源未选中 tab 在实际纸白底复测为 5.595:1。Dialog 与 Sheet 遮罩 `rgba(0,0,0,0.4)`、`backdrop-filter: none`。专家 `.mcp.json` 文件预览为深石墨文字与纸灰表面。
- 成功色从浏览器实际主题令牌取值复算：surface 5.508:1、canvas 5.041:1、selected 4.561:1、sunken 4.814:1、success-soft 5.022:1；健康页成功 Badge 的实际渲染组合为 5.508:1。
- 资源未选中 tab：4.04:1 → 5.595:1；成功 Badge：4.47:1 → 5.508:1。
- 无引用的旧语法色、彩色边线与成功浅底均已回收；成功色对已移除浅绿底的额外复算结果仅留作审计证据，不保留无调用令牌。
- JSON 正则清理后临时 Vitest + `renderToStaticMarkup` 自检 1 用例通过：覆盖字符串/字面量 null、布尔、负数/小数/指数、转义引号、包含 null 的 key；原文保真且仅字面量 null 弱化。临时自检文件已移除。
- review 清理后再次执行 `pnpm test:web`：28 文件/263 用例通过；`pnpm --filter @agentport/web exec vite build --logLevel error` 成功；`pnpm lint:focus`、`pnpm lint:contract` 通过；执行代理 web typecheck 退出 0。
- 未制造失败运行/待审批记录，未触发真实危险删除；这些分支通过源码 review 与现有前端测试覆盖。
