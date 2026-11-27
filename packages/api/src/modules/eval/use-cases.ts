import { fail } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import {
  DEFAULT_JOB_RETENTION,
  type EvalDatasetImportResult,
  type evalDatasetSchema,
} from '@agentport/shared';
import type { z } from 'zod';
import { getEvalQueue, getQueue } from '../../queue/producer.js';
import { requireRunQueueCapacity } from '../runs/capacity.js';

export function toEvalRun(row: repo.evalRepo.EvalRunSummary) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersion: row.agentVersion,
    resourceVersions: row.resourceVersions,
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
  return repo.evalRepo.importCases(db, agentId, dataset.cases, createdBy);
}

export async function startEvalRun(
  db: Database,
  agentId: string,
  createdBy: string,
  target: 'published' | 'draft' = 'published',
): Promise<{ evalRunId: string }> {
  await requireRunQueueCapacity(undefined, [getQueue(), getEvalQueue()]);

  const evalRun = await repo.evalRepo.startRun(db, agentId, createdBy, target);
  if (!evalRun) fail('EVAL_RUN_IN_PROGRESS', '该智能体已有正在运行的评估');

  try {
    await getEvalQueue().add(
      'eval-run',
      { evalRunId: evalRun.id },
      { jobId: evalRun.id, ...DEFAULT_JOB_RETENTION },
    );
  } catch {
    try {
      const failed = await repo.evalRepo.failUnclaimedEvalRun(
        db,
        evalRun.id,
        '评估入队失败，请稍后重试',
      );
      if (failed) {
        await getEvalQueue()
          .getJob(evalRun.id)
          .then((job) => job?.remove())
          .catch(() => undefined);
      }
    } catch {}
    fail('SERVICE_UNAVAILABLE', '评估入队失败，请稍后重试');
  }

  return { evalRunId: evalRun.id };
}
