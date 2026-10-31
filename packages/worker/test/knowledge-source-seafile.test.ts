import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSeafile, readSeafile } from '../src/knowledge/source-seafile.js';
import { SourceAuthError, type SourceConfig } from '../src/knowledge/sources.js';

const SITE = 'http://127.0.0.1:9';
const REPO = '11111111-2222-3333-4444-555555555555';
const fixtureFile = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/knowledge-sources/seafile/${name}`, import.meta.url));
const TREE = JSON.parse(fixtureFile('tree.json').toString('utf8')) as {
  listings: Record<string, DirEntry[]>;
};
const A_MD = fixtureFile('a-md.bin');
const B_PDF = fixtureFile('b-pdf.bin');

type Call = { url: string; method: string; headers: Headers };
type Handler = (url: URL) => Response;
type DirEntry = { type: string; name: string; size?: number; mtime?: number; id?: string };

let calls: Call[] = [];
let handler: Handler = () => new Response('not mocked', { status: 599 });

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fileResponse(bytes: Uint8Array, objectId?: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: objectId === undefined ? {} : { 'x-seafile-object-id': objectId },
  });
}

/** Seafile 11 returns the file object ID in the download-link response header. */
function linkResponse(href: string, oid?: string): Response {
  return new Response(JSON.stringify(href), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(oid === undefined ? {} : { oid }),
    },
  });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      url: url.href,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return handler(url);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(repoId = REPO, paths: string[] = []): SourceConfig {
  return {
    type: 'seafile',
    url: SITE,
    credentials: { apiToken: '{{SECRET_vyfaoqfj}}' },
    settings: { repoId, paths },
    allowLoopback: true,
  };
}

function dir(entries: DirEntry[]): Response {
  return json(entries);
}

function downloadLink(url: URL): { href: string; path: string } | undefined {
  const path = url.searchParams.get('p');
  if (url.pathname.endsWith('/file/') && path) {
    return { href: `${SITE}/files/${path.slice(1)}`, path };
  }
  return undefined;
}

describe('seafile', () => {
  it('walks selected directories recursively with Bearer auth and tokenless downloads', async () => {
    const bodies: Record<string, Uint8Array> = {
      '/files/Documents/a.md': A_MD,
      '/files/Documents/Manuals/b.pdf': B_PDF,
    };
    const oids: Record<string, string> = {
      '/Documents/a.md': 'oid-a',
      '/Documents/Manuals/b.pdf': 'oid-b',
    };
    handler = (url) => {
      if (url.pathname === '/api2/repos/11111111-2222-3333-4444-555555555555/dir/') {
        const path = url.searchParams.get('p');
        const listing = path === null ? undefined : TREE.listings[path];
        if (listing !== undefined) return dir(listing);
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href, oids[link.path]);
      const body = bodies[url.pathname];
      if (body) return fileResponse(body);
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readSeafile(config(REPO, ['Documents']), undefined, undefined);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.cursor).toEqual({ version: 1, initial: true });
    expect(snapshot.items.map((item) => item.path)).toEqual([
      'Documents/a.md',
      'Documents/Manuals/b.pdf',
    ]);
    expect(snapshot.items[0]?.mimeType).toBe('text/markdown');
    expect(snapshot.items[0]?.title).toBe('a.md');
    expect(Buffer.from(snapshot.items[0]?.bytes ?? []).toString('utf8')).toBe('abc');
    expect(
      createHash('sha256')
        .update(snapshot.items[0]?.bytes ?? [])
        .digest('hex'),
    ).toBe(createHash('sha256').update(A_MD).digest('hex'));
    expect(snapshot.items[0]?.revision).toBe('oid-a:10:3');
    expect(snapshot.items[0]?.sourceUrl).toBe('');
    expect(snapshot.items[0]?.externalId.length).toBeLessThan(500);

    const apiCalls = calls.filter((call) => call.url.includes('/api2/'));
    for (const call of apiCalls) {
      expect(call.headers.get('authorization')).toBe('Bearer {{SECRET_vyfaoqfj}}');
    }
    const downloadCalls = calls.filter((call) => call.url.includes('/files/'));
    expect(downloadCalls.length).toBe(2);
    for (const call of downloadCalls) {
      expect(call.headers.get('authorization')).toBeNull();
    }
  });

  it('deduplicates overlapping roots and never merges repos', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        const path = url.searchParams.get('p');
        if (path === '/Documents') {
          return dir([
            { type: 'file', name: 'a.md', size: 3, id: 'oid-a' },
            { type: 'dir', name: 'Manuals' },
          ]);
        }
        if (path === '/Documents/Manuals') {
          return dir([{ type: 'file', name: 'b.md', size: 3, id: 'oid-b' }]);
        }
      }
      const link = downloadLink(url);
      if (link) {
        return linkResponse(link.href, link.path === '/Documents/a.md' ? 'oid-a' : 'oid-b');
      }
      if (url.pathname.startsWith('/files/')) return fileResponse(new TextEncoder().encode('abc'));
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readSeafile(
      config(REPO, ['Documents', 'Documents/Manuals']),
      undefined,
      undefined,
    );
    expect(snapshot.items).toHaveLength(2);
    const other = await readSeafile(config(REPO, ['Documents/Manuals']), undefined, undefined);
    const samePath = other.items.find((item) => item.path === 'Documents/Manuals/b.md');
    const first = snapshot.items.find((item) => item.path === 'Documents/Manuals/b.md');
    expect(samePath?.externalId).toBe(first?.externalId);

    const differentRepo = await readSeafile(
      config('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ['Documents']),
      undefined,
      undefined,
    );
    const crossRepo = differentRepo.items.find((item) => item.path === 'Documents/a.md');
    expect(crossRepo?.externalId).not.toBe(snapshot.items[0]?.externalId);
    expect(crossRepo?.externalId).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('reports a size mismatch without publishing the file', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        return dir([{ type: 'file', name: 'a.md', size: 999, id: 'oid-a' }]);
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href, 'oid-a');
      if (url.pathname.startsWith('/files/')) {
        return fileResponse(new TextEncoder().encode('abc'));
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('size mismatch');
  });

  it('fails before downloading when the download link oid differs from the listing', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        return dir([{ type: 'file', name: 'a.md', size: 3, id: 'old-oid' }]);
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href, 'new-oid');
      if (url.pathname.startsWith('/files/')) {
        throw new Error('download must not start after an oid conflict');
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('object ID');
    expect(calls.filter((call) => call.url.includes('/files/'))).toHaveLength(0);
  });

  it('does not publish when the download link omits the official object ID', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        return dir([{ type: 'file', name: 'a.md', size: 3, id: 'oid-a' }]);
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href);
      if (url.pathname.startsWith('/files/')) {
        return fileResponse(new TextEncoder().encode('abc'), 'oid-a');
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('object ID');
    expect(calls.filter((call) => call.url.includes('/files/'))).toHaveLength(0);
  });

  it('keeps the download response object ID as extra evidence', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        return dir([{ type: 'file', name: 'a.md', size: 3, id: 'oid-a' }]);
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href, 'oid-a');
      if (url.pathname.startsWith('/files/')) {
        return fileResponse(new TextEncoder().encode('abc'), 'other-oid');
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('object ID');
  });

  it('treats an empty directory as complete but a missing root as a failure', async () => {
    let missing = false;
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        if (missing) return new Response('missing', { status: 404 });
        return dir([]);
      }
      return new Response('unexpected', { status: 404 });
    };
    const empty = await readSeafile(config(), undefined, undefined);
    expect(empty.complete).toBe(true);
    expect(empty.items).toEqual([]);

    missing = true;
    await expect(readSeafile(config(), undefined, undefined)).rejects.toThrow(/HTTP 404/);
  });

  it('closes complete for unsupported entries and unknown directory entry types', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        return dir([
          { type: 'file', name: 'tool.exe', size: 3 },
          { type: 'shortcut', name: 'weird' },
        ]);
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.map((failure) => failure.code)).toEqual([
      'unsupported_type',
      'invalid_response',
    ]);
  });

  it('probes the ping and each selected root only', async () => {
    handler = (url) => {
      if (url.pathname === '/api2/auth/ping/') return new Response('pong', { status: 200 });
      if (url.pathname.endsWith('/dir/')) return dir([]);
      return new Response('unexpected', { status: 404 });
    };
    await probeSeafile(config(REPO, ['Documents', 'Manuals']), undefined);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      `${SITE}/api2/auth/ping/`,
      `${SITE}/api2/repos/${REPO}/dir/?p=%2FDocuments`,
      `${SITE}/api2/repos/${REPO}/dir/?p=%2FManuals`,
    ]);
  });

  it('keeps one forbidden subdirectory as a failure and still reads the rest', async () => {
    handler = (url) => {
      if (url.pathname.endsWith('/dir/')) {
        const path = url.searchParams.get('p');
        if (path === '/') {
          return dir([
            { type: 'dir', name: 'Locked' },
            { type: 'file', name: 'visible.md', size: 3, id: 'oid-v' },
          ]);
        }
        if (path === '/Locked') return new Response('forbidden', { status: 403 });
      }
      const link = downloadLink(url);
      if (link) return linkResponse(link.href, 'oid-v');
      if (url.pathname.endsWith('/visible.md')) {
        return fileResponse(new TextEncoder().encode('abc'));
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readSeafile(config(), undefined, undefined);
    expect(snapshot.items.map((item) => item.path)).toEqual(['visible.md']);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures).toHaveLength(1);
  });

  it('turns a 401 into SourceAuthError', async () => {
    handler = () => new Response('unauthorized', { status: 401 });
    await expect(readSeafile(config(), undefined, undefined)).rejects.toBeInstanceOf(
      SourceAuthError,
    );
  });
});
