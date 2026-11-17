import { fail } from '@agentport/core';
import type { DepartmentInput, DepartmentMembersInput } from '@agentport/shared';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { authUsers, departmentMembers, departments } from '../../schema.js';
import { hasBusinessHistory } from '../accounts.js';

export async function listDepartments(db: DbHandle) {
  const [rows, members] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.name)),
    db
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
      .orderBy(asc(departmentMembers.businessId)),
  ]);
  return rows.map((row) => ({
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
  }));
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
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    members: [],
  };
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
  const department = (await listDepartments(db)).find((department) => department.id === id);
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
  const department = (await listDepartments(db)).find((department) => department.id === id);
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
