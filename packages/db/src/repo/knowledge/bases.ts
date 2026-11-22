import { AppError, ASR_PROFILE_INVALID_MESSAGE } from '@agentport/core';
import type { KnowledgeBaseSettings, ResourceAccessFilter } from '@agentport/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import {
  auditLog,
  knowledgeBasePins,
  knowledgeBases,
  knowledgeModelProfiles,
} from '../../schema.js';
import { resourceScopeWhere } from '../access.js';
import { keysetPage } from '../pagination.js';
import {
  type KnowledgeBaseRow,
  type KnowledgeJobRow,
  type Page,
  type PageOptions,
  pageLimit,
} from './shared.js';

export interface CreateBaseInput {
  slug: string;
  name: string;
  description: string;
  serverId: string;
  embeddingProfileId: string;
  rerankProfileId: string | null;
  asrProfileId?: string | null | undefined;
  status?: 'active' | 'disabled' | undefined;
  settings: KnowledgeBaseSettings;
  ownerBusinessId?: string | undefined;
}

async function assertUsableAsrProfile(db: DbHandle, profileId: string): Promise<void> {
  const [profile] = await db
    .select({
      kind: knowledgeModelProfiles.kind,
      enabled: knowledgeModelProfiles.enabled,
    })
    .from(knowledgeModelProfiles)
    .where(eq(knowledgeModelProfiles.id, profileId))
    .limit(1);
  if (profile?.kind !== 'asr' || !profile.enabled) {
    throw new AppError('INVALID_INPUT', ASR_PROFILE_INVALID_MESSAGE);
  }
}

export async function createBase(db: DbHandle, input: CreateBaseInput): Promise<KnowledgeBaseRow> {
  if (input.asrProfileId !== null && input.asrProfileId !== undefined) {
    await assertUsableAsrProfile(db, input.asrProfileId);
  }
  const [row] = await db
    .insert(knowledgeBases)
    .values({ id: newId('knowledgeBase'), ...input })
    .returning();
  if (!row) throw new Error('knowledge base insert returned no row');
  return row;
}

export async function getBase(db: Database, id: string): Promise<KnowledgeBaseRow | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).limit(1);
  return row ?? null;
}

export async function listBases(
  db: Database,
  options: PageOptions = {},
  access?: ResourceAccessFilter,
): Promise<Page<KnowledgeBaseRow> | null> {
  const limit = pageLimit(options);
  const filters: SQL[] = [];
  if (access) {
    const scope = resourceScopeWhere(access, knowledgeBases.id, knowledgeBases.ownerBusinessId);
    if (scope) filters.push(scope);
  }
  return keysetPage(db, {
    table: knowledgeBases,
    cursor: options.cursor,
    limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(knowledgeBases)
        .where(where)
        .orderBy(desc(knowledgeBases.createdAt), desc(knowledgeBases.id))
        .limit(limit),
  });
}

export interface BasePatch {
  name?: string | undefined;
  description?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  embeddingProfileId?: string | undefined;
  rerankProfileId?: string | null | undefined;
  asrProfileId?: string | null | undefined;
  settings?: KnowledgeBaseSettings | undefined;
}

export async function updateBase(
  db: Database,
  id: string,
  patch: BasePatch,
): Promise<KnowledgeBaseRow | null> {
  if (patch.asrProfileId !== null && patch.asrProfileId !== undefined) {
    await assertUsableAsrProfile(db, patch.asrProfileId);
  }
  const [row] = await db
    .update(knowledgeBases)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeBases.id, id))
    .returning();
  return row ?? null;
}

export async function deleteBase(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeBases)
    .where(eq(knowledgeBases.id, id))
    .returning({ id: knowledgeBases.id });
  return rows.length > 0;
}

export async function listPinnedBaseIds(db: Database, businessId: string): Promise<string[]> {
  const rows = await db
    .select({ baseId: knowledgeBasePins.baseId })
    .from(knowledgeBasePins)
    .where(eq(knowledgeBasePins.businessId, businessId))
    .orderBy(desc(knowledgeBasePins.pinnedAt));
  return rows.map((row) => row.baseId);
}

export async function setBasePin(
  db: Database,
  businessId: string,
  baseId: string,
  pinned: boolean,
): Promise<void> {
  if (pinned) {
    await db.insert(knowledgeBasePins).values({ businessId, baseId }).onConflictDoNothing();
    return;
  }
  await db
    .delete(knowledgeBasePins)
    .where(and(eq(knowledgeBasePins.businessId, businessId), eq(knowledgeBasePins.baseId, baseId)));
}

