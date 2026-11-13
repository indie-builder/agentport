import { AppError, chunkBlocks, markdownBlocks } from '@agentport/core';
import { repo } from '@agentport/db';
import type { KnowledgeBaseSettings } from '@agentport/shared';
import { knowledgeBaseSettingsSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import { isPgCode } from '../../../http/errors.js';
import { ensureKnowledgeServer, supportsImageVectors } from '../service.js';
import { type KnowledgeDeps, type PageQuery, pageOptions, notFound } from './shared.js';

function toBase(row: Awaited<ReturnType<typeof repo.knowledge.createBase>>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    serverId: row.serverId,
    status: row.status,
    embeddingProfileId: row.embeddingProfileId,
    rerankProfileId: row.rerankProfileId,
    asrProfileId: row.asrProfileId,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function imageSettingsProblem(
  settings: KnowledgeBaseSettings,
  embedding: {
    embeddingProtocol: string;
    model: string;
    imageInputEnabled: boolean;
    enabled: boolean;
  } | null,
): Promise<string | null> {
  if (!embedding) return 'embedding profile 不存在，可能已被删除';
  if (!settings.imageProcessing.enabled) return null;
  if (
    !settings.imageProcessing.imageVectorEnabled ||
    (embedding.enabled && supportsImageVectors(embedding))
  )
    return null;
  return (
    '图片向量需要当前 embedding profile 为 cohere_v2 + embed-v4.0 且开启图片输入；' +
    '请先创建并切换到满足条件的 profile'
  );
}

// ---- bases ----------------------------------------------------------------

export async function listBases(deps: KnowledgeDeps, query: PageQuery) {
  const page = await repo.knowledge.listBases(deps.db, pageOptions(query));
  return { items: page.items.map(toBase), nextCursor: page.nextCursor };
}

/**
 * 置顶是个人偏好：没有用户主体时不报错，按「未置顶」返回；
 * 这不是管理变更，也不写审计。
 */
export async function listPins(deps: KnowledgeDeps) {
  if (deps.actor === '' || deps.actor === 'anonymous') return { baseIds: [] };
  return { baseIds: await repo.knowledge.listPinnedBaseIds(deps.db, deps.actor) };
}

export async function setPin(deps: KnowledgeDeps, baseId: string, pinned: boolean) {
  const base = await repo.knowledge.getBase(deps.db, baseId);
  if (!base) notFound('知识库');
  await repo.knowledge.setBasePin(deps.db, deps.actor, baseId, pinned);
  return { pinned };
}

export async function createBase(
  deps: KnowledgeDeps,
  input: {
    slug: string;
    name: string;
    description: string;
    embeddingProfileId: string;
    rerankProfileId: string | null;
    asrProfileId: string | null;
    /** 省略时按表默认 active；复制已有库时沿用源库状态。 */
    status?: 'active' | 'disabled' | undefined;
    settings: KnowledgeBaseSettings;
  },
) {
  const [embedding, rerank, asr] = await Promise.all([
    repo.knowledge.getModelProfileWithSecret(deps.db, input.embeddingProfileId),
    input.rerankProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, input.rerankProfileId)
      : null,
    input.asrProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, input.asrProfileId)
      : null,
  ]);
  if (embedding?.kind !== 'embedding' || !embedding.enabled) {
    throw new AppError('INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
  }
  if (input.rerankProfileId && (rerank?.kind !== 'rerank' || !rerank.enabled)) {
    throw new AppError('INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
  }
  if (input.asrProfileId && (asr?.kind !== 'asr' || !asr.enabled)) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
  }
  const settingsProblem = await imageSettingsProblem(input.settings, embedding);
  if (settingsProblem !== null) throw new AppError('CONFLICT', settingsProblem);
  try {
    const server = await ensureKnowledgeServer(deps.db, { slug: input.slug });
    const row = await repo.knowledge.createBase(deps.db, {
      slug: input.slug,
      name: input.name,
      description: input.description,
      serverId: server.id,
      embeddingProfileId: input.embeddingProfileId,
      rerankProfileId: input.rerankProfileId,
      asrProfileId: input.asrProfileId,
      status: input.status,
      settings: input.settings,
    });
    await ensureKnowledgeServer(deps.db, { slug: row.slug, id: row.id, serverId: server.id });
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.base.created',
      target: row.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: deps.requestId,
    });
    return toBase(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '该 slug 已被占用，请换一个');
    throw err;
  }
}

