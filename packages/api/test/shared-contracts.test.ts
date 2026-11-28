import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  AGENT_ROLES,
  agentInputSchema,
  agentSchema,
  commonEnvSchema,
  parseEnv,
  previewMcpEntry,
  SECRET_MASK,
} from '@agentport/shared';
import { z } from 'zod';
import { loadConfig as workerConfig } from '../../worker/src/config.js';
import { loadConfig as apiConfig } from '../src/config.js';

const repoRoot = Bun.fileURLToPath(new URL('../../../', import.meta.url));

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
      WORKSPACES_DIR: join(repoRoot, 'data/workspaces'),
      MODEL_PROXY_PORT: 3426,
    });
  });

  it('preserves issue order and the environment error message', () => {
    const schema = commonEnvSchema.extend({ DATABASE_URL: z.string().min(1) });
    expect(() => parseEnv(schema, { REDIS_URL: '' })).toThrow(
      new Error(
        'Invalid environment:\nREDIS_URL: 数值过小：期望 string >=1 字符\nDATABASE_URL: 无效输入：期望 string，实际接收 undefined',
      ),
    );
  });
});

describe('shared MCP entry rendering', () => {
  it('keeps secrets out of previews and preserves permissive config normalization', () => {
    expect(
      previewMcpEntry(
        { kind: 'stdio', config: { command: 7, args: ['ok', 3], env: { TOKEN: 'secret' } } },
        { TOKEN: SECRET_MASK },
      ),
    ).toEqual({
      command: '',
      args: ['ok'],
      env: { TOKEN: SECRET_MASK },
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

describe('standard agent occupations', () => {
  it('assigns a general assistant occupation to agents without a role', () => {
    expect(agentInputSchema.parse({ slug: 'helper', name: 'Helper' }).role).toBe('通用助手');
    expect(agentInputSchema.parse({ slug: 'helper', name: 'Helper', role: '' }).role).toBe(
      '通用助手',
    );
    expect(agentInputSchema.parse({ slug: 'helper', name: 'Helper', role: ' \t\n' }).role).toBe(
      '通用助手',
    );
  });

  it('keeps historical roles intact while enforcing the write catalog', () => {
    for (const role of AGENT_ROLES) {
      expect(agentInputSchema.parse({ slug: 'helper', name: 'Helper', role }).role).toBe(role);
    }
    const input = agentInputSchema.parse({ slug: 'helper', name: 'Helper' });
    for (const role of ['旧岗位', '  旧岗位  ', '']) {
      const agent = agentSchema.parse({
        ...input,
        role,
        id: 'agt_helper',
        createdBy: 'biz_creator',
        ownerBusinessId: 'biz_owner',
        parentId: null,
        isDefault: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(agent.role).toBe(role);
    }
  });
});
