import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeConnectors } from '../src/knowledge/connector-adapter.js';
import { parseDocument } from '../src/knowledge/parsing.js';
import {
  probeSource,
  readSource,
  SourceAuthError,
  type SourceConfig,
} from '../src/knowledge/sources.js';

type Call = { method: string; url: URL; headers: Headers; body: string };

const calls: Call[] = [];
const exportsByToken = new Map<string, string>();
const state = {
  pending: new Set<string>(),
  failures: new Set<string>(),
  createdError: null as { code: number; msg: string } | null,
  statusError: null as { code: number; msg: string } | null,
  wikiRootPage: null as unknown,
  driveRootPage: null as unknown,
  downloadFilename: null as string | null,
  downloadContentType: null as string | null,
};

function fixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/knowledge-sources/lark/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

const docxFixture = fixture<{ bytesBase64: string; sha256: string; mimeType: string }>(
  'export-docx.json',
);
const xlsxFixture = fixture<{ bytesBase64: string; sha256: string; mimeType: string }>(
  'export-xlsx.json',
);
const originalFixture = fixture<{ bytesBase64: string; sha256: string }>('file-original.json');

const LARK_HOST = 'open.larksuite.com';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytes(base64: string): Response {
  return new Response(Buffer.from(base64, 'base64'), { status: 200 });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const request = init ?? {};
      const headers = new Headers(request.headers);
      const body = typeof request.body === 'string' ? request.body : '';
      calls.push({ method: request.method ?? 'GET', url, headers, body });

      const path = decodeURIComponent(url.pathname);
      if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
        return json({ code: 0, tenant_access_token: 'lark-token' });
      }
      if (path === '/open-apis/wiki/v2/spaces/get_node') {
        return json(fixture('wiki-node-root.json'));
      }
      if (path === '/open-apis/wiki/v2/spaces/spc1/nodes') {
        if (
          state.wikiRootPage !== null &&
          !url.searchParams.get('parent_node_token') &&
          !url.searchParams.get('page_token')
        ) {
          return json(state.wikiRootPage);
        }
        if (url.searchParams.get('parent_node_token') === 'nod1') {
          return json(fixture('wiki-nodes-child.json'));
        }
        if (url.searchParams.get('page_token') === 'np2') {
          return json(fixture('wiki-nodes-page2.json'));
        }
        return json(fixture('wiki-nodes-page1.json'));
      }
      if (/^\/open-apis\/docx\/v1\/documents\/[^/]+\/blocks$/.test(path)) {
        return json({
          code: 0,
          data: {
            items: [
              {
                block_id: 'p1',
                block_type: 2,
                text: { elements: [{ text_run: { content: 'hi' } }] },
              },
            ],
            has_more: false,
          },
        });
      }
      if (path === '/open-apis/drive/v1/files') {
        const folder = url.searchParams.get('folder_token');
        if (folder === 'fldroot') {
          if (state.driveRootPage !== null && !url.searchParams.get('page_token')) {
            return json(state.driveRootPage);
          }
          return json(
            url.searchParams.get('page_token') === 'dp2'
              ? fixture('drive-files-page1b.json')
              : fixture('drive-files-page1.json'),
          );
        }
        if (folder === 'fldA') return json(fixture('drive-files-page2.json'));
        if (folder === 'fldB') return json(fixture('drive-files-nested.json'));
        throw new Error(`unexpected folder token ${folder}`);
      }
      if (path === '/open-apis/drive/v1/export_tasks') {
        if (state.createdError) return json(state.createdError);
        const parsed = JSON.parse(body) as {
          token: string;
          type: string;
          file_extension: string;
        };
        exportsByToken.set(parsed.token, parsed.file_extension);
        return json({ code: 0, data: { ticket: `ticket-${parsed.token}` } });
      }
      if (path.startsWith('/open-apis/drive/v1/export_tasks/file/')) {
        const fileToken = path.slice(
          '/open-apis/drive/v1/export_tasks/file/'.length,
          -'/download'.length,
        );
        const token = fileToken.replace(/^file-/, '');
        const kind = exportsByToken.get(token);
        return bytes(kind === 'xlsx' ? xlsxFixture.bytesBase64 : docxFixture.bytesBase64);
      }
      if (path.startsWith('/open-apis/drive/v1/export_tasks/')) {
        if (state.statusError) return json(state.statusError);
        const token = url.searchParams.get('token') ?? '';
        if (state.pending.has(token)) {
          return json({ code: 0, data: { result: { job_status: 1 } } });
        }
        if (state.failures.has(token)) {
          return json({
            code: 0,
            data: { result: { job_status: 3, job_error_msg: 'export failed' } },
          });
        }
        return json({
          code: 0,
          data: { result: { job_status: 0, file_token: `file-${token}` } },
        });
      }
      const download = /^\/open-apis\/drive\/v1\/files\/([^/]+)\/download$/.exec(path);
      if (download) {
        const headers = new Headers();
        if (state.downloadFilename) {
          headers.set('content-disposition', `attachment; filename="${state.downloadFilename}"`);
        }
        if (state.downloadContentType) headers.set('content-type', state.downloadContentType);
        return new Response(Buffer.from(originalFixture.bytesBase64, 'base64'), {
          status: 200,
          headers,
        });
      }
      throw new Error(`unexpected request ${url.href}`);
    }),
  );
}

