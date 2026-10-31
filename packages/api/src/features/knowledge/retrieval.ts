import {
  AppError,
  decryptSecrets,
  embedTexts,
  rerankDocuments,
  segmentForSearch,
} from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type {
  KnowledgeImageRef,
  KnowledgeSearchHit,
  KnowledgeSearchQuery,
} from '@agentport/shared';
import { knowledgeImageChunkMetadataSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';

type Db = Database;

const PER_PATH = 50;
const RRF_K = 60;
const FUSED = 30;
const QUOTE_LIMIT = 1200;

interface SearchRow extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  version_id: string;
  heading: string | null;
  content: string;
  page_from: number | null;
  page_to: number | null;
  title: string;
  source_url: string | null;
  metadata: Record<string, unknown>;
  rank: number;
}

export interface SearchKnowledgeResult {
  hits: KnowledgeSearchHit[];
  /** 向量路不可用（profile 缺失/禁用/调用失败）时为真，只返回关键词结果。 */
  degraded: boolean;
}

export interface SearchKnowledgeOptions {
  /** 解密 profile apiKey 用；与 worker 共用 APP_SECRET_KEY。 */
  secretKey: string;
  signal?: AbortSignal;
}

/** 一次检索的可见范围：库、过滤条件、图片开关与当前 embedding profile。 */
interface SearchScope {
  baseId: string;
  query: KnowledgeSearchQuery;
  imageProcessingEnabled: boolean;
  /** 只召回该 profile 生成的版本向量，避免换库后混空间。 */
  profileId: string;
}

/** 契约 §4.6：旧版本、禁用 chunk、非 ready 文档都不召回；文件夹/标签是附加过滤。 */
function scopeFilter(scope: SearchScope) {
  const { baseId, query } = scope;
  // chunk.folder_id 是写入时快照；文档移动后归属以 d.folder_id 为准。
  const folders =
    query.folders.length === 0
      ? sql``
      : sql`and d.folder_id = any(array[${sql.join(
          query.folders.map((folder) => sql`${folder}`),
          sql`, `,
        )}]::text[])`;
  const tags =
    query.tags.length === 0
      ? sql``
      : sql`and (select count(distinct t.name) from knowledge_document_tags dt
          join knowledge_tags t on t.id = dt.tag_id
          where dt.document_id = c.document_id and t.name = any(array[${sql.join(
            query.tags.map((tag) => sql`${tag}`),
            sql`, `,
          )}]::text[])) = ${query.tags.length}`;
  // 图片处理关闭时隐藏图片语义 chunk；普通正文不受影响。
  const images = scope.imageProcessingEnabled ? sql`` : sql`and c.metadata -> 'image' is null`;
  return sql`c.base_id = ${baseId}
    and c.enabled
    and d.status = 'ready'
    and d.current_version_id = c.version_id
    ${folders} ${tags} ${images}`;
}

const selectedColumns = sql`c.id as chunk_id, c.document_id, c.version_id, c.heading, c.content,
  c.page_from, c.page_to, c.metadata, d.title, d.source_url`;

async function keywordSearch(db: Db, scope: SearchScope, segmented: string): Promise<SearchRow[]> {
  if (segmented.length === 0) return [];
  // plainto_tsquery 而不是手工拼 '&'：分词结果里可能带引号，拼串会被当成 tsquery 语法。
  const result = await db.execute<SearchRow>(sql`
    select ${selectedColumns},
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', ${segmented})) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    where ${scopeFilter(scope)}
      and coalesce(c.metadata ->> 'imageRole', '') <> 'vector'
      and c.search_vector @@ plainto_tsquery('simple', ${segmented})
    order by rank desc, c.id
    limit ${PER_PATH}
  `);
  return result.rows;
}

/** 文本向量路：只召回当前 profile 生成的版本，且排除图片 vector 子块。 */
async function vectorSearch(db: Db, scope: SearchScope, vector: number[]): Promise<SearchRow[]> {
  const literal = `[${vector.join(',')}]`;
  const result = await db.execute<SearchRow>(sql`
    select ${selectedColumns}, 1 - (c.embedding <=> ${literal}::vector) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    join knowledge_document_versions v on v.id = c.version_id
    where ${scopeFilter(scope)}
      and v.embedding_profile_id = ${scope.profileId}
      and coalesce(c.metadata ->> 'imageRole', '') <> 'vector'
      and c.embedding is not null
    order by c.embedding <=> ${literal}::vector
    limit ${PER_PATH}
  `);
  return result.rows;
}

/** 图片向量单路：同空间文本查询，按 imageVectorMinScore 过滤，不冒充文字命中。 */
async function imageVectorSearch(
  db: Db,
  scope: SearchScope,
  vector: number[],
  minScore: number,
): Promise<SearchRow[]> {
  const literal = `[${vector.join(',')}]`;
  const result = await db.execute<SearchRow>(sql`
    select ${selectedColumns}, 1 - (c.embedding <=> ${literal}::vector) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    join knowledge_document_versions v on v.id = c.version_id
    where ${scopeFilter(scope)}
      and v.embedding_profile_id = ${scope.profileId}
      and c.metadata ->> 'imageRole' = 'vector'
      and c.embedding is not null
      and 1 - (c.embedding <=> ${literal}::vector) >= ${minScore}
    order by c.embedding <=> ${literal}::vector
    limit ${PER_PATH}
  `);
  return result.rows;
}

