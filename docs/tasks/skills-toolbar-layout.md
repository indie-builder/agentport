# 资源中心工具栏与技能切换调整

## 目标

分清资源导航、技能来源、搜索与筛选层级，沿用黑白灰视觉与现有控件规格。

## 方案

- 共享 ResourcePage：第一行资源导航与创建操作；第二行左侧来源切换/结果数量，右侧搜索、筛选与排序。
- 技能来源使用浅灰分段控件「内部 / 市场」。
- 市场榜单直接展示「总榜 / 趋势 / 新热」，输入搜索时隐藏榜单选择。
- 市场安装按钮统一 outline，安装状态与既有行为保持一致。
- 修复本地多 worktree 登录：`CORS_ORIGINS` 显式配置 `https://*.agentport.localhost`，CORS、登录/登出和 Better Auth 使用同一套可信来源规则。
- 专家、技能、连接器同步共享工具栏排列；不改数据存储。

## 步骤

- [x] 共享工具栏调整
- [x] 技能分段与榜单交互
- [x] Opus review：通过，无阻塞问题
- [x] Web typecheck、受影响测试与浏览器检查

## 改动文件

- packages/web/src/components/resource-page.tsx
- packages/web/src/pages/skills.tsx
- docs/DESIGN-SYSTEM.md
- 必要的现有前端测试

## 下一步

审查和验证完成，用户已确认通过 PR 提交并合并；返回主 checkout 后同步本地 Origin 配置。

## 验证

- `pnpm --filter @agentport/web typecheck`：通过。
- `pnpm test:web`：28 个文件、261 项测试通过。
- `pnpm lint:focus`、`pnpm lint:contract`、改动源码 `biome check`、`git diff --check`：通过。
- 浏览器：来源分段、直接切趋势、搜索隐藏榜单、键盘方向键及 Space 切换通过；内部与市场 320px 无横向溢出，桌面工具栏高度 32px、上下两行对齐。
- 浏览器截图接口连续超时；通过实际交互、可访问树与计算样式验证，未取得视觉截图。
- 预览：https://worktree-skills-toolbar-layout.agentport.localhost/skills?scope=market
- Origin 修复：API typecheck 与 config/auth/security 的 37 项测试通过；Opus 审查通过。
- API 镜像已重建并仅重启 API；浏览器从预览域名真实表单登录成功，`/api/auth/me` 返回 authenticated=true。
- 本 worktree 的 `.env` 已配置通配符，API 已加载；`.env.example` 已同步。主 checkout 的 `.env` 尚未更新（worktree 隔离规则拒绝修改），合并/返回主 checkout 后需同步这一行，使未来新 worktree 经 `.worktreeinclude` 继承。
- `docs/PITFALLS.md` 补齐本轮教训；流程明确开工前阅读并落实相关规避方式。
