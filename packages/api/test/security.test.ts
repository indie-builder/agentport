import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infraReady, inject, startApp } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('security headers', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the SPA with a CSP that allows inline styles but not inline scripts', async () => {
    for (const url of ['/', '/health/live']) {
      const res = await inject(app, { method: 'GET', url });
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("style-src 'self' 'unsafe-inline'");
    }
  });

  it('omits CSP on the MCP endpoint, which non-browser clients call', async () => {
    // 不存在的 serverId 走同一路由，CSP 关闭由路由配置决定，与鉴权结果无关。
    const res = await inject(app, { method: 'POST', url: '/mcp/missing', payload: {} });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('does not reflect arbitrary origins in CORS preflight', async () => {
    const res = await inject(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
