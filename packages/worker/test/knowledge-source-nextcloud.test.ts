import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeNextcloud, readNextcloud } from '../src/knowledge/source-nextcloud.js';
import { SourceAuthError, type SourceConfig } from '../src/knowledge/sources.js';

const SITE = 'http://127.0.0.1:9';
const fixtureFile = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/knowledge-sources/nextcloud/${name}`, import.meta.url));
const TREE = JSON.parse(fixtureFile('tree.json').toString('utf8')) as {
  documentsDepth0: string;
  documentsDepth1: string;
  subDepth1: string;
  subFileDepth0: string;
};
const A_MD = fixtureFile('a-md.bin');
const B_PDF = fixtureFile('b-pdf.bin');

type Call = { url: string; method: string; headers: Headers; body: string | null };
type Handler = (url: URL, init: RequestInit) => Response;

let calls: Call[] = [];
let handler: Handler = () => new Response('not mocked', { status: 599 });

function xml(value: string): Response {
  return new Response(value, {
    status: 207,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

function props(entry: {
  id?: string;
  etag?: string;
  modified?: string;
  size?: number;
  type?: string;
  collection?: boolean;
}): string {
  return [
    `<x:resourcetype>${entry.collection ? '<x:collection/>' : ''}</x:resourcetype>`,
    entry.etag === undefined ? '' : `<x:getetag>${entry.etag}</x:getetag>`,
    entry.modified === undefined ? '' : `<x:getlastmodified>${entry.modified}</x:getlastmodified>`,
    entry.size === undefined ? '' : `<x:getcontentlength>${entry.size}</x:getcontentlength>`,
    entry.type === undefined ? '' : `<x:getcontenttype>${entry.type}</x:getcontenttype>`,
    entry.id === undefined ? '' : `<nc:id>${entry.id}</nc:id>`,
  ].join('');
}

function response(href: string, property: string, status = 200): string {
  return (
    `<x:response><x:href>${href}</x:href>` +
    `<x:propstat><x:prop>${property}</x:prop>` +
    `<x:status>HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Forbidden'}</x:status></x:propstat>` +
    `</x:response>`
  );
}

/** Required properties succeed while an optional property is explicitly absent. */
function optionalMissing(value: string, property: string): string {
  return (
    `<x:response><x:href>${value}</x:href>` +
    `<x:propstat><x:prop>${property}</x:prop>` +
    `<x:status>HTTP/1.1 200 OK</x:status></x:propstat>` +
    `<x:propstat><x:prop><x:getcontenttype/></x:prop>` +
    `<x:status>HTTP/1.1 404 Not Found</x:status></x:propstat>` +
    `</x:response>`
  );
}

/** Non-default prefixes prove the parser does not depend on `d:`/`oc:`. */
function multistatus(body: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<x:multistatus xmlns:x="DAV:" xmlns:nc="http://owncloud.org/ns">' +
    body +
    '</x:multistatus>'
  );
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
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return handler(url, init ?? {});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(path = '/Documents', username = 'alice'): SourceConfig {
  return {
    type: 'nextcloud',
    url: SITE,
    credentials: { appPassword: '{{SECRET_4mdnus3f}}' },
    settings: { username, path },
    allowLoopback: true,
  };
}

function depth(init: RequestInit): string {
  return new Headers(init.headers).get('depth') ?? '';
}

