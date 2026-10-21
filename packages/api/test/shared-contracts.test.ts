import {
  commonEnvSchema,
  idParams,
  PREVIEW_SECRET,
  parseEnv,
  previewMcpEntry,
} from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig as workerConfig } from '../../worker/src/config.js';
import { loadConfig as apiConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_SECRET_KEY: 'a'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  ADMIN_PASSWORD: 'strong-enough-pass',
};

describe('shared environment parsing', () => {
  it('preserves API and worker defaults for missing environment variables', () => {
    for (const loadConfig of [apiConfig, workerConfig]) {
      expect(loadConfig(base)).toMatchObject({
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        REDIS_URL: 'redis://localhost:6379',
      });
    }
    expect(apiConfig(base)).toMatchObject({ PORT: 3000, APPROVAL_WAIT_MS: 300_000 });
    expect(workerConfig(base)).toMatchObject({
      WORKSPACES_DIR: './data/workspaces',
      MODEL_PROXY_PORT: 3426,
    });
  });

  it('preserves issue order and the environment error message', () => {
    const schema = commonEnvSchema.extend({ REQUIRED: z.string() });
    const env = { REDIS_URL: '', REQUIRED: '' };
    const result = schema.safeParse(env);
    if (result.success) throw new Error('expected invalid environment');
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    expect(() => parseEnv(schema, env)).toThrow(`Invalid environment:\n${detail}`);
  });
});

describe('shared MCP entry rendering', () => {
  it('keeps secrets out of previews and preserves permissive config normalization', () => {
    expect(
      previewMcpEntry(
        { kind: 'stdio', config: { command: 7, args: ['ok', 3], env: { TOKEN: 'secret' } } },
        { TOKEN: PREVIEW_SECRET },
      ),
    ).toEqual({
      command: '',
      args: ['ok'],
      env: { TOKEN: '<已配置>' },
    });
    expect(
      previewMcpEntry({
        kind: 'http',
        config: { url: 'https://mcp.test', headers: { Authorization: 'secret' } },
      }),
    ).toEqual({
      type: 'http',
      url: 'https://mcp.test',
      headers: {},
    });
    expect(
      previewMcpEntry({ kind: 'generated', config: { baseUrl: 'https://upstream.test' } }),
    ).toEqual({
      type: 'http',
      url: 'https://upstream.test',
      headers: {},
    });
  });

  it('uses runtime values supplied by the worker without masking or dropping them', () => {
    expect(
      previewMcpEntry(
        { kind: 'http', config: { url: 'https://mcp.test' } },
        { Authorization: 'Bearer runtime' },
      ),
    ).toEqual({
      type: 'http',
      url: 'https://mcp.test',
      headers: { Authorization: 'Bearer runtime' },
    });
  });
});

it('requires a nonempty id while preserving the existing parameter schema behavior', () => {
  expect(idParams.safeParse({ id: '' }).success).toBe(false);
  expect(idParams.parse({ id: 'run-1', extra: true })).toEqual({ id: 'run-1' });
});