export async function getBase(deps: KnowledgeDeps, id: string) {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  return toBase(row);
}

type UpdateBaseBody = {
  name?: string | undefined;
  description?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  embeddingProfileId?: string | undefined;
  rerankProfileId?: string | null | undefined;
  asrProfileId?: string | null | undefined;
  settings?:
    | {
        chunkTokens?: number | undefined;
        chunkOverlap?: number | undefined;
        wikiAutoUpdate?: boolean | undefined;
        imageProcessing?: Partial<KnowledgeBaseSettings['imageProcessing']> | undefined;
      }
    | undefined;
};

function settingsChanged(current: KnowledgeBaseSettings, next: KnowledgeBaseSettings): boolean {
  if (
    current.chunkTokens !== next.chunkTokens ||
    current.chunkOverlap !== next.chunkOverlap ||
    current.wikiAutoUpdate !== next.wikiAutoUpdate
  ) {
    return true;
  }
  const keys = Object.keys(next.imageProcessing) as Array<
    keyof KnowledgeBaseSettings['imageProcessing']
  >;
  return keys.some((key) => current.imageProcessing[key] !== next.imageProcessing[key]);
}

/**
 * 审计只记被改动的字段名，不记值；空 patch 或提交了与原值相同的字段都不算变更，
 * 免得活动流里出现「更新知识库」却没有实际改动。
 */
function changedBaseFields(
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>,
  body: UpdateBaseBody,
  settings: KnowledgeBaseSettings,
): string[] {
  const fields: string[] = [];
  if (body.name !== undefined && body.name !== current.name) fields.push('name');
  if (body.description !== undefined && body.description !== current.description) {
    fields.push('description');
  }
  if (body.status !== undefined && body.status !== current.status) fields.push('status');
  if (
    body.embeddingProfileId !== undefined &&
    body.embeddingProfileId !== current.embeddingProfileId
  ) {
    fields.push('embeddingProfileId');
  }
  if (body.rerankProfileId !== undefined && body.rerankProfileId !== current.rerankProfileId) {
    fields.push('rerankProfileId');
  }
  if (body.asrProfileId !== undefined && body.asrProfileId !== current.asrProfileId) {
    fields.push('asrProfileId');
  }
  if (body.settings !== undefined && settingsChanged(current.settings, settings)) {
    fields.push('settings');
  }
  return fields;
}

