# Plan 006: 分页游标携带排序键，消除重复页与 runs 游标 400

> **Executor instructions**: 严格按步骤执行；每步先跑验证命令并确认预期结果，再进入下一步。遇到「STOP conditions」立即停止并报告，不要自行发挥。完成后更新 `plans/README.md` 中本计划的 Status 行（除非派发者声明由他维护索引）。
>
> **Drift check（先跑）**: `git diff --stat 90a0ad2c..HEAD -- packages/db/src/repo/pagination.ts packages/db/src/repo/runs.ts packages/db/src/repo/chat/conversations.ts packages/db/src/repo/chat/search.ts packages/db/src/repo/channels.ts packages/db/src/repo/knowledge/wiki.ts packages/db/src/repo/knowledge/documents.ts`
> 若有文件变化，先对照本文件「Current state」的摘录；对不上按 STOP 处理。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW（只读路径；游标对外不透明）
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `90a0ad2c`, 2026-11-22

## Why this matters

列表分页用 `(排序列, id)` 键集，但游标只保存 id。下一面请求时 `keysetBound` 重新查锚点行、拿它**当前**的排序值当边界。排序列是可变的（会话 `lastMessageAt`、频道 `updatedAt`、文档/Wiki `updatedAt`），锚点行在两次请求之间收到新消息或重新入库，就会把已经展示过的行再返回一次（重复行、重复 React key）；runs 列表更糟：启动时间从 null 变成时间戳时直接返回无效游标 400。修复后，游标自带生成时的排序值，翻页边界不再随锚点漂移。

## Current state

- `packages/db/src/repo/pagination.ts:25-38` — 边界靠子查询读锚点当前值：
  ```ts
  export function keysetBound(table, cursorId, column, direction, id = table.id): SQL {
    if (column === id) return direction === 'asc' ? gt(id, cursorId) : lt(id, cursorId);
    const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
    return sql`(${column}, ${id}) ${operator} (
      select cursor.${sql.identifier(column.name)}, cursor.${sql.identifier(id.name)} from ${table} cursor
      where cursor.${sql.identifier(id.name)} = ${cursorId}
    )`;
  }
  ```
- `packages/db/src/repo/pagination.ts:48-51` — 游标只写 id：
  ```ts
  export function paginate<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
  ```
- `packages/db/src/repo/pagination.ts:51-79` — `keysetPage` 的签名与游标分支：
  ```ts
  export async function keysetPage<T extends { id: string }>(
    db: DbHandle,
    options: {
      limit: number;
      cursor?: string | null | undefined;
      column?: AnyPgColumn;
      direction?: 'asc' | 'desc';
      where: (SQL | undefined)[];
      load: (args: { where: SQL | undefined; limit: number }) => Promise<T[]>;
    } & (...),
  ): Promise<CursorPage<T> | null> {
    // ...
    if (cursor != null) {
      const [anchor] = await db.select({ id }).from(table)
        .where(and(...filters, eq(id, cursor))).limit(1);
      if (!anchor) return null;
      filters.push(keysetBound(table, cursor, column, direction, id));
    }
    return paginate(await load({ where: and(...filters), limit: limit + 1 }), limit);
  }
  ```
- 可变排序列的调用点（本计划要改的全部）：
  - `packages/db/src/repo/chat/conversations.ts:291` — `column: conversations.lastMessageAt`；`load` 的 select 目前**没有** `lastMessageAt`。
  - `packages/db/src/repo/chat/search.ts:120` — `column: conversations.lastMessageAt`；`load` 已选出 `cursorAt: sql<string>`\`${conversations.lastMessageAt}::text\``。
  - `packages/db/src/repo/channels.ts:226` — `column: channels.updatedAt`；`load` 已选出 `updatedAt`。
  - `packages/db/src/repo/knowledge/wiki.ts:310` — `column: knowledgeWikiPages.updatedAt`；`load` 选出 `page: knowledgeWikiPages`。
  - `packages/db/src/repo/knowledge/documents.ts:206` 与 `:398` — `column: knowledgeDocuments.updatedAt`；`load` 为 `select()` 全行。
- `packages/db/src/repo/runs.ts:167-184` — 独立实现的游标，比较锚点当前值与游标值，不一致就返回 null（上层转 400）：
  ```ts
  const parts = decodeCursor(options.cursor, 2);
  const cursorStartedAt = parts?.[0];
  const anchorId = parts?.[1];
  if (cursorStartedAt === undefined || anchorId === undefined) return null;
  const [anchor] = await db.select({ id: agentRuns.id, startedAt: runStartedAtCursor })
    .from(agentRuns).where(and(...filters, eq(agentRuns.id, anchorId))).limit(1);
  if (!anchor || (anchor.startedAt ?? '') !== cursorStartedAt) return null;
  if (anchor.startedAt === null) { /* null 边界 */ } else { /* 时间戳边界 */ }
  ```
  排序是 `startedAt desc nulls last`；游标里的空串表示该行当时没有 `startedAt`。

