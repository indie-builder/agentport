import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AUTH_COOKIE } from '../src/modules/auth/types.js';
import { infraReady, request, startApp, type TestApp, testConfig } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('security headers', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the SPA with a CSP that allows inline styles but not inline scripts', async () => {
    for (const url of ['/', '/health/live']) {
      const res = await request(app, { method: 'GET', url });
      const csp = String(res.headers.get('content-security-policy') ?? '');
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("style-src 'self' 'unsafe-inline'");
      // UI 把鉴权拉取的图片转成 blob URL 渲染；缺 blob: 会被 CSP 拦掉。
      expect(csp, url).toContain("img-src 'self' data: blob:");
      // 原生 PDF 预览把下载字节转成 Blob URL 放进 iframe；缺 blob: 会被 CSP 拦掉。
      expect(csp, url).toContain("frame-src 'self' blob:");
      // 其余保持收紧：不许 object、data: 或远程 frame，也不放开内联脚本。
      expect(csp, url).toContain("object-src 'none'");
      expect(csp, url).not.toMatch(/frame-src\b[^;]*(?:\*|data:|https?:)/);
      expect(csp, url).not.toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  it('serves the MCP endpoint with the global browser CSP', async () => {
    const res = await request(app, { method: 'POST', url: '/mcp/missing', payload: {} });
    const csp = String(res.headers.get('content-security-policy') ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('does not reflect arbitrary origins in CORS preflight', async () => {
    const res = await request(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe.skipIf(!ready)('production CORS and auth cookies', () => {
  const config = testConfig();
  const origin = 'https://worktree-skills-toolbar-layout.agentport.localhost';
  let app: TestApp;

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
    const res = await request(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('still omits the header for an unrelated origin', async () => {
    const res = await request(app, {
      method: 'OPTIONS',
      url: '/api/servers',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps cookie guarantees for a wildcard-origin login and logout', async () => {
    const login = await request(app, {
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

    const logout = await request(app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin, cookie: `${AUTH_COOKIE}=${cookie?.value ?? ''}` },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.cookies.find((c) => c.name === AUTH_COOKIE)?.value).toBe('');
  });
});
