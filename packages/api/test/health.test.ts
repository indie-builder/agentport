import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildApp } from '../src/app.js';
import { infraReady, loginCookie, request, startApp, type TestApp, testConfig } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('health', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns ok', async () => {
    const res = await request(app, { method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 503 when Redis is unreachable', async () => {
    // 端口 1 上不会有 Redis；探测有 1.5s 超时，比默认 testTimeout 短。
    const broken = await buildApp({ ...testConfig(), REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const res = await request(broken, { method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'degraded', db: 'ok', redis: 'error' });
    } finally {
      await broken.close();
    }
  });

  it('GET /health/ready pings the database', async () => {
    const res = await request(app, { method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('GET /health/metrics requires auth: it is not a public probe', async () => {
    const anon = await request(app, { method: 'GET', url: '/health/metrics' });
    expect(anon.statusCode).toBe(401);
  });

  it('GET /health/metrics returns process, queue, db and redis metrics', async () => {
    const cookie = await loginCookie(app);
    const res = await request(app, {
      method: 'GET',
      url: '/health/metrics',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      process: {
        uptimeSeconds: expect.any(Number),
        memoryRssBytes: expect.any(Number),
        bunVersion: expect.any(String),
      },
      queue: { waiting: expect.any(Number), active: expect.any(Number) },
      knowledgeQueue: {
        waiting: expect.any(Number),
        active: expect.any(Number),
        completed: expect.any(Number),
        failed: expect.any(Number),
        delayed: expect.any(Number),
      },
      db: {
        connected: true,
        pingMs: expect.any(Number),
        maxConnections: expect.any(Number),
      },
      redis: { pingMs: expect.any(Number) },
    });
  });
});
