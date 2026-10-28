# Qoder CN UI 对齐（qoder-ui-integration）

状态：六项共享契约已由 Opus 设计并冻结；六个执行代理按域并行实施中（2026-10-29）。

## 目标

以 `docs/research/qoder-cn-ui/report.md` 的实地观察为输入，一次性完成六项 UI/交互对齐，作为**一个完整任务**交付：

1. **对话过程层级**：任务消息区把「已处理」过程折叠，正文与旁侧监控/成果分层且保持关联，不照搬 Qoder 的监控内容与默认状态。
2. **资源中心**：类型切换、搜索与管理操作置于顶栏，分类/排序紧邻列表，详情再呈现服务配置与可用性。
3. **定时任务创建**：创建弹窗按「任务内容」与「执行条件/计划/授权」分区，危险或授权语义就近可见，但不照搬其默认授权。
4. **文档阅读工具栏**：文件侧栏可收起，阅读区就近提供渲染/源码切换、复制、下载。
5. **专家配置布局**：按现有设计体系重排信息层级与分区，不复制 Qoder 的视觉主题。
6. **历史搜索**：支持按标题、ID、消息正文检索，结果带专家与时间，并提供键盘上下选择 + Enter 打开；后端能力缺失时与前端一起补齐。

验收标准：六项均可实际操作并通过整体验证；沿用项目现有设计令牌、shadcn/Base UI 与既有布局契约；不破坏现有功能。

## 方案

- 先由 Opus 子代理基于调研报告与现有代码确定**共享契约**（布局骨架、组件复用、令牌、数据/接口契约、历史搜索后端边界），再让 Sonnet 子代理按六个域并行执行。共享契约现已冻结，完整范围一次性派发，域内实现不互相等待。
- 六项之间只有先后依赖，没有分批确认：共享契约冻结后一次性派发完整范围。
- 最后由 Opus 子代理做 code review 与整体验证，主会话负责合并与按改动范围运行验证命令。
- 视觉一律沿用现有 design tokens 与 `docs/DESIGN-SYSTEM.md`；**不复制 Qoder 的品牌色、渐变和宣传文案**。本任务按冻结契合同步修正 `DESIGN-SYSTEM.md` 中与六项冲突的布局/交互条款；所有视觉数值与令牌保持不变。
- 历史搜索若缺少后端检索能力，与前端同一任务内补齐，不拆成后续需求。

### 历史搜索接口（已冻结）

```text
GET /api/conversations/search
查询：{ q, agentId?, limit, before? }
响应：{ items, nextBefore }
item：{ id, agentId, agentName, title, updatedAt, match }
```

客户端接入：

- `api.searchConversations(options, signal)`
- `searchConversationsOptions(options)`

## 写入域（并行约定）

| 域 | 独占写入文件 |
|---|---|
| 资源 | `packages/web/src/components/resource-page.tsx`、`packages/web/src/pages/skills.tsx`、`packages/web/src/pages/plugins.tsx`（列表索引） |
| 表单 | `packages/web/src/pages/ops.tsx` |
| 专家 | `packages/web/src/pages/agents.tsx` |
| 阅读 | `packages/web/src/pages/plugin-detail.tsx`、`packages/web/src/pages/knowledge-detail.tsx`、`packages/web/src/components/conversation-outputs.tsx`、`packages/web/src/components/reader-toolbar.tsx` |
| 聊天 | `packages/web/src/pages/chat.tsx`、`packages/web/src/components/conversation-search.tsx`、trace 相关组件 |
| 后端与共享客户端（shared） | `packages/shared/src/chat.ts`、`packages/db/src/repo/chat.ts`、`packages/api/src/features/chat/routes.ts`、`packages/web/src/lib/api.ts`、`packages/web/src/lib/queries.ts` |

- `shared` 域是唯一后端接口写入者；聊天域是唯一聊天 UI 写入者，避免同一文件多写入者。
- `packages/web/test/resource-navigation.test.ts` 归资源域；`packages/web/test/chat-outputs.test.ts` 归阅读域。

## 基线与范围

