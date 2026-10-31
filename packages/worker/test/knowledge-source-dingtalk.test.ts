import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeDingtalk, readDingtalk } from '../src/knowledge/source-dingtalk.js';
import { SourceAuthError } from '../src/knowledge/source-http.js';
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
    readFileSync(new URL(`./fixtures/knowledge-sources/dingtalk/${name}`, import.meta.url), 'utf8'),
  ) as T;
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

function bytes(value: Buffer, contentType: string): Response {
  return new Response(value, { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(settings: Record<string, unknown>): SourceConfig {
  return {
    type: 'dingtalk',
    url: '',
    credentials: { clientSecret: 'client-secret' },
    settings: {
      clientId: 'client-id',
      operatorUnionId: 'union-1',
      ...settings,
    },
    trustedHosts: ['api.dingtalk.com'],
    allowLoopback: true,
  };
}

const workspaceConfig = () => config({ rangeKind: 'dingtalk_workspace', resourceId: 'ws1' });
const nodeConfig = (nodeId: string) => config({ rangeKind: 'dingtalk_node', resourceId: nodeId });

function docxBytes(): Buffer {
  return Buffer.from(fixture<{ base64: string }>('sample-docx.json').base64, 'base64');
}

describe('readDingtalk', () => {
  it('reads workspace pages, docKey blocks and uploaded bytes with stable identities', async () => {
    const workspace = fixture('workspace.json');
    const rootPage1 = fixture('nodes-root-page-1.json');
    const rootPage2 = fixture('nodes-root-page-2.json');
    const folder = fixture('nodes-folder.json');
    const docItems = fixture('doc-items.json');
    const blocks1 = fixture('blocks-doc-1.json');
    const blocks4 = fixture('blocks-doc-4.json');
    const downloadInfo = fixture('download-info.json');
    const signedUrl = 'http://127.0.0.1:9000/file';
    const docx = docxBytes();

    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.hostname === 'api.dingtalk.com') {
        if (url.pathname === '/v1.0/oauth2/accessToken') {
          return json({ accessToken: 'token-1', expireIn: 7200 });
        }
        if (url.pathname === '/v2.0/wiki/workspaces/ws1') return json(workspace);
        if (url.pathname === '/v2.0/wiki/nodes') {
          const parent = url.searchParams.get('parentNodeId');
          if (parent === 'root-1') {
            return url.searchParams.get('nextToken') === 'page-2'
              ? json(rootPage2)
              : json(rootPage1);
          }
          if (parent === 'folder-1') return json(folder);
          throw new Error(`unexpected parent node ${parent}`);
        }
        if (url.pathname === '/v2.0/doc/items') {
          const nodeUrl = url.searchParams.get('url') ?? '';
          const value = docItems[nodeUrl];
          if (!value) throw new Error(`unexpected node URL ${nodeUrl}`);
          return json(value);
        }
        if (url.pathname.startsWith('/v1.0/doc/suites/documents/')) {
          const docKey = decodeURIComponent(url.pathname.split('/')[5] ?? '');
          return json(docKey === 'doc-key-1' ? blocks1 : blocks4);
        }
        if (url.pathname === '/v2.0/doc/dentries/uuid-2/queryDentryId') {
          return json({ spaceId: '333', dentryId: '444', dentryUuid: 'uuid-2' });
        }
        if (url.pathname === '/v1.0/storage/spaces/333/dentries/444/downloadInfos/query') {
          return json({
            ...downloadInfo,
            headerSignatureInfo: {
              ...(downloadInfo.headerSignatureInfo as Json),
              resourceUrls: [signedUrl],
            },
          });
        }
      }
      if (record.url === signedUrl) return bytes(docx, 'application/octet-stream');
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(workspaceConfig(), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.failures).toBeUndefined();
    expect(snapshot.cursor).toEqual({ version: 1, initial: true });
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'dingtalk:node:node-child',
      'dingtalk:node:node-online',
      'dingtalk:node:node-upload',
    ]);

    const token = requests.find((request) => request.url.endsWith('/v1.0/oauth2/accessToken'));
    expect(token?.method).toBe('POST');
    expect(JSON.parse(token?.body ?? '{}')).toEqual({
      appKey: 'client-id',
      appSecret: 'client-secret',
    });
    expect(token?.headers['x-acs-dingtalk-access-token']).toBeUndefined();

    const workspaceRequest = requests.find((request) =>
      request.url.includes('/v2.0/wiki/workspaces/ws1'),
    );
    expect(workspaceRequest?.method).toBe('GET');
    expect(new URL(workspaceRequest?.url ?? '').searchParams.get('operatorId')).toBe('union-1');
    expect(workspaceRequest?.headers['x-acs-dingtalk-access-token']).toBe('token-1');

    const onlineMetadata = requests.find(
      (request) =>
        request.url.includes('/v2.0/doc/items') &&
        new URL(request.url).searchParams.get('url') === 'https://example.dingtalk.com/doc/1',
    );
    expect(onlineMetadata).toBeDefined();
    expect(new URL(onlineMetadata?.url ?? '').searchParams.get('operatorId')).toBe('union-1');

    const blockRequest = requests.find((request) =>
      request.url.includes('/v1.0/doc/suites/documents/doc-key-1/blocks'),
    );
    expect(blockRequest).toBeDefined();
    expect(blockRequest?.url).not.toContain('node-online');
    expect(new URL(blockRequest?.url ?? '').searchParams.get('startIndex')).toBe('0');
    expect(new URL(blockRequest?.url ?? '').searchParams.get('endIndex')).toBe('99');

    const storage = requests.find((request) =>
      request.url.includes('/v1.0/storage/spaces/333/dentries/444/downloadInfos/query'),
    );
    expect(storage?.method).toBe('POST');
    expect(JSON.parse(storage?.body ?? '{}')).toEqual({
      option: { version: 1, preferIntranet: false },
    });
    expect(new URL(storage?.url ?? '').searchParams.get('unionId')).toBe('union-1');

    const signed = requests.find((request) => request.url === signedUrl);
    expect(signed?.headers.authorization).toBe('signed-token');
    expect(signed?.headers['x-amz-signature']).toBe('signature-1');
    expect(signed?.headers.host).toBeUndefined();
    expect(signed?.headers['content-length']).toBeUndefined();
    expect(signed?.headers.connection).toBeUndefined();

    const online = snapshot.items.find((item) => item.externalId === 'dingtalk:node:node-online');
    expect(online?.title).toBe('Intro');
    expect(online?.path).toBe('Intro.md');
    expect(online?.mimeType).toBe('text/markdown');
    expect(online?.content).toContain('Hello world');
    expect(online?.content).toContain('Overview');
    expect(online?.content).toContain('- first item');
    expect(online?.content).toContain('```ts');
    expect(online?.content).toContain('| Name | Value |');
    expect(online?.content).toContain('Attachment: spec.pdf');
    expect(online?.sourceUrl).toBe('https://example.dingtalk.com/doc/1');
    expect(online?.revision).toBe('1700000000000');

    const child = snapshot.items.find((item) => item.externalId === 'dingtalk:node:node-child');
    expect(child?.path).toBe('Folder A/Child.md');
    expect(child?.content).toContain('Folder child body');

    const upload = snapshot.items.find((item) => item.externalId === 'dingtalk:node:node-upload');
    expect(upload?.title).toBe('spec.docx');
    expect(upload?.path).toBe('spec.docx');
    expect(upload?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(upload?.revision).toBe('1700000001000');
    expect(
      createHash('sha256')
        .update(upload?.bytes ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(createHash('sha256').update(docx).digest('hex'));
  });

  it('reads descendants of a file node that reports hasChildren', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-root') {
        return json({
          node: {
            nodeId: 'node-root',
            workspaceId: 'ws1',
            name: 'Root doc',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/root',
            hasChildren: true,
          },
        });
      }
      if (url.pathname === '/v2.0/wiki/nodes') {
        return json({
          nodes: [
            {
              nodeId: 'node-desc',
              workspaceId: 'ws1',
              name: 'Desc',
              type: 'FILE',
              category: 'ALIDOC',
              extension: 'adoc',
              url: 'https://example.dingtalk.com/doc/desc',
            },
          ],
        });
      }
      if (url.pathname === '/v2.0/doc/items') {
        const nodeUrl = url.searchParams.get('url') ?? '';
        return json({ dentry: { docKey: nodeUrl.endsWith('/root') ? 'doc-root' : 'doc-desc' } });
      }
      if (url.pathname.includes('/doc-root/blocks')) {
        return json({
          success: true,
          result: {
            data: [{ blockType: 'paragraph', id: 'r1', paragraph: { text: 'root body' } }],
          },
        });
      }
      if (url.pathname.includes('/doc-desc/blocks')) {
        return json({
          success: true,
          result: {
            data: [{ blockType: 'paragraph', id: 'd1', paragraph: { text: 'desc body' } }],
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-root'), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.externalId).sort()).toEqual([
      'dingtalk:node:node-desc',
      'dingtalk:node:node-root',
    ]);
    const descendant = snapshot.items.find((item) => item.externalId === 'dingtalk:node:node-desc');
    expect(descendant?.path).toBe('Root doc/Desc.md');
    expect(descendant?.content).toContain('desc body');
  });

  it('fails the whole document on an unknown inline element', async () => {
    const blocks = fixture('blocks-unknown-inline.json');
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-online') {
        return json({
          node: {
            nodeId: 'node-online',
            workspaceId: 'ws1',
            name: 'Intro',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') {
        return json({ dentry: { docKey: 'doc-key-1' } });
      }
      if (url.pathname.includes('/doc-key-1/blocks')) return json(blocks);
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-online'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('unsupported_block');
    expect(snapshot.failures?.[0]?.message).toContain('slot');
  });

  it('fails immediately on an empty non-terminal node page', async () => {
    let listCalls = 0;
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') return json(fixture('workspace.json'));
      if (url.pathname === '/v2.0/wiki/nodes') {
        listCalls += 1;
        return listCalls === 1
          ? json({ nodes: [], nextToken: 'page-2' })
          : json({ nodes: [], nextToken: '' });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toThrow(
      /empty page/,
    );
    expect(listCalls).toBe(1);
  });

  it('rejects a flattened workspace response instead of accepting the fake shape', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') {
        return json({ workspaceId: 'ws1', rootNodeId: 'root-1' });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toThrow(
      /does not match the expected schema/,
    );
  });

  it('rejects a workspace whose reported ID differs from the requested workspace', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') {
        return json({ workspace: { workspaceId: 'ws-other', rootNodeId: 'root-1' } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toThrow(
      /requested workspace/,
    );
    await expect(probeDingtalk(workspaceConfig(), undefined)).rejects.toThrow(
      /requested workspace/,
    );
    expect(requests.some((request) => request.url.includes('/v2.0/wiki/nodes'))).toBe(false);
  });

  it('requires the workspace response to carry a workspaceId in the official envelope', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') {
        return json({ workspace: { rootNodeId: 'root-1' } });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toThrow(
      /expected schema/,
    );
    expect(requests.some((request) => request.url.includes('/v2.0/wiki/nodes'))).toBe(false);
  });

  it('rejects a node whose nodeId differs from the requested node before enumeration', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-requested') {
        return json({
          node: {
            nodeId: 'node-other',
            workspaceId: 'ws1',
            name: 'Other',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(nodeConfig('node-requested'), undefined, undefined)).rejects.toThrow(
      /requested node/,
    );
    await expect(probeDingtalk(nodeConfig('node-requested'), undefined)).rejects.toThrow(
      /requested node/,
    );
    expect(requests.some((request) => request.url.includes('/v2.0/wiki/nodes?'))).toBe(false);
    expect(requests.some((request) => request.url.includes('/v2.0/doc/items'))).toBe(false);
  });

  it('rejects a first-page probe child from another workspace before reading it', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') return json(fixture('workspace.json'));
      if (url.pathname === '/v2.0/wiki/nodes') {
        return json({
          nodes: [
            {
              nodeId: 'node-foreign',
              workspaceId: 'ws-other',
              name: 'Foreign',
              type: 'FILE',
              category: 'ALIDOC',
              extension: 'adoc',
              url: 'https://example.dingtalk.com/foreign',
            },
          ],
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(probeDingtalk(workspaceConfig(), undefined)).rejects.toThrow(/another workspace/);
    expect(requests.some((request) => request.url.includes('/v2.0/doc/items'))).toBe(false);
    expect(requests.some((request) => request.url.includes('/blocks'))).toBe(false);
  });

  it('fails the item instead of guessing docKey from nodeId', async () => {
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-online') {
        return json({
          node: {
            nodeId: 'node-online',
            workspaceId: 'ws1',
            name: 'Intro',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') return json({ dentry: { dentryUuid: 'uuid-1' } });
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-online'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('missing_document_key');
    expect(
      requests.some((request) => request.url.includes('/doc/suites/documents/node-online/')),
    ).toBe(false);
    expect(requests.some((request) => request.url.includes('/blocks'))).toBe(false);
  });

  it('reports an unsupported content block instead of publishing a partial document', async () => {
    const blocks = fixture('blocks-unknown.json');
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-online') {
        return json({
          node: {
            nodeId: 'node-online',
            workspaceId: 'ws1',
            name: 'Intro',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') {
        return json({ dentry: { docKey: 'doc-key-1' } });
      }
      if (url.pathname.includes('/doc-key-1/blocks')) return json(blocks);
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-online'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('unsupported_block');
    expect(snapshot.failures?.[0]?.message).toContain('card');
  });

  it('fails a repeated full block page instead of truncating silently', async () => {
    const fullPage = {
      success: true,
      result: {
        data: Array.from({ length: 100 }, (_, index) => ({
          blockType: 'paragraph',
          id: `block-${index}`,
          paragraph: { text: `line ${index}` },
        })),
      },
    };
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-online') {
        return json({
          node: {
            nodeId: 'node-online',
            workspaceId: 'ws1',
            name: 'Intro',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') {
        return json({ dentry: { docKey: 'doc-key-1' } });
      }
      if (url.pathname.includes('/doc-key-1/blocks')) return json(fullPage);
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-online'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures?.[0]?.code).toBe('fetch_failed');
    expect(snapshot.failures?.[0]?.message).toContain('repeated');
  });

  it('throws SourceAuthError when the API token is rejected', async () => {
    installFetch(() => json({}, 401));

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toBeInstanceOf(
      SourceAuthError,
    );
  });

  it('treats an expired signed download as an item failure, not source revocation', async () => {
    const downloadInfo = fixture('download-info.json');
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-upload') {
        return json({
          node: {
            nodeId: 'node-upload',
            workspaceId: 'ws1',
            name: 'spec',
            type: 'FILE',
            category: 'DOCUMENT',
            extension: 'docx',
            url: 'https://example.dingtalk.com/file/2',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') return json({ dentry: { dentryUuid: 'uuid-2' } });
      if (url.pathname === '/v2.0/doc/dentries/uuid-2/queryDentryId') {
        return json({ spaceId: '333', dentryId: '444' });
      }
      if (url.pathname === '/v1.0/storage/spaces/333/dentries/444/downloadInfos/query') {
        return json({
          ...downloadInfo,
          headerSignatureInfo: {
            ...(downloadInfo.headerSignatureInfo as Json),
            resourceUrls: ['http://127.0.0.1:9000/expired'],
          },
        });
      }
      if (record.url === 'http://127.0.0.1:9000/expired') return json({}, 403);
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-upload'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('fetch_failed');
    expect(snapshot.failures?.[0]?.retryable).toBe(true);
  });

  it('never re-sends signed headers after leaving the target origin', async () => {
    const downloadInfo = fixture('download-info.json');
    const docx = docxBytes();
    const first = 'http://127.0.0.1:9000/file';
    const second = 'http://127.0.0.1:9100/hop';
    const third = 'http://127.0.0.1:9000/final';
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-upload') {
        return json({
          node: {
            nodeId: 'node-upload',
            workspaceId: 'ws1',
            name: 'spec',
            type: 'FILE',
            category: 'DOCUMENT',
            extension: 'docx',
            url: 'https://example.dingtalk.com/file/2',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') return json({ dentry: { dentryUuid: 'uuid-2' } });
      if (url.pathname === '/v2.0/doc/dentries/uuid-2/queryDentryId') {
        return json({ spaceId: '333', dentryId: '444' });
      }
      if (url.pathname === '/v1.0/storage/spaces/333/dentries/444/downloadInfos/query') {
        return json({
          ...downloadInfo,
          headerSignatureInfo: {
            ...(downloadInfo.headerSignatureInfo as Json),
            resourceUrls: [first],
          },
        });
      }
      if (record.url === first) return redirect(second);
      if (record.url === second) return redirect(third);
      if (record.url === third) return bytes(docx, 'application/octet-stream');
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-upload'), undefined, undefined);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items).toHaveLength(1);
    const firstHop = requests.find((request) => request.url === first);
    const crossOrigin = requests.find((request) => request.url === second);
    const backToOrigin = requests.find((request) => request.url === third);
    expect(firstHop?.headers.authorization).toBe('signed-token');
    expect(firstHop?.headers['x-amz-signature']).toBe('signature-1');
    expect(crossOrigin?.headers.authorization).toBeUndefined();
    expect(crossOrigin?.headers['x-amz-signature']).toBeUndefined();
    expect(backToOrigin?.headers.authorization).toBeUndefined();
    expect(backToOrigin?.headers['x-amz-signature']).toBeUndefined();
  });

  it('rejects a repeated node pagination token', async () => {
    const loopNode = {
      nodeId: 'node-loop',
      workspaceId: 'ws1',
      name: 'Loop',
      type: 'FOLDER',
    };
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') {
        return json({ workspace: { workspaceId: 'ws1', rootNodeId: 'root-1' } });
      }
      if (url.pathname === '/v2.0/wiki/nodes') {
        return url.searchParams.get('nextToken') === 'same'
          ? json({ nodes: [loopNode], nextToken: 'same' })
          : json({ nodes: [loopNode], nextToken: 'same' });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(readDingtalk(workspaceConfig(), undefined, undefined)).rejects.toThrow(
      /repeated nextToken/,
    );
  });

  it('reports unsupported node types as item failures', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-mind') {
        return json({
          node: {
            nodeId: 'node-mind',
            workspaceId: 'ws1',
            name: 'Mind',
            type: 'FILE',
            category: 'AMIND',
            extension: 'amind',
            url: 'https://example.dingtalk.com/mind/1',
          },
        });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    const snapshot = await readDingtalk(nodeConfig('node-mind'), undefined, undefined);

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.failures?.[0]?.code).toBe('unsupported_type');
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
    const reading = readDingtalk(workspaceConfig(), undefined, controller.signal);
    await requestStarted;
    controller.abort();

    await expect(reading).rejects.toThrow();
  });
});

describe('probeDingtalk', () => {
  it('proves the selected node without downloading its bytes', async () => {
    const blocks = fixture('blocks-doc-1.json');
    const requests = installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/nodes/node-online') {
        return json({
          node: {
            nodeId: 'node-online',
            workspaceId: 'ws1',
            name: 'Intro',
            type: 'FILE',
            category: 'ALIDOC',
            extension: 'adoc',
            url: 'https://example.dingtalk.com/doc/1',
          },
        });
      }
      if (url.pathname === '/v2.0/doc/items') return json({ dentry: { docKey: 'doc-key-1' } });
      if (url.pathname.includes('/doc-key-1/blocks')) return json(blocks);
      throw new Error(`unexpected request ${record.url}`);
    });

    await probeDingtalk(nodeConfig('node-online'), undefined);

    expect(requests.some((request) => request.url.includes('/downloadInfos/query'))).toBe(false);
    expect(requests.some((request) => request.url.startsWith('http://127.0.0.1'))).toBe(false);
    const blockRequests = requests.filter((request) => request.url.includes('/blocks'));
    expect(blockRequests).toHaveLength(1);
  });

  it('rejects an empty non-terminal first page during probe', async () => {
    installFetch((record) => {
      const url = new URL(record.url);
      if (url.pathname === '/v1.0/oauth2/accessToken') return json({ accessToken: 'token-1' });
      if (url.pathname === '/v2.0/wiki/workspaces/ws1') return json(fixture('workspace.json'));
      if (url.pathname === '/v2.0/wiki/nodes') {
        return json({ nodes: [], nextToken: 'page-2' });
      }
      throw new Error(`unexpected request ${record.url}`);
    });

    await expect(probeDingtalk(workspaceConfig(), undefined)).rejects.toThrow(/empty page/);
  });
});
