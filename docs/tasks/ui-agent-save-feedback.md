# 专家配置页保存/校验/回滚/离开保护反馈（ui-agent-save-feedback）

## 目标

第六轮界面巡检：处理**专家独立配置页**（`/agents/$agentId`）在**保存、校验、版本回滚、离开保护**四个环节的反馈。

验收方向：
- 反馈符合 `docs/DESIGN-SYSTEM.md`（信息表达 §10、动效 §11）与 `docs/PROJECT-BRIEF.md` 的桌面端约定。
- 成功、失败、进行中、被拦截各状态都有可见且可访问的表现，不出现静默失败或无解释的禁用。
- 不新增依赖、不改后端契约、数据模型与设计令牌；不破坏既有保存冲突、版本快照、路由拦截行为。

## 方案

本记录由 Opus 探索四环节后给出唯一确定缺陷，主会话固定契约，再由 Sonnet 执行。

### 已确认缺陷（唯一根因）

`packages/web/src/pages/agents.tsx` 的 `diffFields`（版本差异的唯一字段清单）遗漏 `uiFormat` 与 `pluginBindings`。后果：

- 仅这两项不同时，历史详情展开显示「与当前配置一致」；
- 回滚确认文案声称「该版本与当前配置一致，回滚不会改变字段」；
- 实际后端 `snapshotToWrite` 恢复 `uiFormat`，`updateAgent` 按 `snapshot.pluginBindings` 覆写插件绑定（含 `allowHooks` / `allowMcp` 授权），并生成新版本。

即 UI 对一次真实配置变更（含插件 hooks/MCP 授权）静默不报。

### 契约

- 只在 `diffFields` 增加两项，顺序放在语义相邻处：`['uiFormat', '回复格式']` 紧跟 `systemPrompt`；`['pluginBindings', '插件绑定']` 紧跟 `subAgentIds`（与「能力」分区顺序一致）。
- 值展示沿用现有 `displayValue`：数组走 JSON 全文，不新增字段映射、摘要或组件。
- 不改后端、API 契约、`Agent`/`AgentInput` 类型、设计令牌、依赖。

### 真实遗漏复核（未扩范围）

对照 `packages/shared/src/agent.ts` 的 `Agent` 全部字段与 `packages/api/src/features/agents/routes.ts` 的 `snapshotToWrite` / rollback 参数：

- `uiFormat`、`pluginBindings`：本轮补齐。
- `slug`：rollback 固定沿用当前 slug（`snapshotToWrite(snapshot, current.slug, …)`），不可能被回滚改变，不进差异清单是正确的。
- `parentId`、`id`、`createdAt`、`updatedAt`：身份/委派关系与时间戳，rollback 不恢复 `parentId`（子智能体关系由 `subAgentIds` 承载，已在清单内），不应展示为「将改为」。
- 其余可写字段（`name`、`role`、`description`、`model`、`systemPrompt`、`serverIds`、`skillIds`、`subAgentIds`、`allowedTools`、`disallowedTools`、`permissionMode`、`maxTurns`、`maxBudgetUsd`、`timeoutMs`、`effort`、`maxThinkingTokens`、`enabled`）均已在清单内。

结论：除上述两项外无其他真实遗漏。

## 基线与范围

