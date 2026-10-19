import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
