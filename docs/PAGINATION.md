# 分页契约

> 2026-11-21 统一。权威实现：`packages/shared/src/pagination.ts`（wire 与参数 schema）、`packages/db/src/repo/pagination.ts`（keyset）、`packages/api/src/http/pagination.ts`（API 兜底）。新增或修改列表前先读本文；文档与代码冲突时按代码修正本文。

## 1. 机制选择

| 机制 | 适用场景 | 返回形状 | 实现位置 |
|---|---|---|---|
| 游标键集（默认） | 用户数据滚动列表、无限加载 | `{ items, nextCursor }` | `keysetPage` + `cursorPageSchema` |
| offset 页码 | 需要总数、跳页的管理表格或选择器 | `{ items, total }` | `offsetQuerySchema` + `offsetPageSchema` |
| seq 区间 | 自带单调序的追加流（频道消息、审计链） | 各接口既有形状 | `channelMessagesQuerySchema`、`audit.verify/export` |
| 显式有界 | 有明确硬上限或完整配置集合 | 数组、`{ items }` 或带 `truncated` | 接口契约声明 |

规则：

- 新增普通用户数据列表默认用游标键集；需要总数或页码跳转才用 offset；只有数据本身按 seq 追加时才用 seq 区间。
- 新增普通列表只用 `cursorPageSchema` / `offsetPageSchema` 两种信封，不再新增第三种。下文「现有例外」是历史接口，不据此扩展新形状。
- 有界列表必须显式写明上限或「完整配置集合」的理由；禁止在 handler 或前端静默截断。

## 2. wire 形状

`packages/shared/src/pagination.ts`：

```ts
cursorPageSchema(item)   // { items: item[], nextCursor: string | null }
offsetPageSchema(item)   // { items: item[], total: number }
```

- `nextCursor === null` 表示没有下一页。
- 游标无效、过期或锚点不在当前访问/筛选范围内时，服务端返回 400，不返回空页。
- 客户端把 `cursor` 当作不透明字符串，不解析、不拼接。
- 可变排序列的游标内嵌该行的排序值（时间列为时间戳文本，名称/标题列为原文），保证排序值变化时翻页稳定；解析或校验不通过视为无效游标，返回 400。

现有例外（不改造成新信封）：

| 接口 | 形状 | 原因 |
|---|---|---|
| `GET /api/notifications` | `{ items, nextCursor, unreadCount }` | 同页返回未读数，避免额外请求 |
| `GET /api/conversations/{id}` | `{ conversation, messages, runMetrics, nextCursor }` | 详情内嵌最近一页历史，不另造列表信封 |
| `GET /api/knowledge/wiki-pages/{pageId}` | 页面字段 + `versions`, `nextCursor` | 详情内嵌版本页 |
| `GET /api/channels/{id}/messages` | `channelMessageSchema[]` | seq 区间接口，用 `after` / `before` 表达位置 |
| 有界配置列表 | 数组或 `{ items }` | 没有下一页语义 |

## 3. 参数与默认值

默认值只在契约 schema 中定义，handler 不再补默认值。repo 的 `pageLimit` 与少量内部入口保留兜底默认，只服务内部调用，不作为对外契约值。

| schema | 默认 `limit` | 最大 `limit` | 其他参数 |
|---|---:|---:|---|
| `pageQuerySchema` | 50 | 100 | `cursor` |
| `adminPageQuerySchema` | 50 | 200 | `cursor` |
| `offsetQuerySchema` | 50 | 100 | `offset`（默认 0） |

`cursor` 是不透明字符串，输入上限统一为 `CURSOR_MAX_LENGTH = 262144`（`packages/shared/src/pagination.ts`）。该上限必须覆盖服务端自己签发的最长游标：知识库文档标题游标内嵌同步文档的标题原文，可达数千字符，`JSON.stringify` 转义与 base64url 编码后再放大。不为单个接口另设游标上限。

三个专用短 ID 契约是例外，仍各自保留 200 字符的游标上限（`evalRunListQuerySchema` 见 `packages/shared/src/schemas.ts`，`personalRunListQuerySchema`、`personalShareListQuerySchema` 见 `packages/shared/src/personal.ts`）：它们只签当前页末条的 TypeID，游标长度有界，远低于 200。其余列表一律使用 `pageQuerySchema` / `adminPageQuerySchema` 的 262144。

