# 全站设计精修：distill / layout / typeset / polish / critique

## 目标
对 `packages/web` 全部页面应用 Impeccable 的 layout / typeset / distill / polish 精修，并产出 critique 打分卡。验收：遵循 DESIGN-SYSTEM 与已冻结布局契约；不改功能/权限；空/错/加载与可访问性不退化；typecheck/build/相关测试/检测器通过；真实渲染抽查一致。

## 方案
1. 5 组只读审计子代理 + 静态检测器产出全站打分卡与优先问题。
2. 将四条命令合并为「按页面一次改到位」，消除真实冗余与结构性缺陷；间距/字号只对齐既有尺度，不重排已冻结几何。
3. 6 个实施子代理按文件边界并行落地；主会话跑验证与终审。
4. 完成后抽页渲染复核。

## 基线与范围
- 起始 commit：`0c15d27`（= origin/main），worktree 干净。
- 允许改动：`packages/web/src/**` UI 与其测试；同步 `packages/web/DESIGN.md` 快照。不动 API/worker/db/core 行为。

## 当前有效决定
- 用户要求：所有页面执行 layout/typeset/distill/polish/critique。
- **找专家页的扇形「新建专家」入口卡与「创建数字分身」卡是用户刻意要求保留的创建入口，不得删除/合并/改为仅页头入口**；上一轮误删已整体回退（agents.tsx、agent-avatar.tsx、styles.css、6 张 create-*.png、相关测试、DESIGN.md、DESIGN-SYSTEM.md 全部还原）。保护说明已写入 `packages/web/CLAUDE.md`、`packages/web/DESIGN.md`、`docs/DESIGN-SYSTEM.md`，并在根 `CLAUDE.md` 优先级 4「零死代码」追加通用豁免（用户明确要求保留的元素不算死代码）。
- layout = 修真实间距/节奏缺陷，不重排冻结几何。
- 只做高价值、低风险、可验证改动；不引入新依赖、不新增私有 token。

## 已替代项及原因
- 原范围仅「找专家」页；用户中途扩大为全站，已按全站执行。

## 步骤
- [x] 五组只读审计 + 检测器取证
- [x] 汇总全站 critique 打分卡与优先问题
- [x] 6 组并行实施 distill/layout/typeset/polish
- [x] 验证：typecheck / build / lint:focus / lint:contract / biome / 全量 web 测试
- [x] 抽页渲染复核（找专家列表/空态/筛选、技能、知识库、概览、使用记录、账户、健康等）
- [x] Opus 独立终审（无 P0/P1；2 项 P2 已修：e2e 断言、DESIGN-SYSTEM 同步）
- [x] 修复运维组误写入主 checkout 的补丁（已还原主 checkout 并补进 worktree）与由此引入的测试回归

## 改动文件
- 43 个（含 6 张删除的 png）：agents.tsx 删两张重复创建卡+空态+排版；共享层 data-table/page/states/app-shell/resource-page/copy-button；chat/ops/knowledge/eval/plugin-detail/servers/knowledge-detail/login/not-found/分享页；运维 overview/status/accounts/runs/run-detail/audit 与 routes/-search.ts；个人 usage/memory-panel/memory-review/shares；删除 6 张 create-*.png 与 .agent-create-fan 样式；DESIGN.md 与 DESIGN-SYSTEM 快照；4 个 agents 相关测试 + tests/agent-defaults.e2e.ts 同步。
- 净减少约 150 行。

## 下一步
- 用户授权前不提交。worktree `.claude/worktrees/distill-web-design` 保留未提交改动，主 checkout 干净。
- 需产品裁决项见「待决策/推迟」。

## 验证
- `pnpm --filter @agentport/shared,db,core build` 通过。
- `pnpm --filter @agentport/web typecheck` 通过。
- `pnpm --filter @agentport/web build` 通过（仅既有 chunk 体积告警）。
- `pnpm lint:focus`、`pnpm lint:contract` 通过。
- biome：改动的 174 个 src 文件 + 4 个测试文件全通过（历史测试文件的既有 noNonNullAssertion 债务不在本任务范围）。
- `pnpm test:web`：150 文件 / 1872 用例全部通过（含运维补丁与回归修复后复跑）。补充：整批并行时 `knowledge-faq-regressions` 有 1 条 27s 超时偶发失败，单独复跑该文件 25/25 通过，与本次改动无关。
- 回归修复：`runs` 范围说明恢复「是否按筛选」区分（保留「排序仅作用于当前显示的记录」）；`runtime-environment-detail` 的删除按钮 aria 润色回退到 HEAD（该改法破坏删除流程，5 条测试失败）。
- biome：全部改动文件通过；`lint:focus` / `lint:contract` 通过。
- Impeccable detect 静态扫描 0 条（regex-only，属低估；未做逐页 live）。
- 渲染抽查（真实组件 + 临时独立库 + 真实登录）：找专家列表/空态/筛选、技能页签、知识库空态、概览区块标题、使用记录值轴与响应列、账户搜索宽度与表格字号、健康页读数与分区标题均正常，无报错。临时库与服务已清理，主 checkout 干净。

## 待决策/推迟
- `channel.tsx` 头部与右栏成员/智能体信息重复（结构性去重，需产品确认）。
- `packages/web/DESIGN.md:331` 与 `docs/DESIGN-SYSTEM.md:309` 关于个人模块 1024 上限表述矛盾，需裁决后统一。
- accounts 分页 `offset` 仍为组件态（本轮只把搜索入 URL）。
- chat trace/错误密集元信息仍 11px（高密度只读，暂留）。
- `runtime-environment-detail` 删除按钮的「禁用可访问说明」本轮回退：原 aria-disabled+点击守卫破坏删除流程，需用不破坏 disabled 语义的方式重做。
- 除已抽查页外，其余页面未逐页实屏（共享库登录态限制）。
