# 输入控件修正：Qoder 单一实施契约

## 状态与目标

**最终真实 CU 结果已合并，实施契约已冻结并落地：A/B/C/D 四包全部完成。源码 Opus review a085 通过；规范/测试 Opus review a029 除 `packages/web/DESIGN.md` 强边界一句外通过，该句已修正，并经 Opus 定点复核关闭；本轮源码、规范与测试 review 整体通过，无剩余 finding。** 用户要求输入边线及同根因控件参考 Qoder CN 桌面浅色界面，只修控件外观及真实焦点缺陷，保留布局、尺寸、功能与现有交互原语。

本文是可直接派发的最终契约。已有证据足以确定普通输入 focus `#BDBDBD`、composer focus `#DDDDDD`；未知状态如实记为 PACE 适配或未取得，不要求完整四态、invalid、disabled 参考集才开工。不再研究、不新取证、不重审全 repo、不再向用户确认或索图。本轮只做文档收尾；实施已按 A/B/C/D 四包并行完成。

## 基线与环境

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/qoder-controls-refinement`；分支 `feat/qoder-controls-refinement`；HEAD `e61360e`（`origin/main`，PR #124）。
- 原有未跟踪的本任务文档；`.vitest/json/output.json` 是自动报告，已恢复基线（`baselineclean`），不纳入源码交付。
- web `5190` 从本树启动，API `3000`；旧端口 `5173` 不代表本任务。浏览器 space 73 已 handoff 给 agents 页面，不抢占、重开或操作。
- 不改凭据、后端、数据库、运行配置、依赖；没有 commit/push/PR/merge 授权。
- 本轮只做文档收尾；实现与验证按 `ub-mode` 与 `docs/DEV-WORKFLOW.md` 执行，均已完成。

## 已核实根因与影响

| 位置 | 事实与处理 |
|---|---|
| `packages/web/src/styles.css` | `input` → `line-strong #767676`，与 `control-boundary #767676` 同值；输入聚焦又用 `ring #0D0D0D`。拆输入状态令牌，不全局调浅 `line-strong`、`control-boundary` 或 `ring`。 |
| `components/ui/input.tsx`、`textarea.tsx`、`input-group.tsx`、`select.tsx`、`combobox.tsx` | 同根因输入家族；搜索、composer、菜单搜索和 chips 容器一起覆盖，禁止逐页补色。 |
| `components/conversation-search.tsx`、`pages/chat.tsx` | 搜索弹窗内部去掉重复完整输入框，沿用分隔线表达区域；composer 只在现有 InputGroup 样式边界增加唯一必要的语义令牌覆盖。两文件均归 B。 |
| `components/source-editor.tsx`、`source-editor-inner.tsx` | 外壳及 Suspense textarea、CodeMirror 查找输入同源；匹配括号仍使用 `line-strong`，不得误改。 |
| Input / Textarea / InputGroup / SourceEditor disabled 填充、Switch off 轨道 | 误用 `input` 作背景；改输入令牌前解耦，保持当前渲染色，不顺带改变禁用或开关视觉。 |
| `components/ui/toggle.tsx` | outline Toggle 误用 `border-input`，且焦点依赖深边框、透明环；归回动作控件边线与焦点环。 |
| `components/memory-review.tsx:776` | 记忆列表容器误用 `border-input`，改用普通列表 `border-border`；不改周围业务或布局。 |
| Button / Toggle / Checkbox / Switch invalid | `aria-invalid:focus-visible:ring-0` 吞掉焦点；Button 还清零 offset。错误边框不等于焦点，修复二者共存。 |
| 普通 outline Button、浮层、菜单、主题 selected 卡 | 浮层／菜单浅 `#E6E6E6` 保持；模型文字按钮默认无框、hover 灰保持；主题 selected 卡的黑边属于选中语义，保持。深色主操作、普通图标、文本与数据系列不改。 |

已浏览器核实的 PACE 基线：搜索默认 `#767676`、聚焦 `#0D0D0D`；筛选、表单 input/textarea、composer 默认 `#767676`。沿用已有记录，不重做页面操作。

## 最终真实 CU 证据与明确限制

