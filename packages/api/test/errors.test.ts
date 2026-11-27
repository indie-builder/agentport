import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { contractProcedure } from '@agentport/contract/base';
import { AppError, fail } from '@agentport/core';
import { problemSchema } from '@agentport/shared';
import { implement } from '@orpc/server';
import { SQL } from 'bun';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { RequestContext } from '../src/http/context.js';
import { errorProblem, isPgCode, toAppError } from '../src/http/errors.js';
import { createOpenAPIHandler } from '../src/http/orpc.js';
import { expectProblem, loginCookie, request, startApp, type TestApp } from './helpers.js';

describe('problem responses', () => {
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('unknown route produces a complete Problem', async () => {
    const res = await request(app, { method: 'GET', url: '/api/definitely-not-a-route' });
    const body = expectProblem(res, 'NOT_FOUND');
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('returns 401 Problem when unauthenticated', async () => {
    const res = await request(app, { method: 'GET', url: '/api/agents' });
    expect(expectProblem(res, 'UNAUTHORIZED').retryable).toBe(false);
  });

  it('validates querystring after authentication', async () => {
    const urls = [
      '/api/runs?limit=0',
      '/api/runs?limit=201',
      '/api/runs?limit=abc',
      '/api/runs?status=nope',
      '/api/conversations?limit=999',
      '/api/overview?days=0',
    ];
    for (const url of urls) {
      const anonymous = await request(app, { method: 'GET', url });
      expectProblem(anonymous, 'UNAUTHORIZED');
      const res = await request(app, { method: 'GET', url, headers: { cookie } });
      expect(typeof expectProblem(res, 'INVALID_INPUT').path, url).toBe('string');
    }

    const ok = await request(app, { method: 'GET', url: '/api/runs?limit=5' });
    expect(ok.statusCode).toBe(401);
  });

  it('renders zod default validation messages in Chinese', async () => {
    const res = await request(app, {
      method: 'GET',
      url: '/api/runs?limit=abc',
      headers: { cookie },
    });
    const body = expectProblem(res, 'INVALID_INPUT');
    expect(body.message).toMatch(/[一-鿿]/);
  });
});

describe('AppError contract', () => {
  it('never leaks internal details on a real 500', async () => {
    const broken = await startApp({ DATABASE_URL: 'postgres://u:hunter2@127.0.0.1:1/nope' });
    try {
      const res = await request(broken, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'irrelevant-password' },
      });
      const body = expectProblem(res, 'INTERNAL_ERROR');
      expect(body).toMatchObject({ message: 'Internal server error', retryable: false });
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('127.0.0.1:1');
    } finally {
      await broken.close();
    }
  });

  it('keeps 4xx messages specific and retryable flags honest', () => {
    const conflict = new AppError('CONFLICT', 'server name already exists');
    expect(conflict.status).toBe(409);
    expect(conflict.retryable).toBe(false);

    const stale = new AppError('CONFLICT_STALE', '配置已被修改，请刷新');
    expect(stale.retryable).toBe(false);

    const limited = new AppError('RATE_LIMITED', 'too many requests', { retryable: true });
    expect(limited.status).toBe(429);
    expect(limited.retryable).toBe(true);
  });

  it('maps malformed JSON to a 400, not a 500', async () => {
    const app = await startApp();
    try {
      const res = await request(app, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{bad',
      });
      expect(res.statusCode).toBe(400);
      expect(expectProblem(res, 'INVALID_INPUT').retryable).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('toAppError mappings', () => {
  it.each([
    [400, 'INVALID_INPUT'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [500, 'INTERNAL_ERROR'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps HTTP %i to %s', (status, code) => {
    expect(toAppError(new HTTPException(status))).toMatchObject({
      code,
      status,
    });
  });

  it('maps a Redis outage to a retryable 503, not a 500', () => {
    const unavailable = Object.assign(new Error('Connection closed'), {
      name: 'RedisError',
      code: 'ERR_REDIS_CONNECTION_CLOSED',
    });
    expect(toAppError(unavailable)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
  });

  it('does not treat a generic AbortError as a Redis outage', () => {
    const aborted = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'AbortError',
    });
    expect(toAppError(aborted)).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });

  it('keeps an existing AppError and defaults everything else to INTERNAL_ERROR', () => {
    const original = new AppError('CONFLICT', 'dup');
    expect(toAppError(original)).toBe(original);
    expect(toAppError(new Error('boom'))).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('isPgCode', () => {
  it('finds 23505/23503 nested in drizzle causes', () => {
    const postgres = (errno: string) =>
      Object.assign(Object.create(SQL.PostgresError.prototype), { errno });
    const fk = Object.assign(new Error('update violates fk'), { cause: postgres('23503') });
    expect(isPgCode(fk, '23503')).toBe(true);
    expect(isPgCode(fk, '23505')).toBe(false);
    expect(isPgCode(postgres('23505'), '23505')).toBe(true);
    expect(isPgCode({ errno: '23505' }, '23505')).toBe(true);
    expect(isPgCode(null, '23505')).toBe(false);
    expect(isPgCode(new Error('plain'), '23505')).toBe(false);
  });
});

describe('AppError extra payload', () => {
  it('propagates extra fields while protecting core Problem fields from tampering', () => {
    const err = new AppError('CONFLICT_STALE', 'batch mismatch', {
      hint: 'real hint',
      extra: {
        code: 'INTERNAL_ERROR',
        message: 'forged message',
        status: 200,
        requestId: 'forged-req',
        retryable: true,
        path: '/forged',
        resource: 'forged',
        resourceId: 'forged',
        hint: 'forged hint',
        errors: [{ path: '/forged', message: 'forged' }],
        results: [{ row: 1, status: 'failed' }],
      },
    });
    const body = errorProblem('req-real', err) as Record<string, unknown>;
    expect(body).toEqual({
      code: 'CONFLICT_STALE',
      message: 'batch mismatch',
      status: 409,
      requestId: 'req-real',
      retryable: false,
      hint: 'real hint',
      results: [{ row: 1, status: 'failed' }],
    });
  });

  it('redacts 500 message even when fail() carries extra, while keeping 503 message', () => {
    let internalErr: unknown;
    try {
      fail('INTERNAL_ERROR', 'postgres://user:secret@host/db', {
        extra: { results: [{ row: 1, status: 'failed' }] },
      });
    } catch (err) {
      internalErr = err;
    }
    expect(errorProblem('req-500', internalErr)).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      status: 500,
      requestId: 'req-500',
      results: [{ row: 1, status: 'failed' }],
    });

    const unavailable = new AppError('SERVICE_UNAVAILABLE', 'downstream busy', {
      extra: { results: [{ row: 1, status: 'failed' }] },
    });
    expect(errorProblem('req-503', unavailable)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'downstream busy',
      status: 503,
      requestId: 'req-503',
      results: [{ row: 1, status: 'failed' }],
    });
  });

  it('encodes AppError with extra through createOpenAPIHandler without losing results', async () => {
    const batchErrorSchema = problemSchema.extend({
      results: z.array(z.record(z.string(), z.unknown())).optional(),
    });
    const contract = {
      conflictBatch: contractProcedure
        .errors({
          CONFLICT_STALE: {
            status: 409,
            data: batchErrorSchema.extend({ code: z.literal('CONFLICT_STALE') }),
          },
        })
        .route({ method: 'POST', path: '/test/batch-conflict' })
        .meta({ access: { kind: 'public', reason: 'test' } })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() })),
      internalBatch: contractProcedure
        .errors({
          INTERNAL_ERROR: {
            status: 500,
            data: batchErrorSchema.extend({ code: z.literal('INTERNAL_ERROR') }),
          },
        })
        .route({ method: 'POST', path: '/test/batch-internal' })
        .meta({ access: { kind: 'public', reason: 'test' } })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() })),
    };
    const os = implement(contract).$context<RequestContext>();
    const router = os.router({
      conflictBatch: os.conflictBatch.handler(async () => {
        throw new AppError('CONFLICT_STALE', 'stale import batch', {
          extra: {
            results: [
              { row: 1, status: 'failed', operation: null, documentId: 'doc_1', issues: [] },
            ],
          },
        });
      }),
      internalBatch: os.internalBatch.handler(async () => {
        throw new AppError('INTERNAL_ERROR', 'secret db detail', {
          extra: {
            results: [
              {
                row: 1,
                status: 'failed',
                operation: null,
                documentId: 'doc_1',
                issues: [
                  { field: 'batch', code: 'INTERNAL_ERROR', message: 'Internal server error' },
                ],
              },
            ],
          },
        });
      }),
    });
    const handler = createOpenAPIHandler(router);
    const noopLog = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const makeContext = (req: Request, requestId: string) =>
      ({
        requestId,
        request: req,
        log: noopLog,
        responseHeaders: new Headers(),
        principal: null,
        remoteAddress: '127.0.0.1',
        startedAt: 0,
        limit: async () => undefined,
      }) as unknown as RequestContext;

    const conflictReq = new Request('http://localhost/api/test/batch-conflict', { method: 'POST' });
    const conflictMatch = await handler.handle(conflictReq, {
      prefix: '/api',
      context: makeContext(conflictReq, 'req-batch-409'),
    });
    expect(conflictMatch.matched).toBe(true);
    expect(conflictMatch.response?.status).toBe(409);
    expect(await conflictMatch.response?.json()).toMatchObject({
      code: 'CONFLICT_STALE',
      message: 'stale import batch',
      status: 409,
      requestId: 'req-batch-409',
      retryable: false,
      results: [{ row: 1, status: 'failed', operation: null, documentId: 'doc_1', issues: [] }],
    });

    const internalReq = new Request('http://localhost/api/test/batch-internal', { method: 'POST' });
    const internalMatch = await handler.handle(internalReq, {
      prefix: '/api',
      context: makeContext(internalReq, 'req-batch-500'),
    });
    expect(internalMatch.matched).toBe(true);
    expect(internalMatch.response?.status).toBe(500);
    const internalBody = (await internalMatch.response?.json()) as Record<string, unknown>;
    expect(internalBody).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      status: 500,
      requestId: 'req-batch-500',
      results: [
        {
          row: 1,
          status: 'failed',
          issues: [{ field: 'batch', code: 'INTERNAL_ERROR', message: 'Internal server error' }],
        },
      ],
    });
    expect(JSON.stringify(internalBody)).not.toContain('secret db detail');
  });
});
