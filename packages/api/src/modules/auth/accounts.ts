import { authContract } from '@agentport/contract/auth';
import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { ACCESS_SCOPES, PERMISSIONS } from '@agentport/shared';
import { implement } from '@orpc/server';
import { hashPassword } from 'better-auth/crypto';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';

function rethrowConflict(error: unknown): never {
  if (isPgCode(error, '23505')) throw new AppError('CONFLICT', '业务 ID 或用户名已存在');
  if (isPgCode(error, '23503')) throw new AppError('INVALID_INPUT', 'roleIds 必须引用存在的角色');
  throw error;
}

const os = implement(authContract).$context<RequestContext>();

export const accountRouter = {
  list: os.accounts.list.handler(({ input, context }) =>
    repo.accounts.listAccounts(context.db, {
      limit: input.query.limit,
      offset: input.query.offset,
      ...(input.query.q === undefined ? {} : { q: input.query.q }),
    }),
  ),
  create: os.accounts.create.handler(async ({ input: { body }, context }) => {
    try {
      return await repo.accounts.createAccount(context.db, {
        businessId: body.businessId,
        username: body.username,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        restore: body.restore ?? false,
        ...(body.roleIds === undefined ? {} : { roleIds: body.roleIds }),
      });
    } catch (error) {
      rethrowConflict(error);
    }
  }),
  status: os.accounts.status.handler(async ({ input, context }) => {
    const account = await repo.accounts.setAccountStatus(
      context.db,
      input.params.businessId,
      input.body.status,
    );
    if (!account) throw new AppError('NOT_FOUND', '账户不存在');
    return account;
  }),
  update: os.accounts.update.handler(async ({ input, context }) => {
    const account = await repo.accounts.updateAccount(context.db, input.params.businessId, {
      ...(input.body.username === undefined ? {} : { username: input.body.username }),
      ...(input.body.name === undefined ? {} : { name: input.body.name }),
    });
    if (!account) throw new AppError('NOT_FOUND', '账户不存在');
    return account;
  }),
  password: os.accounts.password.handler(async ({ input, context }) => {
    const ok = await repo.accounts.resetPassword(
      context.db,
      input.params.businessId,
      await hashPassword(input.body.password),
    );
    if (!ok) throw new AppError('NOT_FOUND', '账户不存在');
    return { ok: true };
  }),
  delete: os.accounts.delete.handler(async ({ input, context }) => {
    if (!(await repo.accounts.deleteAccount(context.db, input.params.businessId)))
      throw new AppError('NOT_FOUND', '账户不存在');
    return { ok: true };
  }),
  roles: os.accounts.roles.handler(async ({ input, context }) => {
    if (!(await repo.accounts.hasBusinessHistory(context.db, input.params.businessId)))
      throw new AppError('NOT_FOUND', '账户或历史业务身份不存在');
    await repo.access.setUserRoles(context.db, input.params.businessId, input.body.roleIds);
    return { ok: true };
  }),
};

export const roleRouter = {
  list: os.roles.list.handler(({ context }) => repo.access.getRoleMatrix(context.db)),
  replace: os.roles.replace.handler(async ({ input: { body }, context }) => {
    try {
      return await repo.access.replaceRoleMatrix(context.db, {
        expectedRevision: body.expectedRevision,
        roles: body.roles.map((role) => ({
          name: role.name,
          grants: role.grants,
          ...(role.id === undefined ? {} : { id: role.id }),
        })),
      });
    } catch (error) {
      rethrowConflict(error);
    }
  }),
};

export const permissions = os.permissions.handler(() => ({
  permissions: PERMISSIONS.map((permission) => ({
    ...permission,
    treePath: [...permission.treePath],
    scopes: [...permission.scopes],
  })),
  scopes: ACCESS_SCOPES.map((scope) => ({ ...scope })),
}));
