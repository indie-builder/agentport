import { authContract } from '@agentport/contract/auth';
import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import { APIError } from 'better-auth/api';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { accountRouter, permissions, roleRouter } from './accounts.js';
import { personalAuthRouter } from './personal.js';
import { clearAuthCookie, principalOf, readSession, revokeUserSessions } from './session.js';

const os = implement(authContract).$context<RequestContext>();

export const authRouter = os.router({
  me: os.me.handler(async ({ context }) => {
    const session = await readSession(context);
    if (session === null || session.user.disabled) return { authenticated: false };
    const principal = await principalOf(context, session.user);
    return {
      authenticated: true,
      user: {
        businessId: principal.businessId,
        username: principal.username,
        name: principal.name,
      },
      roles: principal.roles,
      grants: principal.grants,
    };
  }),
  changePassword: os.changePassword.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    try {
      await context.auth.api.changePassword({
        body: {
          currentPassword: input.body.currentPassword,
          newPassword: input.body.newPassword,
          revokeOtherSessions: false,
        },
        headers: context.request.headers,
      });
    } catch (error) {
      if (error instanceof APIError) {
        if (error.statusCode === 400) throw new AppError('UNAUTHORIZED', 'invalid credentials');
        if (error.statusCode === 401) throw new AppError('UNAUTHORIZED', 'not logged in');
      }
      throw error;
    }
    await revokeUserSessions(context, principal.authUserId);
    await clearAuthCookie(context);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'auth.password.changed',
      status: 'ok',
      requestId: context.requestId,
    });
    return { ok: true };
  }),
  ...personalAuthRouter,
  accounts: accountRouter,
  roles: roleRouter,
  permissions,
});
