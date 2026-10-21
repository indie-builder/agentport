import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { evalCases, evalResults, evalRuns } from '../schema.js';

export type EvalCase = typeof evalCases.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;
export type EvalStatus = NonNullable<typeof evalRuns.$inferInsert.status>;

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
  input: { id: string; agentId: string; total: number },
): Promise<EvalRun> {
  const [row] = await db.insert(evalRuns).values(input).returning();
  if (!row) throw new Error('eval run insert returned no row');
  return row;
}

export async function getEvalRun(db: Database, id: string): Promise<EvalRun | null> {
  const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  return row ?? null;
}

export async function finishEvalRun(
  db: Database,
  id: string,
  result: { status: Exclude<EvalStatus, 'running'>; passed: number; error?: string | null },
): Promise<void> {
  // 只收口仍在 running 的跑批：reconciler 已标记 failed 的行不能被晚到的 worker 覆盖。
  await db
    .update(evalRuns)
    .set({ ...result, finishedAt: new Date() })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
}

/** worker 重启后把超时仍停在 running 的跑批收敛为 failed，避免永久卡住。 */
export async function failStaleEvalRuns(
  db: Database,
  error: string,
  olderThan: Date,
): Promise<number> {
  const rows = await db
    .update(evalRuns)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(and(eq(evalRuns.status, 'running'), lt(evalRuns.createdAt, olderThan)))
    .returning({ id: evalRuns.id });
  return rows.length;
}

export async function updateProgress(db: Database, id: string, passed: number): Promise<void> {
  await db
    .update(evalRuns)
    .set({ passed })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')));
}

export async function listRuns(db: Database, agentId?: string): Promise<EvalRun[]> {
  return db
    .select()
    .from(evalRuns)
    .where(agentId === undefined ? undefined : eq(evalRuns.agentId, agentId))
    .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id));
}

/** 同一智能体只允许一个在跑的评估；API 层据此返回 409。 */
export async function hasRunningRun(db: Database, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.agentId, agentId), eq(evalRuns.status, 'running')))
    .limit(1);
  return row !== undefined;
}

export interface EvalResultRow {
  caseId: string;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string;
}

export async function addResult(
  db: Database,
  input: {
    id: string;
    evalRunId: string;
    caseId: string;
    runId: string;
    passed: boolean;
    output: string;
  },
): Promise<void> {
  // 重复投递的 job 会重写同一 run/case；唯一键让重试幂等而不是报错。
  await db.insert(evalResults).values(input).onConflictDoNothing();
}

export async function getRunDetail(
  db: Database,
  id: string,
): Promise<{ evalRun: EvalRun; results: EvalResultRow[] } | null> {
  const [evalRun] = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  if (!evalRun) return null;

  const results = await db
    .select({
      caseId: evalResults.caseId,
      name: evalCases.name,
      prompt: evalCases.prompt,
      expectation: evalCases.expectation,
      passed: evalResults.passed,
      output: evalResults.output,
      runId: evalResults.runId,
    })
    .from(evalResults)
    .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.evalRunId, id))
    .orderBy(asc(evalResults.createdAt), asc(evalResults.id));

  return { evalRun, results };
}
