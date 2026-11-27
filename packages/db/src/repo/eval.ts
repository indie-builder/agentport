import {
  compareResults,
  type EvalComparisonRow,
  type EvalComparisonStatus,
  type EvalResultRow,
  type StoredEvalResult,
  toPublicResult,
} from '@agentport/core';
import type { AccessFilter, AgentDefinition, AgentResourceVersions } from '@agentport/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import {
  agentRuns,
  conversations,
  type EvalCaseSnapshot,
  evalCases,
  evalResults,
  evalRuns,
  messages,
  runFeedback,
} from '../schema.js';
import { maintainedAgentScopeWhere, ownerScopeWhere } from './access.js';
import { messageText } from './chat/messages.js';
import { type CursorPage, keysetPage } from './pagination.js';

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
  sourceRunId?: string | null | undefined;
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

function caseFilters(access: AccessFilter, agentId?: string): SQL[] {
  const filters: SQL[] = [];
  const accessWhere = maintainedAgentScopeWhere(access, evalCases.agentId);
  if (accessWhere) filters.push(accessWhere);
  if (agentId !== undefined) filters.push(eq(evalCases.agentId, agentId));
  return filters;
}

export async function listCases(
  db: Database,
  access: AccessFilter,
  options: { agentId?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<CursorPage<EvalCase> | null> {
  return keysetPage(db, {
    table: evalCases,
    cursor: options.cursor,
    limit: options.limit,
    where: caseFilters(access, options.agentId),
    load: ({ where, limit }) =>
      db
        .select()
        .from(evalCases)
        .where(where)
        .orderBy(desc(evalCases.createdAt), desc(evalCases.id))
        .limit(limit),
  });
}

export async function listAllCases(
  db: Database,
  access: AccessFilter,
  agentId?: string,
): Promise<EvalCase[]> {
  return db
    .select()
    .from(evalCases)
    .where(and(...caseFilters(access, agentId)))
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

export interface EvalSampleCandidate {
  runId: string;
  conversationId: string;
  title: string;
  prompt: string;
  endedAt: Date;
  initiatedBy: string | null;
}

const SAMPLE_WINDOW = 200;

export async function sampleProductionRuns(
  db: Database,
  options: { agentId: string; limit: number; access: AccessFilter },
): Promise<EvalSampleCandidate[]> {
  const linkedCaseRuns = sql`select ${evalCases.sourceRunId} from ${evalCases} where ${evalCases.sourceRunId} is not null`;
  const linkedFeedbackRuns = sql`select ${runFeedback.runId} from ${runFeedback} where ${runFeedback.evalCaseId} is not null`;
  const filters: SQL[] = [
    eq(agentRuns.agentId, options.agentId),
    eq(agentRuns.status, 'succeeded'),
    eq(agentRuns.trigger, 'chat'),
    isNull(agentRuns.evalRunId),
    isNull(agentRuns.channelId),
    isNull(agentRuns.definitionSnapshot),
    isNotNull(agentRuns.endedAt),
    sql`${agentRuns.id} not in (${linkedCaseRuns})`,
    sql`${agentRuns.id} not in (${linkedFeedbackRuns})`,
  ];
  const scope = ownerScopeWhere(agentRuns.initiatedBy, options.access);
  if (scope !== undefined) filters.push(scope);
  const rows = await db
    .select({
      runId: agentRuns.id,
      conversationId: agentRuns.conversationId,
      title: conversations.title,
      endedAt: agentRuns.endedAt,
      initiatedBy: agentRuns.initiatedBy,
    })
    .from(agentRuns)
    .innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(and(...filters))
    .orderBy(desc(agentRuns.endedAt))
    .limit(SAMPLE_WINDOW);
  const prompts = new Map<string, string>();
  if (rows.length > 0) {
    const userMessages = await db
      .selectDistinctOn([messages.runId], { runId: messages.runId, content: messages.content })
      .from(messages)
      .where(
        and(
          inArray(
            messages.runId,
            rows.map((row) => row.runId),
          ),
          eq(messages.role, 'user'),
        ),
      )
      .orderBy(asc(messages.runId), asc(messages.createdAt), asc(messages.id));
    for (const message of userMessages) {
      if (message.runId === null) continue;
      const text = messageText(message.content);
      if (text === null || text.trim() === '') continue;
      prompts.set(message.runId, text.slice(0, 20_000));
    }
  }
  const eligible = rows.filter((row) => prompts.has(row.runId));
  for (let i = eligible.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = eligible[i];
    const target = eligible[j];
    if (current !== undefined && target !== undefined) {
      eligible[i] = target;
      eligible[j] = current;
    }
  }
  return eligible.slice(0, options.limit).flatMap((row) => {
    const prompt = prompts.get(row.runId);
    const { endedAt } = row;
    return prompt === undefined || endedAt === null
      ? []
      : [
          {
            runId: row.runId,
            conversationId: row.conversationId,
            title: row.title.trim() || `运行 ${row.runId.slice(-8)}`,
            prompt,
            endedAt,
            initiatedBy: row.initiatedBy,
          },
        ];
  });
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

export async function cancelEvalRun(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(evalRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')))
    .returning({ id: evalRuns.id });
  return rows.length > 0;
}

export async function failEvalRun(db: Database, id: string, error: string): Promise<boolean> {
  const rows = await db
    .update(evalRuns)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, 'running')))
    .returning({ id: evalRuns.id });
  return rows.length > 0;
}

export async function listRuns(
  db: Database,
  options: { agentId?: string; cursor?: string; limit: number; access: AccessFilter },
): Promise<EvalRunPage | null> {
  const filters: SQL[] = [];
  const accessWhere = maintainedAgentScopeWhere(options.access, evalRuns.agentId);
  if (accessWhere) filters.push(accessWhere);
  if (options.agentId !== undefined) filters.push(eq(evalRuns.agentId, options.agentId));
  return keysetPage(db, {
    table: evalRuns,
    cursor: options.cursor,
    limit: options.limit,
    where: filters,
    load: ({ where, limit }) =>
      db
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
        .where(where)
        .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
        .limit(limit),
  });
}

export type { EvalComparisonRow, EvalComparisonStatus, EvalResultRow };

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
