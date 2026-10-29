# PACE 品牌色与全站 UI 配色

## 目标

设计 PACE 的品牌色，并统一应用于全站按钮、图标、导航、表单、对话与数据呈现，替换原先纯中性灰的交互体系。保留现有布局、字体、控件规格与业务能力；文字和焦点需有实测对比度证据。

## 方案

先由 Opus 设计品牌色与共享语义契约，Sonnet 只读盘点覆盖范围；主会话检查现有界面。确定契约后 Sonnet 按不重叠文件域并行执行，再经 Opus 独立评审与范围验证。复用 shadcn/Base UI 与 styles.css 的语义令牌，不引入依赖。

## 基线与范围

- 主 checkout：`/Users/xbjt/Documents/myself/agentport`，初始干净。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/pace-brand-colors`。
- 分支：`worktree-pace-brand-colors`。
- 起点：`ecc288838b4dd3be8b646ee98e0f4e1a5aa67bda`，与 fetch 后 `origin/main` 一致。
- 工作树初始无差异；全部新增差异属于本任务。
- 允许范围：web 颜色令牌、共享控件与确需同步的页面颜色、设计规范及项目颜色约束。后端、业务逻辑、字体布局与品牌插画不在范围内。

## 当前有效决定

- 用户最初要求设计品牌色并全站应用；2026-10-29 看过预览后指出菜单栏特别不搭，随后明确要求使用 Impeccable 完整重新设计、基于全局整体形成 PACE 自己的品牌色。最新要求替代本记录下方上一版工装蓝方案的设计权威；原有改动保留为可恢复的阶段基线，不整文件撤销。
- 本轮先用 Impeccable 4.8.0 的 Operate 模式建立完整品牌方向和可视方案页，再根据方向完成导航、工作区、共享控件与状态体系。用户已明确全局范围，不再仅修菜单。品牌小狗资产、功能、无障碍、现有组件栈保留。
- 第二版动手前保存第一版差异至 `/tmp/pace-brand-v1-before-redesign.patch`；本记录仍由 git 工作树保留。第二版没有将第一版改动视为其他任务内容，没有 reset/restore 全文件。
- 用户已在方案页选中“类别标准”，并在对话明确表示喜欢；此选择是当前唯一视觉方向，替代黄色/绿色/紫色候选及第一版暖纸工装蓝。采用所选草图的清白表面、冷灰画布、蓝色主操作，普通导航墨色、选中浅蓝配品牌蓝；按草图用户消息实蓝白字。保留 PACE 品牌图像、现有导航结构与业务功能，不把静态草图的示例内容/新布局搬进产品。
- 仍沿用现有组件、桌面布局、圆角、字体与单层焦点规则。
- 未授权 commit/push/merge；交付为未提交差异。
- 预览仅启动工作树前端，复用已有 API，不改变账号配置或主 checkout 服务。

## 已替代项及原因

旧版仅黑白灰的主按钮与中性选中态：无法满足用户对品牌识别的明确要求。

## 步骤

- [x] 读取规范、流程与踩坑记录，建立工作树并核对基线。
- [x] 浏览现有工作台，记录纯灰界面基线截图。
- [x] 固定品牌色及全站语义契约。
- [x] 并行实现共享主题与各消费入口，同步文档。
- [x] Opus 独立 review，修复并复核。
- [x] 验证类型、构建、现有相关测试和浏览器实际配色。

## 改动文件

- `CLAUDE.md`、`docs/DESIGN-SYSTEM.md`、本记录。
- `packages/web/src/styles.css`、`App.tsx`。
- `packages/web/src/components/`：`app-shell.tsx`、`resource-page.tsx`、`conversation-outputs.tsx`、`plugin-file-tree.tsx`、`markdown.tsx`。
- `packages/web/src/components/ui/`：`button.tsx`、`badge.tsx`、`tabs.tsx`、`toggle.tsx`、`combobox.tsx`。
- `packages/web/src/pages/`：`agents.tsx`、`chat.tsx`、`skills.tsx`、`knowledge-detail.tsx`、`memory-panel.tsx`、`runtime-environment-detail.tsx`。
- `packages/web/src/openui/components/`：`forms.tsx`、`charts.tsx`。
- `packages/web/test/`：`ui-focus-states.test.ts`（主题夹具）、`openui-renderer.test.ts`（已有首系列语义断言同步）。

## 下一步

最新轻量收敛已完成：共享 default Button 为1px品牌蓝描边、蓝字、清白底，hover浅蓝；只有发送与登录使用solid。用户消息为浅蓝底+fg正文，附件普通outline；取消/次操作中性outline。全量110文件1271用例、typecheck/build、focus/contract、5文件biome通过；Impeccable detect `[]`。Sonner操作按钮与按钮键盘焦点浏览器实测通过。独立Opus视觉 `ship`，补核toast/solid范围/invalid级联测试后整体代码 `ship`。

用户已明确授权提交 PR、合并并清理工作区。按当前已验证差异提交，保留远端 main 新增的设计技能；不触发或等待 CI、不启动 PR 监控。合并后停止本次 Vite 预览、保存被忽略的设计草图与截图到工作树之外，再仅删除本任务已合并且无未提交差异的工作树。分支与远端保留，其他任务工作树不动。

### 上阶段交付

无实施待办。用户选中的“类别标准”已落地，并经独立 Opus 视觉/代码评审与全局收敛复核；附件文字与单选框焦点两处问题均修复。全局规范、CLAUDE 模型规则与机器记录已同步。实际应用 `http://127.0.0.1:5178/agents` 已打开并保留在前台。全部成果为本工作树未提交差异，未合入 main。

