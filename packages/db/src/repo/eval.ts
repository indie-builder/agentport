import { and, asc, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type EvalCaseSnapshot, evalCases, evalResults, evalRuns } from '../schema.js';

export type EvalCase = typeof evalCases.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;

/** 列表投影：不读 caseSnapshot / claimedAt，避免把大字段带进分页查询。 */
export type EvalRunSummary = Pick<
  EvalRun,
  'id' | 'agentId' | 'status' | 'total' | 'passed' | 'error' | 'createdAt' | 'finishedAt'
>;

export interface EvalRunPage {
  items: EvalRunSummary[];
  nextCursor: string | null;
}

export interface EvalCaseInput {
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
}

export interface EvalCasePatch {
  name?: string | undefined;
  prompt?: string | undefined;
  expectation?: string | undefined;
}

export async function listCases(db: Database, agentId?: string): Promise<EvalCase[]> {
  const filters: SQL[] = [];
  if (agentId !== undefined) filters.push(eq(evalCases.agentId, agentId));
  return db
    .select()
    .from(evalCases)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(evalCases.createdAt), desc(evalCases.id));
}

export async function getCase(db: Database, id: string): Promise<EvalCase | null> {
  const [row] = await db.select().from(evalCases).where(eq(evalCases.id, id)).limit(1);
  return row ?? null;
}

export async function createCase(
  db: Database,
  id: string,
  input: EvalCaseInput,
): Promise<EvalCase> {
  const [row] = await db
    .insert(evalCases)
    .values({ id, ...input })
    .returning();
  if (!row) throw new Error('eval case insert returned no row');
  return row;
}

export async function updateCase(
  db: Database,
  id: string,
  patch: EvalCasePatch,
): Promise<EvalCase | null> {
  if (Object.keys(patch).length === 0) return getCase(db, id);
  const [row] = await db.update(evalCases).set(patch).where(eq(evalCases.id, id)).returning();
  return row ?? null;
}

export async function deleteCase(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(evalCases)
    .where(eq(evalCases.id, id))
    .returning({ id: evalCases.id });
  return rows.length > 0;
}

export async function createEvalRun(
  db: Database,
  input: { id: string; agentId: string; total: number; caseSnapshot?: EvalCaseSnapshot[] },
): Promise<EvalRun> {
  const [row] = await db.insert(evalRuns).values(input).returning();
  if (!row) throw new Error('eval run insert returned no row');
  return row;
}

/**
 * 原子认领：只有把 claimed_at 从 NULL 改成有值的调用方拿到 true。
 * BullMQ 在 Redis 抖动后会重复投递同一个 job，没有认领就会跑两遍（双倍模型花费）。
 */
export async function claimEvalRun(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(evalRuns)
    .set({ claimedAt: new Date() })
    .where(and(eq(evalRuns.id, id), isNull(evalRuns.claimedAt), eq(evalRuns.status, 'running')))
    .returning({ id: evalRuns.id });
  return rows.length > 0;
}

export async function getEvalRun(db: Database, id: string): Promise<EvalRun | null> {
  const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  return row ?? null;
}

export async function finishEvalRun(
  db: Database,
  id: string,
  result: { status: 'succeeded' | 'failed'; passed: number; error?: string | null },
): Promise<void> {
  // 只收口仍在 running 的跑批：reconciler 已标记 failed 的行不能被晚到的 worker 覆盖。
  await db
    .update(evalRuns)
    .set({ ...result, finishedAt: new Date() })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
}