function imageOf(metadata: Record<string, unknown>): KnowledgeImageRef | null {
  const parsed = knowledgeImageChunkMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.image : null;
}

function hitOf(row: SearchRow, score: number): KnowledgeSearchHit {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    title: row.title,
    heading: row.heading,
    quote: row.content.slice(0, QUOTE_LIMIT),
    pageFrom: row.page_from,
    pageTo: row.page_to,
    sourceUrl: row.source_url,
    score,
    image: imageOf(row.metadata),
  };
}

/** RRF：每路各取 top 50，融合后取前 30，再交给 rerank 决定最终顺序。 */
function fuse(paths: SearchRow[][]): Array<{ row: SearchRow; score: number }> {
  const merged = new Map<string, { row: SearchRow; score: number }>();
  for (const rows of paths) {
    rows.forEach((row, index) => {
      const current = merged.get(row.chunk_id) ?? { row, score: 0 };
      current.score += 1 / (RRF_K + index + 1);
      merged.set(row.chunk_id, current);
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, FUSED);
}

/** 同空间图片查询要求 profile 同时具备协议、模型与图片输入能力。 */
function supportsImageVectors(profile: {
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

/**
 * 关键词 + 向量双路召回，RRF 融合后按 base 的 rerank profile 重排。
 * embedding 路径任何一步失败都只降级为关键词结果，不把整次检索变成错误。
 */
export async function searchKnowledge(
  db: Db,
  baseId: string,
  query: KnowledgeSearchQuery,
  options: SearchKnowledgeOptions,
): Promise<SearchKnowledgeResult> {
  const base = await repo.knowledge.getBase(db, baseId);
  if (!base) throw new AppError('NOT_FOUND', '知识库不存在，可能已被删除');
  // 停库即时生效：管理端 REST 与 MCP 都不能再从这里召回，历史引用由各自读路径判断。
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用');

  // 直接写库的旧行可能没有 imageProcessing；按关闭处理，不猜默认值。
  const imageProcessing = base.settings.imageProcessing;
  const scope: SearchScope = {
    baseId,
    query,
    imageProcessingEnabled: imageProcessing?.enabled === true,
    profileId: base.embeddingProfileId,
  };
  const segmented = segmentForSearch(query.q);
  const keyword = await keywordSearch(db, scope, segmented).catch((err: unknown) => {
    // 关键词查询失败是真实故障（SQL/连接），不能悄悄变成「无结果」。
    throw new AppError('INTERNAL_ERROR', '关键词检索失败', { cause: err });
  });

  let vector: SearchRow[] = [];
  let imageVector: SearchRow[] = [];
  let degraded = true;
  const profile = base.embeddingProfileId
    ? await repo.knowledge.getModelProfileWithSecret(db, base.embeddingProfileId)
    : null;
  if (profile?.enabled && profile.kind === 'embedding') {
    const embeddingProfile = {
      endpointUrl: profile.endpointUrl,
      model: profile.model,
      dimensions: 1024 as const,
      embeddingProtocol: profile.embeddingProtocol,
      imageInputEnabled: profile.imageInputEnabled,
      ...(profile.secretsEncrypted
        ? { apiKey: decryptSecrets(profile.secretsEncrypted, options.secretKey).apiKey }
        : {}),
    };
    try {
      const [embedding] = await embedTexts(
        embeddingProfile,
        [segmented.length > 0 ? segmented : query.q],
        options.signal,
        'search_query',
      );
      if (embedding) {
        vector = await vectorSearch(db, scope, embedding);
        degraded = false;
        if (
          imageProcessing?.imageVectorEnabled === true &&
          imageProcessing.enabled &&
          supportsImageVectors(embeddingProfile)
        ) {
          imageVector = await imageVectorSearch(
            db,
            scope,
            embedding,
            imageProcessing.imageVectorMinScore,
          );
        }
      }
    } catch {
      degraded = true;
    }
  }

  const fused = fuse([keyword, vector, imageVector]);
  let ordered = fused;

  if (query.rerank && base.rerankProfileId && fused.length > 0) {
    const rerankProfile = await repo.knowledge.getModelProfileWithSecret(db, base.rerankProfileId);
    if (rerankProfile?.enabled && rerankProfile.kind === 'rerank') {
      try {
        const apiKey = rerankProfile.secretsEncrypted
          ? decryptSecrets(rerankProfile.secretsEncrypted, options.secretKey).apiKey
          : undefined;
        const scores = await rerankDocuments(
          {
            endpointUrl: rerankProfile.endpointUrl,
            model: rerankProfile.model,
            ...(apiKey ? { apiKey } : {}),
          },
          query.q,
          fused.map(({ row }) => row.content),
          options.signal,
        );
        // 重排失败时保留 RRF 顺序：检索结果仍有意义，不该整体失败。
        const scored = scores
          .flatMap((entry) => {
            const match = fused[entry.index];
            return match ? [{ row: match.row, score: entry.score }] : [];
          })
          .sort((a, b) => b.score - a.score);
        if (scored.length > 0) ordered = scored;
      } catch {
        ordered = fused;
      }
    }
  }

  const hits = ordered.slice(0, query.limit).map(({ row, score }) => hitOf(row, score));
  return { hits, degraded };
}