function larkConfig(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'feishu',
    url: 'https://open.larksuite.com',
    credentials: { appSecret: 'lark-secret' },
    trustedHosts: [LARK_HOST],
    settings: {
      appId: 'cli_lark',
      region: 'lark',
      exportFiles: true,
      spaceId: 'spc1',
      ...settings,
    },
  };
}

function wikiFileRoot(title: string): unknown {
  return {
    code: 0,
    data: {
      items: [{ node_token: 'nod1', obj_token: 'file1', obj_type: 'file', title }],
      has_more: false,
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  exportsByToken.clear();
  state.pending.clear();
  state.failures.clear();
  state.createdError = null;
  state.statusError = null;
  state.wikiRootPage = null;
  state.driveRootPage = null;
  state.downloadFilename = null;
  state.downloadContentType = null;
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lark wiki and drive', () => {
  it('exports wiki tree originals with distinct tickets and file tokens', async () => {
    const snapshot = await readSource(larkConfig());

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'lark:wiki:nod1',
      'lark:wiki:nod2',
      'lark:wiki:nod3',
      'lark:wiki:nod4',
      'lark:wiki:nod5',
      'lark:wiki:nod7',
    ]);
    expect(snapshot.failures?.map((failure) => failure.externalId)).toEqual(['lark:wiki:nod6']);
    expect(snapshot.failures?.[0]?.code).toBe('unsupported_type');

    const byId = new Map(snapshot.items.map((item) => [item.externalId, item]));
    const guide = byId.get('lark:wiki:nod1');
    expect(guide?.title).toBe('Guide.docx');
    expect(guide?.mimeType).toBe(docxFixture.mimeType);
    expect(guide?.sourceUrl).toBe('https://larksuite.com/wiki/nod1');
    expect(sha256(guide?.bytes ?? new Uint8Array())).toBe(docxFixture.sha256);

    expect(byId.get('lark:wiki:nod2')?.mimeType).toBe(docxFixture.mimeType);
    expect(byId.get('lark:wiki:nod3')?.title).toBe('Budget.xlsx');
    expect(byId.get('lark:wiki:nod3')?.mimeType).toBe(xlsxFixture.mimeType);
    expect(sha256(byId.get('lark:wiki:nod3')?.bytes ?? new Uint8Array())).toBe(xlsxFixture.sha256);
    expect(byId.get('lark:wiki:nod4')?.mimeType).toBe(xlsxFixture.mimeType);
    expect(byId.get('lark:wiki:nod5')?.title).toBe('Manual.pdf');
    expect(byId.get('lark:wiki:nod5')?.mimeType).toBe('application/pdf');
    expect(sha256(byId.get('lark:wiki:nod5')?.bytes ?? new Uint8Array())).toBe(
      originalFixture.sha256,
    );
    expect(byId.get('lark:wiki:nod7')?.title).toBe('Child.docx');

    const tokenCall = calls.find(
      (call) => call.url.pathname === '/open-apis/auth/v3/tenant_access_token/internal',
    );
    expect(tokenCall?.method).toBe('POST');
    expect(JSON.parse(tokenCall?.body ?? '{}')).toEqual({
      app_id: 'cli_lark',
      app_secret: 'lark-secret',
    });
    for (const call of calls) expect(call.url.host).toBe(LARK_HOST);

    // 建任务用 obj_type + 扩展名；查询带 token；下载只用返回的 file_token。
    const exportBodies = calls
      .filter((call) => call.url.pathname === '/open-apis/drive/v1/export_tasks')
      .map((call) => JSON.parse(call.body) as Record<string, string>);
    expect(exportBodies).toEqual(
      expect.arrayContaining([
        { token: 'doc1', type: 'docx', file_extension: 'docx' },
        { token: 'doc2', type: 'doc', file_extension: 'docx' },
        { token: 'sht1', type: 'sheet', file_extension: 'xlsx' },
        { token: 'bit1', type: 'bitable', file_extension: 'xlsx' },
      ]),
    );
    const exportPost = calls.find(
      (call) => call.url.pathname === '/open-apis/drive/v1/export_tasks',
    );
    expect(exportPost?.method).toBe('POST');
    expect(exportPost?.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const status = calls.find(
      (call) =>
        call.url.pathname === '/open-apis/drive/v1/export_tasks/ticket-doc1' &&
        call.url.searchParams.get('token') === 'doc1',
    );
    expect(status).toBeDefined();
    const download = calls.find((call) =>
      call.url.pathname.includes('/export_tasks/file/file-doc1/download'),
    );
    expect(download).toBeDefined();
    expect(calls.some((call) => call.url.pathname.includes('ticket-doc1/download'))).toBe(false);
    for (const call of calls) {
      if (call.url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') continue;
      expect(call.headers.get('authorization')).toBe('Bearer lark-token');
    }
  });

  it('resolves a wiki node root without a separate space id', async () => {
    const snapshot = await readSource(larkConfig({ spaceId: undefined, nodeToken: 'nod1' }));

    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'lark:wiki:nod1',
      'lark:wiki:nod7',
    ]);
    expect(
      calls.some(
        (call) =>
          call.url.pathname === '/open-apis/wiki/v2/spaces/spc1/nodes' &&
          call.url.searchParams.get('parent_node_token') === null,
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.url.pathname === '/open-apis/wiki/v2/spaces/spc1/nodes' &&
          call.url.searchParams.get('parent_node_token') === 'nod1',
      ),
    ).toBe(true);
  });

  it('walks drive folders, resolves shortcuts once, and keeps raw bytes', async () => {
    const snapshot = await readSource(larkConfig({ spaceId: undefined, folderToken: 'fldroot' }));

    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'lark:drive:docD',
      'lark:drive:docL',
      'lark:drive:raw1',
      'lark:drive:raw2',
      'lark:drive:sht2',
    ]);
    expect(snapshot.failures?.map((failure) => failure.externalId)).toEqual(['lark:drive:lnkB']);
    expect(snapshot.items.some((item) => item.externalId.includes('fldA'))).toBe(false);
    const listFolders = calls
      .filter((call) => call.url.pathname === '/open-apis/drive/v1/files')
      .map((call) => call.url.searchParams.get('folder_token'));
    // 根目录两页；目录快捷方式与真实目录只递归一次。
    expect(listFolders).toEqual(['fldroot', 'fldroot', 'fldA', 'fldB']);

    const byId = new Map(snapshot.items.map((item) => [item.externalId, item]));
    const raw = byId.get('lark:drive:raw1');
    expect(raw?.sourceUrl).toBe('https://larksuite.com/file/raw1');
    expect(raw?.mimeType).toBe('application/pdf');
    expect(sha256(raw?.bytes ?? new Uint8Array())).toBe(originalFixture.sha256);
    expect(byId.get('lark:drive:raw2')?.mimeType).toBe('application/octet-stream');
    expect(byId.get('lark:drive:docD')?.sourceUrl).toBe('https://larksuite.com/docx/docD');
    expect(byId.get('lark:drive:docD')?.mimeType).toBe(docxFixture.mimeType);
    expect(byId.get('lark:drive:sht2')?.mimeType).toBe(xlsxFixture.mimeType);
  });

  it('turns an export job failure into an item failure without publishing empty content', async () => {
    state.failures.add('doc1');
    const snapshot = await readSource(larkConfig());

    expect(snapshot.items.some((item) => item.externalId === 'lark:wiki:nod1')).toBe(false);
    const failure = snapshot.failures?.find((entry) => entry.externalId === 'lark:wiki:nod1');
    expect(failure?.code).toBe('fetch_failed');
    expect(failure?.message).toContain('export failed');
    expect(snapshot.complete).toBe(false);
  });

  it('classifies an auth code on export task creation as source auth', async () => {
    state.createdError = { code: 99991668, msg: 'invalid tenant access token' };

    await expect(readSource(larkConfig())).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('classifies an auth code on export task polling as source auth', async () => {
    state.statusError = { code: 99991668, msg: 'invalid tenant access token' };

    await expect(readSource(larkConfig())).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('rejects a wiki page without has_more instead of treating it as the last page', async () => {
    state.wikiRootPage = {
      code: 0,
      data: {
        items: [{ node_token: 'nod1', obj_token: 'doc1', obj_type: 'docx', title: 'Guide' }],
      },
    };

    await expect(readSource(larkConfig())).rejects.toThrow(/does not match the expected schema/);
  });

  it('fails immediately when a wiki page claims more pages without items', async () => {
    state.wikiRootPage = {
      code: 0,
      data: { items: [], has_more: true, page_token: 'np2' },
    };

    await expect(readSource(larkConfig())).rejects.toThrow(/empty page/);
    expect(
      calls.filter((call) => call.url.pathname === '/open-apis/wiki/v2/spaces/spc1/nodes'),
    ).toHaveLength(1);
  });

  it('rejects a drive page without has_more instead of treating it as the last page', async () => {
    state.driveRootPage = {
      code: 0,
      data: { files: [{ token: 'raw1', name: 'report.pdf', type: 'file' }] },
    };

    await expect(
      readSource(larkConfig({ spaceId: undefined, folderToken: 'fldroot' })),
    ).rejects.toThrow(/does not match the expected schema/);
  });

  it('fails immediately when a drive page claims more pages without files', async () => {
    state.driveRootPage = {
      code: 0,
      data: { files: [], has_more: true, next_page_token: 'dp2' },
    };

    await expect(
      readSource(larkConfig({ spaceId: undefined, folderToken: 'fldroot' })),
    ).rejects.toThrow(/empty page/);
    expect(calls.filter((call) => call.url.pathname === '/open-apis/drive/v1/files')).toHaveLength(
      1,
    );
  });

  it('probes a first page that claims more pages with no items as a failure', async () => {
    state.wikiRootPage = {
      code: 0,
      data: { items: [], has_more: true, page_token: 'np2' },
    };

    await expect(probeSource(larkConfig())).rejects.toThrow(/empty page/);
  });

  it('routes a wiki file by the downloaded filename, not the editable node title', async () => {
    state.wikiRootPage = wikiFileRoot('Guide.md');
    state.downloadFilename = 'original.pdf';

    const snapshot = await readSource(larkConfig());
    const item = snapshot.items[0];
    expect(item?.title).toBe('Guide.pdf');
    expect(item?.mimeType).toBe('application/pdf');
    // 真实解析链必须把 PDF 交给 Docling，而不是按可编辑标题的 .md 当文本解码。
    await expect(
      parseDocument({
        bytes: item?.bytes ?? new Uint8Array(),
        filename: item?.title ?? '',
        mimeType: item?.mimeType ?? '',
      }),
    ).rejects.toMatchObject({ code: 'parser_unavailable' });
  });

  it('uses the trusted non-text response type when the download has no filename', async () => {
    state.wikiRootPage = wikiFileRoot('Guide.md');
    state.downloadContentType = 'application/pdf';

    const snapshot = await readSource(larkConfig());
    const item = snapshot.items[0];
    expect(item?.title).toBe('Guide.pdf');
    expect(item?.mimeType).toBe('application/pdf');
    await expect(
      parseDocument({
        bytes: item?.bytes ?? new Uint8Array(),
        filename: item?.title ?? '',
        mimeType: item?.mimeType ?? '',
      }),
    ).rejects.toMatchObject({ code: 'parser_unavailable' });
  });

  it('fails a wiki file when neither download metadata nor the response names a format', async () => {
    state.wikiRootPage = wikiFileRoot('Guide.md');
    state.downloadContentType = 'application/octet-stream';

    const snapshot = await readSource(larkConfig());

    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.complete).toBe(false);
    const failure = snapshot.failures?.find((entry) => entry.externalId === 'lark:wiki:nod1');
    expect(failure?.code).toBe('unsupported_type');
    expect(failure?.retryable).toBe(false);
  });

  it('probes only the selected root and never imports or advances a cursor', async () => {
    await probeSource(larkConfig());
    expect(
      calls.filter((call) => call.url.pathname === '/open-apis/wiki/v2/spaces/spc1/nodes'),
    ).toHaveLength(1);

    calls.length = 0;
    await probeSource(larkConfig({ spaceId: undefined, folderToken: 'fldroot' }));
    expect(calls.filter((call) => call.url.pathname === '/open-apis/drive/v1/files')).toHaveLength(
      1,
    );
    expect(calls.every((call) => call.url.host === LARK_HOST)).toBe(true);
  });

  it('cancels export polling promptly', async () => {
    state.pending.add('doc1');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled')), 20);

    await expect(readSource(larkConfig(), undefined, controller.signal)).rejects.toThrow(
      /cancelled|aborted/,
    );
  });
});

describe('Lark bridge mapping', () => {
  it('maps the public lark_wiki type to the fixed Lark host and export settings', async () => {
    const items: Array<{ sourceId: string; revision: string; mimeType: string }> = [];
    for await (const item of knowledgeConnectors.lark_wiki.sync({
      connectionId: 'conn',
      config: { appId: 'cli_lark' },
      secrets: { appSecret: 'lark-secret' },
      ranges: [{ kind: 'wiki_space', externalId: 'spc1', ref: null, paths: [] }],
      cursor: {},
      signal: new AbortController().signal,
      network: { trustedHosts: [LARK_HOST] },
      onCheckpoint: async () => undefined,
    })) {
      items.push(item);
    }

    expect(items.map((item) => item.sourceId).sort()).toEqual([
      'conn:lark:wiki:nod1',
      'conn:lark:wiki:nod2',
      'conn:lark:wiki:nod3',
      'conn:lark:wiki:nod4',
      'conn:lark:wiki:nod5',
      'conn:lark:wiki:nod6',
      'conn:lark:wiki:nod7',
    ]);
    expect(items.find((item) => item.sourceId.endsWith('nod1'))?.revision).toBe('lark:wiki:nod1');
    expect(items.find((item) => item.sourceId.endsWith('nod1'))?.mimeType).toBe(
      docxFixture.mimeType,
    );
    for (const call of calls) expect(call.url.host).toBe(LARK_HOST);
  });

  it('keeps the existing Feishu default on the Feishu host', async () => {
    const items: Array<{ sourceId: string; content: unknown }> = [];
    for await (const item of knowledgeConnectors.feishu_wiki.sync({
      connectionId: 'conn',
      config: { baseUrl: 'https://open.feishu.cn', appId: 'cli_feishu' },
      secrets: { appSecret: 'feishu-secret' },
      ranges: [{ kind: 'wiki_node', externalId: 'nod1', ref: null, paths: [] }],
      cursor: {},
      signal: new AbortController().signal,
      network: { trustedHosts: ['open.feishu.cn'] },
      onCheckpoint: async () => undefined,
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(2);
    const guide = items.find((item) => item.sourceId === 'conn:feishu:wiki:nod1');
    expect(guide?.content).toEqual({ markdown: 'hi' });
    expect(items.every((item) => item.sourceId.startsWith('conn:feishu:wiki:'))).toBe(true);
    expect(calls.some((call) => call.url.pathname === '/open-apis/drive/v1/export_tasks')).toBe(
      false,
    );
    expect(calls.every((call) => call.url.host === 'open.feishu.cn')).toBe(true);
  });
});