参考为 **Qoder CN 桌面浅色，2640×1600 原图、Retina 2×**。证据目录：`/tmp/qoder-controls-reference-20261030/`；它是现场证据，不是仓库持久附件。以下合并用户提供的最终 CU 结果，并替代早期报告中的状态误判与初步采样。像素是实际画面的边缘混色，不等于 Qoder 源码 CSS token；表内 `#E6` 等简写表示 `#E6E6E6`。

| 证据 | 最终事实 | 契约含义与限制 |
|---|---|---|
| `01-blank-default.png` | composer 默认左右直边 `#E6/#E7`，底边 `#E7/#E5`。 | 默认映射 PACE 现有 `line #E6E6E6`。不复制顶端抓取条。 |
| `16/18` | 焦点在 composer 内，左右边 `#DD/#DE`，底边 `#DD`。 | composer focus 采用 `#DDDDDD`，是依据实测直边的中性映射，不宣称源码 token。 |
| `17` | 焦点移出至“清空当前工作目录”，指针仍在 composer 内；左右边恢复 `#E6/#E7`。 | 与 `16/18` 配对证明边线加深随输入焦点消失，指针留在内部不会保持深边；composer hover 不加深。hover 只影响顶端抓取条，本轮不复制抓取条。 |
| `03/05` | `03` 按 Esc 后并未失焦；`05` Shift+Tab 到的是计划模式。 | 不把 `03` 当失焦证据，也不把 `05` 文件名或操作称为输入 keyboard focus 证据。 |
| 设置搜索 `13/14` | `13` 白填充、默认边缘 `#E6E4E7`；`14` 聚焦边缘有 `#BEBBB4/#BEBAB9`，上 `#BBBBB3`、下 `#BAB8B9`、右 `#BFBBBA`。 | 普通输入 focus 采用中性 `#BDBDBD` 合适：保留实际加深幅度，消除近中性色的通道偏差；明确标注 **PACE 近似映射，非精准 Qoder token**。没有独立设置搜索键盘聚焦证据。 |
| Select `13/15` | 边线 `#E6`，展开不变；关闭状态的 keyboard focus 未独立取得。 | 默认 `input`，打开本身不触发加深；实际键盘 focus 使用 PACE 可辨焦点适配 `input-focus #BDBDBD`，不得宣称复刻 Qoder 键盘态。 |
| 搜索弹窗 `06/07` | 内部输入无完整框，仅 `#E5` 分隔线；打开已自动聚焦，点击后仍聚焦。 | 去内部重复完整边框，分隔线映射现有 `line #E6E6E6`；不能用 `06→07` 证明默认到焦点的变化。 |
| 模型按钮与菜单 `08/09/10/11` | 模型文字按钮默认无框、hover 灰；menu 外壳为浅 `#E6`。 | 保持当前按钮及菜单外壳，保留键盘高亮；不因输入边线修正改造浮层。 |
| 全部已取证输入 | 没有任何输入黑边。 | 普通输入焦点与全局黑色 `ring` 拆开；主题 selected 卡黑边不属于输入，保持。 |

CU hover move 工具不支持，没有独立取得完整四态配对；这不抹掉 `17` 对 composer 焦点与指针的有效分离。不新增普通 input hover 变化或 `input-hover` token。invalid、disabled 与 Select 关闭键盘焦点未完整取证：前两者只修实际缺陷、保留现有语义，后者明确采用 PACE 焦点适配。**这些限制均不阻塞用户已明确授权的修正。**

## 最终实施契约

### 最小令牌集合与不变量

