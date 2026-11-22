import { sha256Hex, visibleDocumentSummary, writeKnowledgeBlob } from '@agentport/core';
import type { createServiceLogger } from '@agentport/core/logger';
import { type Database, newId, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeEnqueueOptions } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { getKnowledgeQueue } from '../../queue/producer.js';

type Db = Database;
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

export async function ensureKnowledgeServer(
  db: Db,
  base: { slug: string; id?: string; serverId?: string; ownerBusinessId?: string },
) {
  const name = `kb-${base.slug}`;
  const config = base.id ? { knowledgeBaseId: base.id } : {};
  const existing = base.serverId ? await repo.servers.getServer(db, base.serverId) : null;
  if (existing) {
    const owner =
      existing.ownerBusinessId === null && base.ownerBusinessId !== undefined
        ? base.ownerBusinessId
        : null;
    if (existing.name === name && existing.config.knowledgeBaseId === base.id && owner === null) {
      return existing;
    }
    const updated = await repo.servers.updateServer(db, existing.id, { name, config });
    if (owner !== null) {
      await db
        .update(schema.servers)
        .set({ ownerBusinessId: owner })
        .where(eq(schema.servers.id, existing.id));
    }
    return updated ?? existing;
  }
  const [row] = await db
    .insert(schema.servers)
    .values({
      id: newId('server'),
      name,
      kind: 'knowledge',
      config,
      secretsEncrypted: null,
      ownerBusinessId: base.ownerBusinessId ?? null,
    })
    .returning();
  if (!row) throw new Error('knowledge server insert returned no row');
  return row;
}

export async function storeBlob(knowledgeDir: string, data: Uint8Array): Promise<string> {
  const sha = sha256Hex(data);
  await writeKnowledgeBlob(knowledgeDir, sha, data);
  return sha;
}

export function supportsImageVectors(profile: {
  embeddingProtocol: string;
  model: string;
  imageInputEnabled: boolean;
}): boolean {
  return (
    profile.embeddingProtocol === 'cohere_v2' &&
    profile.model === 'embed-v4.0' &&
    profile.imageInputEnabled
  );
}
