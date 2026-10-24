import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraReady, inject, startApp } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('openapi', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/openapi.json serves the 3.1 document with all routes', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toHaveProperty('/api/servers');
  });

  it('GET /api/docs/ serves Scalar without auth', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // 内联初始化脚本必须被 CSP 放行，否则页面白屏。
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.body).toContain('Scalar.createApiReference');
  });
});