export async function updateBase(deps: KnowledgeDeps, id: string, body: UpdateBaseBody) {
  const current = await repo.knowledge.getBase(deps.db, id);
  if (!current) notFound('知识库');
  const settingsPatch = body.settings;
  const merged = knowledgeBaseSettingsSchema.safeParse({
    chunkTokens: settingsPatch?.chunkTokens ?? current.settings.chunkTokens,
    chunkOverlap: settingsPatch?.chunkOverlap ?? current.settings.chunkOverlap,
    wikiAutoUpdate: settingsPatch?.wikiAutoUpdate ?? current.settings.wikiAutoUpdate,
    imageProcessing: {
      ...current.settings.imageProcessing,
      ...settingsPatch?.imageProcessing,
    },
  });
  if (!merged.success) {
    throw new AppError('INVALID_INPUT', merged.error.issues[0]?.message ?? '知识库设置不合法');
  }
  const settings: KnowledgeBaseSettings = merged.data;
  const nextEmbeddingProfileId = body.embeddingProfileId ?? current.embeddingProfileId;
  const nextRerankProfileId =
    body.rerankProfileId === undefined ? current.rerankProfileId : body.rerankProfileId;
  const nextAsrProfileId =
    body.asrProfileId === undefined ? current.asrProfileId : body.asrProfileId;
  const [embedding, rerank, asr] = await Promise.all([
    repo.knowledge.getModelProfileWithSecret(deps.db, nextEmbeddingProfileId),
    nextRerankProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, nextRerankProfileId)
      : null,
    nextAsrProfileId ? repo.knowledge.getModelProfileWithSecret(deps.db, nextAsrProfileId) : null,
  ]);
  if (nextEmbeddingProfileId !== current.embeddingProfileId) {
    if (embedding?.kind !== 'embedding' || !embedding.enabled) {
      throw new AppError('INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
    }
  } else if (!embedding) {
    throw new AppError('INVALID_INPUT', 'embedding profile 不存在，可能已被删除');
  }
  if (nextRerankProfileId !== current.rerankProfileId) {
    if (nextRerankProfileId && (rerank?.kind !== 'rerank' || !rerank.enabled)) {
      throw new AppError('INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
    }
  }
  if (nextAsrProfileId !== current.asrProfileId) {
    if (nextAsrProfileId && (asr?.kind !== 'asr' || !asr.enabled)) {
      throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
    }
  } else if (nextAsrProfileId && !asr) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在，可能已被删除');
  }
  const settingsProblem = await imageSettingsProblem(settings, embedding);
  if (settingsProblem !== null) throw new AppError('CONFLICT', settingsProblem);
  const { settings: _settings, ...rest } = body;
  const fields = changedBaseFields(current, body, settings);
  const row = await repo.knowledge.updateBase(deps.db, current.id, {
    ...rest,
    ...(settingsPatch === undefined ? {} : { settings }),
  });
  if (!row) notFound('知识库');
  if (fields.length > 0) {
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.base.updated',
      target: row.id,
      input: { fields },
      status: 'ok',
      requestId: deps.requestId,
    });
  }
  return toBase(row);
}

export async function deleteBase(deps: KnowledgeDeps, id: string): Promise<void> {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  const unbound = await deps.db.execute<{ agent_id: string }>(
    sql`select agent_id from agent_servers where server_id = ${row.serverId}`,
  );
  await repo.servers.deleteServer(deps.db, row.serverId);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.deleted',
    target: row.id,
    input: { unboundAgents: unbound.map((entry) => entry.agent_id) },
    status: 'ok',
    requestId: deps.requestId,
  });
}

export async function getBaseSummary(deps: KnowledgeDeps, id: string) {
  const summary = await repo.knowledge.getBaseSummary(deps.db, id);
  if (!summary) notFound('知识库');
  return {
    documents: summary.documents,
    faqs: summary.faqs,
    wikiPages: summary.wikiPages,
    sources: summary.sources,
    folders: summary.folders,
    tags: summary.tags,
    lastJob:
      summary.lastJob === null
        ? null
        : {
            id: summary.lastJob.id,
            type: summary.lastJob.type,
            status: summary.lastJob.status,
            createdAt: summary.lastJob.createdAt.toISOString(),
            updatedAt: summary.lastJob.updatedAt.toISOString(),
          },
  };
}

/**
 * 活动流只读：库不存在按对象不存在处理，其余口径由 repo 的单条 SQL 决定。
 * 与概览其它读数一致，时间统一转 ISO 字符串出 wire。
 */
