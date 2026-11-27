import { sha256Hex, visibleDocumentSummary, writeKnowledgeBlob } from '@agentport/core';
import type { createServiceLogger } from '@agentport/core/logger';
import { repo, type schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeEnqueueOptions } from '@agentport/shared';
import { getKnowledgeQueue } from '../../queue/producer.js';

type Logger = ReturnType<typeof createServiceLogger>;
type JobDb = Parameters<typeof repo.knowledge.createJob>[0];

export type KnowledgeDocumentRow = typeof schema.knowledgeDocuments.$inferSelect;

export function documentWire(row: KnowledgeDocumentRow, tags: string[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    folderId: row.folderId,
    title: row.title,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    sourcePath: row.sourcePath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    contentKind: row.contentKind,
    disabledReason: row.disabledReason,
    sourceConnectionId: row.sourceConnectionId,
    currentVersionId: row.currentVersionId,
    ...visibleDocumentSummary(row),
    tags,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function enqueueKnowledgeJobAfterCommit(
  log: Logger,
  job: { id: string },
): Promise<void> {
  try {
    await getKnowledgeQueue().add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));
  } catch (err) {
    log.warn({ err, jobId: job.id }, 'knowledge job enqueue failed; awaiting reconcile');
  }
}

export async function enqueueKnowledgeJobsAfterCommit(
  log: Logger,
  jobs: { id: string }[],
): Promise<void> {
  if (jobs.length === 0) return;
  try {
    await getKnowledgeQueue().addBulk(
      jobs.map((job) => ({
        name: 'knowledge',
        data: { jobId: job.id },
        opts: knowledgeEnqueueOptions(job.id),
      })),
    );
  } catch (err) {
    log.warn({ err, jobCount: jobs.length }, 'knowledge jobs enqueue failed; awaiting reconcile');
  }
}

export function createJob(
  db: JobDb,
  input: {
    baseId: string | null;
    documentId: string | null;
    sourceId?: string | null;
    payload: KnowledgeJobPayload;
  },
) {
  return repo.knowledge.createJob(db, {
    type: input.payload.type,
    baseId: input.baseId,
    documentId: input.documentId,
    sourceId: input.sourceId ?? null,
    payload: input.payload,
  });
}

export async function storeBlob(knowledgeDir: string, data: Uint8Array): Promise<string> {
  const sha = sha256Hex(data);
  await writeKnowledgeBlob(knowledgeDir, sha, data);
  return sha;
}
