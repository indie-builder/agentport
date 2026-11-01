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

## 当前有效决定
- 第1轮进行中（items 1,2,3,6,9）。提交策略：每轮提交到分支；merge main 需用户确认。

## 验证
- 每轮：build exit0、typecheck exit0、视觉截图（/chat /agents 及涉及页），Opus 终审通过。