本轮Impeccable使用Operate/code-led，方向 `seed:2d635fbf2474dc71` 的canon选择已记录；项目唯一设计规范仍为 `docs/DESIGN-SYSTEM.md`，没有另建根DESIGN.md。

### 全局收敛（2026-10-29 用户追加）

- 用户认为按钮蓝偏重，并要求统一检查整体设计/配色同类问题。保留已选冷灰清白品牌方向，不换方向。
- **按钮柔化已确认实施**：`button-primary #426FBD` / hover `#3B64AA` / active `#345997`，由 default Button 与 toast 操作消费；品牌、链接、导航、气泡、徽章仍为 `#315FAD`。定时任务页头主按钮实测 `rgb(66,111,189)`。
- **全局审计（Opus）结论**：共享控件层无配色不一致；「蓝重」主因是同屏重复实蓝主操作。已处理：定时任务删除空态重复入口（仅留页头）；运行环境与知识库空态重复创建按钮降为 `outline size="sm"`，动作与图标保留；memory-panel 初始化 MEMORY.md 作为唯一主操作保留 default。知识库页头存在同动作主按钮，故空态降级成立。
- **不做**：按位置无差别把所有空态按钮改 outline；降低 brand `primary` 明度（会牺牲品牌识别与对比度）。
- 状态色在新冷灰表面独立复算：success/surface 5.50、success/selected 4.80、success/canvas 5.04、warning/surface 6.00、danger/surface 6.40、warning/soft 5.58、danger/soft 5.70；全部 ≥4.5，无需改动状态语义。
- **收尾**：App toast 操作与实底按钮统一 button 三态；删除无消费方的 `primary-active`；`CLAUDE.md`、设计规范、`.impeccable/design.json` 同步按钮三态分工。
- **最终验证（修复单选焦点后的真实状态）**：`pnpm test:web` 110 文件、**1271 用例**通过；`typecheck`、`vite build --logLevel error`、`pnpm lint:focus`、`pnpm lint:contract` 全部退出 0；`git diff --check` 通过。
- **终审修复**：radio 选中项原 focus 只把 primary 边框改成同色 ring，键盘不可见。项目焦点守卫禁止输入类使用 `ring-2`，最终采用单层 `outline-2 outline-ring outline-offset-2`（未选中仍换边框，invalid 优先级保留），`pnpm lint:focus` 通过；`ui-focus-states` 增补行为断言。规范 §9 补充该必要例外。任务记录与设计规范中的过期 `primary-active`、按钮消费措辞已同步。
- 最新证据：`schedules-final.png`（唯一创建入口）、`desktop-after.png`（柔化按钮整体），后续轻量版本新增 `outline-resources.png`、`outline-chat.png`。蓝描边按钮键盘焦点实际border透明、offset0、单层2px品牌环，过渡完成后确认；Sonner操作蓝描边实际通过。
- 项目模型规则已按用户要求写入 `CLAUDE.md`：设计/规划/方案/探索判断/评审/审计一律 Opus，方案确定后的具体代码执行 Sonnet；高于个人 pstack 配置。个人 memory 同步。

