# CDS 圆角 / 边线 / 焦点只读审计

## 目标与交付边界

按已批准的 Claude CDS 基线审计 radius / border / focus，只记录偏差与不一致；本任务唯一交付文件为本文。没有修改源码、测试、配置、品牌、受保护入口或已批准布局几何，没有提交或推送。

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`
- 分支：`cds-redesign`
- 基线 HEAD：`a44ba5131de7d1d5b396170ed6eafa59d5aa0b8d`
- 日期：2026-11-02。
- 开工状态：`?? tmp/`，为原有未跟踪目录，不纳入交付。
- 当前有效决定：视觉权威为 `packages/web/DESIGN.md`，工程契约为 `docs/DESIGN-SYSTEM.md` §3、§9；不重新讨论设计方向。已替代决定：无。
- 方法：全量检索 `packages/web/src`，复读全部任意值命中及相关原语、调用方、CSS；对关键类名组合运行现有 `cn` 做只读合并探针。采用项目 shadcn 技能的“共享原语优先、先看现有实现”原则。
- 范围：源码目录 195 个文件，其中 177 个 `.ts` / `.tsx` / `.css` 文件、155 个 TSX 文件。检索不包含 `node_modules`、构建产物、截图与历史任务文档中的样例。
- 证据等级：本文为源码静态审计，计算值均是令牌代入结果，不是浏览器计算样式。没有启动应用、截图或执行 Tab / AX / forced-colors 实测；涉及 CSS 优先级、焦点裁切与动态状态的结果另列为待实测风险，不冒充已发生的无障碍故障。

## 基线门禁与统计

按要求在审计前并行运行，两个命令均退出 0：

| 命令 | 真实输出 | 结论 |
|---|---|---|
| `pnpm lint:focus` | `焦点/边框规约校验通过。` | 通过 |
| `pnpm lint:contract` | `project contract OK` | 通过 |

计数按源码中的出现次数：同一行不同属性分别计数，同一类在不同文件/行重复出现也分别计数；不等于唯一类名数、DOM 实例数或偏差数。圆角、边线任意值中包含合法令牌引用和图形例外。

| 检索类别 | 出现次数 | 文件数 | 说明 |
|---|---:|---:|---|
| `rounded-[…]` | 32 | 17 | 含令牌、`min()`、`calc()` 与固定像素 |
| `border-[…]` 及 `border-t/b-[…]` | 11 | 10 | 含 5 处输入焦点色、3 处 hairline、2 处审批色与 1 处图表宽度 |
| `ring-[…]` | 1 | 1 | 日历 `3px` |
| `outline-[…]` | 0 | 0 | 无任意值类；CSS / CodeMirror 的 outline 单独审阅 |
| `shadow-[…]` | 7 | 5 | 5 处令牌引用，2 处自行组合阴影 |
| 上述任意值合计 | 51 | — | 与下行合并后去重为 47 个 file:line / 24 文件 |
| `border-2/4`，含方向变体 | 2 | 2 | 两处 `border-l-2`；没有 `border-4` |
| 焦点 ring / outline / border / shadow 类声明 | 173 | 33 | 分布于 50 个 file:line；含 `focus:`、`focus-visible:`、`focus-within:`、祖先 `has-[…:focus-visible]:`，不含 CSS 规则、普通 hover 与仅控制显隐的焦点类 |

**偏差共 13 项：P1 0、P2 8、P3 5；建议 10 批，每批 1–2 文件。** P1 表示有证据的焦点不可见或关键交互阻断；本轮没有取得此级别的实际证据。P2 为当前可达实现的契约偏差或相互冲突的样式声明；P3 为局部收口、未被实际调用触发的默认值问题或过期说明。待实测风险不计入已确认偏差数。

## 权威契约与映射

| 用途 | 批准值 | 实现入口 |
|---|---|---|
| 卡片、线程容器 | 12px | `rounded-card` / `rounded-xl` |
| Dialog | 16px | `rounded-dialog` / `--radius-dialog` |
| Popover / Select / Combobox / DropdownMenu 浮层 | 10px | `rounded-popover` / `--radius-popover` |
| Composer / 用户消息气泡 | 20 / 18px | `rounded-composer` / `rounded-bubble` |
| 常规按钮、输入、页签容器与项、菜单项、展开侧栏条目、图标按钮 | 8px | `rounded-item` / `rounded-icon` / `rounded-lg` / `rounded-md` |
| 徽章、标签、侧栏收起态图标块 | 6px | `rounded-tag` / `rounded-sm` / `rounded-4xl` |
| 头像、胶囊 | 9999px / 圆形 | `rounded-pill` / `rounded-full` |
| Checkbox | 4px | 现有 `rounded-[4px]`，不可换成当前为 6px 的 `rounded-sm` |
| 普通边线、分隔线 | 既有 1px，颜色 `line` | `border` / 方向 border / `ring-1 ring-line` / `Separator` |
| 页签指示线、普通键盘焦点 | 2px | 页签指示线 / `ring-2 ring-ring` 或全局 outline |
| Input / Textarea / Select / Combobox / InputGroup | 陶土微光 | `cds-focus-glow` 或外层 `--shadow-focus-glow` |
| SourceEditor / CodeMirror 搜索 | `input-focus` 换线 | 编辑器外框或搜索输入自身 |

令牌来源：`packages/web/src/styles.css:81` 至 `:102`。`--radius-md` 与 `--radius-lg` 均为 8px，`--radius-sm` 与 `--radius-4xl` 均为 6px。不要按 Tailwind 默认尺寸推断它们的值。`rounded-[var(...)]` 已经消费令牌，改成语义 utility 多数只是写法收口，不能据此报视觉偏差。

`--color-border` 在 `styles.css:163` 指向 `line`，`--color-input` 在 `:169` 同值。`styles.css:249` 的全局默认边框色覆盖 `* / ::before / ::after`，因此裸 `border-t` / `border-b` 不等于黑色边线。

`--hairline` 在 `styles.css:197` 默认 1px，DPR≥2 为 0.5px（`:202`）、DPR≥3 为 1/3px（`:208`）。这是当前既有实现，`DESIGN.md:361` 已记录 Retina 例外；本轮不建议将其统一替换为固定 1px，也不借此改变既有几何。

## 任意值完整清单

下面每一行均给出实际源文件行号。表内“可收口”表示可以用已存在的语义 utility 表达相同值，不表示必须安排修复。

### 圆角：32 处

| file:line | 当前类 / 用途 | 判断与建议 |
|---|---|---|
| `packages/web/src/App.tsx:24` | `rounded-[var(--radius-card)]!`，Toast | 合规 12；可用 `rounded-card!`，须保留 important 与 Sonner 覆盖行为 |
| `packages/web/src/components/app-shell.tsx:175` | `rounded-[var(--radius-icon)]`，侧栏折叠按钮 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/app-shell.tsx:190` | 同上，侧栏头部操作 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/app-shell.tsx:200` | 同上，侧栏图标按钮 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/app-shell.tsx:604` | 同上，展开账号入口 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/app-shell.tsx:694` | 同上，窄桌面导航开关 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/plugin-file-tree.tsx:23` | 同上，树节点按钮公共类 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/ui/button.tsx:28` | `rounded-[min(var(--radius-md),10px)]`，xs | 当前为 8；合规，可用 `rounded-md` |
| `packages/web/src/components/ui/button.tsx:29` | `rounded-[min(var(--radius-md),12px)]`，sm | 当前为 8；合规，可用 `rounded-md` |
| `packages/web/src/components/ui/button.tsx:31` | `rounded-[var(--radius-icon)]`，icon | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/ui/button.tsx:33` | `rounded-[min(var(--radius-md),10px)]`，icon-xs | 当前为 8；合规，可用 `rounded-icon` |
| `packages/web/src/components/ui/button.tsx:35` | `rounded-[min(var(--radius-md),12px)]`，icon-sm | 当前为 8；合规，可用 `rounded-icon` |
| `packages/web/src/components/ui/button.tsx:36` | `rounded-[var(--radius-icon)]`，icon-lg | 合规 8；可用 `rounded-icon` |
| `packages/web/src/components/ui/chart.tsx:203` | `rounded-[2px]`，tooltip 数据指示符 | 图形标记，保留；不是菜单项或按钮 |
| `packages/web/src/components/ui/chart.tsx:294` | `rounded-[2px]`，图例色块 | 图形标记，保留；不套控件 8px |
| `packages/web/src/components/ui/checkbox.tsx:10` | `rounded-[4px]`，复选框 | 明确批准例外，保留；没有必要为单一例外另造令牌 |
| `packages/web/src/components/ui/combobox.tsx:106` | `rounded-[var(--radius-popover)]`，弹层 | 合规 10；可用 `rounded-popover` |
| `packages/web/src/components/ui/dialog.tsx:52` | `rounded-[var(--radius-dialog)]` | 合规 16；可用 `rounded-dialog` |
| `packages/web/src/components/ui/dropdown-menu.tsx:34` | `rounded-[var(--radius-popover)]` | 合规 10；可用 `rounded-popover` |
| `packages/web/src/components/ui/input-group.tsx:25` | `rounded-[calc(var(--radius)-5px)]`，addon 内 kbd | 得到 3px，P3-02；当前未找到实际 kbd 子节点 |
| `packages/web/src/components/ui/input-group.tsx:72` | `rounded-[calc(var(--radius)-3px)]`，xs 按钮 | 得到 5px，偏离 8，P2-01 |
| `packages/web/src/components/ui/input-group.tsx:74` | 同上，icon-xs 按钮 | 得到 5px，偏离 8，P2-01 |
| `packages/web/src/components/ui/popover.tsx:35` | `rounded-[var(--radius-popover)]` | 合规 10；可用 `rounded-popover` |
| `packages/web/src/components/ui/select.tsx:43` | `rounded-[min(var(--radius-md),10px)]`，sm 触发器 | 当前为 8；合规，可用 `rounded-md` |
| `packages/web/src/components/ui/select.tsx:84` | `rounded-[var(--radius-popover)]`，弹层 | 合规 10；可用 `rounded-popover` |
| `packages/web/src/components/ui/toggle-group.tsx:45` | `rounded-[min(var(--radius-md),10px)]`，sm 容器 | 当前为 8；合规，可用 `rounded-md` |
| `packages/web/src/components/ui/toggle.tsx:16` | `rounded-[min(var(--radius-md),12px)]`，sm | 当前为 8；合规，可用 `rounded-md` |
| `packages/web/src/components/ui/tooltip.tsx:46` | `rounded-[2px]`，旋转箭头 | 图形细节，保留；不要改成 8/10px 使箭头形变 |
| `packages/web/src/pages/channel.tsx:383` | `rounded-[var(--radius-icon)]`，返回按钮 | 合规 8；可用 `rounded-icon` |
| `packages/web/src/pages/channel.tsx:828` | `rounded-[var(--radius-popover)]`，提及浮层 | 合规 10；可用 `rounded-popover`，项目内菜单项另见 P2-07 |
| `packages/web/src/pages/chat.tsx:1863` | `rounded-[var(--radius-composer)]` | 合规 20；可用 `rounded-composer`，必须保留 composer 焦点例外 |
| `packages/web/src/pages/chat.tsx:2407` | `rounded-[var(--radius-bubble)]` | 合规 18；可用 `rounded-bubble` |

