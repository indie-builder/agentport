import { AppError } from '@agentport/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authRateLimit, failFastRateLimitStore } from '../src/plugins/security.js';
import { infraReady, inject, startApp } from './helpers.js';

const ready = await infraReady;

describe('rate-limit store failures', () => {
  type Callback = (err: Error | null, result: [number, number]) => void;

  it('turns a Redis failure into SERVICE_UNAVAILABLE (503)', async () => {
    const store = {
      rateLimit: (
        _key: string,
        _timeWindow: number,
        _max: number,
        _continueExceeding: boolean,
        _exponentialBackoff: boolean,
        callback: Callback,
      ) => callback(new Error('redis down'), [0, 0]),
    };
    failFastRateLimitStore(store);

    const err = await new Promise<unknown>((resolve) => {
      store.rateLimit('k', 60_000, 600, false, false, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as AppError).status).toBe(503);
    expect((err as AppError).retryable).toBe(true);
  });

  it('passes successful counts through unchanged', async () => {
    const store = {
      rateLimit: (
        _key: string,
        _timeWindow: number,
        _max: number,
        _continueExceeding: boolean,
        _exponentialBackoff: boolean,
        callback: Callback,
      ) => callback(null, [1, 60_000]),
    };
    failFastRateLimitStore(store);

    const result = await new Promise<[number, number] | undefined>((resolve) => {
      store.rateLimit('k', 60_000, 600, false, false, (_e, r) => resolve(r));
    });
    expect(result).toEqual([1, 60_000]);
  });
});

/**
 * RATE_LIMIT_DISABLED=1 由 vitest.config.ts 注入。关闭路径若写成 `{}`，路由会落回
 * 全局 120/min；这里用超过两个上限的次数把这条回归打出来。
 * 429 本身无法在本进程验证（plugins/security.ts 的开关是模块加载时的常量），
 * 由部署验证脚本对运行中的实例连打 11 次错误登录覆盖。
 */
describe.skipIf(!ready)('rate limiting', () => {
  let app: Awaited<ReturnType<typeof startApp>>;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    // 失败登录会写审计；runs 之间不清理会无限增长。
    await app.pool.query(
      "delete from audit_log where actor = 'nobody' and action = 'auth.login.failed'",
    );
    await app.close();
  });

  it('RATE_LIMIT_DISABLED makes presets inert instead of re-enabling the global limit', async () => {
    expect(process.env.RATE_LIMIT_DISABLED).toBe('1');
    // 预设本身必须是 false；`{}` 会让 @fastify/rate-limit 套用全局 max。
    expect(authRateLimit.config.rateLimit).toBe(false);

    // 串行：130 个并发 login 会同时跑 scrypt，撑爆默认 20s 超时。
    for (let i = 0; i < 130; i += 1) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'wrong-password' },
      });
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
  });

  it('an unknown route past the global limit is still a Problem', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