| 令牌／角色 | 冻结值或约束 |
|---|---|
| `--color-input` | `var(--color-line)`，即 `#E6E6E6`；输入家族默认边线。不是宣称每个 Qoder 控件像素都同值。 |
| `--color-input-focus` | `#BDBDBD`；普通输入聚焦的 PACE 中性近似映射，非精准 Qoder token；Select 未取得的关闭键盘态也用这一可辨焦点适配。 |
| `--color-composer-focus` | `#DDDDDD`；仅 composer 文本控制器聚焦使用，来自 `16/17/18` 焦点分离实证。由现有 InputGroup 样式边界承担，禁止硬编码页面颜色。 |
| input hover | 无新增 token、无新增加深规则；默认边线保持 `input`。composer hover 也不加深，不实现抓取条。 |
| disabled 背景 | 从 `input/50` 改为独立于输入边线的 `control-boundary/50`，保留现有合成色、opacity 与禁用行为。只替换确有消费者，不新增同值别名。 |
| Switch off 轨道 | 从 `bg-input` 改为 `bg-control-boundary`，保留当前 `#767676`；on 继续 `primary`。本轮无 Qoder off 新设计证据，不借此改色。 |
| outline Toggle | 默认 `border-border`；正常与 invalid 键盘焦点都走现有 `2px ring-ring`，边线保留普通／危险语义；不再用输入焦点边线或透明环。 |
| 其余边线与焦点 | `line-strong`、checkbox/radio `control-boundary` 均保留 `#767676`；全局 `ring` 保留 `#0D0D0D`。普通动作的 hover/active/expanded/checked/selected 不变，主题 selected 卡黑边不改。 |
| 表面、几何、动效 | 保留当前表面、全部高度、内距、圆角、线宽、阴影、布局、滚动及 transition 时长；搜索弹窗只去重复框、沿用分隔线，不改尺寸。 |

默认输入边线定浅不会自动把透明背景改白；实际页面仍按现有纯白内容基底验收。不全局替换 `#767676`，不对所有 `border-input` 机械同改，不引入依赖、JS 键盘模式判断或主题开关。

**InputGroup 共享边界：** 普通组默认使用 `input-focus`；`packages/web/src/pages/chat.tsx` 的 composer 是唯一必要的页面覆盖，在现有 `className` 合并入口以同一文本控制器 focus 选择器切换为 `border-composer-focus`。不增加组件、不改尺寸，不为这个单点新增 variant；只有真实复用且现有边界无法表达时才允许最小 variant。覆盖须保留 invalid 优先级及禁用语义，由编译与实际 computed style 验证。搜索弹窗复用同一 InputGroup 的现有样式入口去完整边框，不给其它搜索全局取消边界。

### 各控件状态与焦点所有者

| 控件 | 默认／hover | 聚焦与打开 | invalid／invalid+focus | disabled／只读 |
|---|---|---|---|---|
| Input / Textarea | `input`；不新增 hover | `input-focus` 单层既有边线；保留 `:focus-visible` 原生匹配，不用 JS 区分输入方式 | 危险边框保留；真实 `:focus-visible` 再用 2px `ring` 色 outline、2px offset 表达焦点，错误边框不能代替焦点 | 禁用背景解耦，不因 hover/focus 加深；保留原生禁用、opacity；readOnly 不冒充 disabled |
| 普通 InputGroup / Combobox / chips / 菜单搜索 | 按原有职责由外层容器或实际输入组承担一层边线；无新增 hover | 文本控制器聚焦由既有外框表达 `input-focus`，内部不画第二层；Addon 按钮保留自己的键盘环；菜单搜索不能被 `border-inherit` 吞掉焦点 | 外框危险边线，真实文本 focus-visible 由外框 outline 表达；不让所有子项和容器同时画 | 禁用合成色解耦，内部透明；保留 Base UI 状态、data-slot、Addon 顺序与选择行为 |
| composer InputGroup | `input`；指针在内但文本失焦仍是 `input` | 文本控制器真实 focus-visible 时外框 `composer-focus`；Addon 获焦不冒充文本焦点 | 同普通 InputGroup；composer 覆盖不能压过危险边线或隐藏错误焦点 | 同普通 InputGroup |
| 搜索弹窗内部输入 | 无重复完整边框；区域分隔线用 `line` 映射参考 `#E5` | 保留真实自动聚焦、输入及键盘行为；无框外观只作用这一内部搜索，不删除全局焦点机制 | 沿用实际存在的错误语义，不制造错误态入口 | 保留现有行为 |
| SelectTrigger | `input`；无新增 hover | 真实 focus 使用 `input-focus`，属于 PACE 适配；仅展开不加深。保留 Base UI data 状态、菜单高亮及 Esc 焦点返回 | 危险边框 + 聚焦 outline | 保留禁用交互和 opacity，不增加未取证填充 |
| SourceEditor fallback / CodeMirror | 外壳 `input`，两种加载状态一致 | 原有外壳 focus-within 改 `input-focus`；内容区不重复轮廓；CM 查找文本输入自身映射默认／focus，按钮仍是动作控件 | 危险外壳边框；后代真实 focus-visible 触发 outline；fallback 与已加载编辑器一致 | 禁用背景解耦；ARIA 名称、readOnly、内容、快捷键、撤销栈与懒加载不改 |
| Button / Toggle | 既有动作状态；outline Toggle 改普通边线 | 现有 2px `ring`；深色实底保持 2px background offset | 删除吞焦点覆盖；危险边框与焦点环共存；深色 Button offset 不因 invalid 消失 | 保留禁用／aria-disabled |
| Checkbox / Switch | 未选边界／off 轨道保持原色，checked/on 保留 primary | 保留焦点机制；核对 FieldLabel 包裹选择器没有吞掉唯一环 | 危险边框与键盘焦点环共存；checked/on 不覆盖危险边框 | 保留 checked/on、disabled 与可访问状态 |
| RadioGroupItem | 不重做默认与选中视觉 | 原有 checked+focus outline 保留 | 仅核对 checked/uncheck × invalid+focus 的真实焦点；如发现新缺陷先报告 Opus，不借此扩大重设计 | 保留 |

