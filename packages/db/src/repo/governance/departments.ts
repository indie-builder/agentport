import { fail } from '@agentport/core';
import type { Department, DepartmentInput, DepartmentMembersInput } from '@agentport/shared';
import { and, asc, eq, getTableColumns, inArray, ne, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { authUsers, departmentMembers, departments } from '../../schema.js';
import { hasBusinessHistory } from '../accounts.js';
import { type CursorPage, keysetPage } from '../pagination.js';

type DepartmentRow = typeof departments.$inferSelect;

function departmentMembersFor(db: DbHandle, departmentIds: string[]) {
  if (departmentIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      departmentId: departmentMembers.departmentId,
      businessId: departmentMembers.businessId,
      isManager: departmentMembers.isManager,
      name: authUsers.name,
      userId: authUsers.id,
      disabled: authUsers.disabled,
    })
    .from(departmentMembers)
    .leftJoin(authUsers, eq(authUsers.businessId, departmentMembers.businessId))
    .where(inArray(departmentMembers.departmentId, departmentIds))
    .orderBy(asc(departmentMembers.businessId));
}

type DepartmentMemberRow = Awaited<ReturnType<typeof departmentMembersFor>>[number];

function toDepartment(row: DepartmentRow, members: DepartmentMemberRow[]): Department {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    members: members
      .filter((member) => member.departmentId === row.id)
      .map((member) => ({
        businessId: member.businessId,
        name: member.name ?? member.businessId,
        isManager: member.isManager,
        accountActive: member.userId !== null && member.disabled === false,
      })),
  };
}

export async function listDepartments(
  db: DbHandle,
  input: { cursor?: string | undefined; limit: number },
): Promise<CursorPage<Department> | null> {
  const page = await keysetPage(db, {
    table: departments,
    cursor: input.cursor,
    limit: input.limit,
    column: departments.name,
    direction: 'asc',
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'text',
    where: [],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          ...getTableColumns(departments),
          cursorValue: departments.name,
        })
        .from(departments)
        .where(where)
        .orderBy(asc(departments.name), asc(departments.id))
        .limit(limit),
  });
  if (!page) return null;
  const members = await departmentMembersFor(
    db,
    page.items.map((row) => row.id),
  );
  return {
    items: page.items.map(({ cursorValue, ...row }) => toDepartment(row, members)),
    nextCursor: page.nextCursor,
  };
}

export async function getDepartmentById(db: DbHandle, id: string): Promise<Department | null> {
  const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
  if (!row) return null;
  return toDepartment(row, await departmentMembersFor(db, [id]));
}

export async function createDepartment(db: Database, input: DepartmentInput) {
  const name = input.name.trim();
  if (!name || name.length > 128) fail('INVALID_INPUT', '部门名称须为 1 到 128 个字符');
  const [row] = await db
    .insert(departments)
    .values({ id: newId('department'), name })
    .onConflictDoNothing()
    .returning();
  if (!row) fail('CONFLICT', '部门名称已存在');
  return toDepartment(row, []);
}

export async function updateDepartment(db: Database, id: string, input: DepartmentInput) {
  const name = input.name.trim();
  if (!name || name.length > 128) fail('INVALID_INPUT', '部门名称须为 1 到 128 个字符');
  const [duplicate] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.name, name), ne(departments.id, id)))
    .limit(1);
  if (duplicate) fail('CONFLICT', '部门名称已存在');
  const [row] = await db
    .update(departments)
    .set({ name, updatedAt: new Date() })
    .where(eq(departments.id, id))
    .returning({ id: departments.id });
  if (!row) fail('NOT_FOUND', '部门不存在');
  const department = await getDepartmentById(db, id);
  if (!department) fail('NOT_FOUND', '部门不存在');
  return department;
}

export async function deleteDepartment(db: Database, id: string) {
  const rows = await db
    .delete(departments)
    .where(eq(departments.id, id))
    .returning({ id: departments.id });
  if (rows.length === 0) fail('NOT_FOUND', '部门不存在');
}

export async function setDepartmentMembers(
  db: Database,
  id: string,
  input: DepartmentMembersInput,
) {
  await db.transaction(async (tx) => {
    const [department] = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, id))
      .for('update');
    if (!department) fail('NOT_FOUND', '部门不存在');
    const ids = input.members.map((member) => member.businessId);
    if (new Set(ids).size !== ids.length) fail('INVALID_INPUT', '部门成员不能重复');
    const registered = await Promise.all(
      ids.map((businessId) => hasBusinessHistory(tx, businessId)),
    );
    if (registered.some((exists) => !exists)) fail('INVALID_INPUT', '成员必须是已登记的业务身份');
    await tx.delete(departmentMembers).where(eq(departmentMembers.departmentId, id));
    if (ids.length > 0) {
      await tx.delete(departmentMembers).where(inArray(departmentMembers.businessId, ids));
      await tx
        .insert(departmentMembers)
        .values(input.members.map((member) => ({ departmentId: id, ...member })));
    }
    await tx.update(departments).set({ updatedAt: new Date() }).where(eq(departments.id, id));
  });
  const department = await getDepartmentById(db, id);
  if (!department) fail('NOT_FOUND', '部门不存在');
  return department;
}

export async function getDepartmentIdForBusinessId(db: DbHandle, businessId: string) {
  const [row] = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(eq(departmentMembers.businessId, businessId))
    .limit(1);
  return row?.id ?? null;
}
