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
- 轮1–5 已闭合多轮审计确认的高/中价值差异。仍待用户决策：轮间距 #2（属已批准布局几何）。其余为低价值/N-A。持续审计中。

## 当前有效决定
- 每轮：提交到分支并 push；merge main 需用户确认。#2 轮间距暂列待决策。

## 验证
- 每轮：typecheck exit0、web build exit0、visual:shots 相关路由、Opus 终审通过方提交。
