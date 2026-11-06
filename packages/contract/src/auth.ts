import {
  ACCESS_SCOPES,
  accessScopeSchema,
  accountCreateSchema,
  accountPasswordSchema,
  accountRolesSchema,
  accountStatusSchema,
  accountUpdateSchema,
  businessIdSchema,
  changeOwnPasswordSchema,
  listQuerySchema,
  permissionGrantSchema,
  permissionIdSchema,
  personalProfileSchema,
  personalSessionListSchema,
  roleMatrixInputSchema,
  updatePersonalProfileInputSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const roleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  systemKey: z.enum(['admin', 'user', 'owner', 'maintainer']).nullable(),
});

export const accountSchema = z.object({
  businessId: z.string(),
  username: z.string(),
  name: z.string(),
  status: accountStatusSchema,
  roles: z.array(roleSummarySchema),
  createdAt: z.iso.datetime(),
});

export const roleMatrixSchema = z.object({
  revision: z.number().int(),
  roles: z.array(
    roleSummarySchema.extend({
      grants: z.array(permissionGrantSchema),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});

export const authMeSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: personalProfileSchema,
    roles: z.array(roleSummarySchema),
    grants: z.array(permissionGrantSchema),
  }),
]);

export const loginBodySchema = z.object({
  username: z
    .string({ error: '请输入用户名' })
    .min(1, '请输入用户名')
    .max(128, '用户名不能超过 128 个字符'),
  password: z
    .string({ error: '请输入密码' })
    .min(1, '请输入密码')
    .max(128, '密码不能超过 128 个字符'),
});

const accountParams = z.object({ businessId: businessIdSchema });
const sessionParams = z.object({ id: z.string().min(1).max(200) });
const okSchema = z.object({ ok: z.literal(true) });

export const authNativeContract = {
  login: contractProcedure
    .meta({ access: { kind: 'public', reason: 'login' }, rateLimit: 10 })
    .route({ method: 'POST', path: '/auth/login' })
    .input(z.object({ body: loginBodySchema }))
    .output(okSchema),
  logout: contractProcedure
    .meta({ access: { kind: 'public', reason: 'logout' } })
    .route({ method: 'POST', path: '/auth/logout' })
    .output(okSchema),
};
const readAccounts = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'accounts.read' },
});
const manageAccounts = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'accounts.manage' },
});
const readRoles = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'roles.read' },
});
const manageRoles = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'roles.manage' },
});

export const authContract = {
  me: contractProcedure
    .meta({ access: { kind: 'public', reason: 'auth status' } })
    .route({ method: 'GET', path: '/auth/me' })
    .output(authMeSchema),
  changePassword: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'POST', path: '/auth/change-password' })
    .input(z.object({ body: changeOwnPasswordSchema }))
    .output(okSchema),
  profile: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'PATCH', path: '/me/profile' })
    .input(z.object({ body: updatePersonalProfileInputSchema }))
    .output(personalProfileSchema),
  sessions: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'GET', path: '/me/sessions' })
    .output(personalSessionListSchema),
  revokeSession: contractProcedure
    .meta({ access: { kind: 'authenticated' } })
    .route({ method: 'DELETE', path: '/me/sessions/{id}', successStatus: 204 })
    .input(z.object({ params: sessionParams }))
    .output(z.void()),
  accounts: {
    list: readAccounts
      .route({ method: 'GET', path: '/accounts' })
      .input(z.object({ query: listQuerySchema }))
      .output(z.object({ items: z.array(accountSchema), total: z.number().int() })),
    create: manageAccounts
      .route({ method: 'POST', path: '/accounts', successStatus: 201 })
      .input(z.object({ body: accountCreateSchema }))
      .output(accountSchema),
    status: manageAccounts
      .route({ method: 'PATCH', path: '/accounts/{businessId}/status' })
      .input(
        z.object({
          params: accountParams,
          body: z.object({ status: accountStatusSchema }).strict(),
        }),
      )
      .output(accountSchema),
    update: manageAccounts
      .route({ method: 'PATCH', path: '/accounts/{businessId}' })
      .input(z.object({ params: accountParams, body: accountUpdateSchema }))
      .output(accountSchema),
    password: manageAccounts
      .route({ method: 'POST', path: '/accounts/{businessId}/password' })
      .input(z.object({ params: accountParams, body: accountPasswordSchema }))
      .output(okSchema),
    delete: manageAccounts
      .route({ method: 'DELETE', path: '/accounts/{businessId}' })
      .input(z.object({ params: accountParams }))
      .output(okSchema),
    roles: manageRoles
      .route({ method: 'PUT', path: '/accounts/{businessId}/roles' })
      .input(z.object({ params: accountParams, body: accountRolesSchema }))
      .output(okSchema),
  },
  roles: {
    list: readRoles.route({ method: 'GET', path: '/roles' }).output(roleMatrixSchema),
    replace: manageRoles
      .route({ method: 'PUT', path: '/roles' })
      .input(z.object({ body: roleMatrixInputSchema }))
      .output(roleMatrixSchema),
  },
  permissions: readRoles.route({ method: 'GET', path: '/permissions' }).output(
    z.object({
      permissions: z.array(
        z.object({
          id: permissionIdSchema,
          label: z.string(),
          treePath: z.array(z.string()),
          scopes: z.array(accessScopeSchema),
        }),
      ),
      scopes: z.array(
        z.object({ id: z.enum(ACCESS_SCOPES.map((scope) => scope.id)), label: z.string() }),
      ),
    }),
  ),
};