export async function listBaseActivity(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listBaseActivity(deps.db, id, pageOptions(query));
  return {
    items: page.items.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actor: entry.actor,
      status: entry.status,
      targetKind: entry.targetKind,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

const CHUNK_PREVIEW_MAX_CHUNKS = 50;

/**
 * 分块预览：只按传入样本与当前/草稿分块参数算一次切分，不读写库内容、不入队、不调模型。
 * chunkTokens 是字符预算，与 worker 摄取时的口径一致。
 */
export async function previewChunks(
  deps: KnowledgeDeps,
  id: string,
  body: { sample: string; chunkTokens?: number | undefined; chunkOverlap?: number | undefined },
) {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  const chunkTokens = body.chunkTokens ?? row.settings.chunkTokens;
  const chunkOverlap = body.chunkOverlap ?? row.settings.chunkOverlap;
  if (chunkOverlap >= chunkTokens) {
    throw new AppError('INVALID_INPUT', '分块重叠必须小于分块长度');
  }
  const blocks = markdownBlocks(body.sample, (line, offset = 0, endOffset = offset) => ({
    page: 'unknown',
    line,
    startOffset: offset,
    endOffset,
  }));
  // 与摄取共用 chunkBlocks：clamp 超长块、表格/代码独立成块，预览块数才与真实分块一致。
  const chunks = chunkBlocks(blocks, body.sample, {
    chunkSize: chunkTokens,
    chunkOverlap,
  });
  const lengths = chunks.map((chunk) => chunk.content.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return {
    chunks: chunks.slice(0, CHUNK_PREVIEW_MAX_CHUNKS).map((chunk, index) => ({
      index,
      heading: chunk.heading,
      content: chunk.content,
      length: chunk.content.length,
    })),
    stats: {
      count: chunks.length,
      avgChars: lengths.length === 0 ? 0 : Math.round(total / lengths.length),
      minChars: lengths.length === 0 ? 0 : Math.min(...lengths),
      maxChars: lengths.length === 0 ? 0 : Math.max(...lengths),
    },
    truncated: chunks.length > CHUNK_PREVIEW_MAX_CHUNKS,
  };
}

const DUPLICATE_NAME_MAX = 120;

const DUPLICATE_SLUG_MAX = 64;

const DUPLICATE_SLUG_SUFFIX = '-copy';

/** slug 上限 64：截断源 slug 让后缀完整保留；末尾字符仍是源 slug 的合法字符。 */
function slugWithSuffix(sourceSlug: string, suffix: string): string {
  return `${sourceSlug.slice(0, DUPLICATE_SLUG_MAX - suffix.length)}${suffix}`;
}

/**
 * 副本 slug：先试 `-copy`，被占用就依次试 `-2`、`-3`……直到找到空位。
 * 每个候选都查唯一索引，命中数量受库里已有副本数限制，不会无限循环；
 * 真正的并发抢占仍由 knowledge_bases_slug_idx 与 createBase 的冲突映射兜底。
 */
async function availableCopySlug(deps: KnowledgeDeps, sourceSlug: string): Promise<string> {
  const preferred = slugWithSuffix(sourceSlug, DUPLICATE_SLUG_SUFFIX);
  if (!(await repo.knowledge.baseSlugExists(deps.db, preferred))) return preferred;
  for (let index = 2; ; index += 1) {
    const candidate = slugWithSuffix(sourceSlug, `-${index}`);
    if (!(await repo.knowledge.baseSlugExists(deps.db, candidate))) return candidate;
  }
}

/**
 * 复制知识库只派生配置，不搬内容：profiles / settings / status / description 沿用源库，
 * 文档、FAQ、Wiki、来源、文件夹、标签都留在源库。创建路径仍走 createBase，不另写一套。
 */
export async function duplicateBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    name?: string | undefined;
    slug?: string | undefined;
    description?: string | undefined;
  },
) {
  const source = await repo.knowledge.getBase(deps.db, id);
  if (!source) notFound('知识库');
  const row = await createBase(deps, {
    slug: body.slug ?? (await availableCopySlug(deps, source.slug)),
    name: body.name ?? `${source.name.slice(0, DUPLICATE_NAME_MAX - 3)} 副本`,
    description: body.description ?? source.description,
    embeddingProfileId: source.embeddingProfileId,
    rerankProfileId: source.rerankProfileId,
    asrProfileId: source.asrProfileId,
    status: source.status,
    settings: source.settings,
  });
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.duplicated',
    target: row.id,
    input: { sourceId: source.id, slug: row.slug },
    status: 'ok',
    requestId: deps.requestId,
  });
  return row;
}
