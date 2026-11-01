# 视觉基准迁移：Qoder → Claude CDS（visual-baseline-claude-cds）

## 目标
把前端视觉基准从「Qoder CN 桌面浅色」换成参考项目 `~/Documents/myself/open-claude-ui`（逆向还原的 Claude 官方桌面端 CDS）。验收：令牌层、视觉原语、动效物理按 CDS 呈现；现有布局 / 信息架构 / 功能 / 行为 / 代码栈（shadcn/ui + Base UI + lucide）不变；真实浏览器几何、焦点、AX、对比度复测通过；单一 h1、无横向溢出。

## 方案
分两层治理（用户 2026-11-01 明确裁决）：
- **视觉层 = open-claude-ui(CDS) 为准，覆盖 PACE 旧禁令**：陶土 `clay #d97757` 为主强调/主操作、暖纸灰 surface 阶梯、alpha 发丝边、双环 + Composer 阴影、物理弹簧动效、彩色焦点微光 / 呼吸状态点、单闭合边框原则。**仅亮色，不做暗色**（用户 2026-11-01 追加）。
- **代码层 = 本项目为准**：shadcn/ui + Base UI 原语、lucide（禁 emoji）、语义令牌（禁散落 hex）、aria/键盘/焦点归还；已有手写业务组件保留本项目实现，只换外观。
- 不整包引入 CDS 组件（其实现含硬编码 hex、emoji、手写非 Portal 下拉、无 Base UI/ARIA）；只抽「令牌值 + 视觉数值 + 交互物理」重表达进现有原语。

