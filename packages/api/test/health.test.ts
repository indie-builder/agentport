import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraReady, inject, startApp } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns ok', async () => {
    const res = await inject(app, { method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready pings the database', async () => {
    const res = await inject(app, { method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('GET /health/metrics returns process, queue, db and redis metrics', async () => {
    const res = await inject(app, { method: 'GET', url: '/health/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      process: { uptimeSeconds: expect.any(Number), memoryRssBytes: expect.any(Number) },
      queue: { waiting: expect.any(Number), active: expect.any(Number) },
      db: { total: expect.any(Number), idle: expect.any(Number), waiting: expect.any(Number) },
      redis: { pingMs: expect.any(Number) },
    });
  });
});
