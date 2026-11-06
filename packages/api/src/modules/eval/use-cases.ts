import { fail } from '@agentport/core';
import { type Database, newId, type repo, schema } from '@agentport/db';
import {
  type EvalDatasetImportResult,
  type evalDatasetSchema,
  RUN_QUEUE_MAX_WAITING,
} from '@agentport/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { isPgCode } from '../../http/errors.js';
import { getEvalQueue, getQueue } from '../../queue/producer.js';

export const agentNotFound = '智能体不存在，可能已被删除；请刷新后重新选择';

export function toEvalRun(row: repo.evalRepo.EvalRunSummary) {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    total: row.total,
    passed: row.passed,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

export async function importEvalCases(
  db: Database,
  agentId: string,
  dataset: z.infer<typeof evalDatasetSchema>,
  createdBy: string,
): Promise<EvalDatasetImportResult> {
  const warnings: string[] = [];

  return db.transaction(async (tx): Promise<EvalDatasetImportResult> => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .for('update');
    if (!agent) fail('NOT_FOUND', agentNotFound);

    const existing = await tx
      .select({ name: schema.evalCases.name })
      .from(schema.evalCases)
      .where(
        and(
          eq(schema.evalCases.agentId, agentId),
          inArray(
            schema.evalCases.name,
            dataset.cases.map((evalCase) => evalCase.name),
          ),
        ),
      );
    const taken = new Set(existing.map((row) => row.name));

    const rows: Array<typeof schema.evalCases.$inferInsert> = [];
    let skipped = 0;
    for (const evalCase of dataset.cases) {
      if (taken.has(evalCase.name)) {
        skipped += 1;
        warnings.push(`用例「${evalCase.name}」已存在，已跳过`);
        continue;
      }
      taken.add(evalCase.name);
      rows.push({ id: newId('evalCase'), agentId, createdBy, ...evalCase });
    }
    if (rows.length > 0) await tx.insert(schema.evalCases).values(rows);

    return { imported: rows.length, skipped, warnings };
  });
}

export async function startEvalRun(
  db: Database,
  agentId: string,
  createdBy: string,
): Promise<{ evalRunId: string }> {
  const [waitingRuns, waitingEvals] = await Promise.all([
    getQueue().getWaitingCount(),
    getEvalQueue().getWaitingCount(),
  ]);
  if (waitingRuns > RUN_QUEUE_MAX_WAITING || waitingEvals > RUN_QUEUE_MAX_WAITING) {
    fail('SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
  }

  let evalRun: typeof schema.evalRuns.$inferSelect | undefined;
  try {
    evalRun = await db.transaction(async (tx) => {
      const [lockedAgent] = await tx
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .for('update');
      if (!lockedAgent) fail('NOT_FOUND', agentNotFound);
      const cases = await tx
        .select({
          id: schema.evalCases.id,
          name: schema.evalCases.name,
          prompt: schema.evalCases.prompt,
          expectation: schema.evalCases.expectation,
        })
        .from(schema.evalCases)
        .where(eq(schema.evalCases.agentId, agentId))
        .orderBy(asc(schema.evalCases.createdAt), asc(schema.evalCases.id));
      if (cases.length === 0) fail('INVALID_INPUT', '该智能体还没有用例');
      const [running] = await tx
        .select({ id: schema.evalRuns.id })
        .from(schema.evalRuns)
        .where(and(eq(schema.evalRuns.agentId, agentId), eq(schema.evalRuns.status, 'running')))
        .limit(1);
      if (running) return undefined;
      const [created] = await tx
        .insert(schema.evalRuns)
        .values({
          id: newId('evalRun'),
          agentId,
          createdBy,
          total: cases.length,
          caseSnapshot: cases,
        })
        .returning();
      return created;
    });
  } catch (err) {
    if (!isPgCode(err, '23505')) throw err;
  }
  if (!evalRun) fail('EVAL_RUN_IN_PROGRESS', '该智能体已有正在运行的评估');

  try {
    await getEvalQueue().add(
      'eval-run',
      { evalRunId: evalRun.id },
      { jobId: evalRun.id, removeOnComplete: 100, removeOnFail: 200 },
    );
  } catch {
    try {
      const [failed] = await db
        .update(schema.evalRuns)
        .set({
          status: 'failed',
          error: '评估入队失败，请稍后重试',
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(schema.evalRuns.id, evalRun.id),
            eq(schema.evalRuns.status, 'running'),
            isNull(schema.evalRuns.claimedAt),
          ),
        )
        .returning({ id: schema.evalRuns.id });
      if (failed) {
        await getEvalQueue()
          .getJob(evalRun.id)
          .then((job) => job?.remove())
          .catch(() => undefined);
      }
    } catch {
      // 清理失败时没有可安全回显的细节，仍然返回固定的入队失败。
    }
    fail('SERVICE_UNAVAILABLE', '评估入队失败，请稍后重试');
  }

  return { evalRunId: evalRun.id };
}