### 任意边线：11 处；粗边线：2 处

| file:line | 当前值 / 用途 | 判断与建议 |
|---|---|---|
| `packages/web/src/components/ui/card.tsx:79` | `border-t-[length:var(--hairline)]`，CardFooter | 合规既有发丝线；不可机械改为固定 1px |
| `packages/web/src/components/ui/chart.tsx:207` | `border-[1.5px]`，虚线数据指示符 | 图形标记，保留；不等于控件边线 1.5px |
| `packages/web/src/components/ui/combobox.tsx:172` | `focus-within:border-[var(--color-button-primary)]` | 合规色源；可收口为 `border-button-primary` 同状态变体；触发范围风险见后文 |
| `packages/web/src/components/ui/input-group.tsx:16` | `has-[…:focus-visible]:border-[var(--color-button-primary)]` | 合规陶土外框；可用同状态 `border-button-primary` |
| `packages/web/src/components/ui/input.tsx:11` | `focus-visible:border-[var(--color-button-primary)]` | 合规，与 `.cds-focus-glow` 同源；可收口，保留 invalid 优先级 |
| `packages/web/src/components/ui/select.tsx:43` | 同上 | 合规，可收口，保留 invalid 优先级 |
| `packages/web/src/components/ui/table.tsx:22` | `[&_tr]:border-b-[length:var(--hairline)]` | 合规既有表头线 |
| `packages/web/src/components/ui/table.tsx:43` | `border-b-[length:var(--hairline)]` | 合规既有表格行线 |
| `packages/web/src/components/ui/textarea.tsx:9` | `focus-visible:border-[var(--color-button-primary)]` | 合规，可收口，保留 invalid 优先级 |
| `packages/web/src/pages/channel.tsx:778` | `border-[var(--color-button-primary)]/50`，等待审批 | 陶土被用于非焦点状态边界，P2-05；建议 `line` |
| `packages/web/src/pages/chat.tsx:3252` | 同上 | P2-05，与频道同时收口 |
| `packages/web/src/components/knowledge-citations.tsx:695` | `border-l-2 border-line-strong`，引用竖线 | 2px 普通内容边线，无明示例外，P2-08 |
| `packages/web/src/components/memory-review.tsx:1774` | `border-l-2 border-line-strong/70`，证据竖线 | 同类边线宽度/颜色不统一，P2-08 |