- 工作目录：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/ui-agent-save-feedback`（分支 `worktree-ui-agent-save-feedback`）。
- 起点 HEAD `2bfaa09ef83de30b9ac76dfd4bedc1703afe2305`，`origin/main` 同为 `2bfaa09ef83de30b9ac76dfd4bedc1703afe2305`，与声明起点一致。
- 本 worktree 初始工作区干净（`git status --short` 无输出）。
- 主 checkout 存在 `.vitest` 相关未提交差异：**非本任务产出**，不提交、不还原、不覆盖。
- 前五轮界面巡检 PR #83/#84/#85/#86 已合并并清理 worktree；第五轮无代码改动、无 PR，树已清，本记录不重复其范围。
- **改动白名单（已固定）**：`packages/web/src/pages/agents.tsx`（仅 `diffFields`）、`packages/web/test/agents-lifecycle.test.ts`、本记录。不改后端、依赖、设计令牌，不扩展到无关页面。

## 当前有效决定

1. 用户已完整授权每轮流程：实现 → 按改动范围验证 → Opus 独立 review → commit / push / PR / merge → 清理 worktree，无需重新授权；git 交付由主会话执行。
2. 本轮只覆盖专家独立配置页的保存、校验、版本回滚、离开保护反馈；Opus 探索给出唯一缺陷为 `diffFields` 遗漏两项，主会话固定，其余环节未发现需改动的确定缺陷。
3. 模型分工按 `pstack-models.md`：探索/设计/独立 review 用 Opus，执行用 Sonnet；主会话不亲自改源码。
4. 动效沿用项目规则：仅局部交互与状态反馈（90–160ms、`--ease-out-soft`、只过渡实际变化的属性），不做页面入场或装饰位移。
5. 实测口径按 `docs/PITFALLS.md`：UI 项交付前读浏览器实际几何、计算样式与焦点行为，数值写入验证段。
6. 个人项目取向：不向后兼容、不为理论风险加防护；验证按改动范围选择，不固定跑全套，不等待 CI。

## 分工与替代项

- Opus（a4d）完成四环节探索并给出唯一缺陷 `diffFields` 遗漏两项，主会话固定契约后交 Sonnet 执行；主会话未亲改源码，只负责 review 与 git 交付。
- 「四环节全量巡检」收窄为唯一确定缺陷：其余保存/校验/离开保护环节未发现可复现的确定缺陷，不为凑数扩大改动。
- 用户授权本轮始终有效：实现、验证、Opus review、commit / push / PR / merge、清理 worktree 均按既有授权执行，无需重新授权。

## 步骤

- [x] 阅读 `docs/DEV-WORKFLOW.md` §3 模板与 `docs/PITFALLS.md` 相关条目。
- [x] 核对基线：HEAD、`origin/main`、worktree 状态与主 checkout 既有差异归属。
- [x] 创建本任务记录。
- [x] 主会话固定唯一缺陷与契约（源自 Opus 探索产出，见「方案」），执行范围收窄到 `diffFields` 两项 + 行为测试 + 本记录。
- [x] 行为测试先红（仅这两项不同的历史出现「与当前配置一致」）；再最小实现转绿。
- [x] Opus（a698）独立 review 通过，除记录同步外无阻塞项。
- [x] 按改动范围验证并更新本记录的「验证」「下一步」。
- [ ] 主会话按既有授权 commit / push / PR / merge，并清理该轮 worktree。

## 改动文件

- `packages/web/src/pages/agents.tsx`：`diffFields` 增加 `['uiFormat', '回复格式']`、`['pluginBindings', '插件绑定']`。
- `packages/web/test/agents-lifecycle.test.ts`：复用真实 `AgentDetailPage` + `VersionHistory` fixture，新增两条参数化用例（2 组、共 4 例：差异文案 / 回滚加载各 2 组）。
- `docs/tasks/ui-agent-save-feedback.md`：本记录。

未改动后端、API、`Agent`/`AgentInput`、依赖、令牌。

## 下一步

1. 主会话按既有授权直接 commit / push / PR / merge，并清理该轮 worktree；review 与验证均已完成，不再等待。

## 验证

基线（2026-10-28，真实输出）：
- `git rev-parse HEAD` → `2bfaa09ef83de30b9ac76dfd4bedc1703afe2305`
- `git rev-parse origin/main` → `2bfaa09ef83de30b9ac76dfd4bedc1703afe2305`
- `git status --short` → 无输出（工作区干净）

### 定向测试与检查

- 先红：`pnpm vitest run --project web packages/web/test/agents-lifecycle.test.ts` → 27 tests，3 failed。失败原文：
  - 差异用例：`expected '… v101/01 08:00收起差异 回滚与当前配置一致。' not to contain '与当前配置一致'`（回复格式、插件绑定各一条）。
  - 回滚加载用例（插件绑定）：`expected null to be 'false'`（回滚后 `#plugin-plugin-1-hooks` 授权未按目标快照加载；测试先行写法用到了 `aria-checked`，改为读原生 `checked` 后该条通过，只剩差异两条红）。