## 基线与范围
- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/visual-baseline-claude-cds`
- 分支：`worktree-visual-baseline-claude-cds`；起点 `de5d7f7`（= origin/main，fetch 后一致），初始 clean。
- 主 checkout 保持干净，产出只在本树。
- 允许改动：`packages/web/src/styles.css`、`packages/web/src/components/ui/*`、`packages/web/src/components/*`、`packages/web/src/App.tsx`、`docs/DESIGN-SYSTEM.md`、`packages/web/CLAUDE.md`、`packages/web/DESIGN.md`(+`.impeccable/design.json`)、根 `CLAUDE.md` 优先级行。不改后端/DB/接口。
- 全站样式已 100% 走 `styles.css` 的 `@theme` 语义令牌（全仓 0 处散落 hex），换基准主改令牌层 + 视觉原语 + 补动效原语。

## 当前有效决定
1. 视觉以 CDS 为准，不受 PACE 旧禁令反向限制；代码规范以本项目为准。（2026-11-01）
2. 先不做暗色，仅亮色。（2026-11-01）
3. 陶土作为主强调/主操作（视觉）；带文字实底按钮若对比不足时以 CDS 自身 border-strong/深色档处理，不回到 Qoder 中性规则。
4. 保留现有布局几何、信息架构、控件位置、行为、路由、数据；只改颜色/圆角/阴影/边线呈现/动效物理/字体回退。

## 已替代项及原因
- 旧「UI 基准优先 = Qoder CN」及 `docs/DESIGN-SYSTEM.md` 全篇 Qoder 值 → 被 CDS 取代。
- 旧禁令「动作只有中性深色实底 / 无彩色光晕 / 无呼吸点 / 无装饰入场动画」→ 被 CDS 视觉取代（代码层仍禁 emoji/散落 hex/破坏 a11y）。

## 步骤
- [ ] P0 契约文档：重写 `docs/DESIGN-SYSTEM.md`（surface/clay/发丝边/圆角/阴影/字体/动效映射 CDS，去暗色）；更新 `packages/web/CLAUDE.md` 视觉来源；根 `CLAUDE.md` 优先级行 Qoder→CDS；更新 `packages/web/DESIGN.md` sidecar。
- [x] P1 令牌层：`styles.css` 的 `@theme` 全量映射 CDS 亮色 + 补 keyframes/utility（btn-squish、scroll-fade、quiet-dots、timeline-expand、动效曲线/时长）。已完成（+176/−54）；连带把冻结的 Qoder 契约测试 `packages/web/test/theme-contrast.test.ts` 改写为 CDS 契约（6 例全绿）。
- [x] P2 视觉原语：AppShell 平铺全幅（用户「按你的建议」确认）；Composer 白底 + `shadow-composer` 双环三态 + 20px 圆角；按钮 `cds-btn-squish` 弹簧按压；input-group disabled 减淡；toggle/tabs 语义归位。（web typecheck + build 通过，P2 截图 4 张）。
- [~] P3 交互物理（收敛为最小高风险项）：用户气泡 18px 圆角 + py-3（去全圆 pill）；清理迁移后死令牌。Trace 三点波/滚动遮罩/streaming diff 暂不做（改动 chat.tsx 逻辑、风险高收益低），列为可选后续。
- [ ] P4 验证：真实浏览器（visual-check）多视口截图 + getBoundingClientRect/计算样式 + AX + 对比度重算 + typecheck/build；更新 sidecar。

## 改动文件
- `packages/web/src/styles.css`（P1 令牌层）
- `packages/web/test/theme-contrast.test.ts`（契约改写为 CDS）

## 下一步
- 全部阶段已完成（P0 文档 / P1 令牌 / P2 原语+外壳平铺 / P3 动效 / P4 细节补齐 / design.json 重建）。**未提交、未合入**（用户未授权 commit/push）。
- 待你决定：是否把本分支合并/提交。提交前建议再跑一次独立 Opus 终审（本轮已跑两轮并修复全部 finding）。
- P4 明细：输入焦点陶土微光（input/textarea/select/combobox/input-group，SourceEditor/CodeMirror 保留 input-focus）、卡片 `.cds-card-interactive` panel 阴影+hover 浮起、弹层圆角 Dialog16/Popover10 + `.cds-overlay-enter` scale 弹入、链接 `--color-link #a8482b`、卡片/消息 `.message-fade-up`、资源页分段 CDS 胶囊、排版 `text-wrap`/heading tracking。两处 Opus 级联 bug 已修：输入焦点边框改由 utilities 层 `focus-visible:border-[…]` 保证、Card 去 `ring-1` 让 panel 阴影生效。
- 未做/合理跳过：暗色、全局 rem-scale 缩放（会缩小全站几何）、streaming diff 专门视觉、SourceEditor/CodeMirror 焦点(保留中性)。

## 验证
- 构建：`pnpm --filter @agentport/web build` exit 0（P4 后多次）。
- 类型：`pnpm --filter @agentport/web typecheck` exit 0。
- 测试：`pnpm --filter @agentport/web exec vitest run test/theme-contrast.test.ts` 6/6 通过（CDS 契约，rgba 合成 + 对比度实算）。
- 真实渲染：`pnpm visual:shots` 多轮（P1/P2/final/P3/P4/final2），/chat /agents /skills 1440/1200；隔离临时库自动删除、端口释放；无横向溢出/重叠。视觉：陶土主操作、暖灰表面、alpha 发丝边、CDS 圆角、外壳平铺全幅、Composer 白底双环、卡片浮起、分段胶囊。
- 独立 Opus 终审两轮：(1) P0–P2 → squish 入 @layer、删未接入动效死代码；(2) P0–P4 → 输入焦点边框级联覆盖、Card ring 覆盖阴影已修，文档同步。修复后构建/一致性核对通过。
- P4 一致性核对：select/combobox/input-group 无残留 `border-input-focus`；card 无 `ring-1`；`--color-input-focus` 仍仅被 source-editor 使用（未变死令牌）。
- `packages/web/.impeccable/design.json`：整份重建为 CDS（schemaVersion 2），JSON 合法、无 Qoder/旧渐变残留。
- 改动文件（26）：CLAUDE.md、docs/DESIGN-SYSTEM.md、packages/web/{CLAUDE.md,DESIGN.md}、.impeccable/design.json、components/{app-shell,markdown}.tsx、ui/{badge,button,card,combobox,dialog,dropdown-menu,input-group,input,message-scroller,popover,select,skeleton,tabs,textarea,toggle}.tsx、pages/{chat,skills}.tsx、styles.css、test/theme-contrast.test.ts；新增 docs/tasks/visual-baseline-claude-cds.md。
