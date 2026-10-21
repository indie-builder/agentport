import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authRateLimit } from '../src/plugins/security.js';
import { infraReady, inject, startApp } from './helpers.js';

const ready = await infraReady;

/**
 * RATE_LIMIT_DISABLED=1 由 vitest.config.ts 注入。关闭路径若写成 `{}`，路由会落回
 * 全局 120/min；这里用超过两个上限的次数把这条回归打出来。
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
