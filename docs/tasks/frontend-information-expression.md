# 全站前端信息表达审查与调整

## 目标

按 DESIGN-SYSTEM §10 审查所有前端页面、弹层和共享状态：删除不提供新信息的次级标签与描述，以分组、对齐和布局表达关系。

## 方案

- 范围覆盖 pages 下全部页面、共享骨架/状态/弹层与路由错误界面。
- 先由四组 Opus 只读审查，主会话合并具体问题，再分配 Sonnet 按文件执行。
- 保留表单标签/格式约束、危险与权限提示、状态结果、错误恢复、无障碍名称。
- 沿用现有组件和令牌，不引入新能力；保留当前 worktree 中工具栏与可信来源修复。

## 步骤

- [x] 全站源码审查与问题合并
- [x] 分组实施
- [x] Opus review 与前端验证
- [x] 浏览器检查主要页面和窄屏

## 改动文件

- 页面：agents、servers、skills、chat、eval、memory-panel、ops、status、runs、run-detail、overview。
- 共享组件：states、data-table；已有 resource-page 与工具栏变更保留。
- audit、login、not-found、app-shell、page、dialog-shell、confirm-dialog、路由包装及错误状态已审查，无需改动。

## 合并发现与调整

| 严重度 | 范围 / 位置 | 调整 | 保留的信息 |
| --- | --- | --- | --- |
| Medium | `components/states.tsx:54` | 删除统一追加的「点右侧重试」说明 | 实际错误信息、重试按钮、alert |
| Low | `components/data-table.tsx:399` | 零行时不再同时显示行数和空态 | 加载状态、非零计数、列设置 |
| Medium | `pages/agents.tsx:1722` | 连接器类型只在徽章显示 | 名称、类型、搜索匹配信息 |
| Medium | `pages/agents.tsx:1588`、`:1909`、`:2434` | 草稿用标题表达，未保存状态独立显示；密钥提示仅在 MCP 文件展示 | 工作区依赖、已保存文件来源、密钥占位约束 |
| Medium | `pages/servers.tsx:803`、`:2109` | 测试只留来源与时间；密钥复用规则放到对应输入下 | 最近测试结果、来源类型不可改、宿主执行警告 |
| Low | `pages/skills.tsx` | 支持文件空态不复述加载机制；删除确认去掉零绑定叙述 | 路径示例、添加动作、不可撤销与绑定影响 |
| Low | `pages/chat.tsx`、`pages/eval.tsx` | 移除重命名和用例空态的多余用途说明 | 真实表单、校验、评估启动引导 |
| Medium | `pages/memory-panel.tsx` | 删除规则加载路径说明及重复的侧栏空态 | 新建/选择入口、输出风格替换行为 |
| Medium | `pages/overview.tsx:555` | 区分「需要处理」和「最近失败运行」；空态保留动作而非展示承诺 | 时间窗口、失败记录、管理入口 |
| Low | `pages/ops.tsx:136`、`pages/runs.tsx` | 空态只留含义与下一步 | UTC/cron 要求、创建入口 |
| Medium | `pages/run-detail.tsx:386` | 「专家（当前）」直接放字段标签 | 当前名称与入队版本的来源差别 |
| Low | `pages/status.tsx` | 删除「不可用」前置复述，保留真实 Reason | 故障原因、恢复方式、旧指标提示 |

## 审查边界

源码覆盖全部页面、弹层、共享状态与路由。重点是 Writing / Layout；无障碍检查保留标签、描述引用、状态与恢复动作。颜色、字体、动效沿用现有规范，未对全站对比度、读屏、RTL 或每种数据分支做完整专项验收，不据此宣称这些专项全部通过。

## 下一步

审查和验证完成，用户已确认通过 PR 提交并合并。

## 验证

- `pnpm test:web`：28 个文件、261 项通过。
- `pnpm --filter @agentport/web typecheck`：通过。
- `pnpm lint:focus`、`pnpm lint:contract`、改动源码 Biome、`git diff --check`：通过。
- Opus 独立复核：无阻塞问题；侧栏重复空态已删除，追加 resource-navigation 6 项回归测试与 typecheck 通过。
- 浏览器实际打开工作台、专家配置、技能、连接器、对话、评估、定时任务、健康、运行与审计；未提交业务编辑。
- 10 个主路由（含专家列表）在 320px 测得 document 无横向溢出；检查新建定时任务弹窗及专家能力分组保留可访问操作。
- 未穷举每个错误、空数据与长内容的浏览器分支；这些分支已源码审查，现有测试覆盖回归。
- 当前预览：https://worktree-skills-toolbar-layout.agentport.localhost/
