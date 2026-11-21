import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeEnqueueOptions } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { getKnowledgeQueue } from '../../queue/producer.js';

type Db = Database;
type JobDb = Parameters<typeof repo.knowledge.createJob>[0];

export type KnowledgeDocumentRow = typeof schema.knowledgeDocuments.$inferSelect;

export function documentWire(row: KnowledgeDocumentRow, tags: string[]) {
  const summaryActive =
    row.currentVersionId !== null && row.summaryVersionId === row.currentVersionId;
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
    summary: summaryActive ? row.summary : null,
    summaryStatus: summaryActive ? row.summaryStatus : ('none' as const),
    summaryGeneratedAt: summaryActive ? (row.summaryGeneratedAt?.toISOString() ?? null) : null,
    summaryError: summaryActive ? row.summaryError : null,
    tags,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function enqueueKnowledgeJob(job: { id: string }): Promise<void> {
  await getKnowledgeQueue().add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));
}

export async function enqueueKnowledgeJobs(jobs: { id: string }[]): Promise<void> {
  if (jobs.length === 0) return;
  await getKnowledgeQueue().addBulk(
    jobs.map((job) => ({
      name: 'knowledge',
      data: { jobId: job.id },
      opts: knowledgeEnqueueOptions(job.id),
    })),
  );
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

export function blobPathFor(knowledgeDir: string, sha: string): string {
  return join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
}

export async function storeBlob(knowledgeDir: string, data: Buffer): Promise<string> {
  const sha = sha256Hex(data);
  const target = blobPathFor(knowledgeDir, sha);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${newId('knowledgeJob')}`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
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
