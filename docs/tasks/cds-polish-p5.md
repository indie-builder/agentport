# CDS 对齐 Loop（持续审计+修复）

## 目标
持续比对参考项目 `~/Documents/myself/open-claude-ui`（Claude CDS）与当前 agentport 的**视觉差异**，每轮选取一批高价值项修复并验证，直到无明显差异或收益递减。视觉层按 CDS（亮色）；代码层按本项目（shadcn/Base UI + lucide、语义令牌禁散落 hex、保 aria/键盘/焦点）。

## 基线
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/cds-polish-p5`，分支 `worktree-cds-polish-p5`，基线 origin/main `cbfac0e`（上一轮 CDS 迁移已合并）。

## 已知差异清单（来自本轮审计）
1. [轮1] 代码块浅底 → CDS 深色 `#0d0d0c`（含浅色语法、复制 2.5s 衰减）。
2. [轮1] 发丝边缺 DPR 细化（2x→0.5px、3x→1/3px）。
3. [轮1] 滚动遮罩 3 档静态 → CDS 7 档非线性。
6. [轮1] 复制反馈 1.5s → CDS 2.5s `saved-check-decay`。
9. [轮1] selection/滚动条配色、发丝边用 box-shadow 消除 1px 位移。
4. [轮2] 分段控件无滑动 thumb（改为 Motion layoutId 滑块）。
7. [轮2] 排版：行内图标光学对齐 `-.125em`、tabline-nums；rem-scale 需谨慎（不全站缩放）。
8. [轮2] ready 状态灯呼吸（需真实消费点，否则不做）。 
5. [N/A] 消息气泡分组圆角：当前每轮单条用户消息，无连续同侧气泡 → 无消费者，不做（避免死代码）。

## 每轮流程
审计（diff vs 参考）→ 派子代理落地 → `typecheck`/`build`/`visual:shots` 多视口 + Opus 终审 → 提交到分支 `worktree-cds-polish-p5`（每轮一个逻辑提交）→ 下一轮。主分支合并待用户确认。

## 轮次记录
- 轮1（已提交 a70cb4f）：代码块深色 + DPR 发丝边 + 7 档滚动遮罩 + 复制 2.5s 衰减 + 选区/滚动条；Opus 终审 3 项已修（选区可读、复制重播、围栏复制保留 Streamdown 并记录）。文档同步代码块深色。
- 轮2（本提交）：item4 分段控件改 CDS 滑动 thumb（Motion layoutId + useId 防串扰 + reduced-motion）。
  - item5（气泡分组圆角）：N/A（每轮单条用户消息，无连续同侧气泡，避免死代码）。
  - item7（行内图标光学对齐）：N/A（无真实「图标嵌入文本」场景；tabular-nums 已在用）；rem-scale 不全局套用（会缩全站几何）。
  - item8（ready 呼吸灯）：N/A（status-dot 仅用于运行态 running/error，无 ready 消费点）。

## 待修复 / 轮次记录（续）
- 轮3（本提交）：①助手回复整段复制（复用 CopyButton，hover/focus 显影、始终占位可 Tab）；②附件 chip 扩展名徽标 + `middleTruncate` + `min-w-0 truncate`（保扩展名/大小/操作不被挤）；③用户气泡轻投影 `--shadow-bubble`；④终审后修：附件名可收缩、移除误波及 OpenUI 卡片的 `pl-1` 内缩（改在 openui-message 内部区分文本/卡片，超出边界，故按低价值去掉）。
- 2. [中·待决策] 轮间距偏松（`gap-4`+`pt-5`=36px vs CDS ~16px）：属已批准布局几何，需用户确认再改。
- 轮4（本提交）：用户长消息 >300px 折叠（`FoldingMessageBody`：`useLayoutEffect` 首帧前测量避闪动、`ResizeObserver` 重测、折叠 `max-h-[300px] overflow-hidden` + 底部 3rem 渐变 mask + 「展开/收起」`aria-expanded`；短消息与附件不受影响）。

## 轮次记录（续）与收敛状态
- 轮5（本提交）：①待审批卡 pending 加陶土边线+微光+「等待授权」药丸（终态中性，药丸文字用 `--color-link` 达 AA）；②channel `@` 提及浮层统一 `radius-popover`+`shadow-md`；③7 档滚动遮罩触顶/触底动态归零（`--fade-top`/`--fade-bottom` + rAF onScroll，无 setState 抖动）。
- 轮6（本提交）：跨页面一致性——①内联链接统一 `--color-link`（memory-review/knowledge-citations/memory-panel/personal-shares/personal-usage）；②空态下一步动作改共享 Button(default sm, 用 Link 保留导航语义)；③ghost/outline hover `bg-muted`→`bg-hover`（button/badge/message-scroller）；④Tooltip 加 `.cds-overlay-enter`，Sheet 仅 scrim 透明度（面板保持 fade，避免 scale 露边）。
- 轮7-8（本提交）：①表格分隔线用 `--hairline`；②Dialog scrim 加 `backdrop-blur-[2px]`；③knowledge-detail tabs 去 `pb-3`；④success 徽章补 `--color-success-soft`；⑤抽出共享 `SegmentedToggle`（view-toggle.tsx），`ViewToggle` 升级 CDS 胶囊+滑动 thumb（7 页通用），skills 复用，plugins 保留语义 line Tabs；⑥空态 EmptyState 虚线→实线（受保护扇形卡保留虚线）；⑦对话轮间距 36→24px（pt-5→pt-2）。17 用例回归通过，Opus 终审可交付。
- 轮9-10（本提交）：轮9 审计发现 4 项中价值（空态与页头重复主操作、概览「需要处理」0 项空行、卡内嵌边框空态=卡片套卡片、CardFooter 整条灰带/卡内按钮偏重）；轮10 修复：servers/channels 空态主操作降级 outline、servers 卡内按钮改 ghost；概览/ops「需要处理」0 项整段不渲染（仅 isSuccess&&total=0，保 loading/error）；EmptyState 增 `bordered`(默认 true)、趋势卡用无边框；CardFooter 去灰带改 hairline；文档 §9 卡内操作改 ghost。终审 2 项（PageSection 残留标题、吞错误）已修。
- 轮11（本提交）：低价值收尾——图表图例文字弱化为 muted；概览健康整句去 mono（数值仍等宽）；run-detail 状态改为复用 RunStatusBadge（eyebrow，可读屏）；Toast 圆角对齐 `--radius-card`（Sonner 需 !important）；breadcrumb 经核实被 plugin-detail 使用，保留。
- 轮12（本提交）：低价值收尾——新增 `--shadow-2xs` 极轻投影（default/solid 按钮）；禁用态 opacity 50%→35%（button/input/textarea/select/checkbox/radio-group/switch/toggle）；StatusBadge 增 `brand` tone，runStatusVariant.running warn→brand、RunStatusBadge running 圆点改陶土；ConfirmDialog 危险图标 36px 圆角方→40px 圆形；同步 DESIGN-SYSTEM §2.3/§13「运行中状态徽章/圆点用陶土」例外。轮1–12 全部高/中/低价值项已闭合。
- 轮1–12 已闭合多轮审计高/中价值 + 主要低价值项。分支 `worktree-cds-polish-p5` 共 10 个提交，未合并 main（等用户）。

## 当前有效决定
- 每轮：提交到分支并 push；merge main 需用户确认。#2 轮间距暂列待决策。

## 验证
- 每轮：typecheck exit0、web build exit0、visual:shots 相关路由、Opus 终审通过方提交。
