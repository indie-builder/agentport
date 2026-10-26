import { describe, expect, it } from 'vitest';
import {
  knowledgeMcpEntry,
  knowledgeTokenEnv,
  serverInputSchema,
  serverSchema,
} from '../src/mcp.js';

const readFields = {
  id: 'srv_kb',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('knowledge server read/write split', () => {
  it('reads the internal knowledge kind', () => {
    const parsed = serverSchema.parse({
      ...readFields,
      kind: 'knowledge',
      name: 'kb-handbook',
      description: '',
      config: { knowledgeBaseId: 'kb_1' },
    });
    expect(parsed.kind).toBe('knowledge');
    // 读形状里没有 token / 凭据字段。
    expect('headers' in parsed).toBe(false);
    expect('url' in parsed).toBe(false);
  });

  it('reads the three user-configurable kinds unchanged', () => {
    expect(
      serverSchema.parse({
        ...readFields,
        kind: 'http',
        name: 'remote',
        description: '',
        url: 'https://example.com/mcp',
        headers: { Authorization: '' },
      }).kind,
    ).toBe('http');
  });

  it('never accepts knowledge through the user-facing input union', () => {
    expect(
      serverInputSchema.safeParse({
        kind: 'knowledge',
        name: 'kb-handbook',
        description: '',
        config: { knowledgeBaseId: 'kb_1' },
      }).success,
    ).toBe(false);
  });

  it('derives a dedicated credential variable per knowledge server name', () => {
    expect(knowledgeTokenEnv('kb-handbook')).toBe('KNOWLEDGE_KB_HANDBOOK_TOKEN');
    expect(knowledgeTokenEnv('kb-team.notes')).toBe('KNOWLEDGE_KB_TEAM_NOTES_TOKEN');
  });

  it('keeps the runtime entry independent of the exported credential variable', () => {
    const entry = knowledgeMcpEntry({
      apiUrl: 'https://pace.example.com',
      serverId: 'srv_kb',
      runId: 'run_1',
      runToken: 'run-token',
    });
    expect(entry.headers.Authorization).toBe('Bearer run-token');
    expect(JSON.stringify(entry)).not.toContain(knowledgeTokenEnv('kb-handbook'));
  });
});