约定：
- 游标是服务端生成、前端按不透明字符串处理的；改格式不需要前端改动。
- 无效游标统一返回 `null`，由 `packages/api/src/http/pagination.ts` 的 `requireCursorPage` 转 400 `INVALID_INPUT`。
- 排序列全部是 `notNull` 的 `timestamptz`（`packages/db/src/schema/chat.ts:71`、`knowledge-documents.ts:106`、`knowledge-wiki.ts:46`）；runs 的 `startedAt` 可空，单独处理。

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
- `tests/chat-history-pages.e2e.ts`（只加一个回归用例，见 Test plan）

**Out of scope（不要动）**
- 前端分页组件与 `useDrainPages`；它们只消费不透明游标。
- 其余 ~40 个 `keysetPage` 调用点：它们按不可变列（`createdAt`、`ordinal`、`version`、`name`）排序，保持 id-only 游标行为。
- 契约 output schema：`nextCursor` 仍是 `string | null`。
- `keysetBound` 的既有导出签名；`audit.ts` 与 `chat/messages.ts` 仍在用。

## Git workflow

- worktree + 分支 `improve/006-stable-cursors`（按 `docs/DEV-WORKFLOW.md` §2）。
- 提交信息示例：`fix(db): 分页游标携带排序键，避免可变列翻页重复`
- 不 push、不开 PR，除非派发者明确要求。

## Steps

### Step 1: 给 `keysetPage` 增加时间戳游标模式

在 `packages/db/src/repo/pagination.ts`：

1. 新增内部编码/解码：
   ```ts
   interface TimestampCursor { v: string; id: string }
   function encodeTimestampCursor(value: string, id: string): string {
     return Buffer.from(JSON.stringify({ v: value, id }), 'utf8').toString('base64url');
   }
   function decodeTimestampCursor(raw: string): TimestampCursor | null {
     try {
       const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
       if (typeof parsed !== 'object' || parsed === null) return null;
       const { v, id } = parsed as { v?: unknown; id?: unknown };
       if (typeof v !== 'string' || typeof id !== 'string' || v === '' || id === '') return null;
       if (Number.isNaN(new Date(v).getTime())) return null;
       return { v, id };
     } catch { return null; }
   }
   ```
   **游标值必须是数据库格式化到微秒的字符串**（`to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`），不能传 JS `Date`：`Date` 只有毫秒精度，而 PostgreSQL `now()` 默认有微秒，截断会在边界产生重复/跳过。`chunks.ts:360-375` 已有同样的写法，照抄。
2. `keysetPage` 的 options 增加：
   ```ts
   timestampCursor?: (row: T) => string;
   ```
   - 有 `timestampCursor` 时，游标按 `decodeTimestampCursor` 解析；解析失败返回 `null`。**锚点查询与边界都必须用 `decoded.id`**，不能用原始游标串。
   - 保留锚点存在性查询（`where(and(...filters, eq(id, decoded.id)))`）：它同时完成对象可见性/范围校验。**不要**再比较锚点当前值。
   - 边界 SQL：
     ```ts
     const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
     filters.push(sql`(${column}, ${id}) ${operator} (${decoded.v}::timestamptz, ${decoded.id})`);
     ```
     注意 `${column}` 必须是 `options.column ?? table.createdAt` 解析后的列。
   - 没有 `timestampCursor` 时，行为与现状完全一致（id-only + 子查询）。
3. `paginate` 增加可选游标构造器，保持现有调用方（`runtime-environments.ts:140`）不变：
   ```ts
   export function paginate<T extends { id: string }>(
     rows: T[],
     limit: number,
     cursorOf?: (row: T) => string,
   ): CursorPage<T> {
     const items = rows.slice(0, limit);
     const last = items.at(-1);
     const nextCursor = rows.length > limit && last !== undefined ? (cursorOf?.(last) ?? last.id) : null;
     return { items, nextCursor };
   }
   ```
   `keysetPage` 调用：
   ```ts
   const cursorOf = timestampCursor === undefined ? undefined : (row: T) =>
     encodeTimestampCursor(timestampCursor(row), row.id);
   return paginate(await load(...), limit, cursorOf);
   ```

**Verify**: `bun run --filter @agentport/db typecheck` → exit 0。

### Step 2: 六个可变排序列调用点启用时间戳游标

逐点加 `timestampCursor`，并让 `load` 选出微秒级的游标字符串（统一命名 `cursorValue`）：