没有找到硬编码任意 hex / rgb 边框色类。两处审批边线仍取自变量，但“用了变量”不能证明其语义和阴影词汇合规。

### Ring / outline / shadow：8 处任意值

| file:line | 当前值 / 用途 | 判断与建议 |
|---|---|---|
| `packages/web/src/components/ui/calendar.tsx:175` | `group-data-[focused=true]/day:ring-[3px]` | P2-04；应归 2px 陶土单层焦点，不能只改数字而忽略继承的 Button 焦点 |
| `packages/web/src/components/ui/button.tsx:12` | `shadow-[var(--shadow-2xs)]`，default | 现有按钮轻阴影；可用已存在的 `shadow-2xs`，不是自造阴影 |
| `packages/web/src/components/ui/button.tsx:14` | 同上，solid | 同上 |
| `packages/web/src/components/ui/combobox.tsx:172` | `focus-within:shadow-[var(--shadow-focus-glow)]` | 合规阴影令牌；可用同状态 `shadow-focus-glow`，触发范围见风险 |
| `packages/web/src/components/ui/input-group.tsx:16` | `has-[…:focus-visible]:shadow-[var(--shadow-focus-glow)]` | 合规外框焦点；可用同状态 `shadow-focus-glow` |
| `packages/web/src/pages/chat.tsx:2407` | `shadow-[var(--shadow-bubble)]` | 现有气泡阴影令牌；可用 `shadow-bubble`，本轮不把它当新加阴影 |
| `packages/web/src/pages/chat.tsx:3252` | `shadow-[0_0_0_1px_color-mix(…35%…),0_0_12px_-2px_color-mix(…30%…)]` | P2-05，自行组合常驻陶土光晕；不应改名包装成新 token |
| `packages/web/src/pages/channel.tsx:778` | 同上 | P2-05，同一问题在两页重复 |

`outline-[…]` 为 0。`source-editor-inner.tsx:93` 的 `outline: 1px solid line-strong` 是括号匹配标记；`styles.css:339` 的 `2px Highlight !important` 是强制颜色模式适配，均不是自造普通焦点。

### 括号简写、CSS 与样式对象补查

