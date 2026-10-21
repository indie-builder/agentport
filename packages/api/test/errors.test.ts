import { AppError, isAppError } from '@agentport/core';
import { errorCode } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject, startApp } from './helpers.js';

/**
 * 错误契约的边界测试：每个出口都必须给出同一形状。
 * 业务路径的断言在各自 feature 的测试里，这里只验证「形状与安全」。
 */
describe('problem responses', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a complete Problem for an unknown route', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', status: 404, retryable: false });
    const body = res.json();
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('returns 401 Problem when unauthenticated', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED', status: 401, retryable: false });
  });

  it('validates querystring at the schema boundary', async () => {
    // 校验在 preHandler 之前：非法查询串不会因为未登录而变成 401。
    for (const url of [
      '/api/runs?limit=0',
      '/api/runs?limit=201',
      '/api/runs?limit=abc',
      '/api/runs?status=nope',
      '/api/conversations?limit=999',
      '/api/overview?days=0',
    ]) {
      const res = await inject(app, { method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
      expect(typeof res.json<{ path: string }>().path, url).toBe('string');
    }

    const ok = await inject(app, { method: 'GET', url: '/api/runs?limit=5' });
    expect(ok.statusCode).toBe(401);
  });
});

describe('AppError contract', () => {
  it('never leaks internal details on 5xx', () => {
    // 系统异常统一走 INTERNAL_ERROR；细节只进日志，响应文案由边界替换。
    const err = new AppError('INTERNAL_ERROR', 'password=hunter2 at src/db.ts:88');
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
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
      const res = await inject(app, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{bad',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_INPUT', status: 400, retryable: false });
    } finally {
      await app.close();
    }
  });

  it('every error code maps to a sane HTTP status', () => {
    for (const [code, status] of Object.entries(errorCode)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('recognises AppError across module boundaries', () => {
    expect(isAppError(new AppError('NOT_FOUND', 'x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