普通输入浅中性聚焦边线是视觉契约；错误态额外 outline 是 PACE 必要焦点修正，明确不声称来自未采样的 Qoder 错误态。不能为“永远一层”让错误状态下焦点消失。

### 无障碍限制与测试诚实性

主源：[WCAG 2.2 Understanding 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)（已有记录：2026-10-30 查证，本轮未重新联网）。白底输入若仅靠边线识别，边线对相邻背景需至少 3:1；label 不自动豁免，聚焦后加深也不补救默认态不足。

本轮按 WCAG sRGB 相对亮度公式实算对白 `#FFFFFF` 的比值：默认 `#E6E6E6` **1.248:1**，普通 focus `#BDBDBD` **1.879:1**，composer focus `#DDDDDD` **1.358:1**，三者均低于 3:1。用户已明确 Qoder 视觉优先，这些是接受并公开记录的限制；“PACE 可辨焦点适配”表示状态有可见差别，不代表满足 3:1。**不能宣称输入边界、焦点对比或整页 WCAG AA 全达标。** 文本、主操作、checkbox/radio 强边线、全局焦点的原有要求保留；错误态用独立 outline 补焦点。

现有 `theme-contrast.test.ts` 将 `input` 与无障碍强边线混为一谈，`ui-focus-states.test.ts` 要求 invalid Button/Checkbox/Switch 无环、Toggle invalid 只留红边。这些是被新需求与真实缺陷替代的旧契约：更新时加入三种浅边线真实比值／已知限制断言，保留强边线与文本对比检查；将“隐藏焦点”改为“错误边框与焦点可区分”。不能删除对比检查、降低所有阈值或改标题冒充全部可访问。

## Sonnet 执行包（四包，单文件单 writer）

**四包已并行实施并完成。** 源码和测试均由 Sonnet，主会话只编排与验收。共享接口为 `input=#E6`、`input-focus=#BD`、`composer-focus=#DD`，无 `input-hover`；设计分歧回 Opus。以下文件归属互斥，不让其它包代写共享测试、主题或文档。

