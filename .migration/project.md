# project — Radix → Base UI

2026-10-21 · `base-nova`（Base UI）· 全部 wrapper 已迁移，radix 依赖与 lockfile 条目已清零。

## 当前状态（以磁盘为准）

- `components.json`：`style: base-nova`，无 `base` 键（schema 不接受该键）。
- `packages/web/src/components/ui/`：15 个底座文件 + 项目自定义层。
- radix 残留：`grep -rn "radix-ui" packages/web/src` → **0**；`pnpm-lock.yaml` 中 `@radix-ui/` → **0**。

## 目录结构

| 分类 | 文件 |
|---|---|
| 底座（registry 原样） | button, badge, input, label, textarea, skeleton, table, dialog, sheet, select, popover, tooltip, dropdown-menu, collapsible |
| 项目自定义层 | field.tsx, status-badge.tsx, search-input.tsx, segmented-tabs.tsx, table-wrap.tsx, app-dialog.tsx（若存在） |
| AI Elements（官方 registry） | message.tsx, message-scroller.tsx |

规则见 `docs/BASE-FIRST.md`：底座先行，视觉由 `styles.css` 令牌层控制，自定义独立成文件。

## 行为差异（已修）

| 项 | 旧（Radix） | 新（Base UI） | 处理 |
|---|---|---|---|
| Select 列表滚动 | Viewport 自带 | List 仅在 item 对齐时滚动 | 给 List 加 `max-h` + `overflow-y-auto` |
| Select 展开位置 | `position="popper"` | 默认 `alignItemWithTrigger` | `alignItemWithTrigger={false}` |
| Menu 焦点循环 | 到端点停 | `loopFocus=true` 默认环绕 | 设 `loopFocus={false}` 保持旧行为 |
| Collapsible 退出动画 | `forceMount` 交给 Motion | `keepMounted` 仍会加 `hidden` | 与 Motion 完成回调协调 |
| 键盘拖拽中按 Esc | 文档捕获阶段，dnd-kit 能取消 | Popup 上处理并阻止冒泡 | 在 reason=escape-key 时 `cancel()` 并放行传播 |
| Tooltip 箭头 | Radix 计算贴合边 | Base UI 只给坐标 | 按 side 补贴合偏移 |

## 令牌层

- `--color-muted` 是**表面色**（base-nova 的 `bg-muted` 语义）；文字色统一走 `--color-muted-foreground`。
  项目原有 107 处 `text-muted` 已重命名为 `text-muted-foreground`。
- 圆角：sm 6 / md 7 / lg 9 / xl 16（=radius-card）/ 2xl 16 / 3xl 16 / 4xl 6。
- `@custom-variant dark (&:where(.dark, .dark *))`：项目只有亮色，显式关闭系统级 dark 生效。

## 遗留扫描

- 无 `*.bak` / `*-old` / `*-radix` / `*-base` 文件。
- 无 `--radix-*`、`data-radix-*`。
- `data-[state=]` 仅剩一处且属于原生表格行语义（非 Radix）。
- 已删除：`ui/tabs.tsx`（无消费方）、`.tabular`、`.streaming-caret`、`@keyframes pace-caret`、`--radius-chip`、`--color-ink-hover`、`--shadow-sm`。
