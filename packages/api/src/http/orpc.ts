import { AsyncLocalStorage } from 'node:async_hooks';
import type { RouteMeta } from '@agentport/contract/access';
import { AppError } from '@agentport/core';
import { problemSchema } from '@agentport/shared';
import { ORPCError } from '@orpc/contract';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { type AnyRouter, traverseContractProcedures } from '@orpc/server';
import { requireTrustedOrigin } from '../modules/auth/origin.js';
import type { RequestContext } from './context.js';
import { errorProblem, toAppError } from './errors.js';
import { enforceAccess } from './middleware.js';

const requests = new AsyncLocalStorage<RequestContext>();

export function createOpenAPIHandler(router: AnyRouter) {
  traverseContractProcedures({ router, path: [] }, ({ contract, path }) => {
    if (contract['~orpc'].meta.access === undefined)
      throw new Error(`contract procedure ${path.join('.')} is missing access metadata`);
  });
  return new OpenAPIHandler<RequestContext>(router, {
    rootInterceptors: [({ context, next }) => requests.run(context, next)],
    clientInterceptors: [
      async ({ context, procedure, next }) => {
        const metadata: Partial<RouteMeta> = procedure['~orpc'].meta;
        const access = metadata.access;
        if (access === undefined) throw new Error('contract procedure is missing access metadata');
        context.route = procedure['~orpc'].route.path ?? 'orpc';
        try {
          if (metadata.rateLimit !== undefined)
            await context.limit(metadata.rateLimit, context.route ?? 'orpc');
          await enforceAccess(context, access);
          if (
            (access.kind === 'authenticated' || access.kind === 'permission') &&
            !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)
          ) {
            requireTrustedOrigin(context);
          }
          return await next();
        } catch (error) {
          if (error instanceof ORPCError) throw error;
          const body = errorProblem(context.requestId, error);
          if (body.status >= 500)
            context.log.error({ err: error, code: body.code }, 'unhandled error');
          else if (body.status !== 401)
            context.log.warn({ err: error, code: body.code }, 'request rejected');
          throw new ORPCError(body.code, {
            status: body.status,
            message: body.message,
            data: body,
            cause: error,
          });
        }
      },
    ],
    customErrorResponseBodyEncoder: (error) => {
      const parsed = problemSchema.safeParse(error.data);
      if (parsed.success) return error.data;
      const context = requests.getStore();
      if (context === undefined) throw new AppError('INTERNAL_ERROR', 'missing request context');
      const normalized = toAppError(error);
      if (normalized.status >= 500) context.log.error({ err: error }, 'unhandled transport error');
      return errorProblem(context.requestId, error);
    },
  });
}
