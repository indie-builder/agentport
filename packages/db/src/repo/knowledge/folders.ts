import { AppError } from '@agentport/core';
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeFolders } from '../../schema.js';
import { paginate } from '../keyset.js';
import { type KnowledgeFolderRow, type Page, type PageOptions, pageLimit } from './shared.js';

// ---------------------------------------------------------------------------
// 文件夹 / 标签

export async function createFolder(
  db: Database,
  input: { baseId: string; parentId: string | null; name: string; path: string },
): Promise<KnowledgeFolderRow> {
  const [row] = await db
    .insert(knowledgeFolders)
    .values({ id: newId('knowledgeFolder'), ...input })
    .returning();
  if (!row) throw new Error('knowledge folder insert returned no row');
  return row;
}

export async function listFolders(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeFolderRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeFolders.baseId, baseId)];
  if (options.cursor) filters.push(gt(knowledgeFolders.id, options.cursor));
  const rows = await db
    .select()
    .from(knowledgeFolders)
    .where(and(...filters))
    .orderBy(asc(knowledgeFolders.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

export async function getFolder(db: DbHandle, id: string): Promise<KnowledgeFolderRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeFolders)
    .where(eq(knowledgeFolders.id, id))
    .limit(1);
  return row ?? null;
}

/** LIKE 默认转义符是反斜杠；路径里的 % _ \ 必须转义后才能当字面前缀匹配。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** 改名或移动后整棵子树的物化路径一起重写；路径唯一冲突交给 409。 */
async function rewriteFolderPath(
  tx: Transaction,
  folder: KnowledgeFolderRow,
  nextParentId: string | null,
  nextName: string,
): Promise<KnowledgeFolderRow> {
  let nextPath = `/${nextName}`;
  if (nextParentId) {
    const parent = await getFolder(tx, nextParentId);
    if (!parent) throw new AppError('NOT_FOUND', '父文件夹不存在');
    if (parent.baseId !== folder.baseId)
      throw new AppError('INVALID_INPUT', '父文件夹属于其他知识库');
    if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
      throw new AppError('INVALID_INPUT', '不能移动到自身或子孙文件夹下');
    }
    nextPath = `${parent.path}/${nextName}`;
  }
  const [row] = await tx
    .update(knowledgeFolders)
    .set({ parentId: nextParentId, name: nextName, path: nextPath })
    .where(eq(knowledgeFolders.id, folder.id))
    .returning();
  if (!row) throw new Error('knowledge folder update returned no row');
  // JS length 按 UTF-16 计数，emoji 会多算一位；字符偏移交给 PG char_length。
  await tx.execute(sql`
    update ${knowledgeFolders}
    set path = ${nextPath} || substr(path, char_length(${folder.path}::text) + 1)
    where base_id = ${folder.baseId} and path like ${`${escapeLike(folder.path)}/%`}
  `);
  return row;
}

/** 改名与移动合并为一次事务：只写最终 path，冲突时整棵子树都不会留下中间状态。 */
export async function updateFolder(
  db: Database,
  id: string,
  patch: { parentId?: string | null | undefined; name?: string | undefined },
): Promise<KnowledgeFolderRow | null> {
  return db.transaction(async (tx) => {
    const folder = await getFolder(tx, id);
    if (!folder) return null;
    return rewriteFolderPath(
      tx,
      folder,
      patch.parentId === undefined ? folder.parentId : patch.parentId,
      patch.name ?? folder.name,
    );
  });
}

export async function deleteFolder(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeFolders)
    .where(eq(knowledgeFolders.id, id))
    .returning({ id: knowledgeFolders.id });
  return rows.length > 0;
}
