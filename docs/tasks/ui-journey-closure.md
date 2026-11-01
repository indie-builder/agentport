# UI 动线闭环（第一批）

## 目标

按用户 2026-11-01 确认的审计结论，先修「动线闭环」这一类问题：减少下钻后回不到来源、下一步不可点、同一实体重复管理入口。

验收标准：

1. 从使用记录、概况、对话、运维待处理、评估结果进入运行详情后，返回按钮回到进入前的页面并保留该页 URL 状态；直接打开详情仍回运行列表。
2. 专家配置的能力分区在没有可绑定项时，给出可点击的真实导航入口（连接器 / 知识库 / 技能），与同区插件入口一致。
3. 知识库处理记录中的文档/来源对象可以进入对应工作面，与来源页已有跳转一致。
4. 个人记忆有内容时，已保存正文先于说明文字出现；空态不再出现与「还没有个人记忆」矛盾的注入说明。
5. 概况存在待处理事项时，「需要处理」排在运行趋势之前；没有待处理时保持原位。
6. 专家详情同一屏只出现一个删除专家入口：配置工具栏可见时由它承担，其余情况由页头菜单承担。

## 方案

- 运行来源统一用一个 `backTo` 查询参数承载进入前的相对 URL（`pathname + search`），替代 `fromAgent/fromStatus/fromView` 三个参数；入口用 `useLocation().href` 生成，详情校验只接受站内相对路径，缺省回 `/runs`。
- 能力分区空态复用现有 `Link + buttonVariants({ variant: 'outline', size: 'sm' })`。
- 知识库 `JobsTab` 增加 `onOpenDocument` / `onOpenSource`，复用详情页已有的 `go()` 面板跳转。
- 个人记忆只调整说明文字的位置，不改变阅读态工具栏在正文之前的既定结构。
- 概况用同一 `useAttention` 查询判断 `total > 0` 后决定「需要处理」与趋势的相对顺序。
- 专家页头菜单的删除项在 `tab === 'config' && canReadConfig` 时隐藏，由配置工具栏菜单承担。

## 基线与范围

- 起点：`origin/main` `ea49e5bf44be6265e0625b214190a1f953a1ed3f`；worktree `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-journey-closure`，分支 `worktree-ui-journey-closure`。
- 开工时 `git status --porcelain` 为空。
- 允许改动：`packages/web/src/routes/-search.ts`、`packages/web/src/pages/{run-detail,runs,overview,ops,eval,chat,personal-usage,agents,knowledge-detail}.tsx`、`packages/web/src/components/personal-memory-panel.tsx`、对应 `packages/web/test/*` 与 `tests/regression.e2e.ts` 的定位器。
- 不改后端、契约 schema、DESIGN-SYSTEM 的已批准布局。

## 当前有效决定

- 用户 2026-11-01 明确：「按你的建议来给我调整」，即执行审计中排在第一批的动线闭环项。
- 只做第一批；身份列、重复文案、术语统一等留到后续批次。
- 本任务不 commit/push/merge，交付「验证完成、未提交差异」。

## 已替代项及原因

- 个人记忆原方案「把正文整体提到操作之前」被收窄为「把注入说明移出首屏」：操作行是阅读态工具栏，移到正文下方会让编辑入口被长文遮挡，反而降低可用性。
- 运行来源原方案扩展 `from=personal|overview|chat` 枚举，改为单一 `backTo`：枚举需要为每个来源再带筛选参数，参数数量更多且仍会漏；完整相对 URL 能保留任意筛选与分页。

## 步骤

- [x] 运行详情改用 `backTo`，更新运行列表与全部入口
- [x] 专家能力分区空态改成真实链接
- [x] 专家详情删除入口去重
- [x] 知识库任务对象可导航
- [x] 个人记忆说明文字归位
- [x] 概况待处理前置
- [x] 定向测试 + typecheck + build
- [x] 独立 Opus 终审；4 个必须修已修复并复核通过

## 改动文件

源码 11 个：

- `packages/web/src/routes/-search.ts`
- `packages/web/src/pages/run-detail.tsx`、`runs.tsx`
- `packages/web/src/pages/overview.tsx`、`ops.tsx`、`eval.tsx`、`chat.tsx`、`personal-usage.tsx`
- `packages/web/src/pages/agents.tsx`
- `packages/web/src/pages/knowledge-detail.tsx`
- `packages/web/src/components/personal-memory-panel.tsx`

测试 16 个：`packages/web/test/` 下 admin-errors、admin-pages、agents-lifecycle、chat-interactions、chat-trace、chat-ux、knowledge-management、memory-review-page、overview-health、overview-ux、personal-memory-page、personal-usage-journey、run-detail-navigation、runs-view-toggle、search-contract；以及 `tests/regression.e2e.ts`。

## 下一步

- 第一批已完成，未提交。第二、三批（身份列、重复文案、术语统一）待用户确认后再开工。
- 真实浏览器与完整 E2E 未跑：需共享 PostgreSQL/Redis、迁移库、API + Web 与管理员会话；为避免写共享开发数据，本次未执行。

## 验证

- `pnpm --filter @agentport/web typecheck`：通过（`tsc -b` 无输出）。
- `pnpm --filter @agentport/web build`：通过（820ms）。
- `pnpm test:web`：149 个测试文件、1863 条用例全部通过。
- `pnpm lint:focus`：焦点/边框规约校验通过。
- `pnpm lint:contract`：project contract OK。
- `biome check`（全部 27 个改动文件）：0 error；2 条 warning 为既有代码（`chat-ux.test.ts:35` 非空断言）。
- 独立 Opus 终审第一轮：4 个必须修（backTo 同源占位绕过、专家配置失败时删除入口消失、概况失败态误前置、e2e 加载中误判），全部修复。
- 独立 Opus 复核：4 项全部通过，无必须修；113 项定向测试通过。
- 定向安全用例覆盖：`//placeholder.invalid`、`/\placeholder.invalid`、反斜杠+字母、制表符、空格、绝对 URL、超长、空串均被拒绝；合法站内路径通过。
