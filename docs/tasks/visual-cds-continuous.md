# CDS 设计原则审计 Loop（持续）

## 目标
对照参考项目 `~/Documents/myself/open-claude-ui`（Claude CDS）的**设计原则**，持续审计 agentport 前端（packages/web）仍可改进项，每轮修复一批并验证。区别于上一轮「令牌/视觉值对齐」loop（已合并 main `7049266`），本 loop 聚焦**设计原则层面**：信息表达与克制、留白节奏、排版、色彩语义、动效物理、状态设计、图标细节、组件交互契约。

## 基线
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-cds-continuous`
- 分支：`worktree-visual-cds-continuous`
- 起点：origin/main `7049266`（上一轮 CDS 对齐 loop 已合并）

## 约束
- 视觉层按 CDS；代码层按本项目规范（shadcn/Base UI、语义令牌禁散落 hex、保 aria/键盘/焦点、无 emoji）。
- 主会话不写代码，全部派子代理；每轮 typecheck + build（必要时 visual:shots）+ Opus 独立终审 → 提交分支并 push。
- 不合并 main（除非用户明确授权）。
- 每 10 分钟由 cron `aa0c2544` 触发一轮；已有完整轮次或无明显差异时只做巡检、不造改动。

## 参考设计原则（提炼自 open-claude-ui v1 文档）
1. **表达克制**：层级靠表面明度/字重/留白，不靠框线和彩色标签；一条视线最多 1 层闭合边框，容器内二级控件 ghost/无框；AI 正文零边框，操作栏 hover/focus 才出现；每区只 1 个主操作或危险动作，clay 不作装饰。
2. **留白节奏**：密度靠节奏非挤压；控件高 24/32、图标 16/20；对话 gutter 32、轮次 ~15、块 10、正文 4px 内缩；阅读宽 42–48rem、气泡 85%。
3. **排版**：7 档字号；标题 balance、正文 pretty、长串 anywhere；动态数字 tabular-nums；移动输入 ≥16px。
4. **色彩语义**：Surface 阶梯只差 1–3% 明度；clay 只做品牌/焦点/推理，蓝做运行就绪，红做错误危险；边框 0.5/1/1.5/2px 分场景。
5. **动效**：时长 60/120/200/300/450ms，进入 `.22,1,.36,1`、退出 `-4px/180ms`，四弹簧分场景；禁 linear/ease；reduce 下禁循环与位移。
6. **状态**：hover 150ms/5% 底、active .975–.98、focus 三层 clay 环、disabled 35%+not-allowed+pointer-none；空态上限 24px 图标+一句说明+一个次要动作；状态不只靠颜色。
7. **图标**：线性矢量统一描边；尺寸 12/14/16/20/24；行内 `-0.125em` 光学对齐；装饰图标不承担唯一语义。
8. **组件契约**：primary 只正向提交、secondary 默认无框、ghost 只内联、danger 只破坏；卡片单外框+hover -1.5px；浮层 16px 双环影。

## 改进 backlog（按价值，来自首轮双路审计）
### 高价值
- H1 **信息表达去冗余**：标题已是编辑/详情入口，底部又重复「查看详情/编辑/查看运行」（`plugins.tsx:250/346`、`skills.tsx:313/390`、`runs.tsx:171/211`）；页头主按钮与空态同名按钮重复（`channels.tsx:39/61`、`runtime-environments.tsx:72/109`）；频道头部计数再以头像/chip 重复表达（`channel.tsx:382-417`）。原则1、项目 §10。
- H2 **可点击暗示要诚实**：`ui/card.tsx:14` 默认给所有 Card 加 `cds-card-interactive` 上浮，但概览指标卡 `overview.tsx:546`、环境卡 `runtime-environments.tsx:184` 实际只能点标题 → 改为按需上浮。原则8。
- H3 **空态语言统一**：`knowledge.tsx:468`(96px 插画) vs `plugins.tsx:223`(PageNote) vs `audit.tsx:266`(表格内一行字) 三套；`personal-shares.tsx:249/282` 重复同文案。原则6（24px 图标+一句+一次要动作）。
### 中价值
- M1 **动效令牌落地**：DESIGN-SYSTEM 声明 5 档时长/8 缓动，`styles.css:111-113` 仅 `--ease-out-soft/--dur-fast/--dur-slow`；实现硬编码 150/140/90ms、0.12s（`app-shell.tsx:165/175/267`、`view-toggle.tsx:51-53`）、`duration-150` 回落默认 ease（`channels.tsx:105`、`eval.tsx:569`、`agents.tsx:4133`）。原则5。
- M2 **强调层级一致**：数字列被系统性弱化 `data-table.tsx:591` 用 muted，`personal-usage.tsx:465-471` 同值用 fg；同类读数 `overview.tsx:554`(text-3xl) vs `status.tsx:60`(text-xs)；停用徽章未突出 `agents.tsx:736-742`。原则1、3。
- M3 **knowledge 悬停跳变 bug**：`knowledge.tsx:138` `transition-shadow` 覆盖 Card transform，上浮瞬时跳变。原则8。
- M4 **阅读行长不统一**：`page.tsx:41` 60ch、`agents.tsx:1316` 70ch、`plugin-detail.tsx:366/394` 75ch（目标 42–48rem）。原则3。
### 低价值
- L1 图标尺寸散落（页面直写 size-3/5 约 59 处）与 16px 全局冲突。原则7。
- L2 发丝边混用：`table.tsx:22`（0.5px）vs `page.tsx:84`/`channels.tsx:70`（1px border）vs `agents.tsx:1477`（ring-1）。原则4。
- L3 `status-badge.tsx:14` brand tone 未被使用，`channel.tsx:777`/`chat.tsx:3343` 内联复制陶土光晕；空描述「—」vs「暂无描述」措辞不一。原则6、零死代码。

## 轮次记录
- **轮1（提交）**：信息表达去冗余 + 动效 bug。①plugins 页脚「查看详情」与标题 Link 同目标，删除页脚重复入口（保留「被 N 个专家使用」+ 编辑按钮）；②runs 页脚「查看运行」与标题 Link 同目标，删除；③knowledge.tsx Card `transition-shadow hover:ring-foreground/25` 覆盖默认交互过渡致 hover 上浮跳变，去掉 overrides。终审发现 4 个既有测试（plugin-editor/audit-action-feedback/run-detail-navigation/runs-view-toggle）仍按旧页脚入口定位，已等价改到标题链接（保留 URL/可访问名/backTo），4 文件 32 用例全绿。验证：typecheck exit0、web build exit0。遗留：另 7 个 theme-contrast/ui-focus-states 既有失败与本轮无关。
  - 待办调整：H1 剩余（channels/runtime 重复主按钮、channel 计数重复）、H2 卡片按需上浮、H3 空态语言统一、M1 动效令牌、M2 强调层级、M4 阅读行长、L1–L3 → 后续轮次。
- **轮2（提交）**：①H2 卡片 affordance 诚实——`ui/card.tsx` 新增 `interactive` 属性（默认 true），仅真·纯展示卡（overview 指标卡等，无任何可交互子元素）设 `interactive={false}`，消除「不可点却在 hover 上浮」的误导；②M2 数字排版一致——runs 卡片统计（耗时/成本/token 等）补 `tabular-nums`，与 personal-usage/data-table 一致。验证见下。
  - 终审发现并修复：最初整类移除 `cds-card-interactive` 会连带丢失常驻 `--shadow-panel`（卡片边界）——已拆为 `.cds-card-surface`（所有卡片常驻边界）+ `.cds-card-interactive`（仅 hover 上浮/过渡）；card.tsx 恒带 surface、条件加 interactive；同步 DESIGN-SYSTEM §2.3/§9 与 packages/web/DESIGN.md 措辞。验证：typecheck exit0、web build exit0。
  - 核实排除（审计过度声称，勿再改）：channel.tsx 头部的头像/chip 是 `xl:hidden` 的响应式身份/状态展示，非纯重复计数；personal-shares `empty="还没有分享"` 是 DataTable 分支，items=0 时已被上方 EmptyState 截胡，实际走不到。
- **轮3（提交）**：①M1 文档诚信——`DESIGN-SYSTEM §11` 原称「缓动全部在 @theme / 时长阶梯各档都是令牌」，实际 @theme 只有 `--ease-out-soft`/`--dur-fast`/`--dur-slow`/`--btn-spring`，其余曲线与时长是 utility 内联；按「文档服从代码」修正两条并保留 CDS 参考值。②status.tsx 把 PageHeader 后的孤立说明行「运行指标每 10 秒自动刷新」并入 PageHeader `description`，消除 `Page` 直接子节点造成的上下留白不均（§2 留白节奏 + 页面骨架）。
  - 核实排除：H3「空态三套语言」不成立——skills/servers/plugins/knowledge 主空态统一用 `PageNote`+BusinessIllustration；knowledge 的 96px 插画空态是刻意品牌化，非缺陷。M4「阅读行长」参考值 42–48rem 反而宽于现状 60–75ch，且为 max-width 语义，非同类框定，不做。
  - 收敛判断：经 3 轮，H1/H2/H3、M1/M2/M3/M4 已处理或核实排除；剩余仅 L1（图标尺寸散落，面广收益低）、L2（发丝边 0.5/1px 混用，属既有可接受限制）、L3（brand tone 现已被运行徽章使用）等细节，趋于收敛。后续轮次以巡检为主，不强行造改动。
