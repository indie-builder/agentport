# Plan 006: 分页游标携带排序键，消除可变列翻页重复与 runs 游标 400

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告，不要自行发挥。`plans/README.md` 的索引由派发者维护，本计划不修改它。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- packages/db/src/repo/pagination.ts packages/db/src/repo/runs.ts packages/db/src/repo/chat/conversations.ts packages/db/src/repo/chat/search.ts packages/db/src/repo/channels.ts packages/db/src/repo/knowledge/wiki.ts packages/db/src/repo/knowledge/documents.ts`
> 若有文件变化，先对照本文件「Current state」的摘录；`CursorPage` 已从 `@agentport/shared` 导入是该计划预知的漂移，其余对不上按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW（只读路径；游标对外不透明）
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `90a0ad2c`, 2026-11-22
- **Scope decided**: 2026-11-22，按「游标跨可变排序列」整类修复，共 11 个调用点

## Why this matters

列表分页用 `(排序列, id)` 键集，但游标只保存 id。下一页请求时 `keysetBound` 重新查锚点行、拿它**当前**的排序值当边界。排序列是可变的（会话 `lastMessageAt`、频道 `updatedAt`、文档/Wiki `updatedAt`、预算 `updatedAt`、名称列），锚点行在两次请求之间收到新消息或改名，就会把已经展示过的行再返回一次（重复行、重复 React key）。runs 列表更糟：启动时间从 null 变成时间戳时直接返回无效游标 400。

修复后，游标自带签发时的排序值，翻页边界不再随锚点漂移；只稳定边界，不保证跨边界行的重复/漏读。

## Current state

- `packages/db/src/repo/pagination.ts` — 游标只写 id，边界靠子查询读锚点当前值；`paginate(rows, limit)` 的 `nextCursor` 取末条 id。
- `packages/db/src/repo/runs.ts` — 独立实现的复合游标 `[startedAt, id]`，比较锚点当前值与游标值，不一致返回 `null`（上层转 400）。
- 需要游标自带排序值的 `keysetPage` 调用点（全部纳入）：
  1. `chat/conversations.ts` — `lastMessageAt`，timestamp。
  2. `chat/search.ts` — `lastMessageAt`，timestamp；复用已有 `cursorAt` 文本值。
  3. `channels.ts` — `updatedAt`，timestamp。
  4. `knowledge/wiki.ts:310` — `knowledgeWikiPages.updatedAt`，timestamp。
  5. `knowledge/documents.ts:206` — `updatedAt`，timestamp。
  6. `knowledge/documents.ts:398` — `updatedAt`，timestamp。
  7. `knowledge/documents.ts:144-148` — 动态 `sortColumn`：`updatedAt` 用 timestamp，`title` 用 text；外层 `[sort, direction, cursor]` 包装保持不变，只包新的不透明游标。
  8. `governance/budgets.ts:98` — `updatedAt`，timestamp。
  9. `governance/departments.ts:55` — `name`，text，asc。
  10. `governance/resources.ts:38` — `table.name`，text，asc。
  11. `skills.ts:56` — `name`，text，asc。

约定：
- 游标是服务端生成、前端按不透明字符串处理的；改格式不需要前端改动。
- 无效游标统一返回 `null`，由 `packages/api/src/http/pagination.ts` 的 `requireCursorPage` 转 400 `INVALID_INPUT`。
- 排序列全部是 `notNull`；runs 的 `startedAt` 可空，单独处理。

## Commands you will need

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 安装 | `bun install --frozen-lockfile` | exit 0 |
| 类型检查 | `bun run --filter @agentport/db typecheck`、`--filter @agentport/api typecheck` | exit 0 |
| 后端测试 | `bun run test -- packages/db/test/channels-m2.test.ts`、`packages/api/test/knowledge-management-routes.test.ts` | 全绿 |
| e2e 回归 | `bun run test:e2e -- tests/chat-history-pages.e2e.ts` | 全绿 |
| 格式 | `bunx biome check packages/db/src/repo` | 0 error |

> 先构建共享包再跑测试：`bun run --filter @agentport/shared --filter @agentport/contract --filter @agentport/db --filter @agentport/core build`（见 `docs/PITFALLS.md`「workspace 包导出指向 dist」）。后端测试需要 Docker PostgreSQL/Redis。

## Scope

**In scope**
- `packages/db/src/repo/pagination.ts`
- `packages/db/src/repo/runs.ts`
- `packages/db/src/repo/chat/conversations.ts`
- `packages/db/src/repo/chat/search.ts`
- `packages/db/src/repo/channels.ts`
- `packages/db/src/repo/knowledge/wiki.ts`
- `packages/db/src/repo/knowledge/documents.ts`
- `packages/db/src/repo/governance/budgets.ts`
- `packages/db/src/repo/governance/departments.ts`
- `packages/db/src/repo/governance/resources.ts`
- `packages/db/src/repo/skills.ts`
- `tests/chat-history-pages.e2e.ts`（只加一个回归用例）
- 本文件

**Out of scope（不要动）**
- 前端分页组件与 `useDrainPages`；它们只消费不透明游标。
- 其余 `keysetPage` 调用点：按不可变列（`createdAt`、`ordinal`、`version`、folders `id`）排序与任何非 `keysetPage` 分页。
- 契约 output schema：`nextCursor` 仍是 `string | null`。
- `keysetBound` 的既有导出签名；`audit.ts`、`chat/messages.ts` 仍在用 id-only 路径。

## Steps

### Step 1: 给 `keysetPage` 增加通用值游标

在 `packages/db/src/repo/pagination.ts`：

1. 新增导出 `cursorValueSql(column)`：
   ```ts
   export function cursorValueSql(column: AnyPgColumn): SQL<string> {
     return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
   }
   ```
   游标值必须是数据库格式化到微秒的字符串，不能传 JS `Date`（毫秒精度会在边界重复/跳过）。
2. 新增内部编解码，两种 kind 共用 `{v, id}` base64url JSON：
   ```ts
   export type CursorKind = 'timestamp' | 'text';
   function encodeValueCursor(value: string, id: string): string
   function decodeValueCursor(raw: string, kind: CursorKind): { v: string; id: string } | null
   ```
   `text` 要求 `v`、`id` 非空；`timestamp` 额外要求 `v` 能 `new Date(v)` 解析。
3. `keysetPage` 的 options 增加 `valueCursor?: (row: NoInfer<T>) => string` 与 `cursorKind?: CursorKind`。
   - 有 `valueCursor` 时按 kind 解析游标；解析失败返回 `null`。
   - 锚点存在性查询仍用 `decoded.id` 与同一组 `where`（对象可见性/范围校验）；**不比较锚点当前值**。
   - 边界 SQL：`(column, id) < (${v}::timestamptz, ${id})`（timestamp）或 `(column, id) < (${v}, ${id})`（text），按 `direction` 用 `>` / `<`。
   - 没有 `valueCursor` 时行为与现状完全一致（id-only + 子查询）。
4. `paginate` 增加可选游标构造器，现有 2 参调用方不变：
   ```ts
   export function paginate<T extends { id: string }>(
     rows: T[],
     limit: number,
     cursorOf?: (row: T) => string,
   ): CursorPage<T>
   ```
   `keysetPage` 用 `encodeValueCursor(valueCursor(row), row.id)` 作为 `cursorOf`。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 2: 11 个调用点启用值游标

统一规则：
- timestamp 站点在 `load` 里选出 `cursorValue: cursorValueSql(<column>)`，传 `valueCursor: (row: { cursorValue: string }) => row.cursorValue` 与 `cursorKind: 'timestamp'`；`nextCursor` 之后把 `cursorValue` 从 items 剥离，避免进入 repo 返回值/API 输出。
- text 站点在 `load` 里选出 `cursorValue: <column>`，传同形 `valueCursor` 与 `cursorKind: 'text'`，同样剥离。
- 跨子查询引用 SQL 表达式时给表达式加别名（`cursorValueSql(...).as('cursorValue')`）。
- 不改任何 `orderBy`；`load` 参数显式标注 `{ where: SQL | undefined; limit: number }`（否则 `await` 上下文中泛型推断会退化为 `{ id: string }`）。

逐点：
1. `chat/conversations.ts` — 子查询 `page` 选出并对齐 `cursorValue`，外层 select 与 items 映射相应带上/剥离。
2. `chat/search.ts` — 直接把 `options.before` 交给 `keysetPage`，`valueCursor: (row: { cursorAt: string }) => row.cursorAt`，`nextBefore: result.nextCursor`；删除本文件的 `decodeSearchCursor` / `encodeSearchCursor`。
3. `channels.ts` — `cursorValue: cursorValueSql(channels.updatedAt)`。
4. `knowledge/wiki.ts:310` — `cursorValue: cursorValueSql(knowledgeWikiPages.updatedAt)`，保留 `page`/`version`，items 映射已剥离。
5-6. `knowledge/documents.ts:206` 与 `:398` — 用 `getTableColumns(knowledgeDocuments)` + `cursorValue`。
7. `knowledge/documents.ts:144-148` — `sort === 'updated'` 用 timestamp，`sort === 'title'` 用 text，其余（created）保持 id-only；外层包装不变。
8. `governance/budgets.ts:98` — `cursorValueSql(budgetLimits.updatedAt)`。
9. `governance/departments.ts:55` — `cursorValue: departments.name`，text asc。
10. `governance/resources.ts:38` — `cursorValue: table.name`，text asc。
11. `skills.ts:56` — `cursorValue: skills.name`，text asc。

**Verify**: `bun run --filter @agentport/db typecheck && bun run --filter @agentport/api typecheck` → exit 0。

### Step 3: runs 游标不再校验锚点当前值

改 `packages/db/src/repo/runs.ts`：
1. 保留 cursor 解析与锚点存在性查询（保证可见性/范围）。
2. 删除 `(anchor.startedAt ?? '') !== cursorStartedAt` 校验；非空游标值先做日期解析校验（无效返回 `null`，避免畸形游标进入 `::timestamptz` 变成数据库异常），再用 `cursorStartedAt` 构造边界：
   - `''` → `startedAt is null and id < anchorId`。
   - 否则 → `startedAt is null or (startedAt, id) < (cursorStartedAt::timestamptz, anchorId)`。
3. 锚点不存在仍返回 `null`（对象不可见 → 400，符合现有语义）。

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 4: 回归验证

1. 构建共享包后跑：
   - `bun run test -- packages/db/test/channels-m2.test.ts`
   - `bun run test -- packages/api/test/knowledge-management-routes.test.ts`
   - `bun run test -- packages/api/test/knowledge-faq-routes.test.ts`
2. 跑 e2e：`bun run test:e2e -- tests/chat-history-pages.e2e.ts`。

**Verify**: 全部 exit 0、0 skip（Docker/栈不可用时在报告注明，不得宣称通过）。

## Test plan

新增一个系统级回归用例（e2e 属于允许范围）写在 `tests/chat-history-pages.e2e.ts`：

1. 创建 3 个会话（fixture 让它们 `lastMessageAt` 相同，靠 id 决定并列顺序）。
2. 按 `agentId` 拉 `/api/conversations?limit=2` 第一页，取第 2 行为锚点及其 `nextCursor`。
3. 对锚点会话 `appendMessages`，触发器会把它的 `lastMessageAt` 前移。
4. 用第一页游标拉第二页，断言：HTTP 200；不包含第一页出现过的会话 id；不包含锚点 id；自身无重复。

runs 的 queued 起跑场景当前夹具无法稳定构造，不在本次新增用例内；不为此改生产代码。

## Done criteria

- [ ] `grep -n "valueCursor" packages/db/src/repo` 命中 `pagination.ts` + 11 个调用点。
- [ ] `grep -n "cursorValue" packages/db/src/repo` 命中 timestamp/text 站点的 select 与 items 剥离。
- [ ] `grep -n "anchor.startedAt ?? ''" packages/db/src/repo/runs.ts` 返回空。
- [ ] `bun run --filter @agentport/db typecheck` 与 `--filter @agentport/api typecheck` exit 0。
- [ ] 后端套件 + e2e 用例全绿。
- [ ] `git status --short` 只含 Scope 内文件。
- [ ] `plans/README.md` 未修改。

## STOP conditions

- `keysetPage` 的现有实现与「Current state」摘录不符（`CursorPage` 来自 shared 除外）。
- 某个调用点的 `load` 没有被选出的排序列，且补 select 会改变契约 output。
- e2e 无法稳定构造「锚点行在两次请求之间变化」的场景（先报告，不要改生产代码迁就测试）。
- 发现 Scope 之外的 `keysetPage` 调用点按可变列排序。

## Maintenance notes

- 新增按可变列分页的列表必须传 `valueCursor` + `cursorKind`，否则会退回旧的「回查当前值」语义。
- 值游标稳定的是边界：跨边界行的重复/漏读仍可能发生，不承诺快照隔离。
- `keysetBound` 的 id-only 路径仍被 `audit.ts`、`chat/messages.ts` 使用；不要删除。
- 若将来排序列可为空，需要为值游标增加 null 语义；当前列均 `notNull`（runs 单独处理）。
- 审查重点：锚点存在性检查必须保留（对象范围校验），只删除「当前值比较」。
