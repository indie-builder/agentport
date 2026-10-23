import type { ServerInput } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { parseMcpJson } from '../src/mcp-json.js';
import { toMcpJsonEntry } from '../src/tools.js';

const doc = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

function reject(text: string): AppError {
  try {
    parseMcpJson(text);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe('INVALID_INPUT');
    expect(appError.path).toBe('mcpJson');
    return appError;
  }
  throw new Error('expected parseMcpJson to reject');
}

const stdio: ServerInput = {
  name: 'files',
  kind: 'stdio',
  description: '',
  command: 'npx',
  args: ['-y', 'files-mcp'],
  env: { API_KEY: 'literal-secret' },
};

const http: ServerInput = {
  name: 'remote',
  kind: 'http',
  description: '',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer literal-secret' },
};

describe('parseMcpJson', () => {
  it('parses stdio and http entries into ServerInput', () => {
    expect(
      parseMcpJson(
        doc({
          files: { command: 'npx', args: ['-y', 'files-mcp'], env: { API_KEY: 'literal-secret' } },
          remote: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer literal-secret' },
          },
        }),
      ),
    ).toEqual([stdio, http]);
  });

  it('accepts the stdio literal and streamable-http type', () => {
    expect(
      parseMcpJson(
        doc({
          files: { type: 'stdio', command: 'npx' },
          remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
        }),
      ),
    ).toEqual([
      { ...stdio, args: [], env: {} },
      { ...http, headers: {} },
    ]);
  });

  it('applies entry defaults', () => {
    expect(
      parseMcpJson(
        doc({
          files: { command: 'npx' },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        }),
      ),
    ).toEqual([
      { ...stdio, args: [], env: {} },
      { ...http, headers: {} },
    ]);
  });

  it('round-trips entries produced by toMcpJsonEntry', () => {
    const entries = {
      files: toMcpJsonEntry(stdio, { EXTRA: 'runtime-secret' }),
      remote: toMcpJsonEntry(http, { 'X-Token': 'runtime-secret' }),
    };
    const parsed = parseMcpJson(doc(entries));
    expect(parsed).toEqual([
      { ...stdio, env: { ...stdio.env, EXTRA: 'runtime-secret' } },
      { ...http, headers: { ...http.headers, 'X-Token': 'runtime-secret' } },
    ]);
  });

  it('strips an optional BOM', () => {
    expect(parseMcpJson(`﻿${doc({ files: { command: 'npx' } })}`)[0]?.name).toBe('files');
  });

  it('accepts exactly 100 servers', () => {
    const servers = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`s${i}`, { command: 'npx' }]),
    );
    expect(parseMcpJson(doc(servers))).toHaveLength(100);
  });

  it('accepts plain $VAR but rejects template placeholders anywhere', () => {
    const tpl = (name: string) => `$${`{${name}}`}`;
    expect(
      parseMcpJson(doc({ files: { command: '$NPX', env: { TOKEN: '$TOKEN' } } })),
    ).toHaveLength(1);

    for (const entry of [
      { command: tpl('NPX') },
      { command: 'npx', args: [tpl('ARG')] },
      { command: 'npx', env: { TOKEN: tpl('TOKEN') } },
      { command: 'npx', env: { [tpl('KEY')]: 'x' } },
      { type: 'http', url: `https://${tpl('HOST')}/mcp` },
      { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: tpl('TOKEN') } },
    ]) {
      const err = reject(doc({ files: entry }));
      expect(err.message).not.toContain('$');
    }
  });

  it('rejects malformed JSON without echoing the input', () => {
    const err = reject('{"mcpServers":{"files":{"command":"super-secret"');
    expect(err.message).not.toContain('super-secret');
  });

  it('rejects non-object roots and extra root keys', () => {
    reject('[]');
    reject('null');
    reject('{}');
    expect(reject('{"mcpServers":{},"other":1}').message).toContain('other');
  });

  it('rejects an empty or oversized server list', () => {
    reject(doc({}));
    const servers = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`s${i}`, { command: 'npx' }]),
    );
    reject(doc(servers));
  });

  it('rejects text over 1 MiB', () => {
    reject(doc({ files: { command: 'npx', args: ['x'.repeat(1_048_576)] } }));
  });

  it('rejects invalid server names silently', () => {
    const err = reject(doc({ 'Bad Name': { command: 'npx' } }));
    expect(err.message).not.toContain('Bad Name');
  });

  it('does not echo an invalid server key when its entry is not an object', () => {
    const key = 'Bearer fixture-secret-key-not-a-slug';
    expect(reject(doc({ [key]: 'invalid entry' })).message).not.toContain(key);
  });

  it('rejects unsupported types without echoing their values', () => {
    for (const type of ['sse', 'ws', 'bogus']) {
      const err = reject(doc({ files: { type, url: 'https://example.com/mcp' } }));
      expect(err.message).not.toContain(type);
    }
  });

  it('rejects url without a type and names every unknown field', () => {
    expect(reject(doc({ files: { url: 'https://example.com/mcp' } })).message).toContain('url');

    const err = reject(
      doc({
        files: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: {},
          title: 'x',
          oauth: {},
        },
      }),
    );
    expect(err.message).toContain('title');
    expect(err.message).toContain('oauth');
  });

  it('rejects credentials in http URLs without echoing them', () => {
    const err = reject(
      doc({ files: { type: 'http', url: 'https://user:password@example.com/mcp' } }),
    );
    expect(err.message).not.toContain('user');
    expect(err.message).not.toContain('password');
  });

  it('rejects non-http URLs and non-string fields', () => {
    reject(doc({ files: { type: 'http', url: 'ftp://example.com/mcp' } }));
    reject(doc({ files: { command: '' } }));
    reject(doc({ files: { command: 1 } }));
    reject(doc({ files: { command: 'npx', args: [1] } }));
    reject(doc({ files: { command: 'npx', env: { TOKEN: 1 } } }));
    reject(doc({ files: { type: 'http', url: 'https://example.com/mcp', headers: { A: 1 } } }));
  });
});
