import { randomInt } from 'node:crypto';
import {
  AppError,
  decryptSecrets,
  embedTexts,
  rerankDocuments,
  segmentForSearch,
} from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type {
  KnowledgeFaq,
  KnowledgeFaqHit,
  KnowledgeImageRef,
  KnowledgeLocator,
  KnowledgeSearchDiagnostics,
  KnowledgeSearchDirectAnswer,
  KnowledgeSearchHit,
  KnowledgeSearchQuery,
  KnowledgeSearchResult,
  KnowledgeSearchScores,
  KnowledgeSearchWarning,
  KnowledgeTarget,
} from '@agentport/shared';
import { knowledgeImageChunkMetadataSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import { normalizeFaqQuestion } from './faq.js';

type Db = Database;

const PER_PATH = 50;
const RRF_K = 60;
const FUSED = 30;
const QUOTE_LIMIT = 1200;
const DEFAULT_MIN_VECTOR_SCORE = 0.3;

const ALL_KINDS = ['document', 'faq', 'wiki'] as const;
type SearchKind = (typeof ALL_KINDS)[number];

/** 新 wire 的三类可检索对象；query 里缺省时按全类型处理，兼容旧调用方。 */
type SearchQuery = Omit<
  KnowledgeSearchQuery,
  | 'kinds'
  | 'minVectorScore'
  | 'diagnostics'
  | 'onlyRecommended'
  | 'faqPriority'
  | 'faqDirectAnswerThreshold'
> & {
  kinds?: readonly SearchKind[];
  minVectorScore?: number;
  diagnostics?: boolean;
  // 未显式传入时用 false/false/0.9，便于内部调用与测试省略默认值。
  onlyRecommended?: boolean;
  faqPriority?: boolean;
  faqDirectAnswerThreshold?: number;
};

export type { KnowledgeSearchWarning };

export type SearchKnowledgeResult = KnowledgeSearchResult;

export interface SearchKnowledgeOptions {
  /** 解密 profile apiKey 用；与 worker 共用 APP_SECRET_KEY。 */
  secretKey: string;
  signal?: AbortSignal;
}

/** 一次检索的可见范围：库、过滤条件、图片开关与当前 embedding profile。 */
interface SearchScope {
  baseId: string;
  query: SearchQuery;
  imageProcessingEnabled: boolean;
  /** 只召回该 profile 生成的版本向量，避免换库后混空间。 */
  profileId: string;
}

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
  content_kind: string;
  locator: KnowledgeLocator | null;
  parent_ordinal: number | null;
  wiki_page_id: string | null;
  wiki_version_id: string | null;
  rank: number;
}

type FaqData = KnowledgeFaq;

interface Candidate {
  row: SearchRow;
  rrf: number;
  keyword: number | null;
  vector: number | null;
}

/** Wiki 可消费条件：页面可读，且索引版本追上线指针；别名由本文件固定传入。 */
function wikiReadableFilter(baseId: string): ReturnType<typeof sql> {
  return sql`exists (
    select 1 from knowledge_wiki_pages p
    where p.id = d.metadata ->> 'wikiPageId'
      and p.current_version_id = v.metadata ->> 'wikiVersionId'
      and ${repo.knowledge.readableWikiPageSql('p', baseId)}
  )`;
}

/** 文件夹/标签过滤；Wiki 索引文档不看自己的目录，改查其来源文档。 */
function folderTagFilter(alias: string, query: SearchQuery): ReturnType<typeof sql> {
  const a = sql.raw(alias);
  const folders =
    query.folders.length === 0
      ? sql``
      : sql`and ${a}.folder_id = any(array[${sql.join(
          query.folders.map((folder) => sql`${folder}`),
          sql`, `,
        )}]::text[])`;
  const tags =
    query.tags.length === 0
      ? sql``
      : sql`and (select count(distinct t.name) from knowledge_document_tags dt
          join knowledge_tags t on t.id = dt.tag_id
          where dt.document_id = ${a}.id and t.name = any(array[${sql.join(
            query.tags.map((tag) => sql`${tag}`),
            sql`, `,
          )}]::text[])) = ${query.tags.length}`;
  return sql`${folders} ${tags}`;
}