### 类别标准当前契约

- primary、ring、selected-foreground 为 `#315FAD`，品牌悬停 `#284F92`（徽章链接）；实底主按钮与 toast 操作用 `button-primary #426FBD` / hover `#3B64AA` / active `#345997`；canvas `#F0F2F5`、surface/panel `#FBFCFE`、selected/accent `#E7EDF7`。
- fg/ink `#1E293B`、muted-foreground `#596577`、line `#D7DDE5`、input/line-strong/subtle `#8993A2`、hover/sunken/chip/code `#E9EDF2`、shell-line `#E4E8EE`。
- 普通导航采用fg，分组/账户辅助采用muted；当前项浅蓝＋品牌蓝。最新轻量收敛：default主按钮为品牌蓝描边/蓝字/清白底，hover selected；发送和登录显式solid。用户气泡为selected浅蓝底+fg正文，附件普通outline Badge与muted小字。成功/警告/危险独立。
- 选择草图input在surface 3.027:1，但在selected/sunken仅2.64:1；必要checkbox/radio边界单独使用 `control-boundary #7F8998`，最差3.009:1，保留输入框原选色与聚焦/错误优先级。
- 布局、字体、控件几何、品牌图像、菜单路由和所有业务功能保持既有契约；不将草图演示区/内容引入真实业务。

### 第一版实施契约（已由类别标准替代）

- 唯一品牌主色「工装蓝」`#315FAD`；primary-hover `#284F92`、primary-active `#21437D`，不用透明度降低悬停对比度。
- selected `#E8EFFA`、selected-foreground 为品牌蓝；hover `#EFF3F9`。
- canvas `#F4F2ED`；surface/panel `#FFFEFB`；sunken/chip/code `#EEECE6`。
- fg/ink `#253044`；muted-foreground `#626A78`；line `#DEDCD5`；shell-line `#E7E4DD`；input/line-strong/subtle `#7E8794`。
- primary/ring/运行图表映射品牌蓝；accent 为浅蓝，accent-foreground 为品牌蓝；主按钮白字。success/warning/danger 继续独立。
- 导航、文件列表、Toggle 与 OpenUI 选中态使用浅蓝和品牌蓝前景；line 页签保留透明底，当前项使用品牌蓝文字与既有指示线，分段页签保留白底与品牌蓝文字。普通图标继承所属文字/状态，避免所有图标染蓝。
- 聊天气泡浅蓝底与 fg 正文；助手正文保持墨色；链接品牌蓝保留下划线；代码关键字可品牌蓝，注释辅助蓝灰。
- 保留布局、字体、原语行为与品牌图片；主按钮焦点加背景间隔以区别同色实底。
- 图表只将既有运行系列与 OpenUI 首系列映射品牌蓝，其他系列保留既有中性层级与纹理，不扩展为新分类色板。
- Sonnet 文件域：主题共享；页面消费；规范文档。三者不共享写入文件。

## 类别标准落地验证（当前版本）

