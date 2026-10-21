# UI 层归属清单（按 shadcn 官方四级优先级）

> 2026-10-21。准则：官方最佳实践优先。依据 `.agents/skills/shadcn/customization.md`。

## 官方四级优先级

1. 内置 variant　2. `className`（**只做布局**）　3. 源码里加 `cva` variant　4. 包装组件

## 底座（`src/components/ui/`，registry 原样）

button · badge · input · label · textarea · skeleton · table · dialog · sheet · select
· popover · tooltip · dropdown-menu · collapsible · field · separator · combobox
· input-group · tabs · message · message-scroller

这些文件**不改结构、不改 class**。项目差异全部通过 `styles.css` 的 `@theme` 令牌注入
（`--primary`、`--background`、`--muted`、`--radius-*` 等），改令牌即改全部组件。

## 第 4 级：包装组件（组合底座）

| 文件 | 位置 | 为什么 |
|---|---|---|
| `dialog-shell.tsx` | `src/components/` | 组合 `DialogContent` + `DialogHeader` + 项目尺寸/滚动区，5 个弹窗共用 |
| `confirm-dialog.tsx` | `src/components/` | 组合 Dialog + 危险操作二次确认 |
| `search-input.tsx` | `src/components/` | 组合 `Input` + `Button` + lucide，无底座等价物 |
| `status-badge.tsx` | `src/components/` | 组合 base `Badge`，补 success/warn/danger 语义（第 3 级的替代方案，避免改底座） |
| `required-mark.tsx` | `src/components/` | 项目原子（必填星号），底座无对应 |

## 禁止

- 在 `ui/` 里新增非 registry 文件。
- 为「少写几行」造中间层（例如把 `DialogContent` 的三个子节点再包一层）。
- 手改底座文件的 class；需要变体时走第 3 级或第 4 级。

## 本轮清理结果

| 规则 | 前 | 后 |
|---|---:|---:|
| `space-x-*` / `space-y-*`（官方禁止） | 66 | 0 |
| 等值 `w-N h-N`（应用 `size-N`） | 1 | 0 |
| app 层手写 `dark:` 覆盖 | 0 | 0 |
| app 层手写 `z-50` | 0 | 0 |
| `text-muted`（应为 `-foreground`） | 107 | 0 |
| 已删除的适配层 | app-dialog, table-wrap, segmented-tabs, multi-select | — |

## 待复核（70 处 flagged）

`className` 覆盖了底座组件的颜色/字号（官方建议用 variant 或令牌）。这些是为了对齐
`DESIGN-SYSTEM.md` 的实测值而刻意保留的，逐条记录在当时的审计输出里。
**尚未逐条决策**：是把它们提升为 `cva` variant，还是收敛成令牌。
