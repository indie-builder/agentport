import { authNativeContract, loginBodySchema } from '@agentport/contract/auth';
import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { ensureBootstrap } from './bootstrap.js';
import { requireTrustedOrigin } from './origin.js';
import {
  forwardSetCookie,
  issuedCookie,
  normalizeSession,
  revokeUserSessions,
  sessionFromCookie,
} from './session.js';

export function registerAuthRoutes(app: Hono<HttpEnv>, runtime: AppContext): void {
  const loginAccess = authNativeContract.login['~orpc'].meta.access;
  const logoutAccess = authNativeContract.logout['~orpc'].meta.access;
  if (loginAccess === undefined || logoutAccess === undefined) {
    throw new Error('native auth contract is missing access metadata');
  }
  let bootstrapReady: Promise<void> | undefined;
  function ensureBootstrapReady(): Promise<void> {
    bootstrapReady ??= ensureBootstrap(runtime.db, runtime.config).catch((error) => {
      bootstrapReady = undefined;
      throw error;
    });
    return bootstrapReady;
  }

  app.post(
    '/api/auth/login',
    bodyLimit({
      maxSize: 1_048_576,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
      },
    }),
    access(loginAccess),
    async (c) => {
      const context = c.get('context');
      const rateLimit = authNativeContract.login['~orpc'].meta.rateLimit;
      if (rateLimit !== undefined) await context.limit(rateLimit, 'auth.login');
      requireTrustedOrigin(context);
      if (
        !context.request.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .match(/^application\/(?:[\w.+-]+\+)?json$/i)
      ) {
        throw new AppError(
          'UNSUPPORTED_MEDIA_TYPE',
          '不支持的 Content-Type，请使用 application/json',
        );
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch (error) {
        throw new AppError('INVALID_INPUT', '请求体不是合法 JSON', { cause: error });
      }
      const { username, password } = loginBodySchema.parse(body);
      await ensureBootstrapReady();
      const signIn = () =>
        context.auth.api.signInUsername({
          body: { username, password },
          headers: context.request.headers,
          asResponse: true,
        });
      let result = await signIn();
      let session = result.ok
        ? await sessionFromCookie(context.auth, issuedCookie(result.headers))
        : null;
      if (result.ok && session === null) {
        context.log.warn({ username }, 'login session missing after sign-in, retrying once');
        result = await signIn();
        if (result.ok)
          session = await sessionFromCookie(context.auth, issuedCookie(result.headers));
      }
      if (!result.ok) {
        context.log.warn({ username }, 'login failed');
        await repo.audit.writeAudit(context.db, context.log, {
          actor: 'anonymous',
          action: 'auth.login.failed',
          input: { username },
          status: 'denied',
          requestId: context.requestId,
        });
        if (result.status >= 400 && result.status < 500)
          throw new AppError('UNAUTHORIZED', 'invalid credentials');
        throw new Error(`better-auth sign-in failed with status ${result.status}`);
      }
      if (session === null) throw new Error('better-auth sign-in did not persist a session');
      if (session.user.disabled) {
        await revokeUserSessions(context, session.user.id);
        await repo.audit.writeAudit(context.db, context.log, {
          actor: 'anonymous',
          action: 'auth.login.failed',
          input: { username },
          status: 'denied',
          requestId: context.requestId,
        });
        throw new AppError('UNAUTHORIZED', 'account disabled');
      }
      forwardSetCookie(result.headers, context);
      await repo.audit.writeAudit(context.db, context.log, {
        actor: session.user.businessId,
        action: 'auth.login.succeeded',
        status: 'ok',
        requestId: context.requestId,
      });
      return c.json({ ok: true });
    },
  );

  app.post('/api/auth/logout', access(logoutAccess), async (c) => {
    const context = c.get('context');
    requireTrustedOrigin(context);
    const headers = context.request.headers;
    const session = normalizeSession(await context.auth.api.getSession({ headers }));
    const result = await context.auth.api.signOut({ headers, asResponse: true });
    if (!result.ok) throw new Error(`better-auth sign-out failed with status ${result.status}`);
    if (await context.auth.api.getSession({ headers }))
      throw new Error('better-auth session revocation failed');
    forwardSetCookie(result.headers, context);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: session?.user.businessId ?? 'anonymous',
      action: 'auth.logout',
      status: 'ok',
      requestId: context.requestId,
    });
    return c.json({ ok: true });
  });
}
