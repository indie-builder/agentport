import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeNotion, readNotion } from '../src/knowledge/source-notion.js';
import type { SourceConfig } from '../src/knowledge/sources.js';

const BASE = 'http://127.0.0.1:4444';
const OTHER = 'http://127.0.0.2:4445';
const TOKEN = 'secret-token';
const fixtureDir = new URL('./fixtures/knowledge-sources/notion/', import.meta.url);

type Json = Record<string, unknown>;

function load<T = Json>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8')) as T;
}

const attachment = readFileSync(new URL('attachment.bin', fixtureDir));

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const DATABASE_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECORD_A = '44444444-4444-4444-8444-444444444444';
const RECORD_B = '55555555-5555-4555-8555-555555555555';
const TOGGLE_BLOCK = '66666666-6666-4666-8666-666666666666';

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

type Handler = (call: Call, signal: AbortSignal) => Response | Promise<Response>;

let calls: Call[] = [];

function installFetch(handler: Handler): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const call: Call = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      };
      calls.push(call);
      // 直接用调用方传入的 signal：Request 复制出的 signal 在 Node 下不总是跟随中止。
      return handler(call, init?.signal ?? request.signal);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function binary(value: Buffer, mimeType: string): Response {
  return new Response(value, { status: 200, headers: { 'content-type': mimeType } });
}

/** 官方 page property item 列表形状：完整数组从第一页开始返回。 */
function propertyItems(
  type: string,
  values: unknown[],
  options: { hasMore?: boolean; next?: string | null } = {},
): Json {
  return {
    object: 'list',
    type: 'property_item',
    property_item: { id: type, type, next_url: null },
    results: values.map((value) => ({ object: 'property_item', id: type, type, [type]: value })),
    has_more: options.hasMore ?? false,
    next_cursor: options.next ?? null,
  };
}

function titleItems(text: string): Json {
  return propertyItems('title', [
    { type: 'text', text: { content: text, link: null }, plain_text: text, href: null },
  ]);
}

function config(rangeKind: string, resourceId: string): SourceConfig {
  return {
    type: 'notion',
    url: BASE,
    credentials: { apiKey: TOKEN },
    settings: { rangeKind, resourceId },
    allowLoopback: true,
  };
}

function pathOf(call: Call): string {
  return decodeURIComponent(new URL(call.url).pathname);
}

function downloadCalls(): Call[] {
  return calls.filter((call) => {
    const path = pathOf(call);
    return path.startsWith('/files/') || path.startsWith('/download/');
  });
}

/** Shared page-only route table for a root page with a child, a file, an image and a file_upload. */
function standardPages(options: { forbidReport?: boolean } = {}): Handler {
  const root = load('page-root.json');
  const child = load('page-child.json');
  const markdownRoot = load('markdown-root.json');
  const markdownChild = load('markdown-child.json');
  const blocksPage1 = load('blocks-root-page1.json');
  const blocksPage2 = load('blocks-root-page2.json');
  const blocksToggle = load('blocks-toggle.json');
  const blocksEmpty = load('blocks-empty.json');
  const resolvedUpload = load('file-upload-block.json');

  return (call) => {
    const url = new URL(call.url);
    const path = pathOf(call);
    if (path.startsWith('/files/')) {
      if (path === '/files/report.pdf' && options.forbidReport === true) {
        return json({ error: 'missing' }, 403);
      }
      return binary(attachment, path.endsWith('.png') ? 'image/png' : 'application/pdf');
    }
    if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}`) return json(root);
    if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/properties/title`) {
      return json(titleItems('Guide'));
    }
    if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}`) return json(child);
    if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/properties/title`) {
      return json(titleItems('Child'));
    }
    if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/markdown`)
      return json(markdownRoot);
    if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/markdown`)
      return json(markdownChild);
    if (call.method === 'GET' && path === `/v1/blocks/${ROOT_ID}/children`) {
      return json(url.searchParams.get('start_cursor') === 'blocks-2' ? blocksPage2 : blocksPage1);
    }
    if (call.method === 'GET' && path === `/v1/blocks/${CHILD_ID}/children`)
      return json(blocksEmpty);
    if (call.method === 'GET' && path === `/v1/blocks/${TOGGLE_BLOCK}/children`) {
      return json(blocksToggle);
    }
    if (call.method === 'GET' && path === '/v1/blocks/99999999-9999-4999-8999-999999999999') {
      return json(resolvedUpload);
    }
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };
}

