import { describe, expect, it } from 'vitest';
import { getTrustedOrigins, isTrustedOrigin, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_SECRET_KEY: 'a'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  ADMIN_PASSWORD: 'strong-enough-pass',
};

describe('loadConfig', () => {
  it('accepts strong secrets', () => {
    expect(loadConfig(base).ADMIN_PASSWORD).toBe(base.ADMIN_PASSWORD);
  });

  it.each([
    ['APP_SECRET_KEY', { APP_SECRET_KEY: 'a'.repeat(31) }],
    ['JWT_SECRET', { JWT_SECRET: 'j'.repeat(31) }],
    ['short password', { ADMIN_PASSWORD: 'short' }],
    ['weak password', { ADMIN_PASSWORD: 'admin-change-me' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow(/Invalid environment/);
  });
});

describe('trusted origins', () => {
  const split = getTrustedOrigins({
    CORS_ORIGINS:
      ' http://localhost:5173 , ,https://agentport.localhost, https://*.agentport.localhost ',
    SELF_URL: 'http://127.0.0.1:3000',
  });

  it('splits, trims and filters CORS_ORIGINS, then appends SELF_URL', () => {
    expect(split).toEqual([
      'http://localhost:5173',
      'https://agentport.localhost',
      'https://*.agentport.localhost',
      'http://127.0.0.1:3000',
    ]);
  });

  it('accepts exact origins unchanged', () => {
    expect(isTrustedOrigin('http://localhost:5173', split)).toBe(true);
    expect(isTrustedOrigin('https://agentport.localhost', split)).toBe(true);
  });

  it('accepts arbitrary and nested HTTPS worktree subdomains for a wildcard', () => {
    for (const origin of [
      'https://worktree-skills-toolbar-layout.agentport.localhost',
      'https://a.b.agentport.localhost',
    ]) {
      expect(isTrustedOrigin(origin, split), origin).toBe(true);
    }
  });

  it('requires the wildcard base itself to be listed as an exact origin', () => {
    const wildcardOnly = ['https://*.agentport.localhost'];
    expect(isTrustedOrigin('https://agentport.localhost', wildcardOnly)).toBe(false);
    expect(isTrustedOrigin('https://agentport.localhost', split)).toBe(true);
  });

  it('requires the exact protocol and port', () => {
    expect(isTrustedOrigin('http://worktree.agentport.localhost', split)).toBe(false);
    expect(isTrustedOrigin('https://worktree.agentport.localhost:8443', split)).toBe(false);
    expect(
      isTrustedOrigin('https://worktree.agentport.localhost', [
        'https://*.agentport.localhost:8443',
      ]),
    ).toBe(false);
    expect(
      isTrustedOrigin('https://worktree.agentport.localhost:8443', [
        'https://*.agentport.localhost:8443',
      ]),
    ).toBe(true);
  });

  it.each([
    'https://evilagentport.localhost',
    'https://agentport.localhost.evil.example',
    'https://worktree.agentport.localhost.evil.example',
    'https://other.localhost',
  ])('rejects lookalike or unrelated host %s', (origin) => {
    expect(isTrustedOrigin(origin, split)).toBe(false);
  });

  it('rejects origins with credentials, a path, query or fragment', () => {
    for (const origin of [
      'https://user:pass@worktree.agentport.localhost',
      'https://worktree.agentport.localhost/path',
      'https://worktree.agentport.localhost?x=1',
      'https://worktree.agentport.localhost#x',
    ]) {
      expect(isTrustedOrigin(origin, split), origin).toBe(false);
    }
  });

  it('rejects malformed origins and universal wildcards', () => {
    expect(isTrustedOrigin('not an origin', split)).toBe(false);
    expect(isTrustedOrigin('https://anything.example', ['*'])).toBe(false);
    expect(isTrustedOrigin('https://anything.example', ['https://*'])).toBe(false);
  });

  it('denies subdomains when the wildcard is not configured', () => {
    expect(
      isTrustedOrigin('https://worktree.agentport.localhost', ['https://agentport.localhost']),
    ).toBe(false);
  });
});