- `calendar.tsx:26` 的 `--cell-radius` 引用 `--radius-md`；`:63`、`:69`、`:75`、`:85`、`:87`、`:88`、`:92`、`:97`、`:101`、`:175` 的 `rounded-(--cell-radius)` 及方向变体均来自同一 8px 令牌。范围中部 `rounded-none` 用于连续选区，不应强行补圆角。
- `chart.tsx:203` 的 `border-(--color-border)` 由 `:215` 数据色赋值，是图形指示符；不能替换成 `line` 丢失系列标识。
- `source-editor-inner.tsx:65` 搜索面板顶线为 `1px line`，`:74` 搜索输入/按钮圆角 `--radius-md` 为 8，`:79` 输入边线 `1px input`，`:86` 按钮边线 `1px line`，契约一致。
- `styles.css:305` 滚动条 thumb 的 `3px solid transparent` 配 `background-clip: content-box` 是滚动条留白，`:306` 的 9999px 与 `:542`、`:576` 的 50% 是圆形图形，不归普通控件越档。
- `styles.css:354`、`:355`、`:385`、`:386`、`:387` 为受保护“新建专家”扇形入口及插画卡片的边线、圆角和轻阴影；只登记，不安排修改。数字分身入口、工牌特例、品牌与插画同样保留。

## 焦点契约核对

### 已有一致实现与覆盖路径

| 机制 / 场景 | file:line | 源码结论 |
|---|---|---|
| 全局兜底 | `packages/web/src/styles.css:281` | 单层 `2px solid ring` + offset 2；没有显式焦点类的普通链接/按钮仍有兜底，不能按“没写 ring”判缺焦点 |
| 强制颜色 | `packages/web/src/styles.css:337` | `Highlight !important` 恢复系统轮廓，修改局部 outline 时必须保留 |
| Input / Textarea / Select | `packages/web/src/components/ui/input.tsx:11`、`textarea.tsx:9`、`select.tsx:43` | `outline-none` + 陶土边 + `cds-focus-glow`，不叠 ring-2；invalid 保留 danger 边并补 2px outline |
| 输入微光公共规则 | `packages/web/src/styles.css:619` | `:focus-visible` 下边框陶土、阴影 `--shadow-focus-glow` |
| InputGroup | `packages/web/src/components/ui/input-group.tsx:16`、`:109`、`:122` | 外层用真实 control 的 `:focus-visible` 承担边框/阴影；内部 `border-0 shadow-none`，不该给内部重新加 ring；invalid outline 归外层 |
| Composer | `packages/web/src/pages/chat.tsx:1863` | 外框维持 `input` 边，换 `shadow-composer-focus`，为批准例外；不要机械套普通微光 |
| Combobox 多选 | `packages/web/src/components/ui/combobox.tsx:172`、`:202`、`:218` | 输入自身 `outline-none`、父容器有微光；移除按钮继承 Button ring；父子同时触发风险单列 |
| SourceEditor | `packages/web/src/components/source-editor.tsx:48`、`:53`、`:54`、`:70` | 常态父框 `focus-within:border-input-focus`，错误态父框 outline；fallback textarea 不另画 outline |
| CodeMirror | `packages/web/src/components/source-editor-inner.tsx:40`、`:47`、`:81` | 正文 outline 被父框取代；搜索输入独立 `input-focus` 换线；搜索按钮走全局兜底，父框 `focus-within` 范围见风险 |
| Button、Toggle、Tabs | `packages/web/src/components/ui/button.tsx:6`、`:12`、`:14`；`toggle.tsx:6`；`tabs.tsx:51`、`:67` | `ring-2 ring-ring` 与 outline 抑制配套；default/solid 有背景色 offset 2，invalid 不吞焦点 |
| Checkbox / Switch / Radio | `packages/web/src/components/ui/checkbox.tsx:10`；`switch.tsx:18`；`radio-group.tsx:20` | checked 用独立 2px outline + offset，取消内部 ring；Radio 未选中换既有边框色，为批准原语例外，不补 ring |
| 卡片式 FieldLabel | `packages/web/src/components/ui/field.tsx:97` | 外层 label 单层 ring，以上三个控件有对应内部抑制；不要移除其中一半 |
| Slider | `packages/web/src/components/ui/slider.tsx:46` | 焦点在 thumb 内原生 input，使用 `has-[:focus-visible]`，环出现时边透明且内部 outline 被抑制；符合门禁 C |
| 其他共享交互 | `packages/web/src/components/ui/accordion.tsx:31`；`trace.tsx:14`、`:99`；`badge.tsx:7`；`resource-page.tsx:78` | 正常分支均有单层陶土 ring 与 outline 抑制；Badge destructive 覆盖另列 P3 |
| 菜单/选项 | `packages/web/src/components/ui/dropdown-menu.tsx:63`、`:88`；`select.tsx:113`；`combobox.tsx:134`；`components/conversation-search.tsx:194` | 方向键高亮通过 `focus:bg-accent` / `data-highlighted:bg-*` 表达；`outline-hidden/none` 有替代高亮，不能直接报缺焦点或强加第二圈 |
| Toast / 操作 / 关闭 | `packages/web/src/App.tsx:24`、`:32`、`:35` | 保留单层 outline；操作按钮明确 `outline-solid!`、`ring-0!`、`shadow-none!`，避免 Button 与 Sonner 焦点叠加 |
| 知识库整卡链接 | `packages/web/src/pages/knowledge.tsx:144` | 使用 inset ring 降低 Card overflow 裁切风险，源码路径存在；未测实际渲染 |
| 页面自有 ring | `packages/web/src/components/data-table.tsx:193`、`memory-review.tsx:1255`；`pages/agents.tsx:693`、`:4130`、`:4824`；`pages/knowledge-detail.tsx:3869`；`pages/knowledge.tsx:863`；`pages/plugins.tsx:465` | `ring-2 ring-ring` 与 outline 抑制配套；圆角不合规部分另列 |
| OpenUI 交互 | `packages/web/src/openui/components/forms.tsx:716`、`:796`；`layout.tsx:484`、`:515`；`shared.tsx:237`；`charts.tsx:367` | 同样使用 `ring-2 ring-ring` 与 outline 抑制，没有另造普通焦点色 |
| 数据图表入口 | `packages/web/src/components/ui/chart.tsx:65` | 图表 surface 有 2px ring 色 outline；内部图层 outline-hidden 不足以据此判整个图表无焦点 |
| 代码块/原文折叠 | `packages/web/src/components/code-block.tsx:121`、`:167` | 折叠触发器有 ring 与 outline 抑制；`:137` 的可聚焦滚动区保留全局兜底 |

