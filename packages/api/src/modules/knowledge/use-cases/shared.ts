import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AppError } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import type { Logger } from 'pino';
import type { Config } from '../../../config.js';
import { actorOf } from '../../../http/access.js';
import type { RequestContext } from '../../../http/context.js';
import { createJob, enqueueKnowledgeJob, type KnowledgeDocumentRow } from '../service.js';

export type KnowledgeDeps = {
  db: Database;
  config: Config;
  log: Logger;
  requestId: string;
  actor: string;
};

export function depsOf(context: RequestContext): KnowledgeDeps {
  return {
    db: context.db,
    config: context.config,
    log: context.log,
    requestId: context.requestId,
    actor: actorOf(context),
  };
}

export type PageQuery = { cursor?: string | undefined; limit?: number | undefined };

export type DocumentRow = KnowledgeDocumentRow;

export type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;

export type FullChunkRow = typeof schema.knowledgeChunks.$inferSelect;

export function assertBodyBytes(value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
  }
}

export function pageOptions(query: PageQuery): { cursor?: string; limit?: number } {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

export function notFound(what: string): never {
  throw new AppError('NOT_FOUND', `${what}不存在，可能已被删除；请刷新后重试`);
}

export function fileTitle(filename: string): string {
  const withoutExtension = basename(filename).replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
}

export async function collectChunks(db: Database, versionId: string): Promise<FullChunkRow[]> {
  const items: FullChunkRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await repo.knowledge.listChunks(db, versionId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
}

export async function copyVersionImages(
  sourceDir: string,
  targetDir: string,
  images: Array<{ name: string }>,
): Promise<void> {
  if (images.length === 0) return;
  await mkdir(targetDir, { recursive: true });
  for (const image of images) {
    try {
      await copyFile(join(sourceDir, image.name), join(targetDir, image.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('CONFLICT', `版本图片文件缺失：${image.name}`);
      }
      throw err;
    }
  }
}

export async function enqueue(
  deps: KnowledgeDeps,
  payload: KnowledgeJobPayload,
  refs: {
    baseId: string | null;
    documentId: string | null;
    sourceId?: string | null | undefined;
  },
) {
  const job = await createJob(deps.db, {
    baseId: refs.baseId,
    documentId: refs.documentId,
    ...(refs.sourceId === undefined ? {} : { sourceId: refs.sourceId }),
    payload,
  });
  await enqueueKnowledgeJob(job);
  return job;
}

export async function folderIssue(deps: KnowledgeDeps, baseId: string, folderId: string | null) {
  if (!folderId) return false;
  const folder = await repo.knowledge.getFolder(deps.db, folderId);
  return !folder || folder.baseId !== baseId;
}
