import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceAuthError } from '../src/knowledge/source-http.js';
import { probeIma, readIma } from '../src/knowledge/source-ima.js';
import type { SourceConfig } from '../src/knowledge/sources.js';

type RequestRecord = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

type Json = Record<string, unknown>;

function fixture<T = Json>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/knowledge-sources/ima/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/knowledge-sources/ima/${name}`, import.meta.url), 'utf8');
}

function headerObject(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
    );
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function installFetch(
  handler: (record: RequestRecord) => Response | Promise<Response>,
): RequestRecord[] {
  const records: RequestRecord[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const record: RequestRecord = {
        url,
        method: init?.method ?? 'GET',
        headers: headerObject(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      };
      records.push(record);
      return handler(record);
    }),
  );
  return records;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function bytes(value: Buffer | string, contentType: string): Response {
  return new Response(value, { status: 200, headers: { 'content-type': contentType } });
}

function bytesWithoutContentType(value: Buffer): Response {
  return new Response(value, { status: 200 });
}

function csvBytes(): Buffer {
  return Buffer.from('name,amount\nBudget,100\n', 'utf8');
}

/** 旧版 Office 是 OLE2 复合文档；用真实文件头而不是拿 CSV 冒充。 */
function oleBytes(marker: string): Buffer {
  return Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from(marker, 'utf8')]);
}

/** OOXML 是 ZIP 容器；用真实文件头而不是拿 CSV 冒充。 */
function zipBytes(marker: string): Buffer {
  return Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from(marker, 'utf8')]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'ima',
    url: '',
    credentials: { apiKey: 'api-key' },
    settings: { clientId: 'client-id', knowledgeBaseId: 'kb1', ...settings },
    trustedHosts: ['ima.qq.com'],
    allowLoopback: true,
  };
}

const MEDIA_BASE = 'http://127.0.0.1:9200';

function pdfBytes(): Buffer {
  return Buffer.from(fixture<{ base64: string }>('sample-pdf.json').base64, 'base64');
}

function mediaInfoItems(): Json {
  const raw = fixture('media-items.json');
  return JSON.parse(JSON.stringify(raw).replaceAll('__MEDIA_BASE__', MEDIA_BASE)) as Json;
}

describe('readIma', () => {
  it('reads both list pages and folder shapes with media identity and plaintext notes', async () => {
    const rootPage1 = fixture('root-page-1.json');
    const rootPage2 = fixture('root-page-2.json');
    const folderA = fixture('folder-a.json');
    const folder99 = fixture('folder-99.json');
    const note = fixture('note-content.json');
    const media = mediaInfoItems();
    const pdf = pdfBytes();
    const markdown = fixtureText('sample-md.txt');

    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.hostname === 'ima.qq.com') {
        if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
          const body = JSON.parse(record.body) as Json;
          const folderId = typeof body.folder_id === 'string' ? body.folder_id : '';
          const cursor = typeof body.cursor === 'string' ? body.cursor : '';
          if (folderId === 'f1') return json(folderA);
          if (folderId === 'folder_99') return json(folder99);
          return cursor === 'c2' ? json(rootPage2) : json(rootPage1);
        }
        if (url.pathname === '/openapi/wiki/v1/get_media_info') {
          const body = JSON.parse(record.body) as Json;
          const value = media[String(body.media_id)];
          if (!value) throw new Error(`unexpected media ${String(body.media_id)}`);
          return json(value);
        }
        if (url.pathname === '/openapi/note/v1/get_doc_content') return json(note);
      }
      if (record.url === `${MEDIA_BASE}/pdf`) return bytes(pdf, 'application/pdf');
      if (record.url === `${MEDIA_BASE}/dup`) return bytes(pdf, 'application/pdf');
      if (record.url === `${MEDIA_BASE}/md`) return bytes(markdown, 'text/markdown');
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    expect(snapshot.cursor).toEqual({ version: 1, initial: true });
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'ima:media:kb1:m-dup',
      'ima:media:kb1:m-md',
      'ima:media:kb1:m-note',
      'ima:media:kb1:m-pdf',
    ]);

    for (const request of requests.filter(
      (entry) => new URL(entry.url).hostname === 'ima.qq.com',
    )) {
      expect(request.method).toBe('POST');
      expect(request.headers['ima-openapi-clientid']).toBe('client-id');
      expect(request.headers['ima-openapi-apikey']).toBe('api-key');
    }

    const firstList = requests.find(
      (request) =>
        request.url.endsWith('/get_knowledge_list') &&
        (JSON.parse(request.body) as Json).cursor === '',
    );
    expect(JSON.parse(firstList?.body ?? '{}')).toEqual({
      knowledge_base_id: 'kb1',
      cursor: '',
      limit: 50,
    });
    const folderList = requests.find(
      (request) =>
        request.url.endsWith('/get_knowledge_list') &&
        (JSON.parse(request.body) as Json).folder_id === 'f1',
    );
    expect(folderList).toBeDefined();
    const upstreamFolderList = requests.find(
      (request) =>
        request.url.endsWith('/get_knowledge_list') &&
        (JSON.parse(request.body) as Json).folder_id === 'folder_99',
    );
    expect(upstreamFolderList).toBeDefined();

    const pdfRequest = requests.find((request) => request.url === `${MEDIA_BASE}/pdf`);
    expect(pdfRequest?.headers.authorization).toBe('Bearer media-token');
    expect(pdfRequest?.headers['ima-openapi-clientid']).toBeUndefined();
    expect(pdfRequest?.headers['ima-openapi-apikey']).toBeUndefined();

    const noteRequest = requests.find((request) =>
      request.url.endsWith('/openapi/note/v1/get_doc_content'),
    );
    expect(JSON.parse(noteRequest?.body ?? '{}')).toEqual({
      note_id: 'nb1',
      target_content_format: 0,
    });

    const pdfItem = snapshot.items.find((item) => item.externalId === 'ima:media:kb1:m-pdf');
    expect(pdfItem?.title).toBe('Manual.pdf');
    expect(pdfItem?.path).toBe('Manual.pdf');
    expect(pdfItem?.mimeType).toBe('application/pdf');
    expect(pdfItem?.sourceUrl).toBe('');
    expect(
      createHash('sha256')
        .update(pdfItem?.bytes ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(createHash('sha256').update(pdf).digest('hex'));

    const duplicate = snapshot.items.find((item) => item.externalId === 'ima:media:kb1:m-dup');
    expect(duplicate?.title).toBe('Manual.pdf');
    expect(duplicate?.path).toBe('Manual [m-dup].pdf');

    const markdownItem = snapshot.items.find((item) => item.externalId === 'ima:media:kb1:m-md');
    expect(markdownItem?.path).toBe('Folder A/readme.md');
    expect(markdownItem?.mimeType).toBe('text/markdown');
    expect(Buffer.from(markdownItem?.bytes ?? []).toString('utf8')).toBe(markdown);

    const noteItem = snapshot.items.find((item) => item.externalId === 'ima:media:kb1:m-note');
    expect(noteItem?.path).toBe('Upstream Folder/Note.txt');
    expect(noteItem?.mimeType).toBe('text/plain');
    expect(Buffer.from(noteItem?.bytes ?? []).toString('utf8')).toBe('line one\nline two');
  });

  it('re-reads unchanged media IDs on every run', async () => {
    const media = mediaInfoItems();
    const pdf = pdfBytes();
    let mediaInfoCalls = 0;
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-pdf', title: 'Manual', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        mediaInfoCalls += 1;
        return json(media['m-pdf']);
      }
      if (record.url === `${MEDIA_BASE}/pdf`) return bytes(pdf, 'application/pdf');
      throw new Error(`unexpected request ${record.url}`);
    });

    const first = await readIma(config(), undefined, undefined);
    const second = await readIma(config(), first.cursor, undefined);

    expect(mediaInfoCalls).toBe(2);
    expect(first.items[0]?.externalId).toBe(second.items[0]?.externalId);
    expect(second.cursor).toEqual({ version: 1, initial: false });
  });

  it('chooses csv and legacy office extensions from the download content type', async () => {
    const downloads: Record<
      string,
      { contentType: string; extension: string; mime: string; bytes: Buffer }
    > = {
      csv: {
        contentType: 'text/csv',
        extension: 'csv',
        mime: 'text/csv',
        bytes: csvBytes(),
      },
      xls: {
        contentType: 'application/vnd.ms-excel',
        extension: 'xls',
        mime: 'application/vnd.ms-excel',
        bytes: oleBytes('Microsoft Excel Workbook'),
      },
      doc: {
        contentType: 'application/msword',
        extension: 'doc',
        mime: 'application/msword',
        bytes: oleBytes('WordDocument'),
      },
      ppt: {
        contentType: 'application/vnd.ms-powerpoint',
        extension: 'ppt',
        mime: 'application/vnd.ms-powerpoint',
        bytes: oleBytes('PowerPoint Document'),
      },
    };
    const entries = [
      { id: 'm-csv', title: 'Budget.csv', expectedTitle: 'Budget.csv', mediaType: 5, path: 'csv' },
      {
        id: 'm-xls',
        title: 'Legacy sheet',
        expectedTitle: 'Legacy sheet.xls',
        mediaType: 5,
        path: 'xls',
      },
      {
        id: 'm-doc',
        title: 'Legacy doc',
        expectedTitle: 'Legacy doc.doc',
        mediaType: 3,
        path: 'doc',
      },
      {
        id: 'm-ppt',
        title: 'Legacy deck',
        expectedTitle: 'Legacy deck.ppt',
        mediaType: 4,
        path: 'ppt',
      },
    ];
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: entries.map((entry) => ({
              media_id: entry.id,
              title: entry.title,
              parent_folder_id: '',
            })),
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        const body = JSON.parse(record.body) as Json;
        const entry = entries.find((candidate) => candidate.id === body.media_id);
        if (!entry) throw new Error(`unexpected media ${String(body.media_id)}`);
        return json({
          code: 0,
          data: {
            media_type: entry.mediaType,
            url_info: { url: `${MEDIA_BASE}/${entry.path}` },
          },
        });
      }
      for (const [path, download] of Object.entries(downloads)) {
        if (record.url === `${MEDIA_BASE}/${path}`) {
          return bytes(download.bytes, download.contentType);
        }
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    for (const entry of entries) {
      const item = snapshot.items.find(
        (candidate) => candidate.externalId === `ima:media:kb1:${entry.id}`,
      );
      const download = downloads[entry.path] ?? { extension: '', mime: '' };
      expect(item?.title).toBe(entry.expectedTitle);
      expect(item?.mimeType).toBe(download.mime);
    }
  });

  it('keeps the title extension when the download has no usable MIME type', async () => {
    const entries = [
      {
        id: 'm-csv-missing',
        title: 'Budget.csv',
        expectedTitle: 'Budget.csv',
        mediaType: 5,
        contentType: null,
        bytes: csvBytes(),
        mime: 'text/csv',
      },
      {
        id: 'm-csv-octet',
        title: 'Inventory.csv',
        expectedTitle: 'Inventory.csv',
        mediaType: 5,
        contentType: 'application/octet-stream',
        bytes: Buffer.from('sku,qty\nA,2\n', 'utf8'),
        mime: 'text/csv',
      },
      {
        id: 'm-xls',
        title: 'Legacy sheet.xls',
        expectedTitle: 'Legacy sheet.xls',
        mediaType: 5,
        contentType: 'application/octet-stream',
        bytes: oleBytes('Microsoft Excel Workbook'),
        mime: 'application/vnd.ms-excel',
      },
      {
        id: 'm-doc',
        title: 'Legacy doc.doc',
        expectedTitle: 'Legacy doc.doc',
        mediaType: 3,
        contentType: 'application/octet-stream',
        bytes: oleBytes('WordDocument'),
        mime: 'application/msword',
      },
      {
        id: 'm-ppt',
        title: 'Legacy deck.ppt',
        expectedTitle: 'Legacy deck.ppt',
        mediaType: 4,
        contentType: 'application/octet-stream',
        bytes: oleBytes('PowerPoint Document'),
        mime: 'application/vnd.ms-powerpoint',
      },
      {
        id: 'm-noext',
        title: 'Sheet',
        expectedTitle: 'Sheet.xlsx',
        mediaType: 5,
        contentType: null,
        bytes: zipBytes('xl/workbook.xml'),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ];
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: entries.map((entry) => ({
              media_id: entry.id,
              title: entry.title,
              parent_folder_id: '',
            })),
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        const body = JSON.parse(record.body) as Json;
        const entry = entries.find((candidate) => candidate.id === body.media_id);
        if (!entry) throw new Error(`unexpected media ${String(body.media_id)}`);
        return json({
          code: 0,
          data: {
            media_type: entry.mediaType,
            url_info: { url: `${MEDIA_BASE}/${entry.id}` },
          },
        });
      }
      const entry = entries.find((candidate) => record.url === `${MEDIA_BASE}/${candidate.id}`);
      if (entry) {
        return entry.contentType === null
          ? bytesWithoutContentType(entry.bytes)
          : bytes(entry.bytes, entry.contentType);
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    for (const entry of entries) {
      const item = snapshot.items.find(
        (candidate) => candidate.externalId === `ima:media:kb1:${entry.id}`,
      );
      expect(item?.title).toBe(entry.expectedTitle);
      expect(item?.mimeType).toBe(entry.mime);
      expect(Buffer.from(item?.bytes ?? [])).toEqual(entry.bytes);
    }
  });

  it('redacts signed query strings from item API failures', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-bad', title: 'bad', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({
          code: 110011,
          msg: 'failed https://example.com/file?token=FAKE_QUERY_SECRET',
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    const message = snapshot.failures?.[0]?.message ?? '';
    expect(message).toContain('https://example.com/file');
    expect(message).not.toContain('FAKE_QUERY_SECRET');
  });

  it('redacts signed query strings from permission errors', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 110030,
          msg: 'no permission https://example.com/file?token=FAKE_QUERY_SECRET',
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const error = await readIma(config(), undefined, undefined).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SourceAuthError);
    expect((error as Error).message).toContain('https://example.com/file');
    expect((error as Error).message).not.toContain('FAKE_QUERY_SECRET');
  });

  it('fails immediately on an empty non-terminal page with a next cursor', async () => {
    let listCalls = 0;
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        listCalls += 1;
        return listCalls === 1
          ? json({ code: 0, data: { knowledge_list: [], is_end: false, next_cursor: 'c2' } })
          : json({ code: 0, data: { knowledge_list: [], is_end: true, next_cursor: '' } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readIma(config(), undefined, undefined)).rejects.toThrow(/empty page/);
    expect(listCalls).toBe(1);
  });

  it('throws when a non-terminal page has no next cursor', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ folder_id: 'f-queued', name: 'Queued folder' }],
            is_end: false,
            next_cursor: '',
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readIma(config(), undefined, undefined)).rejects.toThrow(/next_cursor/);
  });

  it('throws when a pagination cursor repeats', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ folder_id: 'f-queued', name: 'Queued folder' }],
            is_end: false,
            next_cursor: 'same',
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readIma(config(), undefined, undefined)).rejects.toThrow(/repeated next_cursor/);
  });

  it('keeps unknown item and directory shapes incomplete instead of guessing', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ folder_id: 'broken-folder' }, { foo: 'bar' }],
            is_end: true,
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures).toHaveLength(2);
    expect(snapshot.failures?.every((failure) => failure.code === 'invalid_response')).toBe(true);
  });

  it('reports code=0 media without a URL as content_unavailable', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-nourl', title: 'Broken', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({ code: 0, data: { media_type: 1 } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('content_unavailable');
    expect(snapshot.failures?.[0]?.retryable).toBe(false);
  });

  it('reports unsupported media types instead of publishing a placeholder', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-audio', title: 'Call', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({ code: 0, data: { media_type: 15 } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('unsupported_type');
  });

  it('uses the download content type to name an image', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-image', title: 'pic', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({
          code: 0,
          data: { media_type: 9, url_info: { url: `${MEDIA_BASE}/image` } },
        });
      }
      if (record.url === `${MEDIA_BASE}/image`) {
        return bytes(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg');
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items[0]?.title).toBe('pic.jpg');
    expect(snapshot.items[0]?.mimeType).toBe('image/jpeg');
  });

  it('fails an empty download instead of treating it as a document', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-empty', title: 'Empty', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({
          code: 0,
          data: { media_type: 1, url_info: { url: `${MEDIA_BASE}/empty` } },
        });
      }
      if (record.url === `${MEDIA_BASE}/empty`) return bytes(Buffer.alloc(0), 'application/pdf');
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('empty_content');
  });

  it('never re-sends media headers after leaving the target origin', async () => {
    const pdf = pdfBytes();
    const first = `${MEDIA_BASE}/a`;
    const second = 'http://127.0.0.1:9201/b';
    const third = `${MEDIA_BASE}/c`;
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({
          code: 0,
          data: {
            knowledge_list: [{ media_id: 'm-pdf', title: 'Manual', parent_folder_id: '' }],
            is_end: true,
          },
        });
      }
      if (url.pathname === '/openapi/wiki/v1/get_media_info') {
        return json({
          code: 0,
          data: {
            media_type: 1,
            url_info: { url: first, headers: { Authorization: 'Bearer media-token' } },
          },
        });
      }
      if (record.url === first) return redirect(second);
      if (record.url === second) return redirect(third);
      if (record.url === third) return bytes(pdf, 'application/pdf');
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readIma(config(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items).toHaveLength(1);
    const firstHop = requests.find((request) => request.url === first);
    const crossOrigin = requests.find((request) => request.url === second);
    const backToOrigin = requests.find((request) => request.url === third);
    expect(firstHop?.headers.authorization).toBe('Bearer media-token');
    expect(crossOrigin?.headers.authorization).toBeUndefined();
    expect(backToOrigin?.headers.authorization).toBeUndefined();
  });

  it('turns IMA permission code 110030 into SourceAuthError', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({ code: 110030, msg: 'no permission' });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readIma(config(), undefined, undefined)).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('aborts an in-flight request', async () => {
    let started: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const fail = () => reject(new DOMException('aborted', 'AbortError'));
            if (init?.signal?.aborted) {
              fail();
              return;
            }
            init?.signal?.addEventListener('abort', fail);
            started();
          }),
      ),
    );
    const controller = new AbortController();
    const reading = readIma(config(), undefined, controller.signal);
    await requestStarted;
    controller.abort();

    await expect(reading).rejects.toThrow();
  });
});

describe('probeIma', () => {
  it('only reads the configured knowledge base first page', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({ code: 0, data: { knowledge_list: [], is_end: true } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await probeIma(config(), undefined);

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      knowledge_base_id: 'kb1',
      cursor: '',
      limit: 50,
    });
    expect(requests.some((request) => request.url.includes('get_media_info'))).toBe(false);
    expect(requests.some((request) => request.url.includes('addable'))).toBe(false);
  });

  it('rejects an empty non-terminal first page during probe', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/openapi/wiki/v1/get_knowledge_list') {
        return json({ code: 0, data: { knowledge_list: [], is_end: false, next_cursor: 'c2' } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(probeIma(config(), undefined)).rejects.toThrow(/empty page/);
  });
});
