import { fail } from '@agentport/core';
import * as repo from '@agentport/db/repo/agents.js';
import { grantDependencies, type PermissionId } from '@agentport/shared';
import { authorize } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
export async function authorizeAgent(
  context: RequestContext,
  row: repo.AgentRow,
  permissionIds: PermissionId | PermissionId[],
): Promise<void> {
  const ids = Array.isArray(permissionIds) ? permissionIds : [permissionIds];
  for (const permissionId of ids) {
    await authorize(context, permissionId, {
      agentId: row.id,
      createdBy: row.createdBy,
    });
    for (const dependency of grantDependencies(permissionId)) {
      await authorize(context, dependency, {
        agentId: row.id,
        createdBy: row.createdBy,
      });
    }
  }
}
export async function authorizedAgent(
  context: RequestContext,
  id: string,
  permissionIds: PermissionId | PermissionId[],
): Promise<repo.AgentRow> {
  const row = await repo.getAgent(context.db, id);
  if (!row) return fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请返回列表刷新后重试');
  await authorizeAgent(context, row, permissionIds);
  return row;
}
