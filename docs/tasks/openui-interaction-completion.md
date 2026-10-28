# OpenUI 交互证据补齐

## 目标

按用户授权，为 7 个已有交互但只有渲染证据的组件补行为测试：ContextCardBlock、FollowUpBlock、OverviewCardBlock、Select、SnippetCardBlock、TextArea、VisualCardBlock。先落会失败的行为用例再修；发现 bug 一并修复。经独立 Opus 评审和本地验证后 commit/push、创建 PR 合并，合并后清理干净 worktree 并更新 main，不等待 CI。

## 基线与既有差异

- worktree：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/openui-integration-audit`
- 分支：`docs/openui-integration-audit`
- 本轮基线 HEAD：`6db7a98`（`6db7a98d21a9cfd788f24acd1c43b9c495ff103e`）。
- 前轮遗留的全部未提交 diff 属本任务延续，保留并继续提交，不丢弃、不重做。
- `docs/tasks/openui-integration-audit.md` 是未跟踪的前轮审计报告，保留。
- 主 checkout 的 `.vitest` 报告差异为原有状态，不触碰。
- 远端 `origin/main` 本地缓存为 `d6aacd3`。

## 当前有效决定

- 主会话不写源码；Opus 定契约与独立评审，Sonnet 按互斥域并行执行。使用 ub-mode。
- 范围：新增 card-actions 与 input-actions 测试；仅按 Opus 设计任务分工改必要源码（content/data/layout/forms）。不改 schema、传输、设计体系或引入依赖。
- `packages/web/test/openui-coverage-registry.json` 只由单一写者更新，避免并行冲突。
- 缺口按同一范围比较；本轮新增证据应使 nestedInteractive 减少，新增能力可登记新缺口并写明，不算回归。人工浏览器证据不计入语义覆盖率。
- 不扩防护：不新增重试、绕过或外部服务。

## 网络阻塞（2026-10-28 记录）

- `git fetch` 失败：SSL issuer 证书校验未通过，无法更新远端引用。这是本机证书链问题，不能据此断定 token 失效。
- `gh auth status` 当时无法确认有效 token；证书链阻断不等于 token 已证失效。
- 因此只能基于本地 `origin/main` 缓存 `d6aacd3`，不能声称已取最新远端。不为此增加额外防护逻辑。

## 步骤

- [x] Opus 定契约与任务分工。
- [x] 并行新增 card-actions / input-actions 行为测试。
- [x] 单一写者更新 coverage registry；跑 `openui:audit` 对比同范围缺口。
- [x] 独立 Opus 评审通过（card 与 parity 补修后复核）。
- [x] 本地提交 `c5a3c13`（仅本地，未推送）。
- [x] 基于缓存 `origin/main` = `d6aacd3` 的 merge 集成验证完成（no-commit；冲突仅 `docs/OPENUI-UPGRADE.md`，已解决且独立 Opus 通过）。
- [ ] merge commit / push / PR / 远端合并 / 删除 worktree / 更新 main：受本机 TLS 证书链阻断，当前只有本地 commit。

## 本轮结果（只补指定 7 项，不代表其余组件已全部覆盖）

- 主会话实跑两个新测试文件：`openui-card-actions.test.ts` 7/7（ContextCardBlock、OverviewCardBlock、SnippetCardBlock、VisualCardBlock、FollowUpBlock 的行为与流式禁用），`openui-input-actions.test.ts` 8/8（Select、TextArea 的必填拦截、快照恢复、流式禁用）。
- 首轮表征即绿：**没有发现需要新修的产品代码**，本轮不改源码。
- 登记：7 个名字从 `nestedOnly` 移入 `specialized`，`kind: "behavior"`，`evidence` 指向上述两个新测试文件；`nestedInteractive` 清空为 `[]`。其它登记、`samples`、审计脚本未动。
- `pnpm openui:audit` 输出：组件总数 84：behavior 14 / render 39 / nested 29（其中嵌套有交互、尚无行为证据 0）/ missing 2（IconButton、MetricIndicatorWithStrikethrough），exit 0。
- 登记自检：`openui-component-coverage.test.ts` 38/38 通过。
- Biome 对 `openui-coverage-registry.json` 检查通过（注意 `pnpm exec biome` 在本环境会命中包脚本报 `eslint not found`，直接用 `./node_modules/.bin/biome`）。
- 前一轮的完整 201 测试不算本轮结果；本轮以上述专项测试与审计输出为准。

## 下一步

顺序固定为：本地提交（已完成）→ merge 缓存 main 的集成验证（已完成）→ merge commit / push / PR 由主会话执行（尚未完成）。

- 独立 Opus 复核已完成：card 评审 2 个测试缺口与 parity 评审 2 项 must-fix（具体错误断言、cleanup 缺失）均已补修并通过。
- 新依赖实装：`@openuidev/lang-core`（core）/`@openuidev/react-lang`（web）1.0.2、`@openuidev/cli` 0.6.1；`pnpm install --frozen-lockfile --offline` 通过；shared/core/db build 与 web typecheck/build 通过。
- OpenUI 19 个测试文件 216 项在旧 deps 1.0.1 与实装 1.0.2 下均通过（中间一次 card+parity 首轮 17/18、随后转绿，发生在临时 mutation 验证同期间，原因未确证，不据此归因；主会话稳定后复跑 216 通过）。
- `openui:check` 11 项全过；`openui:audit`：behavior 14 / render 39 / nested 29（嵌套有交互、尚无行为证据 0）/ missing 2。
- 本轮 merge 集成验证后 Renderer chunk gzip 256.05 kB，仅作记录，不构成性能承诺。
- 完整 diff review 产品代码无阻断项；card locator 与 context 2 处缺口已补修，独立 Opus 通过。
- 仍受本机 TLS 证书链阻断：不能 fetch/push/PR，无法确认远端最新；当前只有本地 commit `c5a3c13`。merge commit 留给主会话，未 PR、未远端合并，也未删除 worktree。不等待 CI，不重建 cron。
- 本树 `.vitest/json/output.json` 已 `git restore`（与 HEAD 一致，操作等同 no-op）；主 checkout 同名差异未触碰。
- commit 授权有效，不再询问；不在缺少远端证据时声称已合并。