### 只读状态

没有发现以 `readOnly` 为条件删除普通 Input / Textarea / SourceEditor 焦点样式的源码分支。只读不等于 disabled，不建议为了“不可编辑”将其移出键盘序列。

- `packages/web/src/pages/accounts.tsx:859`：只读业务 ID 使用共享 Input，仍继承微光。
- `packages/web/src/pages/runtime-environment-detail.tsx:504`、`:515`：Dockerfile 快照与构建日志使用只读 Textarea，仍继承微光。
- `packages/web/src/pages/skills.tsx:736`、`:780`、`:803`、`:814`、`:1045`，以及 `pages/servers.tsx:2285`、`:2311`、`:2335`、`:2351`、`:2369`、`:2401`、`:2431`：只读状态传给已有输入/编辑器，不在页面额外抑制焦点。
- `packages/web/src/components/source-editor-inner.tsx:170`、`:171`、`:215`、`:216`：`readOnly` 只禁止文档修改，`editable` 由 `disabled` 决定；只读 CodeMirror 仍可聚焦，外框承担边线信号。
- 纯展示文字/Badge、hidden 文件上传输入、`tabIndex={-1}` 的程序定位目标不等于“缺少可见焦点的只读按钮”；真正禁用控件不要求进入 Tab 序列。

结论仅是源码路径有替代焦点信号；不据此宣称所有只读状态均已实屏验收。

### 待浏览器确认的焦点风险（不计为已确认 P1/P2）

| file:line | 可复核风险 | 后续最小验证与实现约束 |
|---|---|---|
| `packages/web/src/components/ui/combobox.tsx:172`、`:202` | 外框 `focus-within` 覆盖 Chip / Remove，内部移除按钮又有 Button ring；存在父框微光与内部环同时出现的路径 | 在专家配置多选框按方向键/Tab 定位 Chip 与移除按钮；读取父框 boxShadow 与内部 ring/outline。修复应按实际聚焦主体收窄选择器，不直接砍掉内部按钮焦点 |
| `packages/web/src/components/ui/input-group.tsx:16`；`input.tsx:11`；`textarea.tsx:9`；`select.tsx:43`；`combobox.tsx:172` | invalid 聚焦保留 glow 规则同时添加 outline；错误 outline 是否与微光呈双信号尚未实测 | 普通/invalid 各读 borderColor、boxShadow、outline；如出现重复信号，只在 invalid 分支抑制普通微光，保留 danger 边与 outline，不加 ring |
| `packages/web/src/components/agent-picker.tsx:88` | field 触发器继承 Button `aria-invalid:border-destructive`，自身抑制 ring，但未显式补 Select 同款 invalid outline | 在带 `aria-invalid` 的“执行专家”字段聚焦检查 danger 边、微光与 outline；不能仅因有 glow 就认定错误态契约一致 |
| `packages/web/src/components/source-editor.tsx:54`；`source-editor-inner.tsx:81`、`:86` | 编辑器父框 `focus-within` 也命中搜索子控件；搜索框换线、搜索按钮全局 outline 可能与父框同时表达焦点 | 打开查找/替换面板逐个 Tab，正常与 invalid 各测；如果重复，应区分正文编辑区焦点和搜索工具焦点，不删除全局兜底 |
| `packages/web/src/components/ui/card.tsx:15`；`pages/agents.tsx:693`；`components/code-block.tsx:115`、`:121` | overflow-hidden 可能裁切靠边的外圈焦点；知识库已用 inset，但其它组合仍需确认 | 在当前卡片名称、代码折叠触发器处实测 outline/ring 可见范围；不要全局去掉 overflow，破坏图片裁切 |
| `packages/web/src/components/app-shell.tsx:621` | 收起账号链接为圆形；规范另写账号触发器 8px，也允许头像圆形，当前节点兼有账号入口与头像表现 | 先确认其属于账号触发器还是头像表面；本轮不擅改侧栏收起态或把它并入普通导航条目 |
| `packages/web/src/components/ui/combobox.tsx:106` | 弹层对内部 InputGroup 提供 `border-input / shadow-none` 后代规则，和输入聚焦规则共同参与级联 | 打开 AgentPicker 搜索，检查聚焦时 computed borderColor / boxShadow；不能只看两个文件各自有 focus 类就宣称最终生效 |

