# 底座先行，项目自定义在后

> 2026-10-21 定案。所有前端 UI 改动遵循此顺序，**不允许颠倒**。

## 原则

```
1. 装底座          pnpm dlx shadcn@latest add <name> -c packages/web --overwrite
2. 底座就是底座     不手改 components/ui/ 下任何文件的 class
3. 视觉在令牌层     颜色 / 圆角 / 字号 / 阴影全部在 styles.css 的 @theme 里控制
4. 项目自定义独立成文件   需要底座没有的能力时，新建 components/ui/<name>.tsx
```

第 3 步是关键：底座组件用 `bg-primary`、`text-muted-foreground`、`rounded-lg` 这类语义类，
把这些语义变量在 `@theme` 里定义成项目值，视觉就归项目所有，组件文件保持原样。
这样 `shadcn add` 可以随时重装、升级组件库，不会丢任何定制。

## 为什么不能反过来

之前把视觉写进每个组件的 class 字符串里（`rounded-icon`、`text-fg`、`border-line`…），
导致每次底座变化都要重写全部组件，新增组件也要手工改一遍。
这不是"复刻"，是**适配层堆积**。

## 项目自定义层清单

这些文件不属于底座，是项目在底座之上补的能力。底座重装不会影响它们：

| 文件 | 用途 | 为什么不能只用底座 |
|---|---|---|
| `ui/field.tsx` | `FieldError` / `FieldHint` / `RequiredMark` | 底座表单没有字段级错误/提示的固定形态 |
| `ui/status-badge.tsx` | `StatusBadge` + 7 种 tone | 底座 Badge 只有 6 种语义变体，项目需要 success/warn/danger |
| `ui/search-input.tsx` | 带图标与清除按钮的搜索框 | 底座没有组合好的搜索框 |
| `ui/segmented-tabs.tsx` | 声明式分段切换 | 底座 Tabs 是复合结构，项目的两处用法只需切换受控值 |
| `ui/table-wrap.tsx` | 表格横向滚动容器 + 无障碍 label | 底座 table.tsx 只有表格元素本身 |
| `ui/message*.tsx` | AI Elements（官方 registry） | 底座之外的独立 registry，属于官方提供的组合层 |

## 令牌映射

`styles.css` 里 `--color-*` 是项目真实值，底座语义名指向它们：

| 底座语义 | 项目令牌 |
|---|---|
| `background` / `card` / `popover` | `--color-surface` |
| `foreground` | `--color-fg` |
| `muted-foreground` | `--color-muted` |
| `primary` / `ring` | `--color-ink` / `--color-fg` |
| `border` / `input` | `--color-line` |
| `destructive` | `--color-danger` |

圆角：`sm` 6 / `md` 7 / `lg` 9 / `xl` 12 / `2xl` 16 / `3xl` 16 / `4xl` 6。
项目自己的圆角令牌（`--radius-shell/card/item/icon/tag`）是源头。

## 已验证

- 9 个页面浏览器实测全部正常渲染
- 整体无彩度：主按钮 `rgb(3,3,3)` / 白字，页面底 `rgb(245,245,245)`
- typecheck 7 包、biome 197 文件、179 单测、构建通过