接口专属上限仍可收窄或放宽，但必须写在契约里，例如：

| 接口 | 参数 |
|---|---|
| `/api/notifications` | 默认 30，最大 100，`unreadOnly` |
| `/api/conversations/search` | 默认 20，最大 50 |
| `/api/audit/verify` | 默认 1000，最大 5000 |
| `/api/audit/export?format=ndjson` | 默认 1000，最大 1000 |
| `/api/channels/{id}/messages` | 默认 50，最大 200 |
| `/api/me/outputs` | 默认 50，最大 100 |

知识库 repo 的 `pageLimit` 允许到 200，用于服务端内部完整枚举（如文件夹全量）；HTTP 契约仍按 `pageQuerySchema` 限制到 100，不能绕过契约直接暴露 200。

## 4. 数据库规则

`keysetPage`（`packages/db/src/repo/pagination.ts`）：

- 参数包含 `table`、`cursor`、`limit`、`column`、`direction`、`where`、`load`；可选自定义 `id` 列。
- 有游标时，先在同一组 `where` 条件（含 `AccessFilter` 与业务筛选）内按 id 重查锚点；找不到返回 `null`，由 API 转成 400。
- 边界用 `keysetBound` 生成 `(column, id)` 元组比较，id 是必要的并列 tie-breaker；`column` 本身是 id 时退化为 `>` / `<`。
- 默认 `column = createdAt`、`direction = desc`；其他排序必须显式传入。
- 查询固定取 `limit + 1` 条；`paginate` 只返回前 `limit` 条，多出的第 `limit + 1` 条决定 `nextCursor` 为该页最后一条的 id。
- offset 只用于管理表格或选择器：同一筛选条件并行执行 count 与 page 查询，返回 `total`。用户滚动列表不使用 offset。
- 频道消息的 `after` / `before` 是数值 seq 边界，直接用于 `>` / `<` 比较，不要求对应现存消息。
- 审计验链的 `afterSeq` 与 NDJSON 导出按 `chain_seq` 校验锚点：验链找不到锚点时返回 `ok: false`、`complete: false`；导出或列表找不到锚点时转 `invalidCursor()`。
- 审计列表的游标锚点与页面查询使用同一组条件（`auditFilters` 加 `before` 时间上界）；锚点落在当前时间窗外的游标按无效游标处理。

复合游标：

- 多列排序、排序模式切换用 `encodeCursor(parts)` / `decodeCursor(cursor, expectedParts)`（base64url 编码的 JSON 字符串数组）。
- `decodeCursor` 在 base64/JSON 损坏、部分数量不符或含非字符串时返回 `null`；调用方必须转 `invalidCursor()`。
- 现有复合游标：runs `[startedAt, id]`（`startedAt` 为空时用空字符串）、agents `[sort, id]`、知识库文档 `[sort, order, id]`（默认 `created desc` 排序仍用末条 id；其他排序切换时按复合游标校验）。
- 工作区产出游标 `{createdAt, runId, path}`（base64url 编码的 JSON 对象）：版本按 `(createdAt, runId)` 倒序，同一版本内按 `path` 升序；会话产出与频道 run 产出共用该游标。
- 知识库图片游标 `{u: updatedAt, d: documentId, n: name}`（base64url 编码的 JSON 对象）：按 `(updatedAt, documentId, name)` 倒序，锚点在当前筛选范围内按 `documentId` 与 `name` 重查。
- 单键列表可以直接用锚点 id 作为游标（如审计列表）；客户端仍按不透明值处理。

## 5. API 规则

`packages/api/src/http/pagination.ts`：

```ts
invalidCursor()            // 400 INVALID_INPUT，path: '/cursor'
requireCursorPage(page)    // page 为 null 时调用 invalidCursor()
```

- repo 返回 `null` 表示游标无效或锚点不在当前范围内；handler 必须经 `requireCursorPage` 或显式 `invalidCursor()` 转换，不能改写成 `{ items: [], nextCursor: null }`。
- handler 不手写 `slice`、`offset` 或二次上限；分页与 `limit + 1` 在 repo 完成。
- 有界列表的上限写进契约（`max()`）或在契约中返回 `truncated`；不允许静默丢弃。
- 新增列表在 `docs/PAGINATION.md` §7 登记机制与上限。

