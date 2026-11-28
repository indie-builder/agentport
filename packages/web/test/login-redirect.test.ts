import { describe, expect, it } from 'vitest';
import { loginPath, resolveReturnTo, safeInternalPath } from '../src/lib/auth-redirect.js';

const PLUGIN_TARGET = '/plugins/plugin_1?tab=content&file=skills%2Fdemo%2FSKILL.md&mode=source#top';
const KNOWLEDGE_TARGET = '/knowledge/kb_1?panel=wiki&page=guide&folder=docs';

describe('safeInternalPath', () => {
  it.each([PLUGIN_TARGET, KNOWLEDGE_TARGET, '/agents/agent_1?tab=files#memory'])(
    'keeps the in-app path %s with search and hash',
    (target) => {
      expect(safeInternalPath(target)).toBe(target);
      expect(resolveReturnTo(target)).toBe(target);
    },
  );

  it.each([
    '//evil.example/steal',
    'https://evil.example/steal',
    'http://evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/\\evil.example/steal',
    '/\\[',
    '/\\evil:bad',
    'evil.example/steal',
    '/login',
    '/login/',
    '/login?returnTo=%2Fagents',
    '/login/#top',
    '/a/..//evil.example',
    '/a/..//evil.example/steal',
    '',
  ])('rejects the untrusted target %s', (target) => {
    expect(safeInternalPath(target)).toBeUndefined();
    expect(resolveReturnTo(target)).toBe('/');
  });

  it('rejects non-string values', () => {
    expect(safeInternalPath(undefined)).toBeUndefined();
    expect(safeInternalPath(null)).toBeUndefined();
    expect(safeInternalPath(['/agents'])).toBeUndefined();
  });
});

describe('loginPath', () => {
  it('keeps pathname, search and hash and marks an expired session once', () => {
    const path = loginPath(PLUGIN_TARGET, 'expired');
    expect(path.startsWith('/login?')).toBe(true);
    const url = new URL(path, 'http://app.local');
    expect(url.searchParams.get('returnTo')).toBe(PLUGIN_TARGET);
    expect(url.searchParams.get('reason')).toBe('expired');
  });

  it('drops the expired reason on a first login and falls back home for untrusted targets', () => {
    expect(new URL(loginPath(undefined), 'http://app.local').searchParams.get('reason')).toBeNull();
    expect(
      new URL(loginPath('https://evil.example'), 'http://app.local').searchParams.get('returnTo'),
    ).toBe('/');
  });
});
