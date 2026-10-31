# 恢复「新建专家 / 创建数字分身」入口卡

## 目标

「找专家」（`/agents`）网格恢复两张常驻入口卡：带六张插画扇形动效的「新建专家」卡，以及带数字分身头像的「创建数字分身」卡。用户要求这两个入口一直存在，不再随版本或列表状态消失。

验收：
- 有 `agents.create` 权限时，专家列表网格始终先渲染两张入口卡（列表为空、筛选无结果时也在）。
- 扇形卡悬停/聚焦按旧版角度展开六张插画并带阴影。
- 两卡分别以「通用助手」「数字分身」角色打开现有创建 Dialog；导入进行中禁用。
- 无创建权限的账户看不到两张卡，保留原有「暂无可用专家」说明。

## 方案

- 从 `8696a56^` 恢复被删除的素材 `packages/web/src/assets/agents/create-*.png`、`agent-avatar.tsx` 的 `createShowcaseAvatars` 导出、`styles.css` 的 `.agent-create-fan` 动效块。
- 在 `agents.tsx` 专家网格中按旧版结构渲染两卡，用现有 `canCreate`、`importing` 门控；点击复用 `CreateAgentDialog`。
- Dialog 初始角色增加一次性覆盖：扇形卡 → `通用助手`，分身卡 → `数字分身`；工具栏仍沿用当前角色筛选预填。
- 有创建权限的空列表由两张入口卡承担空态，删除重复的「还没有专家 / 创建第一位专家」PageNote；无权限账户的说明保留。
- 同步 DESIGN-SYSTEM / USER-STORIES / PROJECT-BRIEF 中「不设独立创建卡、数字分身不另设入口」的旧决定。

## 基线与范围

- 起点：`fbce1fdbcb8ff572717323792a38741c5db44a1c`（origin/main），初始无未提交差异。
- 允许改动：`packages/web/src/pages/agents.tsx`、`packages/web/src/components/agent-avatar.tsx`、`packages/web/src/styles.css`、恢复的 `create-*.png`、相关前端测试、上述文档与本任务记录。

## 当前有效决定

- 用户 2026-10-31 明确要求两张入口卡「一直是要有的」，覆盖 8696a56「不再提供独立数字分身卡与专家创建卡」的决定。
- 动效与卡片内容按 8696a56 之前的实现恢复，不重新设计。

## 已替代项及原因

- 8696a56 将创建入口收敛到工具栏并删除两卡；用户明确要求恢复常驻入口卡。

## 步骤

- [x] 恢复素材、头像导出与扇面样式
- [x] 在专家网格恢复两张入口卡并接上创建 Dialog
- [x] 调整有权限空态并更新测试
- [x] 更新设计/需求文档中的旧决定
- [x] 按改动范围跑测试、typecheck、build

## 改动文件

- `packages/web/src/pages/agents.tsx`
- `packages/web/src/components/agent-avatar.tsx`
- `packages/web/src/styles.css`
- `packages/web/src/assets/agents/create-{frontend,backend,data,devops,qa,ui}.png`（从 `8696a56^` 恢复）
- `packages/web/test/agents-lifecycle.test.ts`
- `packages/web/test/agents-ui.test.ts`
- `packages/web/test/expert-permission-empty.test.ts`
- `packages/web/test/resource-states.test.ts`
- `docs/DESIGN-SYSTEM.md`
- `docs/USER-STORIES.md`
- `docs/PROJECT-BRIEF.md`
- `docs/tasks/agent-experience-redesign.md`
- `docs/tasks/restore-create-cards.md`

## 下一步

无

## 验证

- `pnpm exec vitest run --config packages/web/vitest.config.ts packages/web/test/agents-lifecycle.test.ts packages/web/test/expert-permission-empty.test.ts packages/web/test/resource-states.test.ts packages/web/test/agents-ui.test.ts` → 4 files / 128 tests passed。
- `pnpm --filter @agentport/web typecheck` → `tsc -b` 通过。
- `pnpm --filter @agentport/web build` → `✓ built in 783ms`，仅既有大 chunk 警告。
- 构建产物 CSS 已确认包含 `.agent-create-fan__chip` 规则。
- Opus 独立终审发现无结果提示入口丢失 URL 角色预填，修复后新增行为测试并复核通过；其他已通过范围未重复审查。
- `git diff --check` 通过；`.vitest/json/output.json` 为测试生成结果，不纳入本次提交。
- 未做浏览器实拍：扇形展开角度与焦点动效按 `8696a56^` 原样恢复，未做视觉回归。