export async function baseSlugExists(db: Database, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.slug, slug))
    .limit(1);
  return row !== undefined;
}

export interface BaseSummaryCounts {
  documents: number;
  faqs: number;
  wikiPages: number;
  sources: number;
  folders: number;
  tags: number;
  lastJob: {
    id: string;
    type: string;
    status: KnowledgeJobRow['status'];
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

export async function getBaseSummary(
  db: Database,
  baseId: string,
): Promise<BaseSummaryCounts | null> {
  const rows = await db.execute<{
    documents: number;
    faqs: number;
    wiki_pages: number;
    sources: number;
    folders: number;
    tags: number;
    last_job_id: string | null;
    last_job_type: string | null;
    last_job_status: string | null;
    last_job_created_at: Date | string | null;
    last_job_updated_at: Date | string | null;
  }>(sql`
    select
      (select count(*)::int from knowledge_documents d
        where d.base_id = b.id and d.content_kind = 'document') as documents,
      (select count(*)::int from knowledge_documents d
        where d.base_id = b.id and d.content_kind = 'faq') as faqs,
      (select count(*)::int from knowledge_wiki_pages p where p.base_id = b.id) as wiki_pages,
      (select count(*)::int from knowledge_sources s where s.base_id = b.id) as sources,
      (select count(*)::int from knowledge_folders f where f.base_id = b.id) as folders,
      (select count(*)::int from knowledge_tags t where t.base_id = b.id) as tags,
      last_job.id as last_job_id,
      last_job.type as last_job_type,
      last_job.status as last_job_status,
      last_job.created_at as last_job_created_at,
      last_job.updated_at as last_job_updated_at
    from knowledge_bases b
    left join lateral (
      select j.id, j.type, j.status, j.created_at,
        coalesce(j.ended_at, j.started_at, j.created_at) as updated_at
      from knowledge_jobs j
      where j.base_id = b.id
      order by j.created_at desc, j.id desc
      limit 1
    ) as last_job on true
    where b.id = ${baseId}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    documents: row.documents,
    faqs: row.faqs,
    wikiPages: row.wiki_pages,
    sources: row.sources,
    folders: row.folders,
    tags: row.tags,
    lastJob:
      row.last_job_id === null ||
      row.last_job_type === null ||
      row.last_job_status === null ||
      row.last_job_created_at === null ||
      row.last_job_updated_at === null
        ? null
        : {
            id: row.last_job_id,
            type: row.last_job_type,
            status: row.last_job_status as KnowledgeJobRow['status'],
            createdAt: toDate(row.last_job_created_at),
            updatedAt: toDate(row.last_job_updated_at),
          },
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface BaseActivityEntry {
  id: string;
  action: string;
  actor: string;
  status: string;
  targetKind: 'base' | 'document' | 'tag';
  createdAt: Date;
}

export async function listBaseActivity(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<BaseActivityEntry> | null> {
  return keysetPage(db, {
    table: auditLog,
    cursor: options.cursor,
    limit: pageLimit(options),
    where: [
      sql`(
      ${auditLog.target} = ${baseId}
      or exists (
        select 1 from knowledge_documents d where d.id = ${auditLog.target} and d.base_id = ${baseId}
      )
      or exists (
        select 1 from knowledge_tags t where t.id = ${auditLog.target} and t.base_id = ${baseId}
      )
    )`,
    ],
    load: async ({ where, limit }) => {
      const rows = await db.execute<{
        id: string;
        action: string;
        actor: string;
        status: string;
        target_kind: BaseActivityEntry['targetKind'];
        created_at: Date | string;
      }>(sql`
        select ${auditLog.id}, ${auditLog.action}, ${auditLog.actor}, ${auditLog.status},
          case
            when ${auditLog.target} = ${baseId} then 'base'
            when exists (
              select 1 from knowledge_documents d where d.id = ${auditLog.target} and d.base_id = ${baseId}
            ) then 'document'
            else 'tag'
          end as target_kind,
          ${auditLog.createdAt}
        from ${auditLog}
        where ${where}
        order by ${auditLog.createdAt} desc, ${auditLog.id} desc
        limit ${limit}
      `);
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        actor: row.actor,
        status: row.status,
        targetKind: row.target_kind,
        createdAt: toDate(row.created_at),
      }));
    },
  });
}
