import { AppError } from '@agentport/core';
import type { KnowledgeBaseSettings } from '@agentport/shared';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeBasePins, knowledgeBases, knowledgeModelProfiles } from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeBaseRow,
  type KnowledgeJobRow,
  type Page,
  type PageOptions,
  pageLimit,
} from './shared.js';

// ---------------------------------------------------------------------------
// 知识库

export interface CreateBaseInput {
  slug: string;
  name: string;
  description: string;
  /** 内置 knowledge server；由 API 的 ensureKnowledgeServer 先建后用。 */
  serverId: string;
  embeddingProfileId: string;
  rerankProfileId: string | null;
  /** 绑定音频转录模型时必须存在、kind=asr 且启用；null 表示关闭。 */
  asrProfileId?: string | null | undefined;
  /** 省略时按表默认 active；复制已有库时沿用源库状态。 */
  status?: 'active' | 'disabled' | undefined;
  settings: KnowledgeBaseSettings;
}

/** ASR 绑定与 embedding/rerank 同一条规则：换绑只能指向存在、类型正确且启用的 profile。 */
async function assertUsableAsrProfile(db: Database, profileId: string): Promise<void> {
  const [profile] = await db
    .select({
      kind: knowledgeModelProfiles.kind,
      enabled: knowledgeModelProfiles.enabled,
    })
    .from(knowledgeModelProfiles)
    .where(eq(knowledgeModelProfiles.id, profileId))
    .limit(1);
  if (profile?.kind !== 'asr' || !profile.enabled) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
  }
}

export async function createBase(db: Database, input: CreateBaseInput): Promise<KnowledgeBaseRow> {
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
): Promise<Page<KnowledgeBaseRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [];
  if (options.cursor) {
    filters.push(sql`(${knowledgeBases.createdAt}, ${knowledgeBases.id}) < (
      select b.created_at, b.id from ${knowledgeBases} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeBases)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(knowledgeBases.createdAt), desc(knowledgeBases.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

export interface BasePatch {
  name?: string | undefined;
  description?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  embeddingProfileId?: string | undefined;
  rerankProfileId?: string | null | undefined;
  /** undefined 保持，null 关闭，非空 ID 必须是启用的 ASR profile。 */
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

/** 个人置顶的知识库 ID，按置顶时间倒序；列表用它把置顶组排到最前。 */
export async function listPinnedBaseIds(db: Database, businessId: string): Promise<string[]> {
  const rows = await db
    .select({ baseId: knowledgeBasePins.baseId })
    .from(knowledgeBasePins)
    .where(eq(knowledgeBasePins.businessId, businessId))
    .orderBy(desc(knowledgeBasePins.pinnedAt));
  return rows.map((row) => row.baseId);
}

/** 置顶幂等：重复置顶由联合唯一索引吃掉，不刷新首次置顶时间；取消时不存在即成功。 */
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

/** 复制知识库时按唯一索引判占用；最终仍由 knowledge_bases_slug_idx 裁决并发冲突。 */
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

/**
 * 概览计数走单条 SQL：每类实体一次子查询，最近任务用 lateral 只取一条。
 * wiki 页数以 knowledge_wiki_pages 为准（docs 里 content_kind='wiki' 只是它的检索索引），
 * 所以 documents 只统计 content_kind='document'，三类互不重叠。
 * knowledge_jobs 没有 updated_at，lastJob.updatedAt 取 ended_at/started_at/created_at 的最近值。
 */
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

/**
 * 知识库活动流：单条 SQL 同时取库自身、库内文档与库内标签的审计行。
 * 文档与标签的审计 target 是自身 id，用 exists 子查询回连库归属，避免先取 id 列表再拼 in；
 * targetKind 也在 SQL 里判定，调用方不再逐条回查。
 * 只读聚合：不写审计、不改任何行。已删除文档的删除事件因目标行已不存在而不在流内。
 */
export async function listBaseActivity(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<BaseActivityEntry>> {
  const limit = pageLimit(options);
  const cursor = options.cursor
    ? sql`and (a.created_at, a.id) < (
        select c.created_at, c.id from audit_log c where c.id = ${options.cursor}
      )`
    : sql.empty();
  const rows = await db.execute<{
    id: string;
    action: string;
    actor: string;
    status: string;
    target_kind: BaseActivityEntry['targetKind'];
    created_at: Date | string;
  }>(sql`
    select a.id, a.action, a.actor, a.status,
      case
        when a.target = ${baseId} then 'base'
        when exists (
          select 1 from knowledge_documents d where d.id = a.target and d.base_id = ${baseId}
        ) then 'document'
        else 'tag'
      end as target_kind,
      a.created_at
    from audit_log a
    where (
        a.target = ${baseId}
        or exists (
          select 1 from knowledge_documents d where d.id = a.target and d.base_id = ${baseId}
        )
        or exists (
          select 1 from knowledge_tags t where t.id = a.target and t.base_id = ${baseId}
        )
      )
      ${cursor}
    order by a.created_at desc, a.id desc
    limit ${limit + 1}
  `);
  const items = rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor,
    status: row.status,
    targetKind: row.target_kind,
    createdAt: toDate(row.created_at),
  }));
  return paginate(items, limit);
}
