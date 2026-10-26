import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_SECRET_KEY: 'a'.repeat(32),
};

describe('DOCLING_URL', () => {
  it('treats an empty DOCLING_URL (compose default) as unset', () => {
    const config = loadConfig({ ...base, DOCLING_URL: '', DOCLING_TOKEN: '' });
    expect(config.DOCLING_URL).toBeUndefined();
  });

  it('keeps a real URL and rejects a malformed one', () => {
    expect(loadConfig({ ...base, DOCLING_URL: 'http://docling:5001' }).DOCLING_URL).toBe(
      'http://docling:5001',
    );
    expect(() => loadConfig({ ...base, DOCLING_URL: 'not a url' })).toThrow(/DOCLING_URL/);
  });
});

describe('SANDBOX_MAX_FIELD_BYTES', () => {
  it('defaults to 1MiB', () => {
    expect(loadConfig(base).SANDBOX_MAX_FIELD_BYTES).toBe(1024 * 1024);
  });

  it('refuses a limit whose JSON escaping would exceed the host 8MiB line cap', () => {
    expect(() => loadConfig({ ...base, SANDBOX_MAX_FIELD_BYTES: String(1024 * 1024 + 1) })).toThrow(
      /1MiB/,
    );
    expect(
      loadConfig({ ...base, SANDBOX_MAX_FIELD_BYTES: String(1024 * 1024) }).SANDBOX_MAX_FIELD_BYTES,
    ).toBe(1024 * 1024);
  });
});

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
