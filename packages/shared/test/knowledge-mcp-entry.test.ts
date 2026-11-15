import { describe, expect, it } from 'bun:test';
import { generatedMcpEntry, knowledgeMcpEntry } from '../src/mcp.js';

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

describe('generatedMcpEntry', () => {
  it('strips a trailing slash from apiUrl and keeps the run headers', () => {
    expect(
      generatedMcpEntry({
        apiUrl: 'http://api.internal:3000/',
        serverId: 'srv_x',
        runId: 'run_1',
        runToken: 'tok',
      }),
    ).toEqual({
      type: 'http',
      url: 'http://api.internal:3000/mcp/srv_x',
      headers: { Authorization: 'Bearer tok', 'x-agentport-run-id': 'run_1' },
    });
  });

  it('keeps a single separator when apiUrl has no trailing slash', () => {
    expect(
      generatedMcpEntry({
        apiUrl: 'http://api.internal:3000',
        serverId: 'srv_x',
        runId: 'run_1',
        runToken: 'tok',
      }).url,
    ).toBe('http://api.internal:3000/mcp/srv_x');
  });
});