- 全局、导航与用户气泡均已按选定方向落地；用户附件的文字/大小/hover/焦点一并反色，未改逻辑。
- `pnpm test:web`：110文件、1270用例通过。jsdom原有scrollTo/navigation提示保留，无测试失败。
- `pnpm --filter @agentport/web typecheck`、`pnpm --filter @agentport/web exec vite build --logLevel error`、`pnpm lint:focus`、`pnpm lint:contract`：全部退出0。
- Impeccable `detect --json <5个本轮修改UI文件>`：`[]`，本轮仅执行一次。
- 浏览器：资源页canvas `#F0F2F5`，普通菜单 `rgb(30,41,59)`，选中菜单 `rgb(49,95,173)`；收起态仍一致。账户弹层背景 `rgb(251,252,254)`、文字 `rgb(30,41,59)`。
- 真实历史用户气泡 `rgb(49,95,173)` + 白字，助手正文与状态保持各自语义。未发送真实模型消息、未改账号或业务数据。
- required截图在 `packages/web/.impeccable/review/`：`desktop.png`、`user-1500.png`、`chat-desktop.png`、`desktop-1100.png`，均已Read确认可用。1440/1500/1100桌面尺寸检查，无页面横向溢出；不做移动端或新增暗色。
- 本轮额外改动：`components/ui/checkbox.tsx`、`radio-group.tsx` 的必要边界；`pages/chat.tsx` 气泡/附件反色；`styles.css`与测试夹具更新；`docs/DESIGN-SYSTEM.md`新增真实tokens frontmatter，原中文章节作为唯一权威保留，未新增DESIGN.md副本。
- Biome本轮5个TS/TSX文件通过（CSS未被现有biome包含）；收起导航和账户弹层实测通过；工作台/技能/定时任务/健康均canvas `#F0F2F5`，无横向溢出。
- 文档冲突已处理：旧规范禁实蓝用户气泡与所选方案冲突→按最新选择实蓝白字；旧暖纸色及对比度→新冷灰palette；必要边界独立于输入边框；普通菜单fg与分组muted分层。历史记录保留。
- 机器记录 `packages/web/.impeccable/design.json`（schemaVersion2）已生成并JSON解析验证，包含5个共享组件片段、动效/阴影/颜色元数据；权威明确引用 `docs/DESIGN-SYSTEM.md`，无根DESIGN.md副本。
- 已把真实预览 `http://127.0.0.1:5178/agents` 切到浏览器前台；实际root palette为brand `#315fad`/canvas `#f0f2f5`/surface `#fbfcfe`。
- 附件大小修复采用完整 `text-primary-foreground`，hover叠白10%对比度5.000:1。主会话复跑 `test/chat-attachments.test.ts` 13用例通过、`vite build --logLevel error`与`git diff --check`通过；静态文字默认与父Badge相同白色。定向Opus复核明确 `PASS · resolved · ship`，仅原P2范围。整体首轮fidelity/截图/代码其余已通过，本轮未重复审查。无真实附件新截图，保留计算+源码+行为测试覆盖限制。

## 验证（第一版历史证据）