/** 契约 §4.6：旧版本、禁用 chunk、非 ready 文档都不召回；文件夹/标签是附加过滤。 */
function scopeFilter(scope: SearchScope) {
  const { baseId, query } = scope;
  const kinds = query.kinds ?? ALL_KINDS;
  const kindList = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const hasFilters = query.folders.length > 0 || query.tags.length > 0;
  // Wiki 默认不受文档目录/标签影响；带过滤时要求来源中至少一个文档满足。
  const wikiSourceFilters = hasFilters
    ? sql`and exists (
        select 1 from knowledge_wiki_sources wf
        join knowledge_documents df on df.id = wf.document_id
        where wf.page_id = d.metadata ->> 'wikiPageId'
          ${folderTagFilter('df', query)}
      )`
    : sql``;
  // 图片处理关闭时隐藏图片语义 chunk；普通正文不受影响。
  const images = scope.imageProcessingEnabled ? sql`` : sql`and c.metadata -> 'image' is null`;
  return sql`c.base_id = ${baseId}
    and c.enabled
    and d.current_version_id = c.version_id
    and ${repo.knowledge.readableDocumentSql('d')}
    and d.content_kind = any(array[${kindList}]::text[])
    and coalesce(c.index_role, 'leaf') = 'leaf'
    and (d.content_kind = 'wiki' or (1 = 1 ${folderTagFilter('d', query)}))
    and (d.content_kind <> 'wiki' or (${wikiReadableFilter(baseId)} ${wikiSourceFilters}))
    ${images}`;
}

const selectedColumns = sql`c.id as chunk_id, c.document_id, c.version_id, c.heading, c.content,
  c.page_from, c.page_to, c.metadata, c.locator, c.parent_ordinal,
  d.title, d.source_url, d.content_kind,
  d.metadata ->> 'wikiPageId' as wiki_page_id,
  v.metadata ->> 'wikiVersionId' as wiki_version_id`;

async function keywordSearch(db: Db, scope: SearchScope, segmented: string): Promise<SearchRow[]> {
  if (segmented.length === 0) return [];
  // plainto_tsquery 而不是手工拼 '&'：分词结果里可能带引号，拼串会被当成 tsquery 语法。
  const result = await db.execute<SearchRow>(sql`
    select ${selectedColumns},
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', ${segmented})) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    join knowledge_document_versions v on v.id = c.version_id
    where ${scopeFilter(scope)}
      and coalesce(c.metadata ->> 'imageRole', '') <> 'vector'
      and c.search_vector @@ plainto_tsquery('simple', ${segmented})
    order by rank desc, c.id
    limit ${PER_PATH}
  `);
  return result.rows;
}

/**
 * 文本向量路：只召回当前 profile 生成的版本，且排除图片 vector 子块。
 * 相似度门槛在融合前生效，关键词结果不受影响；ORDER BY 直接用距离保持 pgvector 索引。
 */
