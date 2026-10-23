import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_SECRET_KEY: 'a'.repeat(32),
};

describe('SANDBOX_EGRESS', () => {
  it('defaults to open', () => {
    expect(loadConfig(base).SANDBOX_EGRESS).toBe('open');
  });

  it('fails closed when proxy has no proxy URL', () => {
    for (const env of [
      { SANDBOX_EGRESS: 'proxy' },
      { SANDBOX_EGRESS: 'proxy', HTTPS_PROXY: '', HTTP_PROXY: '' },
    ]) {
      expect(() => loadConfig({ ...base, ...env })).toThrow(/SANDBOX_EGRESS=proxy/);
    }
  });

  it('accepts proxy with HTTPS_PROXY and keeps none as-is', () => {
    expect(
      loadConfig({ ...base, SANDBOX_EGRESS: 'proxy', HTTPS_PROXY: 'http://127.0.0.1:8888' })
        .SANDBOX_EGRESS,
    ).toBe('proxy');
    expect(loadConfig({ ...base, SANDBOX_EGRESS: 'none' }).SANDBOX_EGRESS).toBe('none');
  });
});
