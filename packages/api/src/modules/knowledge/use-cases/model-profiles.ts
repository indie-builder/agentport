import {
  AppError,
  decryptSecrets,
  embedImages,
  embedTexts,
  encryptSecrets,
  KnowledgeModelError,
  rerankDocuments,
} from '@agentport/core';
import { repo } from '@agentport/db';
import { sql } from 'drizzle-orm';
import { isPgCode } from '../../../http/errors.js';
import { assertSafeUrl } from '../../servers/ssrf.js';
import { supportsImageVectors } from '../service.js';
import { type KnowledgeDeps, notFound } from './shared.js';

type ProfileRow = Awaited<ReturnType<typeof repo.knowledge.listModelProfiles>>[number];

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function toProfile(row: {
  id: string;
  kind: ProfileRow['kind'];
  name: string;
  endpointUrl: string;
  model: string;
  dimensions: number | null;
  embeddingProtocol: ProfileRow['embeddingProtocol'];
  imageInputEnabled: boolean;
  enabled: boolean;
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    endpointUrl: row.endpointUrl,
    model: row.model,
    dimensions: row.dimensions,
    embeddingProtocol: row.embeddingProtocol,
    imageInputEnabled: row.imageInputEnabled,
    enabled: row.enabled,
    hasSecret: row.hasSecret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertKnowledgeEndpoint(
  raw: string,
  config: { KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: string; NODE_ENV: string | undefined },
): Promise<void> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const key = url.port ? `${host}:${url.port}` : host;
  const allowed = config.KNOWLEDGE_PRIVATE_HOST_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.includes(key) || allowed.includes(host) || allowed.includes(url.origin)) return;
  await assertSafeUrl(raw, config.NODE_ENV);
}

function imageCapabilityProblem(input: {
  kind: 'embedding' | 'rerank' | 'asr';
  model: string;
  embeddingProtocol: 'openai' | 'cohere_v2';
  imageInputEnabled: boolean;
}): string | null {
  if (!input.imageInputEnabled) return null;
  if (input.kind === 'asr') return 'ASR profile 不支持图片输入';
  if (input.kind !== 'embedding') return '只有 embedding profile 可以开启图片输入';
  if (!supportsImageVectors(input)) {
    return '图片输入需要 embeddingProtocol=cohere_v2 且 model=embed-v4.0';
  }
  return null;
}

// ---- model profiles -------------------------------------------------------

export async function listModelProfiles(deps: KnowledgeDeps, view: 'selection' | undefined) {
  const rows = await repo.knowledge.listModelProfiles(deps.db);
  if (view !== 'selection') return rows.map(toProfile);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    supportsImageVectors: row.kind === 'embedding' && row.enabled && supportsImageVectors(row),
  }));
}

export async function createModelProfile(
  deps: KnowledgeDeps,
  input: {
    kind: 'embedding' | 'rerank' | 'asr';
    name: string;
    endpointUrl: string;
    model: string;
    embeddingProtocol: 'openai' | 'cohere_v2';
    imageInputEnabled: boolean;
    apiKey?: string | undefined;
    enabled: boolean;
  },
) {
  const capabilityProblem = imageCapabilityProblem(input);
  if (capabilityProblem !== null) throw new AppError('INVALID_INPUT', capabilityProblem);
  try {
    await assertKnowledgeEndpoint(input.endpointUrl, deps.config);
    const row = await repo.knowledge.createModelProfile(deps.db, {
      kind: input.kind,
      name: input.name,
      endpointUrl: input.endpointUrl,
      model: input.model,
      embeddingProtocol: input.embeddingProtocol,
      imageInputEnabled: input.imageInputEnabled,
      dimensions: input.kind === 'embedding' ? 1024 : null,
      secretsEncrypted: input.apiKey
        ? encryptSecrets({ apiKey: input.apiKey }, deps.config.APP_SECRET_KEY)
        : null,
      enabled: input.enabled,
    });
    return toProfile({ ...row, hasSecret: row.secretsEncrypted !== null });
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同类型下已有同名 profile');
    throw err;
  }
}

