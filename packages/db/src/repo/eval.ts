import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
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

export async function finishEvalRun(
  db: Database,
  id: string,
  result: { status: Exclude<EvalStatus, 'running'>; passed: number },
): Promise<void> {
  await db
    .update(evalRuns)
    .set({ ...result, finishedAt: new Date() })
    .where(eq(evalRuns.id, id));
}

export async function listRuns(db: Database, agentId?: string): Promise<EvalRun[]> {
  return db
    .select()
    .from(evalRuns)
    .where(agentId === undefined ? undefined : eq(evalRuns.agentId, agentId))
    .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id));
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
  await db.insert(evalResults).values(input);
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