async function vectorSearch(
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
      and coalesce(c.metadata ->> 'imageRole', '') <> 'vector'
      and c.embedding is not null
      and 1 - (c.embedding <=> ${literal}::vector) >= ${minScore}
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

async function loadFaqData(db: Db, versionIds: string[]): Promise<Map<string, FaqData>> {
  if (versionIds.length === 0) return new Map();
  const result = await db.execute<{ id: string; faq: FaqData | null }>(sql`
    select id, faq from knowledge_document_versions
    where id = any(array[${sql.join(
      versionIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[])
  `);
  return new Map(
    result.rows.flatMap((row) => (row.faq === null ? [] : [[row.id, row.faq] as const])),
  );
}

/** 反例归一化复用 F 的 faq.ts，保证查询、入库判重与反例排除是同一套规则。 */
function negativeIndex(faq: Map<string, FaqData>): Map<string, Set<string>> {
  const negatives = new Map<string, Set<string>>();
  for (const [versionId, data] of faq) {
    negatives.set(
      versionId,
      new Set(data.negativeQuestions.map(normalizeFaqQuestion).filter((value) => value !== '')),
    );
  }
  return negatives;
}

/**
 * FAQ 反例只排除候选，不作为正向命中：查询与任一反例归一化相等时排除该 FAQ。
 * 反例不生成索引块，排除只依赖版本 negativeQuestions；onlyRecommended 只筛 FAQ，
 * 文档/Wiki 不受影响，缺省推荐标记按 true。
 */
function filterFaqCandidates(
  candidates: Candidate[],
  faq: Map<string, FaqData>,
  negatives: Map<string, Set<string>>,
  queryText: string,
  onlyRecommended: boolean,
): Candidate[] {
  if (faq.size === 0) return candidates;
  const queryKey = normalizeFaqQuestion(queryText);
  return candidates.filter(({ row }) => {
    if (row.content_kind !== 'faq') return true;
    const blocked = negatives.get(row.version_id);
    if (blocked && blocked.size > 0 && queryKey !== '' && blocked.has(queryKey)) return false;
    if (onlyRecommended && faq.get(row.version_id)?.isRecommended === false) return false;
    return true;
  });
}

/** 同一 FAQ 文档只保留最终排名最高的一条，避免标准问与相似问重复占位。 */
function dedupeFaqDocuments(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter(({ row }) => {
    if (row.content_kind !== 'faq') return true;
    if (seen.has(row.document_id)) return false;
    seen.add(row.document_id);
    return true;
  });
}

/** faqPriority 只把 FAQ 组提前，组内保持最终分数顺序；默认顺序不变。 */
function faqFirst(candidates: Candidate[]): Candidate[] {
  const faqs = candidates.filter(({ row }) => row.content_kind === 'faq');
  if (faqs.length === 0 || faqs.length === candidates.length) return candidates;
  return [...faqs, ...candidates.filter(({ row }) => row.content_kind !== 'faq')];
}

/**
 * 父上下文只由当前版本仍 enabled 的叶子块重建，不读父块存储正文：
 * 禁用/编辑/删除子块后父块旧内容不能通过命中泄漏；FAQ 的响应正文是完整答案。
 */
async function loadParents(db: Db, hits: SearchRow[]): Promise<Map<string, string>> {
  const wanted = hits.filter((row) => row.parent_ordinal !== null && row.content_kind !== 'faq');
  if (wanted.length === 0) return new Map();
  const versionIds = [...new Set(wanted.map((row) => row.version_id))];
  const ordinals = [...new Set(wanted.map((row) => row.parent_ordinal))];
  const result = await db.execute<{
    version_id: string;
    parent_ordinal: number;
    content: string;
  }>(sql`
    select c.version_id, c.parent_ordinal, c.content
    from knowledge_chunks c
    where c.version_id = any(array[${sql.join(
      versionIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[])
      and c.parent_ordinal = any(array[${sql.join(
        ordinals.map((ordinal) => sql`${ordinal}`),
        sql`, `,
      )}]::int[])
      and c.enabled
      and coalesce(c.index_role, 'leaf') = 'leaf'
    order by c.version_id, c.parent_ordinal, c.ordinal, c.id
  `);
  const contexts = new Map<string, string>();
  for (const row of result.rows) {
    const key = `${row.version_id}:${row.parent_ordinal}`;
    const current = contexts.get(key);
    contexts.set(key, current === undefined ? row.content : `${current}\n\n${row.content}`);
  }
  return contexts;
}

function targetOf(row: SearchRow): { target: KnowledgeTarget; targetVersionId: string } {
  if (row.content_kind === 'wiki') {
    return {
      target: { kind: 'wiki', id: row.wiki_page_id ?? row.document_id },
      targetVersionId: row.wiki_version_id ?? row.version_id,
    };
  }
  return {
    target: { kind: row.content_kind === 'faq' ? 'faq' : 'document', id: row.document_id },
    targetVersionId: row.version_id,
  };
}

type FaqAnswers = (versionId: string, data: FaqData) => string[];

function answerStrategyOf(data: FaqData): 'all' | 'random' {
  return data.answerStrategy === 'random' ? 'random' : 'all';
}

/** 随机策略每次 search 每条 FAQ 等概率选一项；all 永远按存储顺序返回完整答案。 */
function quoteOf(row: SearchRow, faq: Map<string, FaqData>, answersOf: FaqAnswers): string {
  const data = row.content_kind === 'faq' ? faq.get(row.version_id) : undefined;
  if (!data) return Array.from(row.content).slice(0, QUOTE_LIMIT).join('');
  const [firstAnswer] = answersOf(row.version_id, data);
  const body = firstAnswer ? `${data.question}\n\n${firstAnswer}` : data.question;
  const marker =
    answerStrategyOf(data) === 'all' && data.answers.length > 1
      ? `\n（共 ${data.answers.length} 个答案）`
      : '';
  // 按 code point 截断：UTF-16 slice 会把 emoji 代理对切成替换字符。
  return Array.from(`${body}${marker}`).slice(0, QUOTE_LIMIT).join('');
}

function faqInfoOf(
  row: SearchRow,
  faq: Map<string, FaqData>,
  answersOf: FaqAnswers,
): KnowledgeFaqHit | null {
  if (row.content_kind !== 'faq') return null;
  const data = faq.get(row.version_id);
  if (!data) return null;
  // 召回的是正问叶子块：questionKind/matchedQuestion 由入库写入，不再读旧 faqRole。
  return {
    answers: answersOf(row.version_id, data),
    answerStrategy: answerStrategyOf(data),
    isRecommended: data.isRecommended !== false,
    matchedQuestion:
      typeof row.metadata.matchedQuestion === 'string' ? row.metadata.matchedQuestion : row.content,
    questionKind: row.metadata.questionKind === 'similar' ? 'similar' : 'standard',
  };
}

/** 子块命中时给出同父上下文；FAQ 的响应正文与本次 answers 选择保持一致。 */
function parentContentOf(
  row: SearchRow,
  parents: Map<string, string>,
  faq: Map<string, FaqData>,
  answersOf: FaqAnswers,
): string | null {
  if (row.content_kind === 'faq') {
    const data = faq.get(row.version_id);
    return data ? answersOf(row.version_id, data).join('\n\n') : null;
  }
  if (row.parent_ordinal === null) return null;
  return parents.get(`${row.version_id}:${row.parent_ordinal}`) ?? null;
}

function hitOf(
  candidate: Candidate,
  parents: Map<string, string>,
  faq: Map<string, FaqData>,
  answersOf: FaqAnswers,
  rerankScore: number | null,
): KnowledgeSearchHit {
  const { row } = candidate;
  const { target, targetVersionId } = targetOf(row);
  const scores: KnowledgeSearchScores = {
    keyword: candidate.keyword,
    vector: candidate.vector,
    rrf: candidate.rrf,
    rerank: rerankScore,
  };
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    title: row.title,
    heading: row.heading,
    quote: quoteOf(row, faq, answersOf),
    pageFrom: row.page_from,
    pageTo: row.page_to,
    sourceUrl: row.source_url,
    score: rerankScore ?? candidate.rrf,
    scoreKind: rerankScore === null ? 'rrf' : 'rerank',
    image: imageOf(row.metadata),
    target,
    targetVersionId,
    locator: row.locator,
    parentContent: parentContentOf(row, parents, faq, answersOf),
    scores,
    faq: faqInfoOf(row, faq, answersOf),
  };
}

