import { copyFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AppError } from '@agentport/core';
import { type Database, repo, type schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import type { Logger } from 'pino';
import type { Config } from '../../../config.js';
import { actorOf, requireUser } from '../../../http/access.js';
import type { RequestContext } from '../../../http/context.js';
import { cursorOption, requireCursorPage } from '../../../http/pagination.js';
import {
  createJob,
  enqueueKnowledgeJobAfterCommit,
  type KnowledgeDocumentRow,
} from '../service.js';

export type KnowledgeDeps = {
  db: Database;
  config: Config;
  log: Logger;
  requestId: string;
  actor: string;
  businessId: string;
};

export function depsOf(context: RequestContext): KnowledgeDeps {
  return {
    db: context.db,
    config: context.config,
    log: context.log,
    requestId: context.requestId,
    actor: actorOf(context),
    businessId: requireUser(context).businessId,
  };
}

export type DocumentRow = KnowledgeDocumentRow;

export type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;

export type FullChunkRow = typeof schema.knowledgeChunks.$inferSelect;

export function assertBodyBytes(value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
  }
}

export function notFoundMessage(what: string): string {
  return `${what}不存在，可能已被删除；请刷新后重试`;
}

export function notFound(what: string): never {
  throw new AppError('NOT_FOUND', notFoundMessage(what));
}

export function fileTitle(filename: string): string {
  const withoutExtension = basename(filename).replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
}

export async function collectChunks(db: Database, versionId: string): Promise<FullChunkRow[]> {
  const items: FullChunkRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = requireCursorPage(
      await repo.knowledge.listChunks(db, versionId, {
        limit: 200,
        ...cursorOption(cursor),
      }),
    );
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
  await enqueueKnowledgeJobAfterCommit(deps.log, job);
  return job;
}

async function folderIssue(deps: KnowledgeDeps, baseId: string, folderId: string | null) {
  if (!folderId) return false;
  const folder = await repo.knowledge.getFolder(deps.db, folderId);
  return !folder || folder.baseId !== baseId;
}

const FOLDER_MISSING_MESSAGE = '文件夹不存在或属于其他知识库';

export async function assertFolderInBase(
  deps: KnowledgeDeps,
  baseId: string,
  folderId: string | null,
): Promise<void> {
  if (await folderIssue(deps, baseId, folderId)) {
    throw new AppError('INVALID_INPUT', FOLDER_MISSING_MESSAGE);
  }
}
