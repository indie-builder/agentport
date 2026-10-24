import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import { infraReady, inject, startApp, testConfig } from './helpers.js';

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

describe.skipIf(!ready)('production CORS and auth cookies', () => {
  const config = testConfig();
  const origin = 'https://worktree-skills-toolbar-layout.agentport.localhost';
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://agentport.localhost,https://*.agentport.localhost',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('reflects an allowed wildcard origin in preflight with credentials', async () => {
    const res = await inject(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('still omits the header for an unrelated origin', async () => {
    const res = await inject(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps cookie guarantees for a wildcard-origin login and logout', async () => {
    const login = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: config.ADMIN_USER, password: config.ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const cookie = login.cookies.find((c) => c.name === AUTH_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.secure).toBe(true);

    const logout = await inject(app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin, cookie: `${AUTH_COOKIE}=${cookie?.value ?? ''}` },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.cookies.find((c) => c.name === AUTH_COOKIE)?.value).toBe('');
  });
});
