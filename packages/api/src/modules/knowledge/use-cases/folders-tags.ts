import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { isPgCode } from '../../../http/errors.js';
import { collectPages } from '../../../http/pagination.js';
import { type KnowledgeDeps, notFound } from './shared.js';

type BaseRow = NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>;
type FolderRow = NonNullable<
  Awaited<ReturnType<typeof repo.knowledge.listFolders>>
>['items'][number];

type TagRow = Awaited<ReturnType<typeof repo.knowledge.listTags>>[number];

function toFolder(row: FolderRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTag(row: TagRow) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function listFolders(deps: KnowledgeDeps, base: BaseRow) {
  const folders = await collectPages((options) =>
    repo.knowledge.listFolders(deps.db, base.id, options),
  );
  return folders.map(toFolder);
}

export async function createFolder(
  deps: KnowledgeDeps,
  base: BaseRow,
  body: { parentId: string | null; name: string },
) {
  const parent = body.parentId ? await repo.knowledge.getFolder(deps.db, body.parentId) : null;
  if (body.parentId && (!parent || parent.baseId !== base.id)) {
    throw new AppError('INVALID_INPUT', '父文件夹不存在或属于其他知识库');
  }
  if (body.name.includes('/')) throw new AppError('INVALID_INPUT', '文件夹名称不能包含 "/"');
  try {
    const row = await repo.knowledge.createFolder(deps.db, {
      baseId: base.id,
      parentId: parent?.id ?? null,
      name: body.name,
      path: parent ? `${parent.path}/${body.name}` : `/${body.name}`,
    });
    return toFolder(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同级下已有同名文件夹');
    throw err;
  }
}

export async function updateFolder(
  deps: KnowledgeDeps,
  folderId: string,
  body: { name?: string | undefined; parentId?: string | null | undefined },
) {
  const current = await repo.knowledge.getFolder(deps.db, folderId);
  if (!current) notFound('文件夹');
  if (body.name?.includes('/')) {
    throw new AppError('INVALID_INPUT', '文件夹名称不能包含 "/"');
  }
  try {
    const row = (await repo.knowledge.updateFolder(deps.db, current.id, body)) ?? current;
    return toFolder(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同级下已有同名文件夹');
    throw err;
  }
}

export async function deleteFolder(deps: KnowledgeDeps, folderId: string): Promise<void> {
  if (!(await repo.knowledge.deleteFolder(deps.db, folderId))) notFound('文件夹');
}

export async function listTags(deps: KnowledgeDeps, id: string) {
  const rows = await repo.knowledge.listTags(deps.db, id);
  return rows.map(toTag);
}

export async function createTag(deps: KnowledgeDeps, base: BaseRow, name: string) {
  const existing = await repo.knowledge.findTagByName(deps.db, base.id, name);
  if (existing) return toTag(existing);
  const row = await repo.knowledge.upsertTag(deps.db, base.id, name);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.tag.created',
    target: row.id,
    input: { baseId: row.baseId },
    status: 'ok',
    requestId: deps.requestId,
  });
  return toTag(row);
}

export async function renameTag(deps: KnowledgeDeps, tagId: string, name: string) {
  try {
    const row = await repo.knowledge.updateTag(deps.db, tagId, name);
    if (!row) notFound('标签');
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.tag.renamed',
      target: row.id,
      input: { name: row.name, baseId: row.baseId },
      status: 'ok',
      requestId: deps.requestId,
    });
    return toTag(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同名标签已存在');
    throw err;
  }
}

export async function deleteTag(deps: KnowledgeDeps, tag: TagRow): Promise<void> {
  if (!(await repo.knowledge.deleteTag(deps.db, tag.id))) notFound('标签');
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.tag.deleted',
    target: tag.id,
    input: { baseId: tag.baseId },
    status: 'ok',
    requestId: deps.requestId,
  });
}
