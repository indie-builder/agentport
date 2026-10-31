import { repo } from '@agentport/db';
import {
  ACCESS_SCOPES,
  accountCreateSchema,
  accountPasswordSchema,
  accountRolesSchema,
  accountStatusSchema,
  accountUpdateSchema,
  businessIdSchema,
  listQuerySchema,
  PERMISSIONS,
  roleMatrixInputSchema,
} from '@agentport/shared';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, isPgCode } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { requireTrustedOrigin } from './origin.js';

const accountParams = z.object({ businessId: businessIdSchema });

/** 唯一约束统一映射成 409；其余错误交给统一错误出口。 */
function rethrowConflict(error: unknown): never {
  if (isPgCode(error, '23505')) throw new AppError('CONFLICT', '业务 ID 或用户名已存在');
  if (isPgCode(error, '23503')) throw new AppError('INVALID_INPUT', 'roleIds 必须引用存在的角色');
  throw error;
}

export function registerAccountRoutes(app: FastifyInstance): void {
  const origin = requireTrustedOrigin(app);
  const readAccounts = {
    config: { access: { kind: 'permission' as const, permissionId: 'accounts.read' as const } },
  };
  const manageAccounts = {
    config: { access: { kind: 'permission' as const, permissionId: 'accounts.manage' as const } },
    preHandler: [origin],
  };
  const readRoles = {
    config: { access: { kind: 'permission' as const, permissionId: 'roles.read' as const } },
  };
  const manageRoles = {
    config: { access: { kind: 'permission' as const, permissionId: 'roles.manage' as const } },
    preHandler: [origin],
  };

  typed(app).get(
    '/api/accounts',
    { ...readAccounts, schema: { querystring: listQuerySchema } },
    async (request) =>
      repo.accounts.listAccounts(app.db, {
        limit: request.query.limit,
        offset: request.query.offset,
        ...(request.query.q === undefined ? {} : { q: request.query.q }),
      }),
  );

  typed(app).post(
    '/api/accounts',
    { ...manageAccounts, schema: { body: accountCreateSchema } },
    async (request, reply) => {
      const input = request.body;
      try {
        const account = await repo.accounts.createAccount(app.db, {
          businessId: input.businessId,
          username: input.username,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          restore: input.restore ?? false,
          ...(input.roleIds === undefined ? {} : { roleIds: input.roleIds }),
        });
        return reply.status(201).send(account);
      } catch (error) {
        rethrowConflict(error);
      }
    },
  );

  typed(app).patch(
    '/api/accounts/:businessId/status',
    {
      ...manageAccounts,
      schema: { params: accountParams, body: z.object({ status: accountStatusSchema }).strict() },
    },
    async (request, _reply) => {
      const account = await repo.accounts.setAccountStatus(
        app.db,
        request.params.businessId,
        request.body.status,
      );
      if (!account) throw new AppError('NOT_FOUND', '账户不存在');
      return account;
    },
  );

  typed(app).patch(
    '/api/accounts/:businessId',
    { ...manageAccounts, schema: { params: accountParams, body: accountUpdateSchema } },
    async (request, _reply) => {
      const account = await repo.accounts.updateAccount(app.db, request.params.businessId, {
        ...(request.body.username === undefined ? {} : { username: request.body.username }),
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
      });
      if (!account) throw new AppError('NOT_FOUND', '账户不存在');
      return account;
    },
  );

  typed(app).post(
    '/api/accounts/:businessId/password',
    { ...manageAccounts, schema: { params: accountParams, body: accountPasswordSchema } },
    async (request) => {
      const ok = await repo.accounts.resetPassword(
        app.db,
        request.params.businessId,
        await hashPassword(request.body.password),
      );
      if (!ok) throw new AppError('NOT_FOUND', '账户不存在');
      return { ok: true };
    },
  );

  typed(app).delete(
    '/api/accounts/:businessId',
    { ...manageAccounts, schema: { params: accountParams } },
    async (request) => {
      const ok = await repo.accounts.deleteAccount(app.db, request.params.businessId);
      if (!ok) throw new AppError('NOT_FOUND', '账户不存在');
      return { ok: true };
    },
  );

  typed(app).put(
    '/api/accounts/:businessId/roles',
    { ...manageRoles, schema: { params: accountParams, body: accountRolesSchema } },
    async (request) => {
      const { businessId } = request.params;
      if (!(await repo.accounts.hasBusinessHistory(app.db, businessId))) {
        throw new AppError('NOT_FOUND', '账户或历史业务身份不存在');
      }
      await repo.access.setUserRoles(app.db, businessId, request.body.roleIds);
      return { ok: true };
    },
  );

  typed(app).get('/api/roles', readRoles, async () => repo.access.getRoleMatrix(app.db));

  typed(app).get('/api/permissions', readRoles, async () => ({
    permissions: PERMISSIONS,
    scopes: ACCESS_SCOPES,
  }));

  typed(app).put(
    '/api/roles',
    { ...manageRoles, schema: { body: roleMatrixInputSchema } },
    async (request) => {
      const input = request.body;
      try {
        return await repo.access.replaceRoleMatrix(app.db, {
          expectedRevision: input.expectedRevision,
          roles: input.roles.map((role) => ({
            name: role.name,
            grants: role.grants,
            ...(role.id === undefined ? {} : { id: role.id }),
          })),
        });
      } catch (error) {
        rethrowConflict(error);
      }
    },
  );
}
