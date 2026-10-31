import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBytes,
  fetchChecked,
  readBytesCapped,
  SourceAuthError,
} from '../src/knowledge/source-http.js';

type Call = { url: string; init: RequestInit };

const calls: Call[] = [];
const trustedHosts = ['a.test', 'b.test'];

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const request = init ?? {};
      calls.push({ url, init: request });
      return handler(url, request);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('source HTTP helper', () => {
  it('keeps POST body on the bound origin and drops it with credentials on a redirect', async () => {
    mockFetch(async (url) =>
      url === 'https://a.test/export'
        ? new Response(null, { status: 302, headers: { location: 'https://b.test/next' } })
        : new Response('[]', { status: 200 }),
    );

    await fetchChecked('https://a.test/export', {
      method: 'POST',
      body: '{"token":"secret"}',
      headers: {
        authorization: 'Bearer api-token',
        'content-type': 'application/json',
      },
      authOrigin: 'https://a.test',
      trustedHosts,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"token":"secret"}');
    expect(headersOf(calls[0]?.init ?? {}).get('authorization')).toBe('Bearer api-token');
    expect(calls[1]?.init.method).toBe('GET');
    expect(calls[1]?.init.body).toBeUndefined();
    expect(headersOf(calls[1]?.init ?? {}).get('authorization')).toBeNull();
  });

  it('keeps PROPFIND and its body on the bound origin', async () => {
    mockFetch(async () => new Response('<multistatus/>', { status: 207 }));

    await fetchChecked('https://a.test/remote.php/dav/files/u/', {
      method: 'PROPFIND',
      body: '<propfind/>',
      headers: { authorization: 'Basic dTpw', depth: '1' },
      authOrigin: 'https://a.test',
      trustedHosts,
    });

    expect(calls[0]?.init.method).toBe('PROPFIND');
    expect(calls[0]?.init.body).toBe('<propfind/>');
    expect(headersOf(calls[0]?.init ?? {}).get('depth')).toBe('1');
  });

  it('never reattaches credentials when a redirect returns to the original origin', async () => {
    mockFetch(async (url) => {
      if (url === 'https://a.test/start') {
        return new Response(null, { status: 302, headers: { location: 'https://b.test/middle' } });
      }
      if (url === 'https://b.test/middle') {
        return new Response(null, { status: 302, headers: { location: 'https://a.test/final' } });
      }
      return new Response('ok', { status: 200 });
    });

    await fetchChecked('https://a.test/start', {
      headers: { authorization: 'Bearer api-token' },
      authOrigin: 'https://a.test',
      trustedHosts,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://a.test/start',
      'https://b.test/middle',
      'https://a.test/final',
    ]);
    expect(headersOf(calls[0]?.init ?? {}).get('authorization')).toBe('Bearer api-token');
    expect(headersOf(calls[1]?.init ?? {}).get('authorization')).toBeNull();
    // A -> B -> A：回到原 origin 也不能重新带上敏感头。
    expect(headersOf(calls[2]?.init ?? {}).get('authorization')).toBeNull();
  });

  it('classifies 401/403 as an item failure when requested', async () => {
    mockFetch(async () => new Response('expired', { status: 401 }));

    await expect(fetchChecked('https://a.test/file', { trustedHosts })).rejects.toBeInstanceOf(
      SourceAuthError,
    );

    const error = await fetchChecked('https://a.test/file', {
      authFailure: 'item',
      trustedHosts,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceAuthError);
    expect((error as Error).message).toContain('HTTP 401');
  });

  it('keeps signed query strings out of redirect errors', async () => {
    mockFetch(async () => new Response(null, { status: 302 }));

    const missingLocation = await fetchChecked('https://a.test/start?token=super-secret', {
      trustedHosts,
    }).catch((caught: unknown) => caught as Error);
    expect(missingLocation.message).toContain('https://a.test/start');
    expect(missingLocation.message).not.toContain('super-secret');
  });

  it('keeps signed query strings out of the redirect-limit error', async () => {
    mockFetch(
      async () => new Response(null, { status: 302, headers: { location: 'https://b.test/next' } }),
    );

    const limited = await fetchChecked('https://a.test/start?token=super-secret', {
      trustedHosts,
    }).catch((caught: unknown) => caught as Error);
    expect(limited.message).toContain('https://a.test/start');
    expect(limited.message).not.toContain('super-secret');
  });

  it('rejects routing/hop-by-hop headers and CR/LF before sending', async () => {
    mockFetch(async () => new Response('ok', { status: 200 }));

    await expect(
      fetchChecked('https://a.test/x', {
        headers: { host: 'evil.test' },
        trustedHosts,
      }),
    ).rejects.toThrow(/host/i);
    await expect(
      fetchChecked('https://a.test/x', {
        headers: { authorization: 'Bearer a\r\nx-injected: 1' },
        trustedHosts,
      }),
    ).rejects.toThrow(/CR\/LF/);
    expect(calls).toHaveLength(0);
  });

  it('preserves non-UTF8 bytes and enforces the response size cap', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe]);
    mockFetch(async () => new Response(bytes, { status: 200 }));

    const downloaded = await fetchBytes('https://a.test/file', { trustedHosts }, 'file');
    expect(downloaded.equals(bytes)).toBe(true);

    const oversized = new Response('x', {
      status: 200,
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    });
    await expect(readBytesCapped(oversized, 'file')).rejects.toThrow(/exceeds/);
  });
});