错误形状与 `Problem` 见 [ERRORS.md](ERRORS.md)。无效游标的固定文案是「分页游标无效，请刷新后重试」，`path` 为 `/cursor`。

## 6. Web 规则

- 无限列表统一用 `packages/web/src/lib/queries/shared.ts` 的 `useCursorList`；它把 `nextCursor` 映射为 `getNextPageParam`，`null` 表示结束。
- query key 必须包含全部筛选条件与页大小；切换筛选就是新的列表，不能复用旧游标。
- 列表尾部提供「加载更多」；需要连续消费时用 `useDrainPages`。禁止在前端 `.slice()` 静默截断。
- 接口返回 `truncated` 时必须在界面显示说明（如 `PageNote` 或 toast），不能当作完整结果。
- offset 表格用页码状态，不套 `useCursorList`；频道消息用 `after` / `before`，会话详情用内嵌 `nextCursor`。

## 7. 现有接口分类

### 游标键集

| 接口 | 默认/上限 | 说明 |
|---|---|---|
| `GET /api/agents` | 50 / 100 | 复合游标 `[sort, id]` |
| `GET /api/audit` | 50 / 200 | 管理列表；游标为上一页末条 id |
| `GET /api/conversations`、`GET /api/me/conversations` | 50 / 100 | 会话列表 |
| `GET /api/conversations/{id}` | 50 / 100 | 详情内嵌历史 |
| `GET /api/conversations/{id}/outputs` | 50 / 100 | 会话产出；复合游标 `{createdAt, runId, path}`，版本内按 `path` 升序 |
| `GET /api/conversations/search` | 20 / 50 | 会话搜索 |
| `GET /api/channels` | 50 / 100 | 频道列表 |
| `GET /api/channels/{id}/runs/{runId}/outputs` | 50 / 100 | run 成果版本；复合游标同会话产出 |
| `GET /api/runs` | 50 / 100 | 复合游标 `[startedAt, id]` |
| `GET /api/me/runs` | 50 / 100 | 走 `keysetPage`，按 `(createdAt, id)` 倒序，游标为末条 id |
| `GET /api/me/output-shares` | 50 / 100 | 本人未撤销分享 |
| `GET /api/notifications` | 30 / 100 | 另返回 `unreadCount` |
| `GET /api/eval/runs` | 50 / 100 | 评估批次 |
| `GET /api/eval/cases` | 50 / 100 | 评估用例；按 `(createdAt, id)` 倒序，支持 `agentId` 过滤 |
| `GET /api/servers`、`GET /api/skills`、`GET /api/plugins`、`GET /api/runtime-environments` | 50 / 100 | 配置列表 |
| `GET /api/security/events`、`/approvals`、`/violations` | 50 / 100 | 安全事件与审批 |
| `GET /api/governance/departments`、`/budgets`、`/resources`、`/identities` | 50 / 200 | 管理列表 |
| `GET /api/integrations/tokens`、`/webhooks`、`GET /api/schedules` | 50 / 100 | 集成与定时任务 |
| `GET /api/knowledge/*` 的标准列表 | 50 / 100 | 知识库、文档、来源、Wiki、chunk、版本、同步记录、任务；文档列表非默认排序使用复合游标 `[sort, order, id]` |
| `GET /api/knowledge/bases/{id}/images` | 50 / 100 | 图片资产；复合游标 `{u: updatedAt, d: documentId, n: name}` |
| `GET /api/knowledge/bases/{id}/faqs` | 50 / 100 | FAQ 列表；按 `(updatedAt, id)` 倒序，游标为末条 id |
| `GET /api/me/memory/versions`、`/api/agents/{id}/memory/{name}/versions`、`/api/agents/{id}/rules/{slug}/versions`、`GET /api/memory-reviews` | 50 / 100 | 记忆版本与审核 |
| `GET /api/data-domains`、`/{id}/query-logs`、`/{id}/approvals` | 50 / 100 | 数据域列表与查询记录 |

### offset 页码