/**
 * directAnswer 只取最终返回 FAQ 的原始问题向量 cosine，绝不用 RRF/rerank 冒充；
 * 并列按 documentId，embedding 不可用时自然没有 cosine 因而返回 null。
 */
function selectDirectAnswer(
  hits: KnowledgeSearchHit[],
  threshold: number,
): KnowledgeSearchDirectAnswer | null {
  let best: {
    target: KnowledgeTarget;
    versionId: string;
    answers: string[];
    vectorScore: number;
  } | null = null;
  for (const hit of hits) {
    if (hit.target.kind !== 'faq' || !hit.faq) continue;
    const cosine = hit.scores.vector;
    if (cosine === null || cosine < threshold) continue;
    if (
      best === null ||
      cosine > best.vectorScore ||
      (cosine === best.vectorScore && hit.target.id < best.target.id)
    ) {
      best = {
        target: hit.target,
        versionId: hit.targetVersionId,
        answers: hit.faq.answers,
        vectorScore: cosine,
      };
    }
  }
  return best;
}

/** RRF：每路各取 top 50，融合后取前 30，再交给 rerank 决定最终顺序。 */
function fuse(paths: SearchRow[][]): Candidate[] {
  const merged = new Map<string, Candidate>();
  paths.forEach((rows, pathIndex) => {
    rows.forEach((row, index) => {
      const current = merged.get(row.chunk_id) ?? {
        row,
        rrf: 0,
        keyword: null,
        vector: null,
      };
      current.rrf += 1 / (RRF_K + index + 1);
      if (pathIndex === 0) current.keyword = Number(row.rank);
      else current.vector = Math.max(current.vector ?? Number.NEGATIVE_INFINITY, Number(row.rank));
      merged.set(row.chunk_id, current);
    });
  });
  return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, FUSED);
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