- 基线 commit：`6b6b3f1d9cb903ab4ad67306d41a3cf1b8288914`（工作树 HEAD 与之相同）。
- 工作树初始状态：干净，无未提交差异。
- 授权边界：用户未授权 commit / push / merge；完成实现与验证后以未提交差异交付，是否提交由用户后续决定。
- 允许改动范围：六项对应的前端实现、必要的共享组件/令牌使用、历史搜索所缺的后端接口、相关测试与任务文档。
- 只读参考：`docs/research/qoder-cn-ui/report.md` 与其 `screenshots/`。
- 边界：`docs/DESIGN-SYSTEM.md` 的视觉数值与令牌不变；仅按冻结契约同步修正布局/交互冲突条款（本任务文档代理负责）。

## 当前有效决定

用户最新明确决定（2026-10-29）：

- 六项一起做，作为一个完整任务；先后只是**依赖顺序**，不需要再分批征求确认。
- 六项固定为：对话过程层级、资源中心、定时任务创建、文档阅读工具栏、专家配置布局、历史搜索。
- 历史搜索必须覆盖标题、ID、消息正文，并带专家/时间与键盘操作；**缺后端就一起补**。
- 沿用现有设计令牌，不复制 Qoder 的渐变与品牌视觉。
- 流程固定为：Opus 设计并定共享契约 → Sonnet 分域并行实现 → Opus review 与整体验证。

设计与实施决定（2026-10-29）：

- 六项共享契约已冻结，六域按上表写入边界并行实施。
- 文档同步修正的六项契约：
  - 资源中心为真实五类（专家 / 技能 / 连接器 / 插件 / 知识库），导航、搜索与管理位置统一；内资源保留卡片，技能市场改为轻量两列条目（窄桌面一列），只显示真实来源与安装数，无宣传与假分类。`ResourcePage` 顶层布局保持复用，搜索最终位置以资源域实现为准，暂写统一操作区、不锁死固定两行。
  - 专家配置短字段（模型 / 权限 / 运行限制等）用横向设置行，标签左、控件右；长提示词与文件仍用纵向 `Field`，不全盘标签上方。
  - 对话每轮正常工具集中到折叠的执行过程；顶层正文顺序全保留；审批、原生提问、失败、缺失结果与 error 始终在折叠外可见且不重复；任务清单独立；失败/超时原因常驻。
  - 历史搜索浮层覆盖全部专家，检索标题、ID 与正文；支持键盘上下选择、输入法保护、关闭焦点归还、取消旧查询与分页；打开目标专家 + 会话并保留草稿，不承诺跳转到正文命中消息本身。
  - 阅读统一 `ReaderToolbar` 的阅读/源码、复制、下载身份；插件、知识库与会话成果保留各自业务差异；会话成果右侧栏保持 320px，不扩宽。
  - 定时任务创建为左右两栏：左侧任务内容，右侧执行条件；只列已有专家、cron 按 UTC 解析、启用开关，不写不存在的时区或授权选项。
- 视觉数值与令牌全部不变。

## 已替代项及原因

以下为**方案收敛**，不是用户对相关功能的明确否决：

- 分批交付、每批确认后再继续 → 改为一次性完整交付，只保留实现依赖顺序；为减少重复确认、缩短完整交付时间。
- 历史搜索先只做前端、后端以后补 → 改为前后端同任务补齐；避免交付半条搜索链路。
- 参考 Qoder 的渐变与品牌色 → 改为只沿用项目现有设计令牌；项目视觉基准高于参考产品外观。

## 步骤

