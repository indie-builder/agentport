import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  exportKnowledgePackage,
  importKnowledgePackage,
  KNOWLEDGE_PACKAGE_MAX_BYTES,
} from '../package.js';
import { blobPathFor } from '../service.js';
import { type KnowledgeDeps, notFound } from './shared.js';

// ---- binary / native ------------------------------------------------------

export async function getVersionDetails(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) throw new AppError('NOT_FOUND', '版本不存在，可能已被删除');
  return {
    id: version.id,
    documentId: version.documentId,
    version: version.version,
    originalFilename: version.originalFilename,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    sourceRevision: version.sourceRevision,
    parseStatus: version.parseStatus,
    pageMap: version.pageMap as Array<Record<string, unknown>>,
    images: version.images,
    createdAt: version.createdAt.toISOString(),
  };
}

export async function getVersionContent(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) notFound('版本');
  const data = await readFile(blobPathFor(deps.config.KNOWLEDGE_DIR, version.blobSha256)).catch(
    () => null,
  );
  if (!data) notFound('原件');
  return { data, mimeType: version.mimeType, filename: version.originalFilename };
}

export async function getVersionMarkdown(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) notFound('版本');
  const [document, markdown] = await Promise.all([
    repo.knowledge.getDocument(deps.db, version.documentId),
    readFile(
      join(deps.config.KNOWLEDGE_DIR, 'docs', version.documentId, version.id, 'markdown.md'),
      'utf8',
    ).catch(() => null),
  ]);
  if (markdown === null) notFound('解析正文');
  return { markdown, status: document?.status ?? 'unknown' };
}

export async function getVersionImage(
  deps: KnowledgeDeps,
  versionId: string,
  name: string,
): Promise<{ data: Buffer; mimeType: string }> {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new AppError('INVALID_INPUT', '图片名不合法');
  }
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) throw new AppError('NOT_FOUND', '版本不存在，可能已被删除');
  const image = version.images.find((entry) => entry.name === name);
  if (!image) throw new AppError('NOT_FOUND', '图片不存在或不属于该版本');
  const data = await readFile(
    join(deps.config.KNOWLEDGE_DIR, 'docs', version.documentId, version.id, 'images', image.name),
  ).catch(() => null);
  if (!data) throw new AppError('NOT_FOUND', '图片文件缺失，请重新解析该版本');
  return {
    data,
    mimeType: /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(image.mimeType)
      ? image.mimeType
      : 'application/octet-stream',
  };
}

export async function exportPackage(deps: KnowledgeDeps, id: string) {
  const pkg = await exportKnowledgePackage(deps.db, deps.config.KNOWLEDGE_DIR, id);
  if (!pkg) notFound('知识库');
  return pkg;
}

export async function importPackage(deps: KnowledgeDeps, archive: Buffer) {
  if (archive.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
  }
  const result = await importKnowledgePackage(deps.db, deps.config.KNOWLEDGE_DIR, archive);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.imported',
    target: result.baseId,
    input: result.counts,
    status: 'ok',
    requestId: deps.requestId,
  });
  return result;
}
