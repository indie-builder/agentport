# 评估通过率趋势图

## 目标
评估页「运行历史」目前只有「通过 / 总数」逐行数字，需人肉扫表才能看出「这版是否越跑越差」。新增一张通过率趋势折线图，让历史一眼可读；纯前端，不改后端/接口。

验收：
- 运行历史内有 ≥2 次可计算通过率的已结束运行（`total>0`、非 running）时，在表格上方显示通过率折线图。
- 图仅视觉展示（`aria-hidden`），可访问等价物是下方「评估运行」数据表（已含 passed/total + 发起时间，带 caption）。
- <2 个有效点、无有效点时不出图，页面其余状态不变。
- `pnpm --filter @agentport/web typecheck` 与定向单测通过。

## 方案
- 在 `packages/web/src/pages/eval.tsx` 新增导出组件 `EvalPassRateChart({ runs })`：
  - 过滤 `status !== 'running'` 且 `total > 0`，按 `createdAt` 升序，映射 `{ label: createdAt, ratePct: round(passed/total*100) }`。
  - `points.length < 2` 返回 `null`。
  - Recharts `LineChart` 单系列 `ratePct`，Y 轴 0–100 带 `%`，复用 `components/ui/chart.tsx` 的 `ChartContainer/ChartTooltip/ChartLegend`；`accessibilityLayer={false}`、`isAnimationActive={false}`（对齐 `overview.tsx` 的 RunTrendCard）。
  - 外层 `<div aria-hidden="true">`；不新增重复数据表（下方运行历史表即等价物）。
- 在「运行历史」`PageSection` 内、`DataTable` 上方渲染 `<EvalPassRateChart runs={runItems} />`。
- 配色只用 `var(--color-chart-runs)`，不硬编码 hex。

## 基线与范围
- 起点 commit：`0c15d274d4ca76cf2cf4fa23b4fa8dce13a8496f`（= origin/main），初始无未提交差异。
- 允许改动：`packages/web/src/pages/eval.tsx`、新增 `packages/web/test/eval-pass-rate-chart.test.ts`。
- 不改后端、不新增依赖、不动其它页面。

## 当前有效决定
用户确认按探索建议先做「① 评估通过率趋势（纯前端）」。

## 已替代项及原因
无。

## 步骤
- [ ] 新增 `EvalPassRateChart` 组件并接入运行历史
- [ ] 新增定向单测（渲染存在/不足 2 点不出图/aria-hidden）
- [ ] typecheck + 单测验证

## 改动文件
- packages/web/src/pages/eval.tsx：新增导出 `buildEvalPassRatePoints`（过滤 running/total=0 → 按 createdAt 升序 → `label: formatDateTime(createdAt)`、`ratePct` 取整）与 `EvalPassRateChart`（<2 点返回 null；`aria-hidden`、`accessibilityLayer={false}`、`isAnimationActive={false}`、单序列 `chart-runs`），并在「运行历史」表上方渲染。
- packages/web/test/eval-pass-rate-chart.test.ts：4 条纯函数单测（乱序→[50,80] 排序、2/3→67 取整、排除 running/total=0、全不合格→[]）+ 4 条 DOM 测试（出图且 aria-hidden、无 role=application；单条/全零/running 不出图）。

## 下一步
无（待用户授权后提交）。

## 验证
- `pnpm --filter @agentport/web typecheck` → 通过（`tsc -b` 无错误）。
- `pnpm test:web pass-rate-chart` → 1 file / 8 tests 通过。
- `pnpm test:web eval-navigation eval-feedback eval-runs-pagination eval-editor-navigation` → 4 files / 26 tests 通过。
- `pnpm --filter @agentport/web build` → exit 0。
- Opus 终审：第一轮 CHANGES-NEEDED（横轴 UTC 与表本地时间不一致；正例测试未验证数据）→ 已修复（横轴改 `formatDateTime`、抽纯函数补有序/取整单测）→ 复核通过。