/** 只有 running 能转 cancelled；返回 false 表示跑批已收口，调用方据此跳过重复审计。 */
export async function cancelEvalRun(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(evalRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')))
    .returning({ id: evalRuns.id });
  return rows.length > 0;
}

export async function updateProgress(db: Database, id: string, passed: number): Promise<void> {
  await db
    .update(evalRuns)
    .set({ passed })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
}

export async function listRuns(
  db: Database,
  options: { agentId?: string; cursor?: string; limit: number },
): Promise<EvalRunPage | null> {
  const filters: SQL[] = [];
  if (options.agentId !== undefined) filters.push(eq(evalRuns.agentId, options.agentId));
  if (options.cursor !== undefined) {
    // 游标必须落在当前筛选范围内；否则会把别人的历史当成自己的下一页。
    const [cursor] = await db
      .select({ id: evalRuns.id })
      .from(evalRuns)
      .where(and(eq(evalRuns.id, options.cursor), ...filters))
      .limit(1);
    if (!cursor) return null;
    // shortcut: 两步查询，游标恰在两步之间被删只会得到空页；需要严格语义时改成单条 CTE。
    // 时间戳在库内读取并比较：JS Date 只有毫秒，转一手会丢掉微秒。
    filters.push(sql`(${evalRuns.createdAt}, ${evalRuns.id}) < (
      select cursor.created_at, cursor.id from ${evalRuns} cursor
      where cursor.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select({
      id: evalRuns.id,
      agentId: evalRuns.agentId,
      status: evalRuns.status,
      total: evalRuns.total,
      passed: evalRuns.passed,
      error: evalRuns.error,
      createdAt: evalRuns.createdAt,
      finishedAt: evalRuns.finishedAt,
    })
    .from(evalRuns)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

/** 同一智能体只允许一个在跑的评估；API 层据此返回 409。 */

export interface EvalResultRow {
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string | null;
}

/** 对比需要判断结果是否带快照；id 与快照只用于配对，不进响应。 */
interface StoredEvalResult extends EvalResultRow {
  id: string;
  caseSnapshot: EvalCaseSnapshot | null;
}

export type EvalComparisonStatus =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'changed_inputs'
  | 'base_only'
  | 'head_only'
  | 'unverified';

export interface EvalComparisonRow {
  key: string;
  status: EvalComparisonStatus;
  base: EvalResultRow | null;
  head: EvalResultRow | null;
}

export async function addResult(
  db: Database,
  input: {
    id: string;
    evalRunId: string;
    caseId: string;
    caseSnapshot?: EvalCaseSnapshot;
    /** 失败的 case 没有对应运行，写 NULL；外键要求如此。 */
    runId: string | null;
    passed: boolean;
    output: string;
  },
  options: { recordProgress?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    if (options.recordProgress) {
      const [batch] = await tx
        .select({ status: evalRuns.status })
        .from(evalRuns)
        .where(eq(evalRuns.id, input.evalRunId))
        .for('update');
      if (batch?.status !== 'running') return;
    }
    // key share 锁住源用例，避免快照写入前用例被删（并发 delete 会等本事务提交）。
    const [locked] = await tx
      .select({ id: evalCases.id })
      .from(evalCases)
      .where(eq(evalCases.id, input.caseId))
      .limit(1)
      .for('key share');
    const inserted = await tx
      .insert(evalResults)
      .values({
        ...input,
        caseId: locked ? input.caseId : null,
        caseSnapshot: input.caseSnapshot ?? null,
      })
      // 重复投递的 job 会重写同一 run/case；唯一键让重试幂等而不是报错。
      .onConflictDoNothing()
      .returning({ id: evalResults.id });
    if (options.recordProgress && inserted.length > 0 && input.passed) {
      await tx
        .update(evalRuns)
        .set({ passed: sql`${evalRuns.passed} + 1` })
        .where(eq(evalRuns.id, input.evalRunId));
    }
  });
}

export async function getRunDetail(
  db: Database,
  id: string,
  limit?: number,
): Promise<{ evalRun: EvalRun; results: EvalResultRow[] } | null> {
  const [evalRun] = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  if (!evalRun) return null;
  return { evalRun, results: (await selectRunResults(db, id, limit)).map(toPublicResult) };
}

function toPublicResult(row: StoredEvalResult): EvalResultRow {
  return {
    caseId: row.caseId,
    name: row.name,
    prompt: row.prompt,
    expectation: row.expectation,
    passed: row.passed,
    output: row.output,
    runId: row.runId,
  };
}

/** 快照优先、源用例兜底；id/snapshot 留给对比配对，不进响应。 */
async function selectRunResults(
  db: Database,
  runId: string,
  limit?: number,
): Promise<StoredEvalResult[]> {
  const query = db
    .select({
      id: evalResults.id,
      caseId: evalResults.caseId,
      caseSnapshot: evalResults.caseSnapshot,
      name: sql<string>`coalesce(${evalResults.caseSnapshot}->>'name', ${evalCases.name}, 'Deleted case')`,
      prompt: sql<string>`coalesce(${evalResults.caseSnapshot}->>'prompt', ${evalCases.prompt}, '')`,
      expectation: sql<string>`coalesce(${evalResults.caseSnapshot}->>'expectation', ${evalCases.expectation}, '')`,
      passed: evalResults.passed,
      output: evalResults.output,
      runId: evalResults.runId,
    })
    .from(evalResults)
    .leftJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.evalRunId, runId))
    .orderBy(asc(evalResults.createdAt), asc(evalResults.id));
  return limit === undefined ? query : query.limit(limit);
}

function snapshotInputs(row: StoredEvalResult): { prompt: string; expectation: string } | null {
  return row.caseSnapshot === null
    ? null
    : { prompt: row.caseSnapshot.prompt, expectation: row.caseSnapshot.expectation };
}

function compareResults(
  baseRows: StoredEvalResult[],
  headRows: StoredEvalResult[],
): EvalComparisonRow[] {
  // 快照 id 在源用例删除后仍稳定；没有快照才退回 caseId；都没有就不配对。
  const keyOf = (row: StoredEvalResult): string | null => row.caseSnapshot?.id ?? row.caseId;

  const group = (rows: StoredEvalResult[]) => {
    const groups = new Map<string, StoredEvalResult[]>();
    const loose: StoredEvalResult[] = [];
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null) loose.push(row);
      else {
        const existing = groups.get(key);
        if (existing) existing.push(row);
        else groups.set(key, [row]);
      }
    }
    return { groups, loose };
  };
  const base = group(baseRows);
  const head = group(headRows);

  const rows: EvalComparisonRow[] = [];

  for (const row of base.loose) {
    rows.push({
      key: `base:${row.id}`,
      status: 'unverified',
      base: toPublicResult(row),
      head: null,
    });
  }
  for (const [key, baseGroup] of base.groups) {
    const headGroup = head.groups.get(key) ?? [];
    // 任一侧有重复，就分不清哪个结果对应哪次执行：逐行标未验证，不互相覆盖。
    if (baseGroup.length > 1 || headGroup.length > 1) {
      for (const result of baseGroup) {
        rows.push({
          key: `base:${result.id}`,
          status: 'unverified',
          base: toPublicResult(result),
          head: null,
        });
      }
      for (const result of headGroup) {
        rows.push({
          key: `head:${result.id}`,
          status: 'unverified',
          base: null,
          head: toPublicResult(result),
        });
      }
      continue;
    }
    const [baseResult] = baseGroup;
    const [headResult] = headGroup;
    if (baseResult === undefined) continue;
    rows.push(
      headResult === undefined
        ? { key, status: 'base_only', base: toPublicResult(baseResult), head: null }
        : comparePair(key, baseResult, headResult),
    );
  }
  for (const row of head.loose) {
    rows.push({
      key: `head:${row.id}`,
      status: 'unverified',
      base: null,
      head: toPublicResult(row),
    });
  }
  for (const [key, headGroup] of head.groups) {
    if (base.groups.has(key)) continue;
    // 头部独有且重复：同样无法确定哪条是这次执行的结果。
    const status = headGroup.length > 1 ? 'unverified' : 'head_only';
    for (const result of headGroup) {
      rows.push({
        key: headGroup.length > 1 ? `head:${result.id}` : key,
        status,
        base: null,
        head: toPublicResult(result),
      });
    }
  }

  return rows;
}

function comparePair(
  key: string,
  base: StoredEvalResult,
  head: StoredEvalResult,
): EvalComparisonRow {
  const baseInputs = snapshotInputs(base);
  const headInputs = snapshotInputs(head);
  // 旧结果没有快照，无法证明两次测的是同一份输入，只能标为未验证。
  if (baseInputs === null || headInputs === null) {
    return { key, status: 'unverified', base: toPublicResult(base), head: toPublicResult(head) };
  }
  if (
    baseInputs.prompt !== headInputs.prompt ||
    baseInputs.expectation !== headInputs.expectation
  ) {
    return {
      key,
      status: 'changed_inputs',
      base: toPublicResult(base),
      head: toPublicResult(head),
    };
  }
  const status: EvalComparisonStatus =
    base.passed === head.passed ? 'unchanged' : head.passed ? 'improved' : 'regressed';
  return { key, status, base: toPublicResult(base), head: toPublicResult(head) };
}

/** 两侧都必须存在且已收口；路由已做 404/400/409 的前置判断。 */
export async function getComparison(
  db: Database,
  baseId: string,
  headId: string,
): Promise<{ baseRun: EvalRun; headRun: EvalRun; rows: EvalComparisonRow[] } | null> {
  const [baseRun, headRun] = await Promise.all([getEvalRun(db, baseId), getEvalRun(db, headId)]);
  if (!baseRun || !headRun) return null;
  const [baseResults, headResults] = await Promise.all([
    selectRunResults(db, baseId),
    selectRunResults(db, headId),
  ]);
  return { baseRun, headRun, rows: compareResults(baseResults, headResults) };
}
