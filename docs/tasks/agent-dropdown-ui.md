# 对话专家下拉 UI 与桌面规则

## 目标
修复对话页专家下拉（专家选择）的 UI 问题；同时把「项目仅面向桌面」固化为常驻规则，清理设计规范中与桌面基线冲突的移动端/窄屏要求。文档 P2 修正已复核，源码修复、测试与浏览器验收已完成；源码独立 Opus review 已通过，未发现需要修改的问题。分支 `fix/agent-dropdown-ui` 已提交 `83807ea`，经 PR #76 合并为 `f33849d`，成果已合入 main。

## 方案
- `CLAUDE.md` 前端只保留一条桌面硬规则，写明桌面布局、不新增手机断点/触摸尺寸/替代导航，保留窗口缩放、容器伸缩与无障碍；不写源码历史清理范围，细节指向 `docs/DESIGN-SYSTEM.md`。
- `docs/DESIGN-SYSTEM.md` 统一为桌面规格：去掉手机专用输入字号、触摸 44px 目标、窄屏 Sheet/Select 替代导航等要求；保留窗口收窄时的换行、堆叠、表格内部滚动与无障碍行为。
- `docs/DESIGN-SYSTEM.md` review 修正（Opus P2）：欢迎标题统一 `3xl`、木工插画固定 96px、删除窗口收窄隐藏快捷键的要求；`2xl` 字号行无唯一用途已删。窗口收窄只保留自然换行、容器伸缩、历史面板收起与内部滚动。
- 专家下拉只改 chat 调用点 `AgentPicker`（`packages/web/src/pages/chat.tsx`），不改共享 Combobox 原语：
  - trigger 的 children 从 `render` 的 `Button` 内移到 `ComboboxTrigger` 下，避免 Button 自带 children 覆盖下箭头。
  - 删除 `ComboboxInput` 的 `w-full`，复用组件自带 `w-auto`，消除搜索框右侧溢出。
  - 选项 `items-start` 改为 `items-center`，头像去掉 `mt-0.5`/`mt-1`，勾选标记不再相对两行文字上偏。
  - 名称与角色允许换行（去掉 `truncate`），角色字号由 `text-2xs`（11px）改为 `text-xs`。
- 依据：已核对 shadcn/ui 与 Base UI 官方文档，并实际操作 openui.com desktop 的模型下拉确认交互与形态。

## 实测问题（浏览器）
- 弹层 x=284 / right=540，宽 256（`min-w-[16rem]`）；搜索框 x=288 / right=544，右侧超出弹层 4px。
- trigger 下箭头被 `Button` 自带 children 覆盖。
- 选项 `items-start` 令勾选标记相对两行文字上偏。
- 角色 `text-2xs` 11px 与可点击控件的字号规则冲突。

## 基线与范围
- 基线 commit：`4ad1f07`；分支 `fix/agent-dropdown-ui`。
- 工作树：`/Users/xbjt/Documents/myself/agent-dropdown-fix`；前端预览代码根同一路径。
- 源码范围：`packages/web/src/pages/chat.tsx`（仅 `AgentPicker` 调用点）。
- 测试范围：`packages/web/test/chat-ux.test.ts`；已新增箭头回归测试并完成 red/green 验证；源码与测试的独立 Opus review 已通过。
- 文档范围：`CLAUDE.md`、`docs/tasks/agent-dropdown-ui.md`；`docs/DESIGN-SYSTEM.md` 的桌面规格清理为本任务前一阶段已产生的改动。
- 不改共享 Combobox 原语，不改后端、认证配置、数据库或 env。
- 主 checkout 的 `.vitest/json/output.json` 已有改动，不属本任务。

## 预览环境
- 前端：`https://agent-dropdown-ui.agentport.localhost`
- 后端：`localhost:3000`
- 配置来源：现有 Docker 后端，未改 env。
- 主 checkout 的 `.env` 登录失败；改用当前运行容器已有配置登录成功，未更改认证配置或数据库。

## 当前有效决定
- 项目只面向桌面，不做移动端适配（用户明确）。
- 保留桌面窗口缩放、分栏/消息容器伸缩、弹层可用空间与无障碍行为。
- 欢迎标题统一 `3xl`、木工插画固定 96px、快捷键不随窗口收窄隐藏；窗口缩放只影响自然换行、容器伸缩、历史面板收起与表格/输入区内部滚动。
- 专家下拉只改调用点，不为单个视觉问题改共享组件默认值。
- 源码中既有移动端实现（`mobile-input`、`sm`/`md` 断点、Sheet 等）本次不清理；桌面规则是新决定，文档不声称源码已清理。
- 用户已明确授权提交、创建 PR 并合并；按项目规则不触发或等待 CI，合并确认后清理已提交且干净的 worktree。