- 后绿：同命令 → **27 passed**（1 file）。
- `pnpm vitest run --project web packages/web/test/agents-ui.test.ts packages/web/test/agents-preview-on-demand.test.ts packages/web/test/agents-files-on-demand.test.ts` → **37 passed**（3 files）。
- `pnpm --filter @agentport/web typecheck` → exit 0（`tsc -b`，无输出）。
- `pnpm exec biome check packages/web/src/pages/agents.tsx packages/web/test/agents-lifecycle.test.ts` → exit 0，`Checked 2 files in 36ms. No fixes applied.`（第一次经 rtk 包装只回了 `Lint: 1 errors` 且无可读明细，`rtk bypass` 复跑为 0；以 exit 0 + 0 改动为准）。

### 主会话最终结果

- 完整 web 套件：77 files、766 tests 全过。
- `pnpm --filter @agentport/web typecheck` → 通过；`pnpm --filter @agentport/web build` → 通过。
- `biome` 2 files 通过；`lint:focus`、`lint:contract` 通过。
- 未做全仓 backend 测试，按改动范围不涉及后端。

### 浏览器实测（ego-browser v2.1.0，固定 space `ui-agent-save-feedback`）

入口：一次性 `packages/web/.visual-check/`（端口 5199），真实 `VersionHistory`（已 export）+ 真实 `src/styles.css` + 受控 `fetch`（`/agents`、`/agents/expert/versions`、`/agents/expert/versions/1`、`/agents/expert/rollback`），内存 TanStack Router/QueryClient；`?case=uiFormat|plugins` 切换预置 current/snapshot，`&pending=1` 让回滚请求永不返回。采样后已停该 Vite、删除临时目录。

- 仅回复格式不同（current `openui` → snapshot `markdown`）：展开差异读到一行「回复格式 / openui → markdown」；无「与当前配置一致」。回滚确认文案真实读数：`将把 1 个字段改为该版本的值：回复格式。当前配置会被覆盖，并生成一个新版本。`
- 仅插件绑定不同（current `allowHooks: true` → snapshot `allowHooks: false`，`allowMcp` 两项均为 `true`）：展开差异读到「插件绑定」，新旧值均为完整 JSON 全文，包含 `pluginId`、`allowHooks`、`allowMcp`（hooks 授权差异可见，MCP 授权原样保留）。DOM 计算样式：值容器 `white-space: pre-wrap`、`word-break: break-all`，`124×109` → `1352×208`，行宽 `1464`，无横向溢出（`scrollWidth === clientWidth`）。回滚确认文案：`将把 1 个字段改为该版本的值：插件绑定。当前配置会被覆盖，并生成一个新版本。`
- pending 与焦点：确认回滚后读真实 DOM：关闭按钮 `disabled: true`，取消 `disabled: true`，确认按钮文本变为「处理中…」且 `aria-busy="true"`、`disabled: true`；焦点仍在对话框内（`dialog.contains(document.activeElement) === true`，`BUTTON`）。此时 `Escape` 不关闭对话框（`stillOpenAfterEscape: true`）。
- 成功回滚：以 `?case=plugins` 正常返回目标快照，页面 current 变为 `uiFormat=markdown pluginBindings=[{"pluginId":"plugin-1","allowHooks":false,"allowMcp":true}]`，对话框关闭，Sonner 吐司读数为「已回滚到 v1」。

### 限制与未测

- 浏览器入口只覆盖 `VersionHistory` 组件层（含真实 `VersionHistory`/`ConfirmDialog`/`Toaster`/样式与受控 mock 数据），不是完整 `AgentDetailPage`，也未接真实登录、数据库与后端回滚后的 `agent-files` 失效及整页刷新；未跑全流程回归（按任务要求收窄）。
- 新建/切换分区的编辑器 side effect（`loadDraft` 后 `rhf.reset`）由 `agents-lifecycle.test.ts` 的真实 `AgentDetailPage` 用例覆盖（回滚后 dirty 清除、`uiFormat` 下拉显示 `Markdown`、插件 `hooks/mcp` 复选框读原生 `checked`），浏览器未重复构造。
- 未执行全仓 backend 测试；本轮只改 web 侧，按改动范围不需要。
