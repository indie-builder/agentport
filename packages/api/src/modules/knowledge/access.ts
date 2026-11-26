import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import type { PermissionId, ResourceAccessLevel } from '@agentport/shared';
import { authorizeResourceAccess, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { notFound, notFoundMessage } from './use-cases/shared.js';

async function authorizeBaseId(
  context: RequestContext,
  baseId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
  message: string,
) {
  const base = await repo.knowledge.getBase(context.db, baseId);
  if (!base) throw new AppError('NOT_FOUND', message);
  await authorizeResourceAccess(
    context,
    permissionId,
    {
      kind: 'knowledge_base',
      resourceId: base.id,
      ownerBusinessId: base.ownerBusinessId,
      level,
    },
    message,
  );
  return base;
}

export function authorizeBase(
  context: RequestContext,
  baseId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  return authorizeBaseId(context, baseId, permissionId, level, notFoundMessage('知识库'));
}

export async function authorizeDocument(
  context: RequestContext,
  documentId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const document = await repo.knowledge.getDocument(context.db, documentId);
  if (!document) notFound('文档');
  await authorizeBaseId(context, document.baseId, permissionId, level, notFoundMessage('文档'));
  return document;
}

export async function authorizeVersion(
  context: RequestContext,
  versionId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const version = await repo.knowledge.getVersion(context.db, versionId);
  const document = version
    ? await repo.knowledge.getDocument(context.db, version.documentId)
    : null;
  if (!version || !document) notFound('版本');
  await authorizeBaseId(context, document.baseId, permissionId, level, notFoundMessage('版本'));
  return { version, document };
}

export async function authorizeChunk(
  context: RequestContext,
  chunkId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const chunk = await repo.knowledge.getChunk(context.db, chunkId);
  if (!chunk) notFound('分块');
  await authorizeBaseId(context, chunk.baseId, permissionId, level, notFoundMessage('分块'));
  return chunk;
}

export async function authorizeFolder(
  context: RequestContext,
  folderId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const folder = await repo.knowledge.getFolder(context.db, folderId);
  if (!folder) notFound('文件夹');
  await authorizeBaseId(context, folder.baseId, permissionId, level, notFoundMessage('文件夹'));
  return folder;
}

export async function authorizeTag(
  context: RequestContext,
  tagId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const tag = await repo.knowledge.getTag(context.db, tagId);
  if (!tag) notFound('标签');
  await authorizeBaseId(context, tag.baseId, permissionId, level, notFoundMessage('标签'));
  return tag;
}

export async function authorizeSource(
  context: RequestContext,
  sourceId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const source = await repo.knowledge.getSource(context.db, sourceId);
  if (!source) notFound('来源');
  await authorizeBaseId(context, source.baseId, permissionId, level, notFoundMessage('来源'));
  return source;
}

export async function authorizeWikiPage(
  context: RequestContext,
  pageId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const page = await repo.knowledge.getWikiPage(context.db, pageId);
  if (!page) notFound('Wiki 页面');
  await authorizeBaseId(context, page.baseId, permissionId, level, notFoundMessage('Wiki 页面'));
  return page;
}

export async function authorizeJob(
  context: RequestContext,
  jobId: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const job = await repo.knowledge.getJob(context.db, jobId);
  if (!job) notFound('任务');
  if (job.baseId === null) {
    const platform = requireUser(context).grants.some(
      (grant) => grant.permissionId === permissionId && grant.scope === 'platform',
    );
    if (!platform) throw new AppError('NOT_FOUND', notFoundMessage('任务'));
    return job;
  }
  await authorizeBaseId(context, job.baseId, permissionId, level, notFoundMessage('任务'));
  return job;
}