```ts
const cursorValueSql = (column: AnyPgColumn) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
```
`cursorValueSql` 可以放在 `pagination.ts` 导出，避免 6 处重复；若导出会给外部 API 增加负担，则放各自文件顶部。

- `chat/conversations.ts`：select 增加 `cursorValue: cursorValueSql(conversations.lastMessageAt)`，options 增加
  `timestampCursor: (row) => row.cursorValue`。
- `chat/search.ts`：现有 `cursorAt: sql<string>`\`${conversations.lastMessageAt}::text\`` 已保留微秒，直接
  `timestampCursor: (row) => row.cursorAt`。
- `channels.ts`：select 增加 `cursorValue: cursorValueSql(channels.updatedAt)`，options 增加
  `timestampCursor: (row) => row.cursorValue`。
- `knowledge/wiki.ts:310`：select 增加 `cursorValue: cursorValueSql(knowledgeWikiPages.updatedAt)`（保留 `page`），options 增加
  `timestampCursor: (row) => row.cursorValue`。
- `knowledge/documents.ts:206` 与 `:398`：select 增加 `cursorValue: cursorValueSql(knowledgeDocuments.updatedAt)`，options 各增加
  `timestampCursor: (row) => row.cursorValue`。

不要改这些查询的 `orderBy`。

**Verify**: `bun run --filter @agentport/db typecheck && bun run --filter @agentport/api typecheck` → exit 0。

### Step 3: runs 游标不再校验锚点当前值

改 `packages/db/src/repo/runs.ts`：
1. 保留 cursor 解析与锚点存在性查询（保证可见性/范围）。
2. 删除 `(anchor.startedAt ?? '') !== cursorStartedAt` 这一校验；改为只用 `cursorStartedAt` 构造边界：
   - `cursorStartedAt === ''` → 使用现有的 null 分支（`startedAt is null and id < anchorId`）。
   - 否则使用时间戳分支，但参数是 `cursorStartedAt`，不是 `anchor.startedAt`。
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

新增的系统级回归用例（允许：仓库只禁止未经指示新增单测/集成测试，e2e 属于允许范围）写在 `tests/chat-history-pages.e2e.ts`，参考同文件已有分页用例结构：

1. 准备 ≥3 个会话，按 `lastMessageAt desc` 拉第一页，取最后一行为锚点。
2. 对锚点会话发送一条新消息（使其 `lastMessageAt` 前移）。
3. 用第一页返回的游标拉第二页。
4. 断言：HTTP 200；第二页不包含第一页出现过的会话 id（无重复）；没有 400。

runs 列表：在 `tests/chat-history-pages.e2e.ts` 或相邻已有 runs 分页用例中，构造一页以 queued run 结尾（`startedAt is null`），触发起跑后再用旧游标请求下一页，断言 200 且无重复。若现有夹具无法稳定构造 queued 行，STOP 并报告，不要为测试改生产代码。

## Done criteria

- [ ] `grep -n "timestampCursor" packages/db/src/repo` 命中 `pagination.ts` + 6 个调用点。
- [ ] `grep -n "cursorValue" packages/db/src/repo` 命中 5 处 select 别名（search 复用 `cursorAt` 之外）。
- [ ] `grep -n "anchor.startedAt ?? ''" packages/db/src/repo/runs.ts` 返回空。
- [ ] `bun run --filter @agentport/db typecheck` 与 `--filter @agentport/api typecheck` exit 0。
- [ ] 两个后端套件 + e2e 用例全绿。
- [ ] `git status --short` 只含 Scope 内文件。
- [ ] `plans/README.md` 的 006 行状态已更新。

## STOP conditions

- `keysetPage` 的现有实现与「Current state」摘录不符。
- 某个调用点的 `load` 没有被选出的排序列，且补 select 会改变契约 output（不是简单加字段）。
- e2e 无法稳定构造「锚点行在两次请求之间变化」的场景（先报告，不要改生产代码迁就测试）。
- 发现除列出的 6 个调用点外，还有 `column:` 指向可变列的 `keysetPage` 调用（如 `governance/departments.ts` 的 `name`、`governance/resources.ts` 的 `name`）；报告并在同一计划内决定是否纳入，不要默默扩大范围。

## Maintenance notes

- 新增按可变列分页的列表必须传 `timestampCursor`，否则会退回旧的“回查当前值”语义。
- `keysetBound` 的 id-only 路径仍被 `audit.ts`、`chat/messages.ts` 使用；不要删除。
- 若将来排序列可为空，需要为 `timestampCursor` 增加 null 语义；当前 6 个列均 `notNull`。
- 审查重点：锚点存在性检查必须保留（对象范围校验），只删除“当前值比较”。
