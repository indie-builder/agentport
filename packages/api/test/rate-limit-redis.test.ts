import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// security.ts 在模块加载时读取这个开关，vitest 默认设为 1；本用例必须真正走 Redis。
const previousLimitsOff = process.env.RATE_LIMIT_DISABLED;
process.env.RATE_LIMIT_DISABLED = '0';

const { registerSecurityPlugins } = await import('../src/plugins/security.js');
const { registerErrorHandler } = await import('../src/plugins/errors.js');

describe('rate-limit Redis outage', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.decorate('config', {
      REDIS_URL: 'redis://127.0.0.1:1',
      CORS_ORIGINS: 'http://localhost:5173',
      SELF_URL: 'http://127.0.0.1:3000',
    });
    registerErrorHandler(app);
    await registerSecurityPlugins(app);
    app.get('/api/probe', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (previousLimitsOff === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = previousLimitsOff;
  });

  it('fails fast with a retryable 503 instead of hanging', async () => {
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/probe' });
    const elapsed = Date.now() - started;

    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    // 命令超时 3s + 建连开销；没有上界时这里会一直挂到 vitest 的 20s 超时。
    expect(elapsed).toBeLessThan(6_000);
  });
});