| 包 | 独占写入文件（路径相对仓库） | 责任与验收 |
|---|---|---|
| A：主题、证明与文档 | `packages/web/src/styles.css`；`packages/web/test/theme-contrast.test.ts`；`packages/web/test/ui-focus-states.test.ts`；`docs/DESIGN-SYSTEM.md`；`packages/web/DESIGN.md`；`packages/web/.impeccable/design.json`；`CLAUDE.md`；本任务记录；`scripts/check-focus-contract.mjs` 的契约说明 | 落定三个令牌；汇总 B/C/D 状态并更新生产 CSS 编译断言；同步配色、状态优先级、低对比及未知状态限制。`CLAUDE.md` 仅限用户授权的旧 `#767` 输入规范冲突作必要同步，以实际文本为准，不全局替换或修改其它规则；sidecar 仅同步 input/focus/composer、示例与相关说明。不改 B/C/D 源码。 |
| B：输入家族、搜索与编辑器 | `packages/web/src/components/ui/input.tsx`、`textarea.tsx`、`input-group.tsx`、`select.tsx`、`combobox.tsx`；`packages/web/src/components/source-editor.tsx`、`source-editor-inner.tsx`；`packages/web/src/components/conversation-search.tsx`；`packages/web/src/pages/chat.tsx`；`packages/web/test/conversation-search-ui.test.ts` | 输入边线、禁用解耦、invalid outline、CM 查找一起闭环；搜索弹窗去重复完整框、保留分隔线；chat 只改 composer 唯一必要语义令牌类，禁止改布局尺寸。保留接口和行为，向 A 提供最终 class/选择器/状态，不编辑共享 focus test。 |
| C：动作与非输入误用 | `packages/web/src/components/ui/button.tsx`、`toggle.tsx`、`checkbox.tsx`、`switch.tsx`；`packages/web/src/components/memory-review.tsx` | 修 invalid 吞焦点、Toggle 边线归位、Switch 轨道解耦、记忆列表边线；保留正常按钮、模型按钮、菜单浮层及主题 selected 卡外观；向 A 提供状态结果，不编辑主题和测试文件。 |
| D：Radio 焦点 | `packages/web/src/components/ui/radio-group.tsx` | 只补 invalid + focus 的 `outline-solid` 与焦点矩阵；不重做默认/选中视觉，不编辑主题和共享测试。 |

A/B/C/D 并行，**最终验证串行**，因为断言必须读取四包合并后的真实组件与主题。新增行为测试文件归 B，不建第二套焦点验证器或演示页。

## 验收与文档同步

1. **真实生产 CSS**：在现有 `ui-focus-states.test.ts` 扩展真实组件探针与 Tailwind 4 编译，验证实际获胜的默认／focus／invalid+focus／checked+invalid+focus；覆盖普通 `#BD` 与 composer `#DD` 的边界及危险态优先级，保留 Button helper、outline、solid 与 Toggle 正常回归。不只检查源码类名。现有 parser 会跳过 `:has/:where/:is`，InputGroup/Combobox 父子选择器须以 PACE 实页 computed style 验证，不扩建通用 CSS 模拟器。
2. **行为**：复用 SourceEditor 测试覆盖 fallback/已加载编辑、禁用/只读、可访问名称；实页完成输入、失焦、重新聚焦，Select/Combobox 开关/方向键/选择/Esc、错误字段再 Tab、Checkbox/Switch 键盘切换及禁用不可操作。焦点缺陷先落会失败的回归断言；纯像素用既有参考证据与实现后实页结果，不造模拟像素测试。
3. **PACE 实页**：实现后使用本树 `http://localhost:5190` 的可用浏览器上下文；浏览器 space 73 已 handoff 给 agents 页面，不抢占、重开或操作。采 composer、搜索弹窗、列表搜索/筛选、表单 Input/Textarea、Select/Combobox、SourceEditor 含查找、记忆列表；记录 activeElement、`:focus-visible`、computed border/background/outline/ring 与令牌一致性。只验证实现，不重新操作 Qoder 参考或索图；没有真实错误入口则用安全临时挂载真实组件，验后清理，不操作用户数据制造错误。
4. **几何回归**：同页面同尺寸比较控件矩形，确认颜色、搜索去重复框与新增 outline 未改 width/height/位置；不重做后端、布局或动效审计。普通 outline Button、模型文字按钮和菜单、主题 selected 卡、checkbox/radio 强边线作为保留项对照。
5. **文档同步**：A 更新 `docs/DESIGN-SYSTEM.md` frontmatter、§2.1/2.3/2.4、§9 及 composer/CM 条目；`packages/web/DESIGN.md` token 表、可编辑边界、Input/Focus/Invalid/Disabled、CodeMirror、Do/Don't、Known Gaps；`packages/web/.impeccable/design.json` 对应 token、focus、示例与说明；`CLAUDE.md` 用户授权的旧输入 `#767` 叙述。将“输入统一 #767”“focus 统一 ring”“错误不叠焦点所以隐藏环”替换成新角色与错误 outline 例外；强边线与全局 ring 原值保留。普通 focus 标 PACE 中性近似、Select 键盘态标 PACE 适配、composer 标实测映射，记录三种低对比。这些文件已由 A 更新；本轮只做收尾核对。

