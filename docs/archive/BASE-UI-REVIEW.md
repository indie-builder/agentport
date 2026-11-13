# Base UI 前端复审

## 流程

1. 三个独立 Haiku 任务审计底座源码差异、令牌与官方文档、应用组合。
2. 独立 Haiku 任务并行修复折叠/Tooltip、Checkbox/Switch、复制行为、筛选组合、表单字段。
3. 主会话重新阅读实际 diff，核实审计结论，修复遗漏与回归，再执行类型、lint、构建、单元/集成和 E2E 验证。

## 确认并修复

| 发现 | 实现 |
|---|---|
| Tooltip 与 Collapsible 混入项目行为 | 恢复官方组件；Motion 隐藏协调放在应用组合 `motion-collapsible.tsx`，组合底座 Content |
| 原生 checkbox 与自制 switch 重复已有控件 | 安装官方 Checkbox/Switch，替换 4 个复选框和智能体启用开关 |
| 表单字段缺少官方 Field 组合 | 改用 Field/FieldLabel；主会话追加复审后补齐 20 处 data-invalid、1 处 data-disabled、6 个 FieldGroup |
| 重复复制状态与定时器 | 统一 CopyButton；主会话修复连续点击的计时器叠加，并在卸载时清理 |
| 工具栏筛选重复 | 5 个普通筛选使用 FilterSelect；聊天与特殊表单仍直接使用复合 Select |
| 筛选弹层覆盖触发器 | 统一 SelectContent 在触发器下方展开；当前组件契约见 DESIGN-SYSTEM §9 |
| --radius 缺失导致 InputGroup 内部 calc 失效 | 令牌设为 9px，内部减去 3px 为 6px |
| 浮层阴影不一致 | shadow-md/lg 映射到同一 overlay 令牌 |
| 菜单项目缺少 Group | 账户、智能体、Server 菜单按用途分组；移动端账户触发器补 accessible name |
| 项目状态变体混在 ui 目录 | StatusBadge 移至 components，继续组合底座 Badge；删除无人使用的 accent tone |
| 规则互相矛盾 | BASE-FIRST 与 CLAUDE 明确 shadcn 允许源码自定义；令牌优先是项目选择，不误称官方禁止修改源码 |

## 未作为错误处理的审计建议

- registry 与项目文件的引号、分号、type-only import 差异不构成行为问题，不因格式不同重装。
- 没有“包装必须至少三个调用方”的官方约束。复制反馈、统一筛选行为有真实复用需求；其他特殊 Select 保持内联。
- 原生按钮可用于列表整行操作。不是所有 button、div 或边框都要额外包装。
- Hex/RGB 是完整 CSS 颜色，支持 Tailwind 的 color-mix 与透明度，不因官方示例使用 OKLCH 就强制转换。
- 不机械拉直所有圆角档位：Badge 的 rounded-4xl 映射到项目标签圆角是已记录的设计取舍。
- 不把可变官方 registry 的新 class 差异自动判为 bug；没有对应功能或行为证据的版本漂移单独处理。

## 资源中心统一性复审

三个独立 Haiku 审查分别覆盖共享令牌/底座、表单弹层、资源页面；修复按文件域并行，主会话复核，并追加独立 Opus 复审。当前组件规则只维护在 DESIGN-SYSTEM §9，本文件记录审查结果。

- 修复输入焦点近黑边框与重复光环，统一输入、搜索、多选、筛选和按钮的焦点提示；保留错误色与键盘焦点。
- 删除页面内 LineInput / CodeArea 外观包装，统一单行控件尺寸，卡片头部、操作菜单、页脚与空结果处理。
- 来源选择使用官方 ToggleGroup，所有 Select 默认向下展开。
- 统一取消/关闭的草稿确认、请求中禁止关闭和实际触发器焦点返回；工具切换也经过草稿保护，并发保存冲突保留输入。
- 补齐必填读屏标记及遗漏的字段错误状态，修复弹层重复内边距与宽度覆盖。
- 浏览器实测普通输入与多选的尺寸/边框/焦点相同，错误边框保留；模拟失败保存保留草稿，390px 下三页及弹层无横向溢出。
- 验证：7 个包 typecheck、208 文件 Biome、web 构建通过；30 个 Vitest 文件、179 项通过；E2E 9 通过、1 个完整模型运行用例按配置跳过。worker 已恢复。

未将“路由链接不能组合 Tabs”判为问题：Base UI 官方支持 Link render 与 nativeButton=false。没有把视觉统一扩展成未经验证的全站 WCAG 合规声明。

## 验证边界

实际运行命令与最终数量由交付消息给出。浏览器验证包括筛选失败/重置、列显隐、键盘拖拽 Escape、复制运行 ID 与连续点击反馈、FieldLabel 聚焦和字段错误状态、官方 Tooltip。

没有以本轮结果声称所有 UI 场景均已穷尽。DataTable 的 grid 实现、产品特定代码排版、状态色与完整模型运行属于独立范围；本轮未增加数据表库或改模型链路。