| 接口 | 默认/上限 | 说明 |
|---|---|---|
| `GET /api/accounts` | 50 / 100 | 管理账户表，返回 `total` |
| `GET /api/identities` | 50 / 100 | 专家成员身份选择，返回 `total` |

### seq 区间

| 接口 | 默认/上限 | 参数 | 说明 |
|---|---|---|---|
| `GET /api/channels/{id}/messages` | 50 / 200 | `after`、`before`（数值 seq 边界） | 返回消息数组，不是 `{items,nextCursor}` |
| `GET /api/audit/verify` | 1000 / 5000 | `afterSeq` | 返回 `{ ok, checked, brokenSeq, nextAfterSeq, complete }`；锚点缺失返回 `ok: false` |
| `GET /api/audit/export?format=ndjson` | 1000 / 1000 | `afterSeq` | 下一页序号在 `x-next-after-seq` 响应头 |

### 显式有界

| 接口 | 上限/理由 | 说明 |
|---|---|---|
| `GET /api/agents/reference` | 500 | 超过 500 时 `truncated: true` |
| `GET /api/knowledge/bases/{id}/folders` | 完整集合 | 服务端按 200/页循环取完；树形结构需要完整集合 |
| `GET /api/knowledge/bases/{id}/tags` | 完整集合 | distinct 标签，服务端无硬上限 |
| `GET /api/model-providers`、`/usage` | 完整配置集合 | 平台供应商数量小，无硬上限 |
| `GET /api/servers/{id}/tools` | 完整配置集合 | 单个连接器的工具定义，无硬上限 |
| `GET /api/servers/{id}/impact` | 完整影响集合 | 删除确认一次读取绑定智能体与工具数，无分页语义；无权查看的绑定只计数（`hiddenCount`）不返回名称 |
| `GET /api/channels/{id}/approvals` | 待处理项 | 只返回活跃 run 中未决、未过期的审批 |
| `GET /api/channels/{id}/runs?status=active` | 活跃项 | 只返回 `ACTIVE_RUN_STATUSES` |
| `GET /api/conversations/{id}/output-shares` | 单成果范围 | 按 `(conversationId, runId, path)` 返回，无硬上限 |
| `GET /api/market/skills` | 50 | 榜单最多 50 行；上游搜索请求 `limit=50` |
| `GET /api/search` | 每类 20，默认 5 | 命令面板 top-K；每类独立截断 |
| `GET /api/me/outputs` | 1..100，默认 50 | `truncated` 只表示 `limit` 或单会话 100 文件上限发生截断；只扫描最近 50 个会话，更早会话被排除且不标记 |
| `GET /api/data-domains/{id}/versions` | 完整版本历史 | 数据域配置量，无硬上限 |
| `GET /api/me/runs/export` | 5000 | 超过 5000 时 `truncated: true` |
| `GET /api/eval/cases/sample-candidates` | 最近 200 次运行、返回最多 50 | 在线抽样候选，先取近 200 次成功生产运行再洗牌 |
| 其他配置集合（安全策略、授权明细、专家规则/输出风格、技能文件、工作流、调度运行、数据域身份/提案、运行环境版本） | 完整集合 | 随父资源返回，无分页语义 |

## 8. DX 检查清单

新增列表时逐项确认：

1. 选机制：默认游标；只有跳页表格用 offset；只有 seq 追加流用 seq 区间。
2. 契约：参数用 `pageQuerySchema` / `adminPageQuerySchema` / `offsetQuerySchema` 或显式 `max()`；输出用 `cursorPageSchema` / `offsetPageSchema`。
3. repo：用 `keysetPage`，把访问范围与业务筛选放进同一个 `where`；需要多列排序时用 `encodeCursor` / `decodeCursor`。
4. handler：用 `requireCursorPage` 或 `invalidCursor()`；不手写切片。
5. web：用 `useCursorList`，query key 带全部筛选；提供加载更多；`truncated` 必须有可见说明。
6. 有界列表：在契约或本文 §7 写明上限/理由；需要提示时返回 `truncated`。
7. 验证：用真实 HTTP 覆盖首页、续页、空页、越界/跨范围游标（400 `INVALID_INPUT`、`path=/cursor`），并确认 `nextCursor` 在最后一页为 `null`。
