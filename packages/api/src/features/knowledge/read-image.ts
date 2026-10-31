import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import {
  type KnowledgeReadImageInput,
  type KnowledgeReadImageResult,
  knowledgeImageChunkMetadataSchema,
} from '@agentport/shared';
import type { KnowledgeServerInput } from './mcp.js';

/** SDK 原生视觉输入只接受这四种 MIME；其他格式提示走 description。 */
const VISUAL_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const QUOTE_LIMIT = 1200;

export class KnowledgeReadImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeReadImageError';
  }
}

/**
 * MCP `knowledge_read_image`：chunk → 当前版本图片清单的授权读取。
 * 不接受任意 name/path/URL；禁用库/文档、非当前版本、来源撤权都即时失效。
 */
export async function readKnowledgeImage(
  input: KnowledgeServerInput,
  args: KnowledgeReadImageInput,
): Promise<{
  result: KnowledgeReadImageResult;
  image?: { mimeType: string; data: string };
}> {
  const base = await repo.knowledge.getBase(input.db, input.baseId);
  if (base?.status !== 'active') {
    throw new KnowledgeReadImageError('BASE_DISABLED', '知识库已禁用');
  }
  if (base.settings.imageProcessing?.enabled !== true) {
    throw new KnowledgeReadImageError('IMAGE_PROCESSING_DISABLED', '该知识库未启用图片处理');
  }
  const chunk = await repo.knowledge.getChunk(input.db, args.chunkId);
  const metadata = chunk ? knowledgeImageChunkMetadataSchema.safeParse(chunk.metadata) : null;
  if (
    !chunk ||
    chunk.baseId !== input.baseId ||
    !chunk.enabled ||
    chunk.kind !== 'image' ||
    !metadata?.success
  ) {
    throw new KnowledgeReadImageError('CHUNK_NOT_FOUND', '图片分块不存在或不可读');
  }
  // 与 read/list 共用同一来源授权判定；Wiki 内部索引文档不能绕过 target 直接读图。
  const document = await repo.knowledge.getReadableDocument(
    input.db,
    input.baseId,
    chunk.documentId,
  );
  if (
    !document ||
    document.currentVersionId !== chunk.versionId ||
    document.contentKind === 'wiki'
  ) {
    throw new KnowledgeReadImageError('DOCUMENT_NOT_READY', '文档未就绪或该分块不属于当前可读版本');
  }
  const version = await repo.knowledge.getVersion(input.db, chunk.versionId);
  const image = version?.images.find((entry) => entry.name === metadata.data.image.name);
  if (!version || !image) {
    throw new KnowledgeReadImageError('IMAGE_NOT_FOUND', '图片不在当前版本图片清单中');
  }

  const target = {
    kind: document.contentKind === 'faq' ? ('faq' as const) : ('document' as const),
    id: document.id,
  };
  const result: KnowledgeReadImageResult = {
    hit: {
      chunkId: chunk.id,
      documentId: document.id,
      versionId: version.id,
      target,
      targetVersionId: version.id,
      title: document.title,
      heading: chunk.heading,
      quote: Array.from(chunk.content).slice(0, QUOTE_LIMIT).join(''),
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
      locator: chunk.locator,
      parentContent: null,
      sourceUrl: document.sourceUrl,
      // 直接读图不经过检索排序，不给它编一个相关性分数。
      score: 0,
      scoreKind: 'rrf',
      scores: { keyword: null, vector: null, rrf: 0, rerank: null },
      image: { name: image.name, mimeType: image.mimeType, page: image.page },
      faq: null,
    },
    description: chunk.content,
  };
  if (args.format === 'description') return { result };

  if (!VISUAL_MIMES.has(image.mimeType)) {
    throw new KnowledgeReadImageError(
      'UNSUPPORTED_MEDIA_TYPE',
      `图片格式 ${image.mimeType} 不能直接供视觉模型读取，请使用 format=description`,
    );
  }
  const data = await readFile(
    join(input.knowledgeDir, 'docs', document.id, version.id, 'images', image.name),
  ).catch(() => null);
  if (!data) throw new KnowledgeReadImageError('IMAGE_NOT_FOUND', '图片文件缺失，请重新解析该版本');
  if (data.length > IMAGE_LIMIT_BYTES) {
    throw new KnowledgeReadImageError(
      'PAYLOAD_TOO_LARGE',
      `图片超过 5MiB，不能直接供视觉模型读取，请使用 format=description`,
    );
  }
  return { result, image: { mimeType: image.mimeType, data: data.toString('base64') } };
}