describe('nextcloud', () => {
  it('reads a tree via PROPFIND, keeps oc:id identity and downloads stable bytes', async () => {
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && url.pathname === '/remote.php/dav/files/alice/Documents') {
        return xml(depth(init) === '0' ? TREE.documentsDepth0 : TREE.documentsDepth1);
      }
      if (
        init.method === 'PROPFIND' &&
        url.pathname === '/remote.php/dav/files/alice/Documents/Sub'
      ) {
        return xml(TREE.subDepth1);
      }
      if (init.method === 'PROPFIND' && url.pathname.endsWith('/Sub/b.pdf')) {
        return xml(TREE.subFileDepth0);
      }
      if (init.method === 'GET' && url.pathname.endsWith('/a.md')) {
        return new Response(A_MD, { headers: { etag: '"v1"' } });
      }
      if (init.method === 'GET' && url.pathname.endsWith('/b.pdf')) {
        return new Response(B_PDF);
      }
      return new Response(`unexpected ${init.method} ${url.href}`, { status: 404 });
    };

    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'nextcloud:file:oc-1',
      'nextcloud:file:oc-2',
    ]);
    expect(snapshot.items.map((item) => item.path)).toEqual([
      'Documents/a.md',
      'Documents/Sub/b.pdf',
    ]);
    expect(snapshot.items[0]?.title).toBe('a.md');
    expect(snapshot.items[0]?.mimeType).toBe('text/markdown');
    expect(Buffer.from(snapshot.items[0]?.bytes ?? []).toString('utf8')).toBe('abc');
    expect(
      createHash('sha256')
        .update(snapshot.items[0]?.bytes ?? [])
        .digest('hex'),
    ).toBe(createHash('sha256').update(A_MD).digest('hex'));
    expect(
      createHash('sha256')
        .update(snapshot.items[1]?.bytes ?? [])
        .digest('hex'),
    ).toBe(createHash('sha256').update(B_PDF).digest('hex'));
    expect(snapshot.items[0]?.revision).toBe('"v1"');
    expect(snapshot.items[0]?.externalId).not.toContain('77');
    expect(snapshot.items[1]?.revision).toBe('W/"weak"');

    for (const call of calls.filter((call) => call.method === 'PROPFIND')) {
      expect(call.body).toContain('<d:propfind');
      expect(call.headers.get('authorization')).toMatch(/^Basic /);
      expect(call.headers.get('depth')).toMatch(/^[01]$/);
    }
    const strongGet = calls.find((call) => call.method === 'GET' && call.url.endsWith('/a.md'));
    expect(strongGet?.headers.get('if-match')).toBe('"v1"');
    const weakGet = calls.find((call) => call.method === 'GET' && call.url.endsWith('/b.pdf'));
    expect(weakGet?.headers.get('if-match')).toBeNull();
    // Weak ETags require one Depth:0 revalidation after the bytes.
    expect(
      calls.some(
        (call) =>
          call.method === 'PROPFIND' &&
          call.url.endsWith('/Sub/b.pdf') &&
          call.headers.get('depth') === '0',
      ),
    ).toBe(true);
  });

  it('keeps a 207 child 403 as an item failure and accepts optional 404 properties', async () => {
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && url.pathname === '/remote.php/dav/files/alice/Documents') {
        if (depth(init) === '0') {
          return xml(
            multistatus(
              response(
                '/remote.php/dav/files/alice/Documents',
                props({ id: '200', collection: true }),
              ),
            ),
          );
        }
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/ok.md',
                props({ id: '1', size: 3, etag: '"ok"' }),
              ) +
              optionalMissing(
                '/remote.php/dav/files/alice/Documents/optional.md',
                props({ id: '2', size: 3, etag: '"optional"' }),
              ) +
              response('/remote.php/dav/files/alice/Documents/secret.md', '', 403),
          ),
        );
      }
      if (init.method === 'GET' && url.pathname.endsWith('/ok.md')) {
        return new Response(new TextEncoder().encode('abc'), { headers: { etag: '"ok"' } });
      }
      if (init.method === 'GET' && url.pathname.endsWith('/optional.md')) {
        return new Response(new TextEncoder().encode('abc'), { headers: { etag: '"optional"' } });
      }
      return new Response(`unexpected ${init.method} ${url.href}`, { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'nextcloud:file:1',
      'nextcloud:file:2',
    ]);
    expect(snapshot.failures?.length).toBe(1);
    expect(snapshot.failures?.[0]?.message).toContain('no successful propstat');
  });

  it('requires oc:id in the ownCloud namespace, not a same-name element elsewhere', async () => {
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                '<x:resourcetype/><x:getcontentlength>3</x:getcontentlength>' +
                  '<z:id xmlns:z="urn:unrelated">wrong-namespace-id</z:id>',
              ),
          ),
        );
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('oc:id');
    expect(calls.some((call) => call.method === 'GET')).toBe(false);
  });

  it('does not count DAV properties carried by a foreign namespace', async () => {
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                '<x:resourcetype/>' +
                  '<z:getcontentlength xmlns:z="urn:unrelated">3</z:getcontentlength>' +
                  '<nc:id>1</nc:id>',
              ),
          ),
        );
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('missing its size');
  });

  it('reads DAV default namespaces and locally rebound ownCloud prefixes', async () => {
    handler = (url, init) => {
      if (init.method === 'PROPFIND') {
        const self =
          '<multistatus xmlns="DAV:"><response>' +
          '<href>/remote.php/dav/files/alice/Documents</href><propstat><prop>' +
          '<resourcetype><collection/></resourcetype>' +
          '<id xmlns="http://owncloud.org/ns">200</id>' +
          '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
        if (depth(init) === '0') return xml(self);
        return xml(
          '<multistatus xmlns="DAV:" xmlns:q="urn:unrelated"><response>' +
            '<href>/remote.php/dav/files/alice/Documents</href><propstat><prop>' +
            '<resourcetype><collection/></resourcetype>' +
            '<id xmlns="http://owncloud.org/ns">200</id>' +
            '</prop><status>HTTP/1.1 200 OK</status></propstat></response>' +
            '<response><href>/remote.php/dav/files/alice/Documents/a.md</href>' +
            '<propstat><prop><resourcetype/><getcontentlength>3</getcontentlength>' +
            '<getetag>"v1"</getetag>' +
            '<q:id xmlns:q="http://owncloud.org/ns">file</q:id>' +
            '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
        );
      }
      if (url.pathname.endsWith('/a.md')) {
        return new Response('abc', { headers: { etag: '"v1"' } });
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual(['nextcloud:file:file']);
    expect(snapshot.items[0]?.revision).toBe('"v1"');
    expect(
      calls.some(
        (call) =>
          call.method === 'PROPFIND' &&
          call.url.endsWith('/a.md') &&
          call.headers.get('depth') === '0',
      ),
    ).toBe(false);
  });

  it('fails a response when any propstat is not 200/404 even if another propstat succeeds', async () => {
    for (const status of [403, 500]) {
      handler = (_url, init) => {
        if (init.method === 'PROPFIND' && depth(init) === '0') {
          return xml(
            multistatus(
              response(
                '/remote.php/dav/files/alice/Documents',
                props({ id: '200', collection: true }),
              ),
            ),
          );
        }
        if (init.method === 'PROPFIND') {
          return xml(
            multistatus(
              response(
                '/remote.php/dav/files/alice/Documents',
                props({ id: '200', collection: true }),
              ) +
                `<x:response><x:href>/remote.php/dav/files/alice/Documents/a.md</x:href>` +
                `<x:propstat><x:prop>${props({ id: '1', size: 3, etag: '"v1"' })}</x:prop>` +
                '<x:status>HTTP/1.1 200 OK</x:status></x:propstat>' +
                '<x:propstat><x:prop><x:getcontenttype/></x:prop>' +
                `<x:status>HTTP/1.1 ${status} Failed</x:status></x:propstat></x:response>`,
            ),
          );
        }
        return new Response('unexpected', { status: 404 });
      };
      const snapshot = await readNextcloud(config(), undefined, undefined);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.items).toEqual([]);
      expect(snapshot.failures?.[0]?.message).toContain(String(status));
      expect(calls.some((call) => call.method === 'GET')).toBe(false);
    }
  });

  it('rejects a 404 propstat that marks a required property unavailable', async () => {
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              `<x:response><x:href>/remote.php/dav/files/alice/Documents/a.md</x:href>` +
              `<x:propstat><x:prop><x:resourcetype/><x:getcontentlength>3</x:getcontentlength></x:prop>` +
              '<x:status>HTTP/1.1 200 OK</x:status></x:propstat>' +
              '<x:propstat><x:prop><nc:id/></x:prop>' +
              '<x:status>HTTP/1.1 404 Not Found</x:status></x:propstat></x:response>',
          ),
        );
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('required');
  });

  it('fails the probe when the first Depth:1 layer reports a failed response', async () => {
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      if (depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      return xml(
        multistatus(
          response(
            '/remote.php/dav/files/alice/Documents',
            props({ id: '200', collection: true }),
          ) + response('/remote.php/dav/files/alice/Documents/secret.md', '', 403),
        ),
      );
    };
    await expect(probeNextcloud(config(), undefined)).rejects.toThrow(/propstat/);
  });

  it('revalidates a weak ETag at Depth:0 even when GET reports the same weak ETag', async () => {
    let revalidated = false;
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0' && url.pathname.endsWith('/a.md')) {
        revalidated = true;
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents/a.md',
              props({ id: '1', size: 3, etag: 'W/"v2"' }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                props({ id: '1', size: 3, etag: 'W/"v1"' }),
              ),
          ),
        );
      }
      if (init.method === 'GET') {
        return new Response('abc', { headers: { etag: 'W/"v1"' } });
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(revalidated).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('changed');
    expect(calls.find((call) => call.method === 'GET')?.headers.get('if-match')).toBeNull();
  });

  it('does not treat an all-missing fingerprint as stable', async () => {
    let revalidated = false;
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0' && url.pathname.endsWith('/a.md')) {
        revalidated = true;
        return xml(
          multistatus(
            response('/remote.php/dav/files/alice/Documents/a.md', props({ id: '1', size: 3 })),
          ),
        );
      }
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) + response('/remote.php/dav/files/alice/Documents/a.md', props({ id: '1', size: 3 })),
          ),
        );
      }
      if (init.method === 'GET') return new Response('abc');
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(revalidated).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('validator');
  });

  it('accepts a missing ETag when modified and size form a comparable fingerprint', async () => {
    const modified = 'Mon, 01 Jan 2024 00:00:00 GMT';
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0' && url.pathname.endsWith('/a.md')) {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents/a.md',
              props({ id: '1', size: 3, modified }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                props({ id: '1', size: 3, modified }),
              ),
          ),
        );
      }
      if (init.method === 'GET') return new Response('abc');
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual(['nextcloud:file:1']);
    expect(snapshot.items[0]?.revision).toBe(`${modified}:3`);
  });

  it('rejects a listing whose getlastmodified is not an HTTP date', async () => {
    handler = (url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0' && url.pathname.endsWith('/a.md')) {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents/a.md',
              props({ id: '1', size: 3, modified: 'not-a-date' }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                props({ id: '1', size: 3, modified: 'not-a-date' }),
              ),
          ),
        );
      }
      if (init.method === 'GET') return new Response('abc');
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('getlastmodified');
  });

  it('fails the walk when the Depth:1 self response stops being a collection', async () => {
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      if (depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      return xml(
        multistatus(
          response('/remote.php/dav/files/alice/Documents', props({ id: '201', size: 3 })),
        ),
      );
    };
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/directory/);
    expect(calls.some((call) => call.method === 'GET')).toBe(false);
  });

  it('fails the probe when the Depth:1 self response stops being a collection', async () => {
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      if (depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      return xml(
        multistatus(
          response('/remote.php/dav/files/alice/Documents', props({ id: '201', size: 3 })),
        ),
      );
    };
    await expect(probeNextcloud(config(), undefined)).rejects.toThrow(/directory/);
  });

  it('rejects a response that is missing oc:id instead of falling back to a path', async () => {
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) + response('/remote.php/dav/files/alice/Documents/no-id.md', props({ size: 3 })),
          ),
        );
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readNextcloud(config(), undefined, undefined);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.failures?.[0]?.message).toContain('oc:id');
  });

  it('keeps identity across a rename and changes only sourcePath', async () => {
    let name = 'a.md';
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                `/remote.php/dav/files/alice/Documents/${name}`,
                props({ id: 'stable', size: 3, etag: '"stable"' }),
              ),
          ),
        );
      }
      if (init.method === 'GET') {
        return new Response(new TextEncoder().encode('abc'), { headers: { etag: '"stable"' } });
      }
      return new Response('unexpected', { status: 404 });
    };
    const first = await readNextcloud(config(), undefined, undefined);
    name = 'renamed.md';
    const second = await readNextcloud(config(), undefined, undefined);
    expect(first.items[0]?.externalId).toBe('nextcloud:file:stable');
    expect(second.items[0]?.externalId).toBe('nextcloud:file:stable');
    expect(first.items[0]?.path).toBe('Documents/a.md');
    expect(second.items[0]?.path).toBe('Documents/renamed.md');
  });

  it('rejects DTDs, malformed XML and non-DAV namespaces', async () => {
    let mode: 'dtd' | 'malformed' | 'namespace' = 'dtd';
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      if (mode === 'dtd') {
        return xml(
          '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
            multistatus(response('/remote.php/dav/files/alice/Documents', props({ id: '200' }))),
        );
      }
      if (mode === 'malformed') return xml('<x:multistatus xmlns:x="DAV:"><x:response>');
      return xml(
        '<multistatus xmlns="urn:not-dav"><response><href>/remote.php/dav/files/alice/Documents</href></response></multistatus>',
      );
    };
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/DTD/);
    mode = 'malformed';
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/invalid/);
    mode = 'namespace';
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/DAV namespace/);
  });

  it('rejects hrefs outside the current user DAV root or deeper than the listing', async () => {
    let href = '/remote.php/dav/files/bob/Documents/a.md';
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) + response(href, props({ id: '1', size: 3 })),
          ),
        );
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/DAV root/);
    href = '/remote.php/dav/files/alice/Documents/Sub/deep.md';
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(
      /outside the requested directory/,
    );
    href = '/remote.php/dav/files/alice/Documents/a%2Fb.md';
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/encoded slash/);
  });

  it('fails an If-Match 412 or a size mismatch without publishing the file', async () => {
    let mode: 'if-match' | 'size' = 'if-match';
    handler = (_url, init) => {
      if (init.method === 'PROPFIND' && depth(init) === '0') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ),
          ),
        );
      }
      if (init.method === 'PROPFIND') {
        return xml(
          multistatus(
            response(
              '/remote.php/dav/files/alice/Documents',
              props({ id: '200', collection: true }),
            ) +
              response(
                '/remote.php/dav/files/alice/Documents/a.md',
                props({ id: '1', size: mode === 'size' ? 10 : 3, etag: '"v1"' }),
              ),
          ),
        );
      }
      if (init.method === 'GET') {
        if (mode === 'if-match') return new Response('precondition failed', { status: 412 });
        return new Response(new TextEncoder().encode('abc'), { headers: { etag: '"v1"' } });
      }
      return new Response('unexpected', { status: 404 });
    };
    const failed = await readNextcloud(config(), undefined, undefined);
    expect(failed.complete).toBe(false);
    expect(failed.items).toEqual([]);
    expect(failed.failures?.[0]?.message).toContain('HTTP 412');

    mode = 'size';
    const mismatch = await readNextcloud(config(), undefined, undefined);
    expect(mismatch.complete).toBe(false);
    expect(mismatch.items).toEqual([]);
    expect(mismatch.failures?.[0]?.message).toContain('size mismatch');
  });

  it('treats a missing selected directory as a failure, not an empty range', async () => {
    handler = () => new Response('missing', { status: 404 });
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/HTTP 404/);
  });

  it('turns a 401 into SourceAuthError', async () => {
    handler = () => new Response('unauthorized', { status: 401 });
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toBeInstanceOf(
      SourceAuthError,
    );
  });

  it('probes Depth:0 and Depth:1 without downloading the tree', async () => {
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      return xml(
        multistatus(
          response('/remote.php/dav/files/alice/Documents', props({ id: '200', collection: true })),
        ),
      );
    };
    await probeNextcloud(config(), undefined);
    expect(calls.map((call) => call.method)).toEqual(['PROPFIND', 'PROPFIND']);
    expect(calls.map((call) => call.headers.get('depth'))).toEqual(['0', '1']);
  });

  it('rejects a range path that is a file rather than a directory', async () => {
    handler = (_url, init) => {
      if (init.method !== 'PROPFIND') return new Response('unexpected', { status: 404 });
      return xml(
        multistatus(response('/remote.php/dav/files/alice/Documents', props({ id: '1', size: 3 }))),
      );
    };
    await expect(readNextcloud(config(), undefined, undefined)).rejects.toThrow(/not a directory/);
  });

  it('stops when the caller aborts before the first request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readNextcloud(config(), undefined, controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