export async function updateModelProfile(
  deps: KnowledgeDeps,
  profileId: string,
  body: {
    name?: string | undefined;
    endpointUrl?: string | undefined;
    model?: string | undefined;
    embeddingProtocol?: 'openai' | 'cohere_v2' | undefined;
    imageInputEnabled?: boolean | undefined;
    apiKey?: string | null | undefined;
    enabled?: boolean | undefined;
  },
) {
  const { apiKey, ...rest } = body;
  if (rest.endpointUrl !== undefined) await assertKnowledgeEndpoint(rest.endpointUrl, deps.config);
  const current = await repo.knowledge.getModelProfileWithSecret(deps.db, profileId);
  if (!current) notFound('模型 profile');
  if (
    current.kind === 'asr' &&
    rest.embeddingProtocol !== undefined &&
    rest.embeddingProtocol !== 'openai'
  ) {
    throw new AppError('INVALID_INPUT', 'ASR profile 固定使用 openai 转录协议');
  }
  const next = {
    kind: current.kind,
    model: rest.model ?? current.model,
    embeddingProtocol: rest.embeddingProtocol ?? current.embeddingProtocol,
    imageInputEnabled: rest.imageInputEnabled ?? current.imageInputEnabled,
  };
  const capabilityProblem = imageCapabilityProblem(next);
  if (capabilityProblem !== null) throw new AppError('INVALID_INPUT', capabilityProblem);
  if (
    (rest.model !== undefined && rest.model !== current.model) ||
    (rest.embeddingProtocol !== undefined &&
      rest.embeddingProtocol !== current.embeddingProtocol) ||
    (rest.imageInputEnabled !== undefined && rest.imageInputEnabled !== current.imageInputEnabled)
  ) {
    const result = await deps.db.execute<{ referenced: boolean }>(sql`
      select exists(
        select 1 from knowledge_bases where embedding_profile_id = ${current.id}
        union all
        select 1 from knowledge_bases where asr_profile_id = ${current.id}
        union all
        select 1 from knowledge_document_versions where embedding_profile_id = ${current.id}
      ) as referenced
    `);
    if (result[0]?.referenced) {
      throw new AppError(
        'CONFLICT',
        '该 profile 已被知识库引用，不能原地更换模型、协议或图片能力；请新建 profile 后切换并重建',
      );
    }
  }
  const row = await repo.knowledge.updateModelProfile(deps.db, profileId, {
    ...rest,
    ...(apiKey === undefined
      ? {}
      : {
          secretsEncrypted:
            apiKey === null ? null : encryptSecrets({ apiKey }, deps.config.APP_SECRET_KEY),
        }),
  });
  if (!row) notFound('模型 profile');
  return toProfile({ ...row, hasSecret: row.secretsEncrypted !== null });
}

export async function deleteModelProfile(deps: KnowledgeDeps, profileId: string): Promise<void> {
  try {
    const result = await deps.db.execute(
      sql`delete from knowledge_model_profiles where id = ${profileId} returning id`,
    );
    if (result.length === 0) notFound('模型 profile');
  } catch (err) {
    if (isPgCode(err, '23001') || isPgCode(err, '23503')) {
      throw new AppError('CONFLICT', '该 profile 仍被知识库使用，请先切换或删除知识库');
    }
    throw err;
  }
}

export async function testModelProfile(
  deps: KnowledgeDeps,
  profileId: string,
): Promise<{ ok: true } | { ok: false; kind: KnowledgeModelError['kind'] }> {
  const row = await repo.knowledge.getModelProfileWithSecret(deps.db, profileId);
  if (!row) notFound('模型 profile');
  if (row.kind === 'asr') {
    throw new AppError('CONFLICT', 'ASR 请通过显式音频上传验证');
  }
  await assertKnowledgeEndpoint(row.endpointUrl, deps.config);
  const apiKey = row.secretsEncrypted
    ? decryptSecrets(row.secretsEncrypted, deps.config.APP_SECRET_KEY).apiKey
    : undefined;
  try {
    if (row.kind === 'embedding') {
      const embeddingProfile = {
        endpointUrl: row.endpointUrl,
        model: row.model,
        dimensions: 1024 as const,
        embeddingProtocol: row.embeddingProtocol,
        imageInputEnabled: row.imageInputEnabled,
        ...(apiKey ? { apiKey } : {}),
      };
      await embedTexts(embeddingProfile, ['ping'], undefined, 'search_query');
      if (row.imageInputEnabled) {
        await embedImages(embeddingProfile, [
          { mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 },
        ]);
      }
    } else {
      await rerankDocuments(
        { endpointUrl: row.endpointUrl, model: row.model, ...(apiKey ? { apiKey } : {}) },
        'ping',
        ['pong'],
      );
    }
    return { ok: true as const };
  } catch (err) {
    if (err instanceof KnowledgeModelError) return { ok: false as const, kind: err.kind };
    throw err;
  }
}