describe('notion page range', () => {
  it('reads properties and native markdown, paginates blocks, imports attachments without leaking the API token', async () => {
    installFetch(standardPages());

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual(
      [
        `notion:page:${ROOT_ID}`,
        `notion:page:${CHILD_ID}`,
        `notion:file:${ROOT_ID}:77777777-7777-4777-8777-777777777777`,
        `notion:file:${ROOT_ID}:88888888-8888-4888-8888-888888888888`,
        `notion:file:${ROOT_ID}:99999999-9999-4999-8999-999999999999`,
      ].sort(),
    );

    const page = snapshot.items.find((item) => item.externalId === `notion:page:${ROOT_ID}`);
    expect(page?.title).toBe('Guide');
    expect(page?.path).toBe('Guide.md');
    expect(page?.mimeType).toBe('text/markdown');
    expect(page?.revision).toBe('2026-10-01T10:00:00.000Z');
    expect(page?.sourceUrl).toBe('https://www.notion.so/Guide-11111111111141118111111111111111');
    expect(page?.content).toContain('# Guide');
    expect(page?.content).toContain('- Tags: alpha, beta');
    expect(page?.content).toContain('- Score: 42');
    expect(page?.content).toContain('- Owner: dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(page?.content).toContain('## Intro\n\nRoot body');
    expect(page?.content.indexOf('- Score: 42')).toBeLessThan(
      page?.content.indexOf('## Intro') ?? -1,
    );

    const child = snapshot.items.find((item) => item.externalId === `notion:page:${CHILD_ID}`);
    expect(child?.path).toBe('Guide/Child.md');

    const report = snapshot.items.find(
      (item) => item.externalId === `notion:file:${ROOT_ID}:77777777-7777-4777-8777-777777777777`,
    );
    expect(report?.title).toBe('report.pdf');
    expect(report?.mimeType).toBe('application/pdf');
    expect(Buffer.from(report?.bytes ?? []).equals(attachment)).toBe(true);

    const image = snapshot.items.find(
      (item) => item.externalId === `notion:file:${ROOT_ID}:88888888-8888-4888-8888-888888888888`,
    );
    expect(image?.title).toBe('diagram.png');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image?.bytes ?? []).equals(attachment)).toBe(true);

    const upload = snapshot.items.find(
      (item) => item.externalId === `notion:file:${ROOT_ID}:99999999-9999-4999-8999-999999999999`,
    );
    expect(upload?.title).toBe('uploaded.docx');
    expect(upload?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    // 分页第二页与嵌套块都被读取。
    expect(
      calls.some(
        (call) =>
          pathOf(call) === `/v1/blocks/${ROOT_ID}/children` &&
          new URL(call.url).searchParams.get('start_cursor') === 'blocks-2',
      ),
    ).toBe(true);
    expect(calls.some((call) => pathOf(call) === `/v1/blocks/${TOGGLE_BLOCK}/children`)).toBe(true);

    for (const call of calls.filter((entry) => !pathOf(entry).startsWith('/files/'))) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers['notion-version']).toBe('2026-03-11');
    }
    const downloads = downloadCalls();
    expect(downloads).toHaveLength(3);
    for (const call of downloads) {
      expect(call.headers.authorization).toBeUndefined();
    }
  });

  it('fails a truncated or unknown native markdown page instead of publishing a partial body', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}`) {
        return json(load('page-child.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/properties/title`) {
        return json(titleItems('Child'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/markdown`) {
        return json(load('markdown-truncated.json'));
      }
      if (call.method === 'GET' && path === `/v1/blocks/${CHILD_ID}/children`) {
        return json(load('blocks-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_page', CHILD_ID), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]).toMatchObject({
      externalId: `notion:page:${CHILD_ID}`,
      code: 'truncated',
      retryable: false,
    });
  });

  it('treats an expiring attachment URL 403 as an item failure, not a source auth failure', async () => {
    installFetch(standardPages({ forbidReport: true }));

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.map((item) => item.externalId)).toContain(`notion:page:${ROOT_ID}`);
    expect(snapshot.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: `notion:file:${ROOT_ID}:77777777-7777-4777-8777-777777777777`,
          code: 'fetch_failed',
        }),
      ]),
    );
  });

  it('fails a markdown response that is missing required completeness fields', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}`) {
        return json(load('page-child.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/properties/title`) {
        return json(titleItems('Child'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/markdown`) {
        return json({ object: 'page_markdown', id: CHILD_ID, markdown: 'Partial' });
      }
      if (call.method === 'GET' && path === `/v1/blocks/${CHILD_ID}/children`) {
        return json(load('blocks-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_page', CHILD_ID), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]).toMatchObject({
      externalId: `notion:page:${CHILD_ID}`,
      code: 'fetch_failed',
    });
    expect(snapshot.failures?.[0]?.message).toContain('schema');
  });

  it('rejects a missing root page instead of returning an empty complete snapshot', async () => {
    installFetch(() => json({ object: 'error', code: 'object_not_found' }, 404));

    await expect(readNotion(config('notion_page', ROOT_ID), undefined, undefined)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('probes only the selected page metadata', async () => {
    installFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === `/v1/pages/${ROOT_ID}`) {
        return json(load('page-root.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await probeNotion(config('notion_page', ROOT_ID), undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/v1/pages/${ROOT_ID}`);
  });

  it('honours cancellation while reading pages', async () => {
    installFetch((call, signal) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}`) {
        return json(load('page-child.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${CHILD_ID}/properties/title`) {
        return json(titleItems('Child'));
      }
      if (path === `/v1/pages/${CHILD_ID}/markdown`) {
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const controller = new AbortController();
    const reading = readNotion(config('notion_page', CHILD_ID), undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(reading).rejects.toThrow();
    expect(calls.some((call) => pathOf(call) === `/v1/pages/${CHILD_ID}/markdown`)).toBe(true);
  });

  it('does not forward the API token when a redirect leaves the API origin', async () => {
    installFetch((call) => {
      const url = new URL(call.url);
      const path = pathOf(call);
      if (url.origin === BASE && path === `/v1/pages/${CHILD_ID}`) {
        return new Response(null, {
          status: 302,
          headers: { location: `${OTHER}/v1/pages/${CHILD_ID}` },
        });
      }
      if (url.origin === OTHER && path === `/v1/pages/${CHILD_ID}`)
        return json(load('page-child.json'));
      if (url.origin === BASE && path === `/v1/pages/${CHILD_ID}/properties/title`) {
        return json(titleItems('Child'));
      }
      if (url.origin === BASE && path === `/v1/pages/${CHILD_ID}/markdown`) {
        return json(load('markdown-child.json'));
      }
      if (url.origin === BASE && path === `/v1/blocks/${CHILD_ID}/children`) {
        return json(load('blocks-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_page', CHILD_ID), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    const redirected = calls.find((call) => new URL(call.url).origin === OTHER);
    expect(redirected?.headers.authorization).toBeUndefined();
  });
});

describe('notion database range', () => {
  it('queries every data source and keeps record properties with page markdown', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/databases/${DATABASE_ID}`) {
        return json(load('database.json'));
      }
      if (call.method === 'POST' && path === `/v1/data_sources/${SOURCE_A}/query`) {
        return json(load('data-source-a.json'));
      }
      if (call.method === 'POST' && path === `/v1/data_sources/${SOURCE_B}/query`) {
        return json(load('data-source-b.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_A}/properties/title`) {
        return json(titleItems('Record A'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_B}/properties/title`) {
        return json(titleItems('Record B'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_A}/markdown`) {
        return json({ ...load('markdown-root.json'), id: RECORD_A, markdown: 'Record A body' });
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_B}/markdown`) {
        return json({ ...load('markdown-root.json'), id: RECORD_B, markdown: 'Record B body' });
      }
      if (
        call.method === 'GET' &&
        (path === `/v1/blocks/${RECORD_A}/children` || path === `/v1/blocks/${RECORD_B}/children`)
      ) {
        return json(load('blocks-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_database', DATABASE_ID), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual(
      [`notion:page:${RECORD_A}`, `notion:page:${RECORD_B}`].sort(),
    );
    const recordA = snapshot.items.find((item) => item.externalId === `notion:page:${RECORD_A}`);
    expect(recordA?.path).toBe('Tasks/Record A.md');
    expect(recordA?.content).toContain('# Record A');
    expect(recordA?.content).toContain('- Count: 7');
    expect(recordA?.content).toContain('Record A body');

    const queries = calls.filter((call) => call.method === 'POST');
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const body = JSON.parse(query.body) as { page_size?: number; start_cursor?: string };
      expect(body.page_size).toBe(100);
      expect(body.start_cursor).toBeUndefined();
    }
  });

  it('rejects an incomplete data source query even when has_more is false', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/databases/${DATABASE_ID}`) {
        return json(load('database.json'));
      }
      if (call.method === 'POST' && path === `/v1/data_sources/${SOURCE_A}/query`) {
        return json(load('incomplete-query.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await expect(
      readNotion(config('notion_database', DATABASE_ID), undefined, undefined),
    ).rejects.toThrow(/incomplete/);
  });

  it('rejects a partial database object instead of treating it as an empty complete range', async () => {
    installFetch((call) => {
      if (call.method === 'GET' && pathOf(call) === `/v1/databases/${DATABASE_ID}`) {
        return json({ object: 'database', id: DATABASE_ID });
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await expect(
      readNotion(config('notion_database', DATABASE_ID), undefined, undefined),
    ).rejects.toThrow(/schema/);
  });
});

describe('notion property completeness', () => {
  const relatedA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const relatedB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  function pageWith(
    properties: Record<string, unknown>,
    extra?: (call: Call) => Response | Promise<Response>,
  ): Handler {
    const markdown = load('markdown-root.json');
    const empty = load('blocks-empty.json');
    const root = load<{ properties: Record<string, unknown> }>('page-root.json');
    return (call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}`) {
        return json({
          ...root,
          properties: { Name: root.properties.Name, ...properties },
        });
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/properties/title`) {
        return json(titleItems('Guide'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/markdown`) return json(markdown);
      if (call.method === 'GET' && path === `/v1/blocks/${ROOT_ID}/children`) return json(empty);
      if (extra) return extra(call);
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    };
  }

  it('completes truncated relation, people and rich_text values through property items', async () => {
    const list = (results: unknown[], hasMore = false, next: string | null = null) => ({
      object: 'list',
      type: 'property_item',
      results,
      has_more: hasMore,
      next_cursor: next,
    });
    installFetch(
      pageWith(
        {
          Related: {
            id: 'rel',
            type: 'relation',
            relation: [{ id: relatedA }],
            has_more: true,
          },
          People: {
            id: 'ppl',
            type: 'people',
            people: [{ id: 'u1', name: 'One' }],
            has_more: true,
          },
          Notes: {
            id: 'notes',
            type: 'rich_text',
            rich_text: [{ plain_text: 'first' }],
            has_more: true,
          },
        },
        (call) => {
          const path = pathOf(call);
          const cursor = new URL(call.url).searchParams.get('start_cursor');
          if (path === `/v1/pages/${ROOT_ID}/properties/rel`) {
            return json(
              cursor === 'rel-2'
                ? list([{ object: 'property_item', type: 'relation', relation: { id: relatedB } }])
                : list(
                    [{ object: 'property_item', type: 'relation', relation: { id: relatedA } }],
                    true,
                    'rel-2',
                  ),
            );
          }
          if (path === `/v1/pages/${ROOT_ID}/properties/ppl`) {
            return json(
              list([
                { object: 'property_item', type: 'people', people: { id: 'u1', name: 'One' } },
                { object: 'property_item', type: 'people', people: { id: 'u2', name: 'Two' } },
              ]),
            );
          }
          if (path === `/v1/pages/${ROOT_ID}/properties/notes`) {
            return json(
              list([
                { object: 'property_item', type: 'rich_text', rich_text: { plain_text: 'first' } },
                { object: 'property_item', type: 'rich_text', rich_text: { plain_text: 'second' } },
              ]),
            );
          }
          throw new Error(`unexpected request ${call.method} ${call.url}`);
        },
      ),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const page = snapshot.items.find((item) => item.externalId === `notion:page:${ROOT_ID}`);

    expect(snapshot.complete).toBe(true);
    expect(page?.content).toContain(`- Related: ${relatedA}, ${relatedB}`);
    expect(page?.content).toContain('- People: One, Two');
    expect(page?.content).toContain('- Notes: firstsecond');
    expect(
      calls.some(
        (call) =>
          pathOf(call) === `/v1/pages/${ROOT_ID}/properties/rel` &&
          new URL(call.url).searchParams.get('start_cursor') === 'rel-2',
      ),
    ).toBe(true);
  });

  it('reads all people past the inline limit even when the page omits has_more', async () => {
    const people = Array.from({ length: 26 }, (_, index) => ({
      object: 'user',
      id: `u${index + 1}`,
      name: `Person${String(index + 1).padStart(2, '0')}`,
    }));
    installFetch(
      pageWith({ People: { id: 'ppl', type: 'people', people: people.slice(0, 25) } }, (call) => {
        if (pathOf(call) === `/v1/pages/${ROOT_ID}/properties/ppl`) {
          return json(propertyItems('people', people));
        }
        throw new Error(`unexpected request ${call.method} ${call.url}`);
      }),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const page = snapshot.items.find((item) => item.externalId === `notion:page:${ROOT_ID}`);

    expect(snapshot.complete).toBe(true);
    expect(page?.content).toContain('Person25');
    expect(page?.content).toContain('Person26');
    expect(calls.some((call) => pathOf(call) === `/v1/pages/${ROOT_ID}/properties/ppl`)).toBe(true);
  });

  it('reads the full rich_text and mention segments when the inline value is truncated', async () => {
    installFetch(
      pageWith(
        { Notes: { id: 'notes', type: 'rich_text', rich_text: [{ plain_text: 'first' }] } },
        (call) => {
          if (pathOf(call) === `/v1/pages/${ROOT_ID}/properties/notes`) {
            return json(
              propertyItems('rich_text', [
                { type: 'text', plain_text: 'first ' },
                {
                  type: 'mention',
                  plain_text: '@Alice',
                  mention: { type: 'user', user: { id: 'u1' } },
                },
              ]),
            );
          }
          throw new Error(`unexpected request ${call.method} ${call.url}`);
        },
      ),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const page = snapshot.items.find((item) => item.externalId === `notion:page:${ROOT_ID}`);

    expect(snapshot.complete).toBe(true);
    expect(page?.content).toContain('- Notes: first @Alice');
    expect(calls.some((call) => pathOf(call) === `/v1/pages/${ROOT_ID}/properties/notes`)).toBe(
      true,
    );
  });

  it('fails the page when a fully-read property has no property id', async () => {
    installFetch(
      pageWith({
        Notes: { type: 'rich_text', rich_text: [{ plain_text: 'unprovable' }] },
      }),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]).toMatchObject({
      externalId: `notion:page:${ROOT_ID}`,
      code: 'fetch_failed',
    });
    expect(snapshot.failures?.[0]?.message).toContain('property id');
  });

  it('fails when a fully-read property paginates without a usable cursor', async () => {
    const people = [{ id: 'u1', name: 'One' }];
    for (const response of [
      propertyItems('people', people, { hasMore: true }),
      propertyItems('people', people, { hasMore: true, next: 'same' }),
    ]) {
      installFetch(
        pageWith({ People: { id: 'ppl', type: 'people', people } }, (call) => {
          if (pathOf(call) === `/v1/pages/${ROOT_ID}/properties/ppl`) return json(response);
          throw new Error(`unexpected request ${call.method} ${call.url}`);
        }),
      );

      const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

      expect(snapshot.items).toEqual([]);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.failures?.[0]).toMatchObject({
        externalId: `notion:page:${ROOT_ID}`,
        code: 'fetch_failed',
      });
    }
  });

  it('keeps supported rollup array values instead of dropping them', async () => {
    installFetch(
      pageWith({
        Original: {
          id: 'roll',
          type: 'rollup',
          rollup: {
            type: 'array',
            array: [
              { type: 'number', number: 8 },
              { type: 'number', number: 5 },
            ],
            function: 'show_original',
          },
        },
      }),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const page = snapshot.items.find((item) => item.externalId === `notion:page:${ROOT_ID}`);

    expect(snapshot.complete).toBe(true);
    expect(page?.content).toContain('- Original: 8, 5');
  });

  it('fails the page instead of publishing a partially paginated property', async () => {
    const list = {
      object: 'list',
      type: 'property_item',
      results: [{ object: 'property_item', type: 'relation', relation: { id: relatedA } }],
      has_more: true,
      next_cursor: 'same',
    };
    installFetch(
      pageWith(
        {
          Related: {
            id: 'rel',
            type: 'relation',
            relation: [{ id: relatedA }],
            has_more: true,
          },
        },
        (call) => {
          if (pathOf(call) === `/v1/pages/${ROOT_ID}/properties/rel`) return json(list);
          throw new Error(`unexpected request ${call.method} ${call.url}`);
        },
      ),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]).toMatchObject({
      externalId: `notion:page:${ROOT_ID}`,
      code: 'fetch_failed',
    });
  });
});

describe('notion data source traversal', () => {
  it('recurses into child data sources by object type and dedupes their IDs', async () => {
    const CHILD_SOURCE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const NESTED_SOURCE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const record = {
      object: 'page',
      id: RECORD_A,
      url: 'https://www.notion.so/Record-A',
      last_edited_time: '2026-10-03T12:00:00.000Z',
      properties: {
        Name: { id: 'title', type: 'title', title: [{ plain_text: 'Record A' }] },
        Count: { id: 'count', type: 'number', number: 7 },
      },
    };
    const end = { object: 'list', results: [], has_more: false, next_cursor: null };
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'POST' && path === `/v1/data_sources/${SOURCE_A}/query`) {
        return json({
          ...end,
          results: [
            { object: 'data_source', id: CHILD_SOURCE, title: [{ plain_text: 'Child source' }] },
            { object: 'data_source', id: CHILD_SOURCE, title: [{ plain_text: 'Duplicate' }] },
          ],
        });
      }
      if (call.method === 'POST' && path === `/v1/data_sources/${CHILD_SOURCE}/query`) {
        return json({ ...end, results: [{ object: 'data_source', id: NESTED_SOURCE }] });
      }
      if (call.method === 'POST' && path === `/v1/data_sources/${NESTED_SOURCE}/query`) {
        return json({ ...end, results: [record] });
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_A}/properties/title`) {
        return json(titleItems('Record A'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${RECORD_A}/markdown`) {
        return json({ ...load('markdown-root.json'), id: RECORD_A, markdown: 'Record A body' });
      }
      if (call.method === 'GET' && path === `/v1/blocks/${RECORD_A}/children`) {
        return json(load('blocks-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_data_source', SOURCE_A), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId)).toEqual([`notion:page:${RECORD_A}`]);
    const queries = calls.filter((call) => call.method === 'POST').map((call) => pathOf(call));
    expect(queries).toEqual([
      `/v1/data_sources/${SOURCE_A}/query`,
      `/v1/data_sources/${CHILD_SOURCE}/query`,
      `/v1/data_sources/${NESTED_SOURCE}/query`,
    ]);
    for (const sourceId of [CHILD_SOURCE, NESTED_SOURCE]) {
      expect(calls.some((call) => pathOf(call).startsWith(`/v1/pages/${sourceId}`))).toBe(false);
      expect(calls.some((call) => pathOf(call).startsWith(`/v1/blocks/${sourceId}`))).toBe(false);
    }
  });
});

describe('notion expiring downloads', () => {
  const FILE_BLOCK = 'aaaaaaaa-0000-4000-8000-000000000009';

  function blockPage(url: string, handler: Handler): Handler {
    return (call) => {
      if (call.method === 'GET' && pathOf(call) === `/v1/blocks/${ROOT_ID}/children`) {
        return json({
          object: 'list',
          results: [
            {
              object: 'block',
              id: FILE_BLOCK,
              type: 'file',
              file: { type: 'file', name: 'doc.pdf', file: { url } },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}`) {
        return json(load('page-root.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/properties/title`) {
        return json(titleItems('Guide'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/markdown`) {
        return json(load('markdown-root.json'));
      }
      return handler(call);
    };
  }

  it('refreshes an expired block URL once from block metadata and retries the download', async () => {
    const oldUrl = `${BASE}/download/old.pdf?signature=rotating`;
    const freshUrl = `${BASE}/download/fresh.pdf?signature=new`;
    installFetch(
      blockPage(oldUrl, (call) => {
        const path = pathOf(call);
        if (path === '/download/old.pdf') return json({ error: 'expired' }, 403);
        if (call.method === 'GET' && path === `/v1/blocks/${FILE_BLOCK}`) {
          return json({
            object: 'block',
            id: FILE_BLOCK,
            type: 'file',
            file: { type: 'file', name: 'doc.pdf', file: { url: freshUrl } },
          });
        }
        if (path === '/download/fresh.pdf') return binary(attachment, 'application/pdf');
        throw new Error(`unexpected request ${call.method} ${call.url}`);
      }),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const file = snapshot.items.find(
      (item) => item.externalId === `notion:file:${ROOT_ID}:${FILE_BLOCK}`,
    );

    expect(snapshot.complete).toBe(true);
    expect(Buffer.from(file?.bytes ?? []).equals(attachment)).toBe(true);
    expect(file?.sourceUrl).toBe('https://www.notion.so/Guide-11111111111141118111111111111111');
    expect(file?.sourceUrl).not.toContain('signature');
    const downloads = downloadCalls();
    expect(downloads.map((call) => pathOf(call))).toEqual([
      '/download/old.pdf',
      '/download/fresh.pdf',
    ]);
    for (const call of downloads) expect(call.headers.authorization).toBeUndefined();
    const blockIndex = calls.findIndex((call) => pathOf(call) === `/v1/blocks/${FILE_BLOCK}`);
    const firstDownload = calls.findIndex((call) => pathOf(call) === '/download/old.pdf');
    const secondDownload = calls.findIndex((call) => pathOf(call) === '/download/fresh.pdf');
    expect(firstDownload).toBeLessThan(blockIndex);
    expect(blockIndex).toBeLessThan(secondDownload);
  });

  it('refreshes a block URL whose expiry_time has passed before downloading', async () => {
    const expiredUrl = `${BASE}/download/expired.pdf?signature=old`;
    const freshUrl = `${BASE}/download/fresh.pdf?signature=new`;
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}`) {
        return json(load('page-root.json'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/properties/title`) {
        return json(titleItems('Guide'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/markdown`) {
        return json(load('markdown-root.json'));
      }
      if (call.method === 'GET' && path === `/v1/blocks/${ROOT_ID}/children`) {
        return json({
          object: 'list',
          results: [
            {
              object: 'block',
              id: FILE_BLOCK,
              type: 'file',
              file: {
                type: 'file',
                name: 'doc.pdf',
                file: { url: expiredUrl, expiry_time: '2020-01-01T00:00:00.000Z' },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (call.method === 'GET' && path === `/v1/blocks/${FILE_BLOCK}`) {
        return json({
          object: 'block',
          id: FILE_BLOCK,
          type: 'file',
          file: {
            type: 'file',
            name: 'doc.pdf',
            file: { url: freshUrl, expiry_time: '2099-01-01T00:00:00.000Z' },
          },
        });
      }
      if (path === '/download/fresh.pdf') return binary(attachment, 'application/pdf');
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(downloadCalls().map((call) => pathOf(call))).toEqual(['/download/fresh.pdf']);
  });

  it('refreshes an expired property file from the owning page metadata', async () => {
    const oldUrl = `${BASE}/download/old-prop.pdf?signature=rotating`;
    const freshUrl = `${BASE}/download/fresh-prop.pdf?signature=new`;
    let pageReads = 0;
    installFetch((call) => {
      const path = pathOf(call);
      const root = load<{ properties: Record<string, unknown> }>('page-root.json');
      const propertyPage = (url: string) => ({
        ...root,
        properties: {
          ...root.properties,
          Files: {
            id: 'files-id',
            type: 'files',
            files: [{ type: 'file', name: 'prop.pdf', file: { url } }],
          },
        },
      });
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}`) {
        pageReads += 1;
        return json(propertyPage(pageReads === 1 ? oldUrl : freshUrl));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/properties/title`) {
        return json(titleItems('Guide'));
      }
      if (call.method === 'GET' && path === `/v1/pages/${ROOT_ID}/markdown`) {
        return json(load('markdown-root.json'));
      }
      if (call.method === 'GET' && path === `/v1/blocks/${ROOT_ID}/children`) {
        return json(load('blocks-empty.json'));
      }
      if (path === '/download/old-prop.pdf') return json({ error: 'expired' }, 403);
      if (path === '/download/fresh-prop.pdf') return binary(attachment, 'application/pdf');
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);
    const file = snapshot.items.find(
      (item) => item.externalId === `notion:file:${ROOT_ID}:files-id:0`,
    );

    expect(snapshot.complete).toBe(true);
    expect(pageReads).toBe(2);
    expect(Buffer.from(file?.bytes ?? []).equals(attachment)).toBe(true);
    expect(file?.sourceUrl).not.toContain('signature');
  });

  it('fails the attachment after one refresh instead of retrying forever or stopping the source', async () => {
    const oldUrl = `${BASE}/download/old.pdf?signature=rotating`;
    const badUrl = `${BASE}/download/bad.pdf?signature=new`;
    installFetch(
      blockPage(oldUrl, (call) => {
        const path = pathOf(call);
        if (path === '/download/old.pdf' || path === '/download/bad.pdf') {
          return json({ error: 'expired' }, 403);
        }
        if (call.method === 'GET' && path === `/v1/blocks/${FILE_BLOCK}`) {
          return json({
            object: 'block',
            id: FILE_BLOCK,
            type: 'file',
            file: { type: 'file', name: 'doc.pdf', file: { url: badUrl } },
          });
        }
        throw new Error(`unexpected request ${call.method} ${call.url}`);
      }),
    );

    const snapshot = await readNotion(config('notion_page', ROOT_ID), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.map((item) => item.externalId)).toContain(`notion:page:${ROOT_ID}`);
    expect(snapshot.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: `notion:file:${ROOT_ID}:${FILE_BLOCK}`,
          code: 'fetch_failed',
        }),
      ]),
    );
    expect(downloadCalls().map((call) => pathOf(call))).toEqual([
      '/download/old.pdf',
      '/download/bad.pdf',
    ]);
    expect(calls.filter((call) => pathOf(call) === `/v1/blocks/${FILE_BLOCK}`)).toHaveLength(1);
  });
});