/** 已发布但索引尚未追上线指针的页面数；用于 MCP/管理的可见告警。 */
async function countPendingWikiIndex(db: Db, baseId: string): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
    from knowledge_wiki_pages p
    where p.base_id = ${baseId}
      and p.status = 'published'
      and not exists (
        select 1 from knowledge_documents d
        join knowledge_document_versions v on v.id = d.current_version_id
        where d.base_id = p.base_id
          and d.content_kind = 'wiki'
          and d.status = 'ready'
          and d.metadata ->> 'wikiPageId' = p.id
          and v.metadata ->> 'wikiVersionId' = p.current_version_id
      )
  `);
  return result.rows[0]?.count ?? 0;
}

/**
 * 关键词 + 向量双路召回，RRF 融合后按 base 的 rerank profile 重排。
 * embedding 路径任何一步失败都只降级为关键词结果，并带 warnings，不把整次检索变成错误。
 */
export async function searchKnowledge(
  db: Db,
  baseId: string,
  query: SearchQuery,
  options: SearchKnowledgeOptions,
): Promise<SearchKnowledgeResult> {
  const startedAt = Date.now();
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
  const kinds = query.kinds ?? ALL_KINDS;
  const warnings: KnowledgeSearchWarning[] = [];
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
        vector = await vectorSearch(
          db,
          scope,
          embedding,
          query.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE,
        );
        degraded = false;
        if (
          imageProcessing?.imageVectorEnabled === true &&
          imageProcessing.enabled &&
          supportsImageVectors(embeddingProfile)
        ) {
          // 图片向量是附加路：失败只丢这一路，不把已成功的文本向量标成 degraded。
          imageVector = await imageVectorSearch(
            db,
            scope,
            embedding,
            imageProcessing.imageVectorMinScore,
          ).catch(() => []);
        }
      }
    } catch {
      degraded = true;
    }
  }
  if (degraded) {
    warnings.push({
      code: 'embedding_unavailable',
      message: '向量检索不可用，结果仅来自关键词匹配',
    });
  }

  const fused = fuse([keyword, vector, imageVector]);
  const faq = await loadFaqData(db, [
    ...new Set(
      fused.filter(({ row }) => row.content_kind === 'faq').map(({ row }) => row.version_id),
    ),
  ]);
  // 反例/推荐过滤在融合之后、rerank 之前：既不进正向排名，也保持候选预算一致。
  const negatives = negativeIndex(faq);
  const candidates = filterFaqCandidates(
    fused,
    faq,
    negatives,
    query.q,
    query.onlyRecommended === true,
  );
  const selectedAnswers = new Map<string, string[]>();
  const answersOf: FaqAnswers = (versionId, data) => {
    const cached = selectedAnswers.get(versionId);
    if (cached) return cached;
    // 随机只影响本次展示，绝不写回版本；答案数为 1 时无需抽样。
    const picked = data.answers[randomInt(Math.max(data.answers.length, 1))];
    const chosen =
      answerStrategyOf(data) === 'random' && data.answers.length > 1 && picked !== undefined
        ? [picked]
        : data.answers;
    selectedAnswers.set(versionId, chosen);
    return chosen;
  };
  let ordered = candidates;
  let rerankScores: Map<string, number> | null = null;
  let rerankState: KnowledgeSearchDiagnostics['rerank'] = 'off';

  if (query.rerank && candidates.length > 0) {
    rerankState = 'unavailable';
    if (base.rerankProfileId && candidates.length > 0) {
      const rerankProfile = await repo.knowledge.getModelProfileWithSecret(
        db,
        base.rerankProfileId,
      );
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
            candidates.map(({ row }) => row.content),
            options.signal,
          );
          // 只有完整、索引合法的响应才替换顺序；任何失败都保留完整 RRF 列表。
          rerankScores = new Map(
            scores.map((entry) => [candidates[entry.index]!.row.chunk_id, entry.score]),
          );
          ordered = [...candidates].sort(
            (a, b) => rerankScores!.get(b.row.chunk_id)! - rerankScores!.get(a.row.chunk_id)!,
          );
          rerankState = 'applied';
        } catch {
          rerankScores = null;
          ordered = candidates;
          rerankState = 'unavailable';
        }
      }
    }
    if (rerankState === 'unavailable') {
      warnings.push({
        code: 'rerank_unavailable',
        message: '重排不可用，结果保留 RRF 融合顺序',
      });
    }
  }

  if (kinds.includes('wiki')) {
    const pending = await countPendingWikiIndex(db, baseId);
    if (pending > 0) {
      warnings.push({
        code: 'wiki_index_pending',
        message: `${pending} 个已发布 Wiki 页面的索引尚未追上线上版本，暂不参与检索`,
      });
    }
  }

  // 去重与 FAQ 优先都基于最终排名；同文档只保留 score 最高的一条。
  ordered = dedupeFaqDocuments(ordered);
  if (query.faqPriority === true) ordered = faqFirst(ordered);

  const limited = ordered.slice(0, query.limit);
  const parents = await loadParents(
    db,
    limited.map(({ row }) => row),
  );
  const hits = limited.map((candidate) =>
    hitOf(candidate, parents, faq, answersOf, rerankScores?.get(candidate.row.chunk_id) ?? null),
  );
  const directAnswer =
    query.faqPriority === true && !degraded
      ? selectDirectAnswer(hits, query.faqDirectAnswerThreshold ?? 0.9)
      : null;

  const result: SearchKnowledgeResult = { hits, degraded, warnings, directAnswer };
  if (query.diagnostics) {
    result.diagnostics = {
      paths: { keyword: keyword.length, vector: vector.length, imageVector: imageVector.length },
      fused: candidates.length,
      returned: hits.length,
      rerank: rerankState,
      elapsedMs: Date.now() - startedAt,
      candidates: ordered.map((candidate) => ({
        chunkId: candidate.row.chunk_id,
        scores: {
          keyword: candidate.keyword,
          vector: candidate.vector,
          rrf: candidate.rrf,
          rerank: rerankScores?.get(candidate.row.chunk_id) ?? null,
        },
      })),
    };
  }
  return result;
}
