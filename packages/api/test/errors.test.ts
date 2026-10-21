import { AppError, isAppError } from '@agentport/core';
import { isIdOfType, newId } from '@agentport/db';
import { errorCode } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPgCode, toAppError } from '../src/plugins/errors.js';
import { expectProblem, inject, loginCookie, startApp } from './helpers.js';

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

  it('unknown route produces a complete Problem', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/definitely-not-a-route' });
    const body = expectProblem(res, 'NOT_FOUND');
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('returns 401 Problem when unauthenticated', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/agents' });
    expect(expectProblem(res, 'UNAUTHORIZED').retryable).toBe(false);
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
      expect(typeof expectProblem(res, 'INVALID_INPUT').path, url).toBe('string');
    }

    const ok = await inject(app, { method: 'GET', url: '/api/runs?limit=5' });
    expect(ok.statusCode).toBe(401);
  });
});

describe('AppError contract', () => {
  it('never leaks internal details on a real 500', async () => {
    // 登录只依赖 Redis（审计写失败会被吞掉），之后打库的读路径才可以制造真实 500。
    const broken = await startApp({ DATABASE_URL: 'postgres://u:hunter2@127.0.0.1:1/nope' });
    try {
      const cookie = await loginCookie(broken);
      const res = await inject(broken, {
        method: 'GET',
        url: '/api/servers',
        headers: { cookie },
      });
      const body = expectProblem(res, 'INTERNAL_ERROR');
      expect(body).toMatchObject({ message: 'Internal server error', retryable: true });
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
      const res = await inject(app, {
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

describe('toAppError mappings', () => {
  it.each([
    [{ statusCode: 413 }, 'PAYLOAD_TOO_LARGE'],
    [{ statusCode: 415 }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ statusCode: 429 }, 'RATE_LIMITED'],
    [{ statusCode: 503 }, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps %o to %s', (input, code) => {
    expect(toAppError(input)).toMatchObject({ code, status: errorCode[code] });
  });

  it('keeps an existing AppError and defaults everything else to INTERNAL_ERROR', () => {
    const original = new AppError('CONFLICT', 'dup');
    expect(toAppError(original)).toBe(original);
    expect(toAppError(new Error('boom'))).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

describe('isPgCode', () => {
  it('finds 23505/23503 nested in drizzle causes', () => {
    const fk = Object.assign(new Error('update violates fk'), {
      cause: Object.assign(new Error('pg'), { code: '23503' }),
    });
    expect(isPgCode(fk, '23503')).toBe(true);
    expect(isPgCode(fk, '23505')).toBe(false);
    expect(isPgCode({ code: '23505' }, '23505')).toBe(true);
    expect(isPgCode(null, '23505')).toBe(false);
    expect(isPgCode(new Error('plain'), '23505')).toBe(false);
  });
});

describe('isIdOfType', () => {
  it('accepts a real id and rejects a wrong prefix or junk suffix', () => {
    const id = newId('run');
    expect(isIdOfType(id, 'run')).toBe(true);

    // 旧实现只比对 `run_` 前缀，因此 run_junk 会通过。
    expect(isIdOfType('run_junk', 'run')).toBe(false);
    expect(isIdOfType(newId('agent'), 'run')).toBe(false);
    expect(isIdOfType('', 'run')).toBe(false);
    expect(isIdOfType('agt_missing', 'agent')).toBe(false);
  });
});