实现合并后的命令（从本 worktree 根运行，不固定跑后端全套）：

```sh
pnpm test:web packages/web/test/theme-contrast.test.ts packages/web/test/ui-focus-states.test.ts packages/web/test/source-editor.test.ts
pnpm --filter @agentport/web typecheck
pnpm --filter @agentport/web build
pnpm lint:focus
```

build 证明生产 Tailwind 能生成，测试证明覆盖的规则和行为，PACE 实页证明复杂选择器及视觉状态；三者不能互相替代。`lint:focus` 输入禁重复 ring 规则继续有效，错误态采用 outline 不需绕过守卫；过时注释只同步说明，不删规则。代码完成后由独立 Opus 仅 review 本契约改动范围及验证证据，不重审全 repo；未通过不提交。

## 当前验证与已替代项

- 已有旧基线：`theme-contrast.test.ts` 与 `ui-focus-states.test.ts` 共 2 文件、13 测试通过；安装后 typecheck 通过。它们仅证明旧 `#767` 契约，不是本方案验收。
- 本轮只合并用户给出的最终真实 CU 结果；未新增 Qoder 操作、截图采样、联网研究或全 repo 审计。只核对必要文件路径、InputGroup 现有样式边界与规范冲突位置，并计算上述三个对白对比值。
- 实施后的验证已补全：A/B/C/D 写入文件互斥，搜索弹窗、chat 与搜索行为测试归 B，CLAUDE 与 sidecar 同步归 A；源码测试、typecheck、build 与 PACE 实页均已按范围执行，结果见下方实施状态。
- 已替代决定：`17`“边框未明显变化、无法判断 hover”的初步结论被最终直边数据替代；设置搜索与 Select 早期混色采样由最终 CU 数据替代；完整四态补证、继续等待 CU 或 Codex、缺状态即返回用户的阻塞要求撤销。
- 已替代契约：默认输入 `#767676`、输入 focus 全部转全局黑色 ring、invalid 时清零焦点；按用户最新要求改为浅默认／分角色 focus／错误 outline，不能据此更改主题 selected 黑边。
- 文档／代码冲突：旧 DESIGN 与代码原本一致，但其输入 `#767`、统一黑色 focus 和错误吞焦点规则与最新契约冲突；根 `CLAUDE.md` 旧输入边界说明、DESIGN 快照及 `.impeccable/design.json` 旧 input/focus/示例已由 A 同步。未扩展到后端或布局。

## 下一步

**四包已实施并按范围验证，本轮源码、规范与测试 review 整体通过，交付未提交差异。** 源码 Opus review a085 通过；规范/测试 Opus review a029 的唯一文档 finding 已修复，并经 Opus 定点复核关闭。提交、推送、合并只在用户另行明确授权后执行。

## 实施状态（2026-10-31，四包完成、验证通过）