- `git fetch origin main` 成功；HEAD 与 `origin/main` 一致。
- `pnpm install --frozen-lockfile` 成功。
- 当前应用 `https://agentport.localhost/` 可用，已读取工作台并保存基线截图；没有修改业务数据。
- `pnpm test:web`：110 文件、1269 用例通过；jsdom 打印现有 scrollTo/navigation 未实现提示，无失败。
- `pnpm --filter @agentport/web typecheck`：退出 0。
- `pnpm --filter @agentport/web build`：成功，5302 模块，保留 >500kB chunk 提示；未扩展至性能改造。
- `pnpm lint:focus`、`pnpm lint:contract`：通过。
- `./node_modules/.bin/biome check <19 个改动 TS/TSX 文件>`：通过，无修改。
- `git diff --check`：通过。
- `node <dataviz skill>/scripts/validate_palette.js '#315FAD,#B42318' --mode light --surface '#FFFEFB'`：亮度、色度、色觉区分、普通视觉区分、表面对比度全部通过；此证据仅覆盖运行/失败二色。
- WCAG sRGB 独立复算：white/primary 6.230:1，white/hover 8.004:1，white/active 9.706:1；fg/surface 13.137:1，muted/surface 5.405:1，muted/selected 4.714:1，muted/sunken 4.615:1；input/surface 3.602:1，input/canvas 3.247:1。
- 预览运行源：本工作树、基线 commit `ecc2888` + 本任务未提交差异；仅 Vite 前端，未读取/改写 `.env`，API 代理复用主 checkout 的 `http://localhost:3000`；访问 `http://127.0.0.1:5178`。为查看已认证页面复制已有 session cookie，未重新登录或更改账号；此步骤不证明登录链路。
- 浏览器：工作台、对话、专家、技能、连接器、插件、知识库、运行、定时任务、评估、运行环境、健康、审计均能显示，1500px 桌面无页面横向溢出。
- 浏览器实际根令牌复算：white/primary 6.230:1、muted/selected 4.714:1、fg/surface 13.137:1，与声明色值计算一致。
- 实际导航前景/图标 `rgb(49,95,173)`，选中底 `rgb(232,239,250)`。输入聚焦边框 `rgb(49,95,173)`，提交空名称后错误边框 `rgb(180,35,24)`，均 `box-shadow:none`；没有触发创建请求。
- 实际发送按钮：背景 `rgb(49,95,173)`、白字；键盘焦点 `--tw-ring-offset-width:2px`，间隔 `#fffefb`，蓝环在外侧 4px 位置，单层信号可辨识。悬停待过渡结束测得 `rgb(40,79,146)`。
- 真实历史会话用户气泡：浅蓝底 `rgb(232,239,250)`、正文 `rgb(37,48,68)`；助手墨色正文与绿色完成状态保持分离，未发送模型请求。
- 截图：`/tmp/pace-brand-overview.png`、`/tmp/pace-brand-chat.png`、`/tmp/pace-brand-resources.png`、`/tmp/pace-brand-conversation.png`。登录路由因已有会话自动跳转，未稳定验收独立登录页；不把瞬态截图视作完成证据。
- 未做危险删除、真实模型发送、强制颜色模式或暗色验收（项目仅亮色）。
- 纯视觉配色不编造实现镜像式测试；通过实际渲染色值、对比度测量、现有交互回归与构建证明目标。

### 评审修复与复测

- 第一轮 Opus 独立 review 审查全部差异，发现三项 P2：Combobox 将边界色用于搜索背景；ghost hover 覆盖当前会话/成果选中态；技能 SegmentedToggle 局部覆盖共享选中态。
- Sonnet 在四个文件内修复：搜索使用 surface/input 正确角色；两个选中分支显式补 hover 选中颜色；技能删除局部选中颜色覆盖。原语、布局、业务行为保留。
- 修复后执行 `pnpm --filter @agentport/web exec vitest run test/chat-outputs.test.ts test/chat-ux.test.ts test/chat-history-pages.test.ts test/market-search.test.ts test/skills-install-lifecycle.test.ts test/agents-ui.test.ts test/expert-knowledge-binding.test.ts test/resource-states.test.ts test/ui-focus-states.test.ts`：9 文件、168 用例通过。
- 修复代理 typecheck/build、biome（四个文件）、lint:focus/contract 全通过；主会话再执行 typecheck、`vite build --logLevel error`、lint:focus、lint:contract、`git diff --check`，均退出 0。
- 浏览器实际搜索背景 `rgb(255,254,251)`，占位符 `rgb(98,106,120)`，组合 5.405:1；当前会话 hover 仍为 `rgb(232,239,250)`/`rgb(49,95,173)`。
- 技能“内部”、市场“市场／总榜”实际选中底与前景均为浅蓝/品牌蓝。
- 当前历史会话没有成果文件，成果选中 hover 依靠生成CSS、已有chat-outputs测试与定向独立review核验，不伪造业务数据。
- 资源页1100px桌面窗口实测 `scrollWidth === innerWidth === 1100`。
- 规范冲突处理：旧无彩度/石墨按钮/灰选中/图标只能中性规则已更新为品牌语义；Tabs 的白底活动页签与 Toggle 的浅蓝活动项依不同原语保留结构，line Tabs透明底+蓝指示线。历史任务与CHANGELOG记录保留历史事实，不作为现行规范。