### `lint:focus` 实施风险

`packages/web` 源码当前不违反门禁；下面是后续修改必须保持的现有约束，不是建议新增门禁。

1. `scripts/check-focus-contract.mjs:9`、`:39`：Input、Textarea、RadioGroup、Select、Combobox、InputGroup 六文件任何行出现 `ring-2` / `ring-3` 都会命中规则 A，包括错误态。修复输入焦点使用边框/现有阴影与错误 outline，不能为方便给这六文件加 ring。
2. `scripts/check-focus-contract.mjs:46`：`focus-visible:ring-2` 所在行必须同时有 `outline-none`。这是按行检查，不理解组件继承、`cn`、跨行拼接或 CSS 级联；改换类字符串排版时也可能触发。反之，跨节点有 outline-none 的同一行也不能证明 DOM 焦点正确。
3. `scripts/check-focus-contract.mjs:59`：Slider 的 thumb 必须继续满足 hover / active / `has-[:focus-visible]` 三态单层 ring-2、border-transparent、内部 input outline-none；不能改成 thumb 自身 `focus-visible`。
4. 日历 `group-data-[focused=true]/day:ring-[3px]` 不在输入文件集合且不匹配规则 B 的字面模式，因此基线通过并没有证明它合规。禁止通过放宽脚本来保留 3px。
5. 门禁不校验圆角、ring 色透明度、实际 focusability、只读路径、CSS/CodeMirror 的焦点、ring 是否被父容器裁切或 invalid 是否叠 glow。`lint:contract` 通过同样不能替代这些视觉证据。

## 边线、分隔与同类圆角复核

- **边线色大体同源。** `border-line`、`border-border`、裸 border、`bg-border` / `bg-line`、`divide-line` 通过别名与全局默认色共享 `line`。`ui/separator.tsx:12`、`ui/dropdown-menu.tsx:110` 是固定 1px 分隔，`ui/table.tsx:22`、`:43` 和 `ui/card.tsx:79` 用既有 hairline；这是密度策略差异，不是颜色漂移。
- **卡片表面不要与列表/工作面混为一谈。** `ui/card.tsx:15`、`:16` 统一 12px + `cds-card-surface`；`pages/roles.tsx:741` 的表格容器、`routes/s.$shareId.tsx:184` 的阅读容器，以及 `pages/agents.tsx:1477`、`:1487`、`:1497`、`:1587`、`:2792`、`:3926`、`:3934`、`:3945`、`:3956` 的配置工作面使用 ring-1。专家配置 work面 ring 是 `DESIGN-SYSTEM.md:247` 明示布局，不在本轮擅加卡片投影。
- **行与分区线颜色一致。** `components/page.tsx:84` / `:119`、`pages/personal-profile.tsx:127`、`pages/personal-security.tsx:318` / `:396`、`components/personal-memory-panel.tsx:360`、`pages/servers.tsx:991` / `:1129`、`pages/agents.tsx:4498` / `:4618`、`pages/channels.tsx:84` 都走上述 1px + line/default，未发现为调行高而额外叠 border 的明确证据。
- **可疑重复边界集中在实例覆盖。** `pages/agents.tsx:2731` 给已有 ring-1 的菜单再加 border；这会新增占用盒模型的边线，见 P2-03。本轮无法仅凭源码判断当初“加 border”的动机，不能声称已证明它被用来改尺寸。
- **引用竖线偏粗。** `knowledge-citations.tsx:695` 与 `memory-review.tsx:1774` 使用 2px，且 line-strong / line-strong/70 不一致；批准契约只列 tab indicator/focus 为 2px，见 P2-08。
- **圆角主体已统一。** 原语常规按钮、输入、菜单项、Tabs 都落 8px，Card 12、Dialog 16、浮层 10、Composer 20、气泡 18、Badge 6、Checkbox 4；`button.tsx` 的 `min(8px,10/12px)` 不应被误报为 10/12px。
- **0px 圆角有合法用途。** Sheet 贴边、line Tabs 容器、InputGroup 内部控制器、连续日期区间、工牌透明 Dialog 均有结构理由；会话搜索对完整输入外框的 0px 覆盖没有相应例外，单列 P2-06。
- **圆形与保护例外。** `AgentAvatar`（`components/agent-avatar.tsx:110`）、头像插画、Switch/Radio/Slider 几何、状态点与批准的胶囊分段保留。`pages/agents.tsx:822` 的透明工牌 Dialog 与 `:1032` 的证件照片属于明确工牌特例，不按普通 Dialog/头像统一改造。`openui/components/layout.tsx:458` 是通用列表缩略图，不据其 8px 推断成“头像应该变圆”。

## 明确偏差清单

建议只改视觉属性与对应过期说明，不改组件职责、布局、按钮权限、交互顺序或受保护元素。

