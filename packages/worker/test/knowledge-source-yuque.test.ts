import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeYuque, readYuque } from '../src/knowledge/source-yuque.js';
import type { SourceConfig } from '../src/knowledge/sources.js';

const BASE = 'http://127.0.0.1:4444';
const TOKEN = 'yuque-token';
const REPO = '123';
const fixtureDir = new URL('./fixtures/knowledge-sources/yuque/', import.meta.url);

type Json = Record<string, unknown>;

function load<T = Json>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8')) as T;
}

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

function config(repoId = REPO): SourceConfig {
  return {
    type: 'yuque',
    url: BASE,
    credentials: { apiToken: TOKEN },
    settings: { repoId },
    allowLoopback: true,
  };
}

function pathOf(call: Call): string {
  return decodeURIComponent(new URL(call.url).pathname);
}

function listOffset(call: Call): string | null {
  return new URL(call.url).searchParams.get('offset');
}

describe('yuque repo range', () => {
  it('reads every offset page, keeps numeric identity, and prefers body over body_lake', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load(listOffset(call) === '0' ? 'docs-page1.json' : 'docs-page2.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/101`) {
        return json(load('doc-101.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/102`) {
        return json(load('doc-102.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/103`) {
        return json(load('doc-103.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    expect(snapshot.items.map((item) => item.externalId)).toEqual([
      'yuque:doc:101',
      'yuque:doc:102',
      'yuque:doc:103',
    ]);

    const markdown = snapshot.items[0];
    expect(markdown?.title).toBe('Doc 101');
    expect(markdown?.mimeType).toBe('text/markdown');
    expect(markdown?.content).toBe('# Doc 101\n\nMarkdown body');
    expect(markdown?.content).not.toContain('internal lake xml');
    expect(markdown?.path).toBe('Doc 101.md');
    expect(markdown?.sourceUrl).toBe(`${BASE}/team/manual/original`);
    expect(markdown?.revision).toBe('2026-10-01T08:00:00.000Z');

    const html = snapshot.items[1];
    expect(html?.mimeType).toBe('text/html');
    expect(html?.content).toBe('');
    expect(Buffer.from(html?.bytes ?? []).toString('utf8')).toBe(
      '<h1>Doc 102</h1><p>HTML body</p>',
    );

    // slug 从 original 改成 renamed 不改变数字身份。
    const renamed = snapshot.items[2];
    expect(renamed?.externalId).toBe('yuque:doc:103');
    expect(renamed?.sourceUrl).toBe(`${BASE}/team/manual/renamed`);

    const listCalls = calls.filter((call) => pathOf(call).endsWith('/docs'));
    expect(listCalls.map(listOffset)).toEqual(['0', '2']);

    for (const call of calls) {
      expect(call.headers['x-auth-token']).toBe(TOKEN);
      expect(call.headers.authorization).toBeUndefined();
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it('rejects a short list that ends before meta.total', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load(listOffset(call) === '0' ? 'docs-short.json' : 'docs-empty.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await expect(readYuque(config(), undefined, undefined)).rejects.toThrow(/meta\.total/);
  });

  it('rejects a list that repeats a numeric id', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-duplicate.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await expect(readYuque(config(), undefined, undefined)).rejects.toThrow(/repeated id 101/);
  });

  it('rejects ids that cannot be represented without precision loss', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-unsafe-id.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await expect(readYuque(config(), undefined, undefined)).rejects.toThrow(/schema/);
  });

  it('fails a detail whose id does not match the listed document', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-single.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/101`) {
        return json(load('detail-mismatch.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]).toMatchObject({
      externalId: 'yuque:doc:101',
      code: 'fetch_failed',
    });
  });

  it('marks drafts and non-Doc entries as skipped and closes complete', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-skipped.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.map((failure) => failure.code)).toEqual(['skipped', 'skipped']);
    expect(calls.some((call) => /\/docs\/\d+$/.test(pathOf(call)))).toBe(false);
  });

  it('fails when only body_lake is available', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-lake-only.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/301`) {
        return json(load('doc-301.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('no readable body');
  });

  it('probes the token and the selected repo without reading details', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === '/api/v2/user') return json(load('user.json'));
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-single.json'));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    await probeYuque(config(), undefined);

    expect(calls.map(pathOf)).toEqual(['/api/v2/user', `/api/v2/repos/${REPO}/docs`]);
    expect(calls[1] ? new URL(calls[1].url).searchParams.get('limit') : null).toBe('1');
    expect(calls.some((call) => /\/docs\/\d+$/.test(pathOf(call)))).toBe(false);
  });

  it('honours cancellation while listing documents', async () => {
    installFetch((call, signal) => {
      if (call.method === 'GET' && pathOf(call) === `/api/v2/repos/${REPO}/docs`) {
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
    const reading = readYuque(config(), undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(reading).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('yuque body formats', () => {
  function detail(format: string, fields: Record<string, unknown>) {
    return {
      data: {
        id: 101,
        type: 'Doc',
        format,
        slug: 'original',
        title: 'Doc 101',
        status: 1,
        ...fields,
      },
    };
  }

  it('treats a non-empty HTML body as HTML bytes instead of Markdown', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-single.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/101`) {
        return json(detail('html', { body: '<h1>中文</h1>', body_html: '<h1>中文</h1>' }));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);
    const item = snapshot.items[0];

    expect(snapshot.complete).toBe(true);
    expect(item?.mimeType).toBe('text/html');
    expect(item?.content).toBe('');
    expect(Buffer.from(item?.bytes ?? []).toString('utf8')).toBe('<h1>中文</h1>');
  });

  it('falls back to body_html as HTML bytes when an HTML body is empty', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-single.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/101`) {
        return json(detail('html', { body: '', body_html: '<p>fallback</p>' }));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);
    const item = snapshot.items[0];

    expect(item?.mimeType).toBe('text/html');
    expect(item?.content).toBe('');
    expect(Buffer.from(item?.bytes ?? []).toString('utf8')).toBe('<p>fallback</p>');
  });

  it('fails an unknown document format instead of guessing Markdown', async () => {
    installFetch((call) => {
      const path = pathOf(call);
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs`) {
        return json(load('docs-single.json'));
      }
      if (call.method === 'GET' && path === `/api/v2/repos/${REPO}/docs/101`) {
        return json(detail('pdf', { body: '# Body' }));
      }
      throw new Error(`unexpected request ${call.method} ${call.url}`);
    });

    const snapshot = await readYuque(config(), undefined, undefined);

    expect(snapshot.items).toEqual([]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.message).toContain('unsupported format');
  });
});
