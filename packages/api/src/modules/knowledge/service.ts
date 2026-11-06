import { type Database, newId, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { knowledgeEnqueueOptions } from '@agentport/shared';
import { getKnowledgeQueue } from '../../queue/producer.js';

type Db = Database;
/** 任务行可以与业务写入同事务落库；仓储接口本身已接受事务连接。 */
type JobDb = Parameters<typeof repo.knowledge.createJob>[0];

export type KnowledgeDocumentRow = typeof schema.knowledgeDocuments.$inferSelect;

/** 文档 wire 的唯一投影：管理列表、详情与发布响应共用，避免字段漂移。 */
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
    tags,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function enqueueKnowledgeJob(job: { id: string }): Promise<void> {
  await getKnowledgeQueue().add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));
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

/**
 * 内置 server（kind='knowledge'）没有长期 token，config 只由平台写 `{ knowledgeBaseId }`。
 * base.server_id 是非空外键，所以创建库必须分两步：先 ensureKnowledgeServer({ slug })
 * 拿到 serverId，建完 base 后再调一次把 knowledgeBaseId 写进 config。
 */
export async function ensureKnowledgeServer(
  db: Db,
  base: { slug: string; id?: string; serverId?: string },
) {
  const name = `kb-${base.slug}`;
  const config = base.id ? { knowledgeBaseId: base.id } : {};
  const existing = base.serverId ? await repo.servers.getServer(db, base.serverId) : null;
  if (existing) {
    if (existing.name === name && existing.config.knowledgeBaseId === base.id) return existing;
    const updated = await repo.servers.updateServer(db, existing.id, { name, config });
    return updated ?? existing;
  }
  const [row] = await db
    .insert(schema.servers)
    .values({ id: newId('server'), name, kind: 'knowledge', config, secretsEncrypted: null })
    .returning();
  if (!row) throw new Error('knowledge server insert returned no row');
  return row;
}
