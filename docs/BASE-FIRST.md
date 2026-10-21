# 底座先行，按官方方式自定义

shadcn 把组件源码交给项目维护，支持修改源码。源码永远不可改、必须反复覆盖重装，以及包装至少三个调用方，都不是官方要求。

新增或改造 UI 时，先读对应的 shadcn / Base UI 文档，安装或复用官方组件，再应用 `docs/DESIGN-SYSTEM.md`。共享视觉通过 `packages/web/src/styles.css` 的语义令牌维护。

## 定制顺序

1. 使用内置 variant 和 size。
2. 局部布局使用 `className`；共享颜色、圆角、字号和阴影优先修改语义令牌。
3. 多处需要的组件语义可以扩展源码里的 variant，保留 Base UI 原语及其键盘、焦点和 ARIA 行为。
4. 有实际复用行为的应用组合放在 `src/components/`，如 `ConfirmDialog`、复制反馈、带清除按钮的搜索框。

依据：shadcn [Introduction](https://ui.shadcn.com/docs)、[Theming](https://ui.shadcn.com/docs/theming)，以及本地 shadcn 技能的 `customization.md` 和 `rules/`。技能中的更严格风格约定与产品 API 要求应分别记录，不能把所有建议当作组件正确性的硬条件。

## 更新组件

从仓库根目录运行 `pnpm dlx shadcn@latest info --json -c packages/web` 检查当前配置。安装或更新前先检查 diff，逐组件核对官方源码与项目变更。`--overwrite` 会覆盖源码定制，不作为无条件默认参数。

## 语义令牌

- `muted` 是浅色表面；次要文字使用 `muted-foreground`，两者不能复用一个文字色变量。
- `border` / `input` 使用项目分隔线颜色。base layer 给裸 `border` 设置默认色，显式状态边框仍由各组件控制。
- `--radius` 供 InputGroup 的 `calc()` 使用；当前为 9px，减去 3px 的内部小按钮为 6px。
- `shadow-md` / `shadow-lg` 映射到同一浮层阴影；输入框胶囊保留独立阴影。
- 项目亮色主题使用 class-based `dark` variant，系统深色偏好不会自行改变组件主题。

## 组合约定

表单使用 `Field`、`FieldLabel`、`FieldError`；字段组的 `data-invalid` 与控件的 `aria-invalid` 同步，禁用字段同步 `data-disabled`。相关字段可使用 `FieldGroup`。

菜单项放在 `DropdownMenuGroup` 中。Select、Tabs、Combobox 使用原语的复合结构；重复的工具栏筛选可组合成 `FilterSelect`，特殊表单仍直接使用原语。

Motion 的折叠协调位于 `components/motion-collapsible.tsx`，组合 `ui/collapsible.tsx`，保持收起内容不可聚焦，并保留退出动画。Tooltip 使用官方结构，颜色与圆角由项目令牌接管。
