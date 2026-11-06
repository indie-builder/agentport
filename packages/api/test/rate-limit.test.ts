import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { infraReady, request, startApp } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('rate limiting', () => {
  let app: Awaited<ReturnType<typeof startApp>>;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    // 失败登录会写审计；runs 之间不清理会无限增长。
    await app.client.unsafe(
      "delete from audit_log where actor = 'nobody' and action = 'auth.login.failed'",
    );
    await app.close();
  });

  it('RATE_LIMIT_DISABLED makes presets inert instead of re-enabling the global limit', async () => {
    expect(process.env.RATE_LIMIT_DISABLED).toBe('1');

    // 串行：130 个并发 login 会同时跑 scrypt，撑爆默认 20s 超时。
    for (let i = 0; i < 130; i += 1) {
      const res = await request(app, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'wrong-password' },
      });
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
  });

  it('an unknown route past the global limit is still a Problem', async () => {
    const res = await request(app, { method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