| ID / 等级 | file:line | 现状 | 建议 | 风险 / 验收重点 |
|---|---|---|---|---|
| P2-01 | `packages/web/src/components/ui/input-group.tsx:72`、`:74` | xs / icon-xs 圆角 `8−3=5px`，共享 Button 同档为 8px | 两处使用既有 8px 档；保留尺寸、variant、内距与 ring | 搜索清除按钮、会话搜索、Combobox 清除/开关、Composer 均受影响；无需改调用方高度，不给输入原语添加 ring |
| P2-02 | `packages/web/src/components/data-table.tsx:193`；`packages/web/src/components/memory-review.tsx:1255` | 图标按钮分别 `rounded-tag` / `rounded-sm`，均 6px | 统一 8px `rounded-icon`，保留原有 ring / outline 抑制 | 表格列拖拽键盘路径与“移除所选来源”仍可用；不能误套 sidebar 收起态 6px 例外 |
| P2-03 | `packages/web/src/pages/agents.tsx:2731` | 更多菜单额外声明 `rounded-card` 12px 并新增 border；共享浮层已有 10px、ring-1、overlay 阴影 | 删除实例圆角/边框/等价阴影覆盖，消费原语 10px 与既有边界；保留 `w-40` 等布局值 | `cn` 实测保留 `rounded-[var(--radius-popover)]` 与 `rounded-card` 两类，不能假定末项获胜；实屏确认 10px 与菜单宽度。移除 border 后复核内容空间，不用 padding 补偿改批准几何 |
| P2-04 | `packages/web/src/components/ui/calendar.tsx:175` | focused day 额外 ring-[3px] / ring-ring/50，与 Button 的 focus-visible:ring-2 并存 | 统一 2px 陶土单层焦点，核对选中填充的背景色间隔与键盘/鼠标状态 | 同一 box-shadow 层的冲突不等于已证实“双环”；需要实测日历方向键、范围选择。保留 outline 抑制，避免触发门禁 B |
| P2-05 | `packages/web/src/pages/chat.tsx:3252`；`packages/web/src/pages/channel.tsx:778` | 等待审批时常驻自造陶土描边 + 光晕，用动作/焦点语言表达状态，两页重复 | 保留“等待授权”文字、警示图标与批准动作，容器边线回 `line`，移除自造光晕；不要新增审批阴影 token | 不得改变批准/停止逻辑、等待状态语义、权限和卡片布局；本项不要求改造批准按钮 |
| P2-06 | `packages/web/src/components/conversation-search.tsx:114` | 完整搜索 InputGroup 以 `rounded-none border-0 border-b` 改成 0px 下划线输入，与全站 8px/1px 外框不一致 | 取消实例形状/边线覆盖，复用 InputGroup；保留弹层内已批准布局与搜索键盘逻辑 | 不借此重排弹窗；读取搜索输入 focused / clear-button focused 两态，避免给内部 Input 补第二圈 |
| P2-07 | `packages/web/src/pages/channel.tsx:839` | MentionMenu 每项无圆角类，默认直角；同类菜单项为 8px | 菜单项采用既有 8px 档，保持 listbox/option、列表宽度与输入选中语义 | 父层 overflow、键盘 Enter/方向键与鼠标选择仍需确认；不能顺带换掉菜单交互实现 |
| P2-08 | `packages/web/src/components/knowledge-citations.tsx:695`；`packages/web/src/components/memory-review.tsx:1774` | 引用/证据竖线 2px，line-strong 与 line-strong/70 不统一 | 统一 1px `line` 内容边线；不变文本与标记背景 | 细线会改变一像素内容起点，保留现有 padding 并检查长引用换行；若产品另批引用线例外，再按批准值实施，不私自推翻当前契约 |
| P3-01 | `packages/web/src/pages/ops.tsx:1086` | Dialog 中 sticky footer 使用 `rounded-b-xl`（12px），父 Dialog 16px | 底角跟随 `--radius-dialog`，不改 sticky / 内外距 | 需在 footer 与 Dialog 底边对齐、短视口滚动时确认是否露出底色；不调整已批准表单几何 |
| P3-02 | `packages/web/src/components/ui/input-group.tsx:25` | addon 内 kbd 的计算圆角为 3px，当前没有实际 `<kbd>` / 对应子节点调用 | 若保留此支持分支，改为现有标签 6px；没有必要新造 3px token | 当前潜伏样式，不宣称已有用户可见问题；不要为证明它专门新增业务 UI |
| P3-03 | `packages/web/src/components/ui/badge.tsx:15` | destructive 变体将 focus ring 改为 destructive/20，普通契约为 ring-ring | 仅统一该变体焦点色，保留危险文字/背景语义 | 当前未找到业务使用 destructive Badge 的可聚焦 render；属于共享默认值偏差，不宣称焦点已不可见；不扩成颜色重设计 |
| P3-04 | `packages/web/src/components/ui/carousel.tsx:187`、`:217` | 共享 icon-sm 导航按钮默认 rounded-full；业务调用意图覆盖为 rounded-icon | 共享默认值统一 8px；核对 `openui/components/layout.tsx:418`、`:419` 与 `shared.tsx:193`、`:194` 的冗余覆盖 | `cn` 对自定义语义类不保证冲突去重，需实测最终 CSS；不改变轮播几何、交互或内容宽度。调用方清理另批，不和三文件混在一批 |
| P3-05 | `packages/web/src/components/app-shell.tsx:603`；`pages/agents.tsx:2730`、`:4127`；`styles.css:165`、`:280` | 说明仍写账号 7px、菜单 16px、草稿 9px、输入普遍中性聚焦、焦点兜底中性；实际分别为 8px、10/12px 冲突、8px、普通输入陶土、ring 陶土 | 在相应源码文件被实际修复时删除或纠正过期说明，不新增注释；本轮只在本文登记 | 避免后续执行者按过期数字把实现改回旧档；这不是授权重写样式或批量修改规则文件 |