- A 已落地：`styles.css` 新增 `--color-input: var(--color-line)`、`--color-input-focus: #BDBDBD`、`--color-composer-focus: #DDDDDD`，无 `input-hover`；`line-strong`、`control-boundary`、`ring` 保持原值。`theme-contrast.test.ts` 记录三种浅边线真实比值（1.248 / 1.879 / 1.358）与低于 3:1 的已知限制，强边界继续 ≥3:1；`ui-focus-states.test.ts` 覆盖输入家族浅边线/输入焦点/错误 outline，以及 invalid 动作控件保留焦点环与实底 offset。
- 基线：C 开始前主会话已真实跑过 `theme-contrast.test.ts` 与 `ui-focus-states.test.ts` 共 13 通过。A 在 C 改造动作控件中途看到 2 个失败，是动作控件尚未改完的中间态时序，不否定该初始基线。
- A 收尾实测：`pnpm vitest run packages/web/test/theme-contrast.test.ts packages/web/test/ui-focus-states.test.ts packages/web/test/source-editor.test.ts` 3 文件 28 通过（其中 theme + focus 18）；`pnpm lint:focus` 通过；`pnpm --filter @agentport/web typecheck` 通过。测试仍使用现有受限 Tailwind 规则解析 helper，未扩建通用 CSS 模拟器。
- outline 可见性：Tailwind `outline-2` 只写 `outline-style: var(--tw-outline-style)`，旧 helper 会把被 `outline-none` 关掉的轮廓误判为可见；已最小修为解析 `--tw-outline-style` 并只接受 `solid`，新增“变量为 none 时不可见”的回归断言。B 已给 Input / Textarea / Select / InputGroup / Chips / SourceEditor 的 invalid + focus 补 `outline-solid`；D 给 radio 的 data-checked / invalid focus 补 `outline-solid`。
- 焦点/radio 矩阵：`ui-focus-states.test.ts` 强制校验获胜 `outline-style` 为 `solid`，不再只把 `var(--tw-outline-style)` 当可见；radio 覆盖未选中 / checked × invalid × focus 八种组合，保留普通未错误态行为。
- B/C/D 状态：B 的输入家族、SourceEditor、搜索与 composer 改动已落地；C 的 Button、Toggle、Checkbox、Switch、memory-review 改动已落地；D 的 radio focus outline 已落地。A 未编辑 B/C/D 源码。
- Radio 归属：旧记录的“仅待发现”已由 Opus 冻结为 D 单文件执行 `packages/web/src/components/ui/radio-group.tsx`；本记录只同步文档，不写该源码。未选中/选中 × invalid × focus 都用 2px `ring` outline + 2px offset，选中普通态仍为 `primary` 填充。
- PACE 实页（主会话采样）：search 默认 `#E6E6E6` / focus `#BDBDBD`，224×32、坐标 248,84 不变；筛选默认 `#E6E6E6`；表单 input/textarea 默认 `#E6E6E6`、name focus `#BDBDBD`；input invalid（临时 DOM `aria-invalid`，不提交数据）danger `#B42318` + solid 2px `#0D0D0D` offset 2；chat 默认 `#E6E6E6` / focus `#DDDDDD`，832×126、坐标 434,686 不变；invalid 外层 danger + solid 2px offset 2，内层 border 0 / outline 0，无第二层；chips 技能 focus `#BDBDBD`，916×32、坐标 512,398.5 与基线一致；CM 查找 focus `#BDBDBD`、outline none（旧全局黑 outline 已修正，`.cm-textfield` 仅文本命中 checkbox 不被压下）；搜索弹窗去完整边框、仅保留 bottom 1px `line`，聚焦 `#BDBDBD`；forced-colors 实测 textarea invalid focus outline solid 2px Highlight、offset 2px；菜单搜索默认 `#BDBDBD`，Esc 后焦点回到专家 trigger。未新建 Dialog，所有临时 aria 已还原，未改用户数据。
- 文档同步：`docs/DESIGN-SYSTEM.md`、`packages/web/DESIGN.md`、`.impeccable/design.json`、根 `CLAUDE.md` 的 input / input-focus / composer-focus 与错误 outline 已同步；sidecar 仅保留 `line-strong` / `control-boundary` 的 `#767676`，未发现把 `#767676` 当输入边线的陈旧声明。`packages/web/DESIGN.md` 强边界条目已删去与全局焦点环 `#0D0D0D` 冲突的“及全局焦点环”，只保留 checkbox/radio、off 开关轨道与需可辨边界场景的用途。
- 最终验证（主会话）：`theme-contrast` + `ui-focus-states` 18 通过；定向 web 回归 11 文件 185 通过；`typecheck`、`build`、`lint:focus`、`lint:contract`、15 个改动源码的 Biome 检查、`git diff --check` 均通过。源码 Opus review a085 通过；规范/测试 Opus review a029 除上述 `DESIGN.md` 一句外全部通过，该句已修正，并经 Opus 定点复核关闭，本轮 review 整体通过。
- 未验边界：Checkbox/Switch/Radio 错误态矩阵由 `ui-focus-states.test.ts` 单测覆盖，不是浏览器实测；错误态浏览器仅实测 textarea（forced-colors）。不宣称这些控件已浏览器验证。
- 本记录不宣称输入边界、焦点对比或整页 WCAG AA 达标。

## 交付状态（2026-10-31）

- 验证与独立评审均完成；本任务差异随分支 `feat/qoder-controls-refinement` 提交并创建 PR，等待合并，尚未合入 `main`。