## 已替代项及原因
- 手机专用输入字号（`mobile-input` 16px，防 iOS 缩放）：与桌面定位冲突，改用共享 13px 桌面字号；对话输入框固定 15px。
- 触摸 44px 目标（发送、短任务入口、窄屏对话操作）：改为桌面 32px / 单行排列。
- 窄屏 Sheet 展示历史与右工作区、窄屏带专家选择/搜索/列表的抽屉、专家配置窄屏改用 `Select`：均属移动导航方案，桌面统一使用既有分栏、页签与收起面板。
- 其余「窄屏」措辞改为「窗口收窄」，只保留桌面窗口缩放时的换行、堆叠与表格内部滚动。
- 欢迎标题降为 `2xl`、插画缩到 80px、窗口收窄隐藏快捷键：只是把手机规格改称呼，仍属过度设计；按 Opus review P2 回退为统一 `3xl`、96px 与始终显示的快捷键。

## 步骤
- [x] 读 `docs/PITFALLS.md`、`docs/DEV-WORKFLOW.md` 与目标文档（前轮）
- [x] `CLAUDE.md` 增加桌面硬规则（压缩为常驻规则，不含历史清理范围）
- [x] `docs/DESIGN-SYSTEM.md` 桌面规格清理（前一阶段）
- [x] Opus 文档 review：P2 指出标题/插画/快捷键三处只是给手机规格改称呼；已按最小修正回退，本轮窄范围复核通过
- [x] 浏览器实测专家下拉，核对 shadcn/Base UI 官方 docs 并操作 openui.com desktop 模型下拉
- [x] 执行代理修改 `packages/web/src/pages/chat.tsx`，仅涉及 `AgentPicker`
- [x] `packages/web/test/chat-ux.test.ts` 先新增箭头测试，red 后最小修复，green 通过
- [x] 主会话完成 web 测试、typecheck、定向 Biome、焦点检查与构建
- [x] 真实浏览器复测默认/调整宽度历史面板、长名称、搜索、切换与焦点
- [x] 源码与测试独立 Opus review 通过，未发现需要修改的问题

## 已完成验证

以下源码测试、构建与浏览器结果来自主会话及执行代理的实际运行；文档复核未重复运行已通过的源码验证。

### 文档窄范围复核（本轮）

- P2 已修：`docs/DESIGN-SYSTEM.md` §4 欢迎标题为 `3xl`（24/32），字号表不再有 `2xl` 行；§6 木工插画宽 96px；快捷键仍位于输入区左下角，已无按窗口收窄隐藏的分支。
- `CLAUDE.md` 前端桌面硬规则与设计规范一致：不增加手机断点、触摸尺寸或替代导航；保留桌面窗口缩放、容器伸缩、自然换行、历史面板收起、内部滚动与无障碍行为。
- 设计规范中的欢迎态文本区最小 80px 是输入区高度，不是插画缩小分支；登录表单最大宽 320px、登录控件高 44px 等属于既有场景规格；CardBlock/Carousel 按容器宽度变化，不是手机视口分支。
- 本轮未发现 P2 残留或两份文档之间的桌面规则冲突。此前记录的源码偏差继续保留：源码中的历史 `mobile-input`、`sm`/`md` 断点与 Sheet 移动端实现未全站清理；文档新规则不代表历史源码已同步。
- 前轮 `git diff --check` 通过；前轮文档关键词检查无手机专用规格残留。本轮仅对上述两份规则文档做读取与定向 `rg` 复核，不重做全仓审查。

### 测试与构建

- 执行代理先在 `chat-ux.test.ts` 新增箭头回归测试：red 为 **1 failed / 23 passed**；最小修复后为 **24 passed**。
- 主会话 `pnpm test:web`：**75 个文件、727 个测试全部通过**。输出含 jsdom `Not implemented: navigation to another Document` 提示，测试结果仍为全通过。
- 主会话 `pnpm --filter @agentport/web typecheck`：通过。
- 主会话 Biome check，范围为 `packages/web/src/pages/chat.tsx` 与 `packages/web/test/chat-ux.test.ts`：通过。
- 主会话 `pnpm lint:focus`：通过。
- 主会话 web build：成功，耗时 **948ms**；仅有 **>500kB chunk** 提示。

### 真实浏览器

- 默认 popup：x=284、right=540、宽 256px；修后搜索框：x=288、right=536、宽 248px，左右各留 4px，完整位于弹层内。
- trigger 下箭头数量为 **1**。
- 选中行 y=290、高 48px，中心 y=314；勾选标记 y=306、高 16px，中心 y=314，垂直居中。
- 历史面板分别调整为 **200px**、**359.5px** 宽时，搜索框均完整显示，左右各留 4px。
- 通过 DOM 临时长名称验证（未写入数据库）：文本宽 168px、`scrollWidth=168`，高 80px、行高 20px，可换为 4 行，无横向溢出。
- 搜索「数字分身」成功；无匹配时显示 empty 状态；切换专家后 URL 更新、输入草稿保留、下拉关闭且焦点返回选择专家触发器。

## 待完成与交付状态

- 源码独立 Opus review 已通过：箭头组合、搜索宽度、选项布局、切换行为与回归测试均未发现需要修改的问题。
- 分支 `fix/agent-dropdown-ui` 已提交 `83807ea`，经 PR #76 合并为 `f33849d`，成果已合入 main（可用 `git log` 核对）。
- 预览进程的当前状态未在本记录内核实，本节不再断言其仍在运行。
- 本轮未派代理、未改源码或其他文件，仅更新本任务记录；历史移动端实现未全站清理。