import { AppError } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { isPgCode } from '../../../http/errors.js';
import { type KnowledgeDeps, type PageQuery, notFound, pageOptions } from './shared.js';

type FolderRow = Awaited<ReturnType<typeof repo.knowledge.listFolders>>['items'][number];

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

// ---- folders / tags -------------------------------------------------------

export async function listFolders(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listFolders(deps.db, id, pageOptions(query));
  return page.items.map(toFolder);
}

export async function createFolder(
  deps: KnowledgeDeps,
  id: string,
  body: { parentId: string | null; name: string },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const parent = body.parentId ? await repo.knowledge.getFolder(deps.db, body.parentId) : null;
  if (body.parentId && (!parent || parent.baseId !== base.id)) {
    throw new AppError('INVALID_INPUT', '父文件夹不存在或属于其他知识库');
  }
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

export async function createTag(deps: KnowledgeDeps, id: string, name: string) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  // upsertTag 幂等：同名标签重复 POST 不算新建，直接返回原行，免得活动流里多一条假创建。
  const existing = await repo.knowledge.findTagByName(deps.db, id, name);
  if (existing) return toTag(existing);
  const row = await repo.knowledge.upsertTag(deps.db, id, name);
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

export async function deleteTag(deps: KnowledgeDeps, tagId: string): Promise<void> {
  // 删除后标签行随之消失，审计要留 baseId 归属，只能在删前读一次。
  const [tag] = await deps.db
    .select({ baseId: schema.knowledgeTags.baseId })
    .from(schema.knowledgeTags)
    .where(eq(schema.knowledgeTags.id, tagId));
  if (!tag) notFound('标签');
  if (!(await repo.knowledge.deleteTag(deps.db, tagId))) notFound('标签');
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.tag.deleted',
    target: tagId,
    input: { baseId: tag.baseId },
    status: 'ok',
    requestId: deps.requestId,
  });
}
