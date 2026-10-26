import { describe, expect, it } from 'vitest';
import { knowledgeMcpEntry } from '../src/mcp.js';

describe('knowledgeMcpEntry', () => {
  it('builds the runtime HTTP entry from the platform URL, never from user config', () => {
    expect(
      knowledgeMcpEntry({
        apiUrl: 'http://api.internal:3000/',
        serverId: 'srv_kb',
        runId: 'run_1',
        runToken: 'tok',
      }),
    ).toEqual({
      type: 'http',
      url: 'http://api.internal:3000/mcp/srv_kb',
      headers: { Authorization: 'Bearer tok', 'x-agentport-run-id': 'run_1' },
    });
  });

  it('keeps a trailing slash from doubling the separator', () => {
    expect(
      knowledgeMcpEntry({
        apiUrl: 'http://api.internal:3000',
        serverId: 'srv_kb',
        runId: 'run_1',
        runToken: 'tok',
      }).url,
    ).toBe('http://api.internal:3000/mcp/srv_kb');
  });
});