- [x] 开工前读 `docs/PITFALLS.md` 与 `docs/DEV-WORKFLOW.md` §3，确认任务记录模板与 worktree 约束。
- [x] 将调研报告复制为 `docs/research/qoder-cn-ui/report.md`，22 张截图保存到同目录 `screenshots/`，核对相对链接全部有效。
- [x] 纠正报告来源：版本 0.4.11 由主会话实际通过 `ps` 读取进程注记取得，非用户提供；Codex CLI 显式使用 `-m gpt-6.1-terra`，TUI 确认 GPT-6.1 Terra high；删除未核实模型的过时说法。
- [x] 删除审批过程与 Rex 无关失败等非产品缺口描述，保留真实观察限制。
- [x] Opus 子代理设计六项共享契约，已冻结并派发。
- [x] 按冻结契约同步修正 `docs/DESIGN-SYSTEM.md` 中资源中心、专家配置、对话过程、历史搜索、阅读工具栏与定时任务创建的冲突条款。
- [x] Sonnet 子代理按六个域并行实现（历史搜索含必要后端）。
- [x] Opus 子代理 code review；搜索游标/摘录、阅读栏溢出、目录选中、复制反馈、搜索键盘、审批去重与缓存错误等发现已修复。
- [x] 按改动范围做整体验证（typecheck、构建、相关测试、真实页面操作），结果见「验证」。

## 改动文件

本次任务已产出或已修改：

- `docs/tasks/qoder-ui-integration.md`（本记录）
- `docs/DESIGN-SYSTEM.md`（按冻结契约同步布局/交互条款；视觉数值与令牌未改）
- `docs/research/qoder-cn-ui/report.md`
- `docs/research/qoder-cn-ui/screenshots/*.png`（22 张，**仅本地暂存，不提交**）

六域实现文件见上表「写入域」；截至本记录更新仍在实施，未定稿。

## 下一步

- 本任务功能、评审与验证已完成，未提交差异保留在 worktree `qoder-ui-integration`。
- commit / push / merge 均未获授权，等用户明确指示。
- thinking 展示未实现：官方 registry 无独立组件，且当前 runner/事件契约不保留 thinking 内容；需另行打通 SDK→事件→存储后再接 `Trace`，不在本任务伪造。

## 验证

实施前基线（真实已执行，**仅代表基线，不是最终验收结果**）：

- `pnpm install --frozen-lockfile` → 通过。
- shared / core build → 通过。
- `pnpm test:web` → 95 个测试文件 / 983 个测试通过。
- `pnpm typecheck` → 通过。

本次文档任务已执行：

- `git rev-parse HEAD` → `6b6b3f1d9cb903ab4ad67306d41a3cf1b8288914`，与基线一致；开工时 `git status --short` 无输出（干净）。
- 截图数量：`ls docs/research/qoder-cn-ui/screenshots | wc -l` → `22`。
- 链接核对：报告中 `screenshots/*.png` 引用去重后 22 个，与目录内 22 个文件名完全一致（`diff` 无差异）；报告内 `DESIGN-SYSTEM.md` 改为相对链接 `../../DESIGN-SYSTEM.md`，可解析到 `docs/DESIGN-SYSTEM.md`。

产品实现与整体验证（真实已执行）：

- `pnpm test:web` → 100 个测试文件 / 1030 条通过。
- 后端相关 `shared + api + db` 六套件 → 6 个文件 / 60 条通过（搜索、微秒分页、聊天、历史分页、定时任务、消息落库）。
- `pnpm typecheck` → 全部包通过；`pnpm --filter @agentport/web build` → 通过。
- `pnpm lint:focus`、`pnpm lint:contract` → 通过。
- 隔离库验收（独立 PG/Redis、3012、夹具数据）：搜索 Enter/方向键跨专家打开正确会话；官方 Trace 的 `trace-collapsible / trace-line / trace-icon / trace-title / trace-description` 均存在；待批审批只出现 1 次且在折叠外；知识文档目录可收起后 `aria-expanded=false`、无横向溢出；源码模式仅 1 个复制入口。
- 限制：未启动真实 worker/模型；验收数据为落库夹具；thinking 数据当前不可用，未展示。

## 隐私与暂存状态

- `docs/research/qoder-cn-ui/screenshots/` 含 Qoder 窗口内的已有任务与知识内容，属工作资料，**仅本地暂存，不提交、不上传、不外发**。
- 后续提交时只显式添加 `docs/research/qoder-cn-ui/report.md` 与本任务记录，禁止 `git add docs/research` 或 `git add -A` 把截图带入版本库。
- 报告文字已注明截图的工作资料属性；截图本身不进入交付物。
