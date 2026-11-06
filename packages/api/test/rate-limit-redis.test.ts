import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { request, startApp, type TestApp } from './helpers.js';

const previousLimitsOff = process.env.RATE_LIMIT_DISABLED;
process.env.RATE_LIMIT_DISABLED = '0';

describe('rate-limit Redis outage', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp({ REDIS_URL: 'redis://127.0.0.1:1' });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (previousLimitsOff === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = previousLimitsOff;
  });

  it('fails fast with a retryable 503 instead of hanging', async () => {
    const started = Date.now();
    const res = await request(app, { method: 'GET', url: '/api/probe' });
    const elapsed = Date.now() - started;

    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    // 命令超时 3s + 建连开销；没有上界时这里会一直挂到 vitest 的 20s 超时。
    expect(elapsed).toBeLessThan(6_000);
  });
});
