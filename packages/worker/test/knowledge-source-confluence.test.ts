import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeConfluence, readConfluence } from '../src/knowledge/source-confluence.js';
import { SourceAuthError, type SourceConfig } from '../src/knowledge/sources.js';

// Scoped tokens use the fixed Atlassian gateway; resolve it to a public address
// so validateSourceUrl never touches real DNS, while fetch stays fully mocked.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const SITE = 'http://127.0.0.1:9';
const SIGNED = 'http://127.0.0.1:10';
const fixtureFile = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/knowledge-sources/confluence/${name}`, import.meta.url));
type CloudFixture = {
  space: unknown;
  pagesFirst: unknown;
  pagesSecond: unknown;
  pages: Record<string, unknown>;
  attachments: unknown;
};
const cloudBasic = JSON.parse(fixtureFile('cloud-basic.json').toString('utf8')) as CloudFixture;
const dcSpaceList = JSON.parse(fixtureFile('dc-space-list.json').toString('utf8'));
const dcSpace = JSON.parse(fixtureFile('dc-space.json').toString('utf8'));
const dcPagesPage1 = JSON.parse(fixtureFile('dc-pages-page1.json').toString('utf8'));
const dcPagesPage2 = JSON.parse(fixtureFile('dc-pages-page2.json').toString('utf8'));
const dcPage = JSON.parse(fixtureFile('dc-page.json').toString('utf8'));
const dcAttachmentList = JSON.parse(fixtureFile('dc-attachment-list.json').toString('utf8'));
const cloudFolder = JSON.parse(fixtureFile('cloud-folder.json').toString('utf8'));
const PNG = fixtureFile('attachment.bin');
const PDF = Buffer.from('%PDF-1.7\nconfluence attachment');

type Call = { url: string; method: string; headers: Headers; body: string | null };
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

let calls: Call[] = [];
let handler: Handler = () => new Response('not mocked', { status: 599 });

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function body(init: RequestInit): string | null {
  return typeof init.body === 'string' ? init.body : null;
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
      body: body(init ?? {}),
    });
    return handler(url, init ?? {});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(
  settings: Record<string, unknown>,
  credentials: Record<string, string> = {},
): SourceConfig {
  return {
    type: 'confluence',
    url: SITE,
    credentials,
    settings,
    allowLoopback: true,
  };
}

function basicConfig(settings: Record<string, unknown>): SourceConfig {
  return config(
    {
      authMode: 'cloud_basic',
      email: 'user@example.com',
      siteUrl: SITE,
      ...settings,
    },
    { apiToken: 'cloud-token' },
  );
}

function pageDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    title: 'Root Page',
    status: 'current',
    spaceId: '123',
    version: { number: 3 },
    body: {
      view: {
        value: '<h1>Root</h1><table><tr><td>A</td></tr></table><pre><code>x</code></pre>',
      },
    },
    _links: { webui: '/wiki/spaces/DOC/pages/1/Root' },
    ...overrides,
  };
}

describe('confluence cloud_basic', () => {
  it('reads a space across pages, keeps HTML bytes and strips the token on a signed redirect', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/wiki/api/v2/spaces/123') {
        return json(cloudBasic.space);
      }
      if (path === '/wiki/api/v2/spaces/123/pages') {
        return json(
          url.searchParams.get('cursor') === null ? cloudBasic.pagesFirst : cloudBasic.pagesSecond,
        );
      }
      if (path === '/wiki/api/v2/pages/1' && url.searchParams.get('body-format') === 'view') {
        return json(cloudBasic.pages['1']);
      }
      if (path === '/wiki/api/v2/pages/2') {
        return json(cloudBasic.pages['2']);
      }
      if (path === '/wiki/api/v2/pages/3') {
        return json(cloudBasic.pages['3']);
      }
      if (path === '/wiki/api/v2/pages/1/attachments') {
        return json(cloudBasic.attachments);
      }
      if (
        path === '/wiki/api/v2/pages/2/attachments' ||
        path === '/wiki/api/v2/pages/3/attachments'
      ) {
        return json({ results: [] });
      }
      if (path === '/wiki/rest/api/content/1/child/attachment/att-1/download') {
        return redirect(`${SIGNED}/signed/att-1?token=one-time`);
      }
      if (path === '/signed/att-1') {
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );

    expect(snapshot.complete).toBe(true);
    expect(snapshot.cursor).toEqual({ version: 1, initial: true });
    const pages = snapshot.items.filter((item) => item.externalId.startsWith('confluence:page:'));
    expect(pages.map((item) => item.externalId)).toEqual([
      'confluence:page:1',
      'confluence:page:2',
      'confluence:page:3',
    ]);
    const root = pages[0];
    expect(root?.mimeType).toBe('text/html');
    expect(Buffer.from(root?.bytes ?? []).toString('utf8')).toContain('<table>');
    expect(root?.content).toBe('');
    expect(root?.path).toBe('DOC/Root Page.html');
    expect(root?.sourceUrl).toBe(`${SITE}/wiki/spaces/DOC/pages/1/Root`);
    expect(root?.revision).toBe('3');

    const attachment = snapshot.items.find(
      (item) => item.externalId === 'confluence:attachment:att-1',
    );
    expect(attachment?.path).toBe('DOC/Root Page/diagram.png');
    expect(attachment?.title).toBe('diagram.png');
    expect(attachment?.mimeType).toBe('image/png');
    expect(Buffer.from(attachment?.bytes ?? [])).toEqual(PNG);
    expect(
      createHash('sha256')
        .update(attachment?.bytes ?? [])
        .digest('hex'),
    ).toBe(createHash('sha256').update(fixtureFile('attachment.bin')).digest('hex'));
    expect(attachment?.revision).toBe('2');

    const gateway = calls.find((call) =>
      call.url.startsWith(`${SITE}/wiki/rest/api/content/1/child/attachment/att-1/download`),
    );
    expect(gateway?.headers.get('authorization')).toMatch(/^Basic /);
    // The provider-provided download link is never used, and identity is the
    // attachment ID rather than the fileId.
    expect(calls.some((call) => call.url.includes('untrusted-download'))).toBe(false);
    expect(calls.some((call) => call.url.includes('file-999'))).toBe(false);

    const signed = calls.find((call) => call.url === `${SIGNED}/signed/att-1?token=one-time`);
    expect(signed?.headers.get('authorization')).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('token=one-time');
  });

  it('rejects pagination links that leave the API origin or context', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') {
        return json({ id: '123', key: 'DOC' });
      }
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({
          results: [{ id: '1', title: 'Root', spaceId: '123' }],
          _links: { next: 'https://evil.example/api/v2/spaces/123/pages?foo=1' },
        });
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/API origin/);
  });

  it('rejects a pagination link that stays on the origin but leaves the API context', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({
          results: [{ id: '1', title: 'Root', spaceId: '123' }],
          _links: { next: `${SITE}/other/api/v2/spaces/123/pages?foo=1` },
        });
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/context path/);
  });

  it('follows a Link rel=next page that has no _links.next', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (path === '/wiki/api/v2/spaces/123/pages') {
        if (url.searchParams.get('cursor') === null) {
          return json(
            { results: [{ id: '1', title: 'First', spaceId: '123' }] },
            {
              headers: {
                link: `<${SITE}/wiki/api/v2/spaces/123/pages?status=current&depth=all&limit=250&cursor=p2>; rel="next"`,
              },
            },
          );
        }
        return json({ results: [{ id: '2', title: 'Second', spaceId: '123' }] });
      }
      if (path === '/wiki/api/v2/pages/1') return json(pageDetail({ id: '1', title: 'First' }));
      if (path === '/wiki/api/v2/pages/2') return json(pageDetail({ id: '2', title: 'Second' }));
      if (path.endsWith('/attachments')) return json({ results: [] });
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:1',
      'confluence:page:2',
    ]);
    expect(calls.map((call) => call.url)).toContain(
      `${SITE}/wiki/api/v2/spaces/123/pages?status=current&depth=all&limit=250&cursor=p2`,
    );
  });

  it('rejects a foreign _links.next before taking its cursor', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({
          results: [{ id: '1', title: 'Root', spaceId: '123' }],
          _links: { next: 'https://evil.example/outside?cursor=second' },
        });
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/API origin/);
    expect(calls.some((call) => call.url.includes('evil.example'))).toBe(false);
  });

  it('rejects a foreign Link rel=next before taking its cursor', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json(
          { results: [{ id: '1', title: 'Root', spaceId: '123' }] },
          { headers: { link: '<https://evil.example/outside?cursor=second>; rel="next"' } },
        );
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/API origin/);
    expect(calls.some((call) => call.url.includes('evil.example'))).toBe(false);
  });

  it('keeps a failed page detail as an item failure and still emits later pages', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({
          results: [
            { id: '1', title: 'First', spaceId: '123' },
            { id: '2', title: 'Broken', spaceId: '123' },
            { id: '3', title: 'Third', spaceId: '123' },
          ],
        });
      }
      if (url.pathname === '/wiki/api/v2/pages/1')
        return json(pageDetail({ id: '1', title: 'First' }));
      if (url.pathname === '/wiki/api/v2/pages/2') return new Response('gone', { status: 404 });
      if (url.pathname === '/wiki/api/v2/pages/3')
        return json(pageDetail({ id: '3', title: 'Third' }));
      if (url.pathname.endsWith('/attachments')) return json({ results: [] });
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:1',
      'confluence:page:3',
    ]);
    expect(snapshot.failures).toEqual([
      expect.objectContaining({ externalId: 'confluence:page:2', code: 'fetch_failed' }),
    ]);
  });

  it('keeps a failed attachment download as an item failure without complete', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({ results: [{ id: '1', title: 'Root', spaceId: '123' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/attachments') {
        return json({
          results: [{ id: 'att-1', title: 'broken.pdf', mediaType: 'application/pdf' }],
        });
      }
      if (url.pathname === '/wiki/rest/api/content/1/child/attachment/att-1/download') {
        return new Response('expired link', { status: 403 });
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.some((item) => item.externalId === 'confluence:page:1')).toBe(true);
    expect(snapshot.failures).toEqual([
      expect.objectContaining({
        externalId: 'confluence:attachment:att-1',
        code: 'fetch_failed',
      }),
    ]);
  });

  it('does not publish an empty attachment download as a document', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({ results: [{ id: '1', title: 'Root', spaceId: '123' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/attachments') {
        return json({ results: [{ id: 'att-1', title: 'empty.txt', mediaType: 'text/plain' }] });
      }
      if (url.pathname === '/wiki/rest/api/content/1/child/attachment/att-1/download') {
        return new Response(new Uint8Array(), { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.some((item) => item.externalId === 'confluence:attachment:att-1')).toBe(
      false,
    );
    expect(snapshot.failures?.[0]?.message).toContain('0 bytes');
  });

  it('keeps a known attachment size and fails only when the download length differs', async () => {
    const attachment = {
      id: 'att-1',
      type: 'attachment',
      status: 'current',
      title: 'a.pdf',
      mediaType: 'application/pdf',
      fileSize: 20,
      version: { number: 1 },
    };
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({ results: [{ id: '1', title: 'Root', spaceId: '123' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/attachments') {
        return json({ results: [attachment] });
      }
      if (url.pathname === '/wiki/rest/api/content/1/child/attachment/att-1/download') {
        return new Response('abc', { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.some((item) => item.externalId === 'confluence:attachment:att-1')).toBe(
      false,
    );
    expect(snapshot.failures).toEqual([
      expect.objectContaining({
        externalId: 'confluence:attachment:att-1',
        code: 'fetch_failed',
        message: expect.stringContaining('20'),
      }),
    ]);
  });

  it('publishes an attachment download whose length matches the known size', async () => {
    const attachment = {
      id: 'att-1',
      type: 'attachment',
      status: 'current',
      title: 'a.txt',
      mediaType: 'text/plain',
      fileSize: 3,
      version: { number: 1 },
    };
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      if (url.pathname === '/wiki/api/v2/spaces/123/pages') {
        return json({ results: [{ id: '1', title: 'Root', spaceId: '123' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/attachments') {
        return json({ results: [attachment] });
      }
      if (url.pathname === '/wiki/rest/api/content/1/child/attachment/att-1/download') {
        return new Response('abc', { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    };

    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    const emitted = snapshot.items.find(
      (item) => item.externalId === 'confluence:attachment:att-1',
    );
    expect(Buffer.from(emitted?.bytes ?? []).toString('utf8')).toBe('abc');
  });

  it('rejects a page subtree that crosses into another space', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/direct-children') {
        return json({ results: [{ id: '2', title: 'Foreign', spaceId: '999' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/2') {
        return json(pageDetail({ id: '2', title: 'Foreign', spaceId: '999' }));
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_page', resourceId: '1' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/another space/);
  });

  it('walks page and folder direct children for a page range', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/direct-children') {
        return json({
          results: [
            { id: '2', title: 'Child', spaceId: '123' },
            { id: 'folder-7', title: 'Folder', spaceId: '123', type: 'folder' },
          ],
        });
      }
      if (url.pathname === '/wiki/api/v2/pages/2') {
        return json(pageDetail({ id: '2', title: 'Child', spaceId: '123' }));
      }
      if (url.pathname === '/wiki/api/v2/pages/2/direct-children') {
        return json({ results: [] });
      }
      if (url.pathname === '/wiki/api/v2/pages/3/direct-children') {
        return json({ results: [] });
      }
      if (url.pathname === '/wiki/api/v2/folders/folder-7/direct-children') {
        return json({ results: [{ id: '3', title: 'In Folder', spaceId: '123' }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/3') {
        return json(pageDetail({ id: '3', title: 'In Folder', spaceId: '123' }));
      }
      if (url.pathname.endsWith('/attachments')) return json({ results: [] });
      return new Response('unexpected', { status: 404 });
    };
    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_page', resourceId: '1' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:1',
      'confluence:page:2',
      'confluence:page:3',
    ]);
  });

  it('rejects a folder child that belongs to another space before queueing it', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (url.pathname === '/wiki/api/v2/pages/1/direct-children') {
        return json({
          results: [{ id: 'folder-7', title: 'Foreign Folder', spaceId: '999', type: 'folder' }],
        });
      }
      if (url.pathname === '/wiki/api/v2/folders/folder-7/direct-children') {
        return json({ results: [] });
      }
      if (url.pathname.endsWith('/attachments')) return json({ results: [] });
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_page', resourceId: '1' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/another space/);
    expect(calls.some((call) => call.url.includes('/folders/folder-7/'))).toBe(false);
  });

  it('confirms a folder without spaceId through its official folder metadata', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (path === '/wiki/api/v2/pages/1/direct-children') {
        return json({ results: [{ id: 'folder-7', title: 'Folder', type: 'folder' }] });
      }
      if (path === '/wiki/api/v2/folders/folder-7') return json(cloudFolder);
      if (path === '/wiki/api/v2/folders/folder-7/direct-children') {
        return json({ results: [{ id: '3', title: 'In Folder', spaceId: '123' }] });
      }
      if (path === '/wiki/api/v2/pages/3') {
        return json(pageDetail({ id: '3', title: 'In Folder', spaceId: '123' }));
      }
      if (path === '/wiki/api/v2/pages/3/direct-children') return json({ results: [] });
      if (path.endsWith('/attachments')) return json({ results: [] });
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };
    const snapshot = await readConfluence(
      basicConfig({ rangeKind: 'confluence_page', resourceId: '1' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:1',
      'confluence:page:3',
    ]);
    expect(calls.map((call) => call.url)).toContain(`${SITE}/wiki/api/v2/folders/folder-7`);
  });

  it('never guesses a folder space when the official metadata has no spaceId', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/wiki/api/v2/pages/1') return json(pageDetail());
      if (path === '/wiki/api/v2/pages/1/direct-children') {
        return json({ results: [{ id: 'folder-7', title: 'Folder', type: 'folder' }] });
      }
      if (path === '/wiki/api/v2/folders/folder-7') {
        return json({ id: 'folder-7', type: 'folder', status: 'current', title: 'Folder' });
      }
      if (path.endsWith('/attachments')) return json({ results: [] });
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_page', resourceId: '1' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/did not return its spaceId/);
  });

  it('stops when the caller aborts before the first request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readConfluence(
        basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('probes only the selected space metadata', async () => {
    handler = (url) => {
      if (url.pathname === '/wiki/api/v2/spaces/123') return json({ id: '123', key: 'DOC' });
      return new Response('unexpected', { status: 404 });
    };
    await probeConfluence(
      basicConfig({ rangeKind: 'confluence_space', resourceId: '123' }),
      undefined,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SITE}/wiki/api/v2/spaces/123`);
  });
});

