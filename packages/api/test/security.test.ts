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
    const res = await inject(app, { method: 'GET', url: '/health/live' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
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
