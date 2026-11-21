import type { AccessFilter, AgentDefinition, AgentResourceVersions } from '@agentport/shared';
import { and, asc, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { type EvalCaseSnapshot, evalCases, evalResults, evalRuns } from '../schema.js';
import { maintainedAgentScopeWhere } from './access.js';
import { keysetBefore, paginate } from './keyset.js';

export type EvalCase = typeof evalCases.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;

export type EvalRunSummary = Pick<
  EvalRun,
  | 'id'
  | 'agentId'
  | 'agentVersion'
  | 'resourceVersions'
  | 'status'
  | 'total'
  | 'passed'
  | 'error'
  | 'createdAt'
  | 'finishedAt'
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
  judgeMode: 'contains' | 'llm';
  expectedTools?: string[] | null | undefined;
  forbiddenTools?: string[] | null | undefined;
  createdBy: string;
}

export interface EvalCasePatch {
  name?: string | undefined;
  prompt?: string | undefined;
  expectation?: string | undefined;
  judgeMode?: 'contains' | 'llm' | undefined;
  expectedTools?: string[] | null | undefined;
  forbiddenTools?: string[] | null | undefined;
}

export async function listCases(
  db: Database,
  access: AccessFilter,
  agentId?: string,
): Promise<EvalCase[]> {
  const filters: SQL[] = [];
  const accessWhere = maintainedAgentScopeWhere(access, evalCases.agentId);
  if (accessWhere) filters.push(accessWhere);
  if (agentId !== undefined) filters.push(eq(evalCases.agentId, agentId));
  return db
    .select()
    .from(evalCases)
    .where(and(...filters))
    .orderBy(desc(evalCases.createdAt), desc(evalCases.id));
}

export async function getCase(db: Database, id: string): Promise<EvalCase | null> {
  const [row] = await db.select().from(evalCases).where(eq(evalCases.id, id)).limit(1);
  return row ?? null;
}

export async function createCase(
  db: DbHandle,
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
  db: DbHandle,
  input: {
    id: string;
    agentId: string;
    total: number;
    createdBy: string;
    caseSnapshot?: EvalCaseSnapshot[];
    agentVersion?: number | null;
    definitionSnapshot?: AgentDefinition | null;
    resourceVersions?: AgentResourceVersions | null;
  },
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
  db: DbHandle,
  id: string,
  result: { status: 'succeeded' | 'failed'; passed: number; error?: string | null },
): Promise<void> {
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

/**
 * 中断/执行失败收口：只允许 running → failed，且不写 passed。
 * 已成功、已取消或已被收口的批次保持原状；重复投递的 processor 与 failed 事件可先后调用。
 */
export async function failEvalRun(db: Database, id: string, error: string): Promise<boolean> {
  const rows = await db
    .update(evalRuns)
    .set({ status: 'failed', error, finishedAt: new Date() })
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
  options: { agentId?: string; cursor?: string; limit: number; access: AccessFilter },
): Promise<EvalRunPage | null> {
  const filters: SQL[] = [];
  const accessWhere = maintainedAgentScopeWhere(options.access, evalRuns.agentId);
  if (accessWhere) filters.push(accessWhere);
  if (options.agentId !== undefined) filters.push(eq(evalRuns.agentId, options.agentId));
  if (options.cursor !== undefined) {
    const [cursor] = await db
      .select({ id: evalRuns.id })
      .from(evalRuns)
      .where(and(eq(evalRuns.id, options.cursor), ...filters))
      .limit(1);
    if (!cursor) return null;
    // shortcut: 两步查询，游标恰在两步之间被删只会得到空页；需要严格语义时改成单条 CTE。
    // 时间戳在库内读取并比较：JS Date 只有毫秒，转一手会丢掉微秒。
    filters.push(keysetBefore(evalRuns, options.cursor));
  }
  const rows = await db
    .select({
      id: evalRuns.id,
      agentId: evalRuns.agentId,
      agentVersion: evalRuns.agentVersion,
      resourceVersions: evalRuns.resourceVersions,
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
  return paginate(rows, options.limit);
}

export interface EvalResultRow {
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  judgeReason: string | null;
  runId: string | null;
}

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
  db: DbHandle,
  input: {
    id: string;
    evalRunId: string;
    caseId: string;
    caseSnapshot?: EvalCaseSnapshot;
    runId: string | null;
    passed: boolean;
    output: string;
    judgeReason?: string | null;
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
    judgeReason: row.judgeReason,
    runId: row.runId,
  };
}

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
      judgeReason: evalResults.judgeReason,
      runId: evalResults.runId,
    })
    .from(evalResults)
    .leftJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.evalRunId, runId))
    .orderBy(asc(evalResults.createdAt), asc(evalResults.id));
  return limit === undefined ? query : query.limit(limit);
}

function snapshotInputs(row: StoredEvalResult): {
  prompt: string;
  expectation: string;
  judgeMode: 'contains' | 'llm';
  expectedTools: string[];
  forbiddenTools: string[];
} | null {
  return row.caseSnapshot === null
    ? null
    : {
        prompt: row.caseSnapshot.prompt,
        expectation: row.caseSnapshot.expectation,
        judgeMode: row.caseSnapshot.judgeMode ?? 'contains',
        expectedTools: [...new Set(row.caseSnapshot.expectedTools ?? [])].sort(),
        forbiddenTools: [...new Set(row.caseSnapshot.forbiddenTools ?? [])].sort(),
      };
}

function compareResults(
  baseRows: StoredEvalResult[],
  headRows: StoredEvalResult[],
): EvalComparisonRow[] {
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
  if (baseInputs === null || headInputs === null) {
    return { key, status: 'unverified', base: toPublicResult(base), head: toPublicResult(head) };
  }
  if (
    baseInputs.prompt !== headInputs.prompt ||
    baseInputs.expectation !== headInputs.expectation ||
    baseInputs.judgeMode !== headInputs.judgeMode ||
    baseInputs.expectedTools.join('\u0000') !== headInputs.expectedTools.join('\u0000') ||
    baseInputs.forbiddenTools.join('\u0000') !== headInputs.forbiddenTools.join('\u0000')
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