describe('confluence dc_pat', () => {
  function dcConfig(settings: Record<string, unknown>): SourceConfig {
    return config({ authMode: 'dc_pat', siteUrl: SITE, ...settings }, { pat: 'dc-pat' });
  }

  function dcSpaceHandler(): Handler {
    return (url) => {
      const path = url.pathname;
      if (path === '/rest/api/space') return json(dcSpaceList);
      if (path === '/rest/api/space/DOC') return json(dcSpace);
      if (path === '/rest/api/space/DOC/content/page') {
        return json({ ...dcPagesPage1, _links: {} });
      }
      if (path === '/rest/api/content/100') return json(dcPage);
      if (path === '/rest/api/content/100/child/attachment') return json(dcAttachmentList);
      if (path === '/rest/api/content/100/child/attachment/55/download') {
        return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
      }
      if (path === '/rest/api/content/100/child/page') {
        return json({ results: [], start: 0, limit: 100, size: 0, _links: {} });
      }
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };
  }

  it('resolves a numeric space ID through the official space list before using the key', async () => {
    handler = dcSpaceHandler();

    const snapshot = await readConfluence(
      dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:100',
      'confluence:attachment:55',
    ]);
    expect(snapshot.items[0]?.path).toBe('DOC/DC Page.html');
    expect(snapshot.items[0]?.sourceUrl).toBe(`${SITE}/display/DOC/DC+Page`);
    expect(Buffer.from(snapshot.items[1]?.bytes ?? [])).toEqual(PDF);

    const urls = calls.map((call) => call.url);
    expect(urls).toContain(`${SITE}/rest/api/space?start=0&limit=100`);
    expect(urls).toContain(`${SITE}/rest/api/space/DOC`);
    expect(urls.some((url) => url.startsWith(`${SITE}/rest/api/space/42`))).toBe(false);
    for (const call of calls.filter((entry) => entry.url.startsWith(`${SITE}/rest/api/`))) {
      expect(call.headers.get('authorization')).toBe('Bearer dc-pat');
    }
  });

  it('probes a numeric DC space through the space list and verifies the key metadata ID', async () => {
    handler = dcSpaceHandler();
    await probeConfluence(dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }), undefined);
    expect(calls.map((call) => call.url)).toEqual([
      `${SITE}/rest/api/space?start=0&limit=100`,
      `${SITE}/rest/api/space/DOC`,
    ]);
  });

  it('rejects DC space metadata whose ID does not match the requested space', async () => {
    handler = (url) => {
      if (url.pathname === '/rest/api/space') return json(dcSpaceList);
      if (url.pathname === '/rest/api/space/DOC') return json({ ...dcSpace, id: 99 });
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      probeConfluence(dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }), undefined),
    ).rejects.toThrow(/did not match/);
  });

  it('reads every equal-size DC page and ends on the real next link, not on size', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/rest/api/space') return json(dcSpaceList);
      if (path === '/rest/api/space/DOC') return json(dcSpace);
      if (path === '/rest/api/space/DOC/content/page') {
        return json(url.searchParams.get('start') === '0' ? dcPagesPage1 : dcPagesPage2);
      }
      if (/^\/rest\/api\/content\/10[01]$/.test(path)) {
        return json({
          ...dcPage,
          id: path.endsWith('101') ? '101' : '100',
          title: path.endsWith('101') ? 'DC Page Two' : 'DC Page',
        });
      }
      if (path.endsWith('/attachments') || path.endsWith('/child/attachment')) {
        return json({ results: [], start: 0, limit: 100, size: 0, _links: {} });
      }
      if (path.endsWith('/child/page')) {
        return json({ results: [], start: 0, limit: 100, size: 0, _links: {} });
      }
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readConfluence(
      dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:100',
      'confluence:page:101',
    ]);
    expect(calls.map((call) => call.url)).toContain(
      `${SITE}/rest/api/space/DOC/content/page?start=1&limit=100`,
    );
  });

  it('keeps the empty-page, repeated-page and page-limit guards', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/rest/api/space') return json(dcSpaceList);
      if (path === '/rest/api/space/DOC') return json(dcSpace);
      if (path === '/rest/api/space/DOC/content/page') {
        return json({
          results: [],
          start: Number(url.searchParams.get('start')),
          limit: 100,
          size: 0,
          _links: { next: '/rest/api/space/DOC/content/page?start=1&limit=100' },
        });
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/empty page before the end/);
  });

  it('resolves official application-relative next links inside the bound context', async () => {
    const context = `${SITE}/confluence`;
    handler = (url) => {
      const path = url.pathname;
      if (path === '/confluence/rest/api/space') return json(dcSpaceList);
      if (path === '/confluence/rest/api/space/DOC') return json(dcSpace);
      if (path === '/confluence/rest/api/space/DOC/content/page') {
        return json(url.searchParams.get('start') === '0' ? dcPagesPage1 : dcPagesPage2);
      }
      if (/^\/confluence\/rest\/api\/content\/10[01]$/.test(path)) {
        return json({ ...dcPage, id: path.endsWith('101') ? '101' : '100' });
      }
      if (path.endsWith('/child/attachment') || path.endsWith('/child/page')) {
        return json({ results: [], start: 0, limit: 100, size: 0, _links: {} });
      }
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readConfluence(
      config(
        {
          authMode: 'dc_pat',
          siteUrl: context,
          rangeKind: 'confluence_space',
          resourceId: '42',
        },
        { pat: 'dc-pat' },
      ),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'confluence:page:100',
      'confluence:page:101',
    ]);
    expect(calls.map((call) => call.url)).toContain(
      `${context}/rest/api/space/DOC/content/page?start=1&limit=100`,
    );
    expect(calls.some((call) => call.url.startsWith(`${SITE}/rest/api/`))).toBe(false);
  });

  it('rejects a DC next link that leaves the bound origin', async () => {
    handler = (url) => {
      const path = url.pathname;
      if (path === '/rest/api/space') return json(dcSpaceList);
      if (path === '/rest/api/space/DOC') return json(dcSpace);
      if (path === '/rest/api/space/DOC/content/page') {
        return json({
          results: [{ id: '100', title: 'DC Page', space: { key: 'DOC' } }],
          start: 0,
          limit: 100,
          size: 1,
          _links: { next: 'https://evil.example/rest/api/space/DOC/content/page?start=1' },
        });
      }
      return new Response('unexpected', { status: 404 });
    };
    await expect(
      readConfluence(
        dcConfig({ rangeKind: 'confluence_space', resourceId: '42' }),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/API origin/);
    expect(calls.some((call) => call.url.includes('evil.example'))).toBe(false);
  });

  it('probes a DC page without body or attachments', async () => {
    handler = (url) => {
      if (url.pathname === '/rest/api/content/100') {
        return json({ id: '100', title: 'DC Page', space: { key: 'DC' } });
      }
      return new Response('unexpected', { status: 404 });
    };
    await probeConfluence(dcConfig({ rangeKind: 'confluence_page', resourceId: '100' }), undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SITE}/rest/api/content/100?expand=version,space`);
  });

  it('turns an API 401 into SourceAuthError', async () => {
    handler = () => new Response('unauthorized', { status: 401 });
    await expect(
      readConfluence(
        dcConfig({ rangeKind: 'confluence_page', resourceId: '100' }),
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(SourceAuthError);
  });
});

describe('confluence cloud_scoped', () => {
  it('uses the fixed gateway, Basic auth, and drops the token on the signed redirect', async () => {
    const api = 'https://api.atlassian.com/ex/confluence/cloud-1/wiki';
    handler = (url) => {
      if (url.origin !== 'https://api.atlassian.com') {
        if (url.href === `${SIGNED}/signed/scoped`) {
          return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
        }
        return new Response('unexpected', { status: 404 });
      }
      if (url.pathname === '/ex/confluence/cloud-1/wiki/api/v2/spaces/7') {
        return json({ id: '7', key: 'SCOPED' });
      }
      if (url.pathname === '/ex/confluence/cloud-1/wiki/api/v2/spaces/7/pages') {
        return json({ results: [{ id: '1', title: 'Scoped Page', spaceId: '7' }] });
      }
      if (url.pathname === '/ex/confluence/cloud-1/wiki/api/v2/pages/1') {
        return json(
          pageDetail({
            id: '1',
            title: 'Scoped Page',
            spaceId: '7',
            body: { view: { value: '<p>scoped</p>' } },
          }),
        );
      }
      if (url.pathname === '/ex/confluence/cloud-1/wiki/api/v2/pages/1/attachments') {
        return json({
          results: [{ id: 'att-9', title: 'file.pdf', mediaType: 'application/pdf' }],
        });
      }
      if (
        url.pathname ===
        '/ex/confluence/cloud-1/wiki/rest/api/content/1/child/attachment/att-9/download'
      ) {
        return redirect(`${SIGNED}/signed/scoped`);
      }
      return new Response(`unexpected ${url.href}`, { status: 404 });
    };

    const snapshot = await readConfluence(
      config(
        {
          authMode: 'cloud_scoped',
          email: 'user@example.com',
          cloudId: 'cloud-1',
          siteUrl: SITE,
          rangeKind: 'confluence_space',
          resourceId: '7',
        },
        { apiToken: 'scoped-token' },
      ),
      undefined,
      undefined,
    );
    expect(snapshot.complete).toBe(true);

    const gatewayDownload = calls.find((call) =>
      call.url.startsWith(`${api}/rest/api/content/1/child/attachment/att-9/download`),
    );
    expect(gatewayDownload?.headers.get('authorization')).toMatch(/^Basic /);
    const signed = calls.find((call) => call.url === `${SIGNED}/signed/scoped`);
    expect(signed?.headers.get('authorization')).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('scoped-token');
  });

  it('requires cloudId for scoped tokens', async () => {
    await expect(
      readConfluence(
        config(
          {
            authMode: 'cloud_scoped',
            email: 'user@example.com',
            siteUrl: SITE,
            rangeKind: 'confluence_space',
            resourceId: '7',
          },
          { apiToken: 'scoped-token' },
        ),
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/cloudId/);
  });
});
