import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, infraReady, inject, loginCookie, startApp } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('openapi', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires auth for the spec and every Scalar route', async () => {
    for (const url of ['/api/openapi.json', '/api/docs/', '/api/docs/openapi.json']) {
      const res = await inject(app, { method: 'GET', url });
      expect(expectProblem(res, 'UNAUTHORIZED'), url).toBeTruthy();
    }
  });

  it('GET /api/openapi.json serves the 3.1 document to a logged-in session', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/openapi.json',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toHaveProperty('/api/servers');
  });

  it('serves Scalar and the spec URL it fetches with the session cookie', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/docs/', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // 内联初始化脚本必须被 CSP 放行，否则页面白屏。
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.body).toContain('Scalar.createApiReference');
    // 页面用相对 URL 取 spec：浏览器同源请求会带上会话 cookie。
    expect(res.body).toContain('./openapi.json');

    const spec = await inject(app, {
      method: 'GET',
      url: '/api/docs/openapi.json',
      headers: { cookie },
    });
    expect(spec.statusCode, spec.body).toBe(200);
    expect(spec.json().paths).toHaveProperty('/api/servers');
  });
});