## 文档 / 代码冲突与保留决定

1. `docs/DEV-WORKFLOW.md:45` 仍称配色与控件参考 Qoder，与当前 `packages/web/DESIGN.md:224` 和本任务批准的 CDS 基线冲突；本轮以 CDS 为准，只在本文登记，不改范围外文档。
2. `docs/DESIGN-SYSTEM.md:247` 明示专家配置工作面 `ring-1 ring-line`，但 `DESIGN.md:412` 对标准卡片要求 `cds-card-surface`；按“配置工作面”与标准 Card 的实际职责区分，保留已批准几何，不把它登记成需要全页加阴影的偏差。
3. `docs/DESIGN-SYSTEM.md:94` 与 `DESIGN.md:376` 概括为 1px 边线；实现 `styles.css:197`、`:202`、`:208` 有 DPR hairline，且 `DESIGN.md:361` 已明确说明。属于文档简写差异，按现有 hairline 保留，不把 Retina 改粗。
4. `DESIGN.md:374` 明确 Checkbox 4px，frontmatter `:105` 的命名圆角表未单列 checkbox；现有 `rounded-[4px]` 是有权威依据的例外，不能以“任意值”为由消除。
5. `DESIGN.md:389` 对实底按钮规定有 offset 的 ring，而 `:402` 对选中 checkbox/radio/switch 另规定 outline；日历选中 day 的填充仍应核对所适用的焦点信号与间隔。本文不预设所有选中按钮都必须改 outline。
6. 源码过期说明全部集中列在 P3-05；本文不修改这些文件。账号入口圆形与 8px 触发器描述的歧义列为待实测/分类风险，不擅改账号外观。

## 验证证据与下一步

- [x] 审计前运行两项基线门禁，均通过。
- [x] 全量列出 51 处任意值与 2 处粗边线；补查括号简写、CSS、CodeMirror 样式对象与原生控件。
- [x] 追踪共享原语与只读调用方，区分外框焦点、全局兜底、菜单高亮与缺陷。
- [x] 使用现有 `cn` 包运行只读合并探针：5px InputGroup 圆角被保留；Agent 更多菜单的 10px 任意值类与 12px 语义类同时保留；Calendar 的两种状态 ring 类同时保留；InputGroup 内部 `shadow-none` 与 `cds-focus-glow` 同时保留。此探针证明类列表，不证明最终 CSS 绘制。
- [x] 只写本文，源码修复未实施。没有创建单元/集成测试；文档审计不需要新增测试，也未运行 typecheck/build 冒充视觉验证。

本任务下一步：无；审计交付完成。若后续授权实施，按下表逐批修复，每批复跑 `pnpm lint:focus` 与 `pnpm lint:contract`，涉及共享原语的批次再按影响范围运行现有 web typecheck，并取得相关真实焦点/计算样式证据。不能以本文静态推导替代后续验收。

## 分批建议（10 批，低风险优先，每批 1–2 文件）

路径均相对 `packages/web/src/`。批次是后续建议，不代表本轮已修改；语义 utility 纯写法收口不单开全站大批。只读审计风险表中尚未确认的问题先实测，不夹带为这些批次的确定修复。

| 批次 | 文件（最多 2 个） | 对应项 / 内容 | 验收重点 |
|---|---|---|---|
| B1 | `components/data-table.tsx`、`components/memory-review.tsx` | P2-02；顺手完成 memory 的 P2-08 线宽 | 图标按钮 8px、单层焦点，列拖拽与来源移除；只动这两文件 |
| B2 | `components/knowledge-citations.tsx`、`pages/ops.tsx` | P2-08 剩余引用线；P3-01 footer 底角 | 引用 1px line 与长文本、Dialog 底角/短视口滚动，保留 padding 与 sticky |
| B3 | `components/ui/input-group.tsx` | P2-01、P3-02 | xs/icon-xs 8px；全站 SearchInput 清除、会话搜索、Combobox 与 Composer 原有焦点不回归 |
| B4 | `components/conversation-search.tsx` | P2-06 | 外框 8px/1px；清除、方向键/Enter、长列表与关闭后焦点 |
| B5 | `pages/agents.tsx` | P2-03；P3-05 该文件说明 | 更多菜单仅一套 10px 圆角/边界；不触碰两张受保护入口、工牌、配置工作面几何 |
| B6 | `pages/channel.tsx`、`pages/chat.tsx` | P2-05、P2-07 | 审批卡去自造光晕，频道提及项 8px；保留审批/停止逻辑与聊天布局 |
| B7 | `components/ui/badge.tsx` | P3-03 | destructive 可聚焦 render 的陶土环与危险语义并存；不新增业务 Badge |
| B8 | `components/ui/carousel.tsx` | P3-04 共享默认值 | 8px 图标按钮；两个现有 OpenUI 轮播调用的最终计算圆角、上一张/下一张 |
| B9 | `components/app-shell.tsx`、`styles.css` | P3-05 剩余过期说明，只删除或纠正既有说明 | 不改视觉值、不碰受保护插画/品牌、不全局重排 CSS；其它原语可收口写法留在其实际修复批次 |
| B10 | `components/ui/calendar.tsx` | P2-04，状态交叉最多，最后处理 | 单日/范围、selected/unselected、键盘/鼠标、Popover、2px 焦点及实底间隔；两项门禁通过不代替实测 |
