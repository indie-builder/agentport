import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeConnectors } from '../src/knowledge/connector-adapter.js';
import type {
  ConnectorNetwork,
  KnowledgeConnector,
  SourceCheckpoint,
  SourceItem,
} from '../src/knowledge/ingestion.js';

type Recorded = { path: string; headers: IncomingMessage['headers'] };

const state = { requests: [] as Recorded[], failingFeed: false };

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function feed(title: string, ids: string[]): string {
  const items = ids
    .map(
      (id) =>
        `<item><guid>${id}</guid><title>${title} ${id}</title><description>body ${id}</description></item>`,
    )
    .join('');
  return `<rss version="2.0"><channel><title>${title}</title>${items}</channel></rss>`;
}

let fixture: Awaited<ReturnType<typeof startServer>>;
let fixtureUrl = '';
const network: ConnectorNetwork = { allowLoopback: true };

beforeAll(async () => {
  fixture = await startServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    state.requests.push({ path, headers: request.headers });
    if (path === '/feed-a') {
      response.writeHead(200, { 'content-type': 'application/rss+xml' });
      response.end(feed('A', state.failingFeed ? [] : ['a1', 'a2']));
      return;
    }
    if (path === '/feed-b') {
      response.writeHead(200, { 'content-type': 'application/rss+xml' });
      response.end(feed('B', ['b1']));
      return;
    }
    if (path === '/broken') {
      response.writeHead(500).end('nope');
      return;
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }));
      return;
    }
    if (path === '/open-apis/wiki/v2/spaces/get_node') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            node: {
              node_token: 'nod1',
              obj_token: 'doc1',
              obj_type: 'docx',
              title: 'Guide',
              space_id: 'spc1',
              has_child: false,
            },
          },
        }),
      );
      return;
    }
    if (path === '/open-apis/docx/v1/documents/doc1/blocks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
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
        }),
      );
      return;
    }
    if (path === '/api/v4/projects/group%2Fproj') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 42, default_branch: 'main' }));
      return;
    }
    if (path === '/api/v4/projects/42/repository/tree') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ path: 'docs/a.md', type: 'blob' }]));
      return;
    }
    if (path === '/api/v4/projects/42/repository/files/docs%2Fa.md/raw') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('# doc');
      return;
    }
    if (path === '/api/v3/repos/octo/proj') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: 77, default_branch: 'main', html_url: `${fixtureUrl}/octo/proj` }),
      );
      return;
    }
    if (path === '/api/v3/repos/octo/proj/git/trees/main') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          tree: [
            { path: 'docs/a.md', type: 'blob', sha: 'shaA' },
            { path: 'src/a.md', type: 'blob', sha: 'shaA' },
          ],
          truncated: false,
        }),
      );
      return;
    }
    if (path === '/api/v3/repos/octo/other') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ id: 78, default_branch: 'dev', html_url: `${fixtureUrl}/octo/other` }),
      );
      return;
    }
    if (path === '/api/v3/repos/octo/other/git/trees/dev') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          tree: [{ path: 'docs/x.md', type: 'blob', sha: 'shaX' }],
          truncated: false,
        }),
      );
      return;
    }
    if (path === '/api/v3/repos/octo/other/git/blobs/shaX') {
      response.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      response.end('# other doc');
      return;
    }
    if (path === '/api/v3/repos/octo/proj/git/blobs/shaA') {
      response.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      response.end('# doc');
      return;
    }
    response.writeHead(404).end('missing');
  });
  fixtureUrl = fixture.url;
});

afterAll(async () => {
  await fixture.close();
});

interface Collected {
  items: SourceItem[];
  checkpoints: Array<{ cursor: Record<string, unknown>; status: SourceCheckpoint }>;
}

async function run(
  type: keyof typeof knowledgeConnectors,
  config: Record<string, unknown>,
  ranges: Array<{ kind: string; externalId: string; ref: string | null; paths: string[] }>,
  cursor: Record<string, unknown> = {},
  net: ConnectorNetwork = network,
  secrets: Record<string, string> = {},
): Promise<Collected> {
  const items: SourceItem[] = [];
  const checkpoints: Collected['checkpoints'] = [];
  const connector: KnowledgeConnector = knowledgeConnectors[type];
  for await (const item of connector.sync({
    connectionId: 'src_conn',
    config,
    secrets,
    ranges,
    cursor,
    signal: new AbortController().signal,
    network: net,
    onCheckpoint: async (next, status) => {
      checkpoints.push({ cursor: next, status });
    },
  })) {
    items.push(item);
  }
  return { items, checkpoints };
}

const withConnection = (externalId: string): string => `src_conn:${externalId}`;

const range = (externalId: string) => ({
  kind: 'feed',
  externalId,
  ref: null,
  paths: [],
});

describe('connector adapter ranges', () => {
  it('reads every feed range, not just the first', async () => {
    state.requests = [];
    state.failingFeed = false;
    const result = await run('feed', { syncDeletions: false }, [
      range(`${fixtureUrl}/feed-a`),
      range(`${fixtureUrl}/feed-b`),
    ]);

    expect(result.items.map((item) => item.sourceId).sort()).toEqual(
      [
        withConnection(`${fixtureUrl}/feed-a:a1`),
        withConnection(`${fixtureUrl}/feed-a:a2`),
        withConnection(`${fixtureUrl}/feed-b:b1`),
      ].sort(),
    );
    expect(state.requests.map((entry) => entry.path).sort()).toEqual(['/feed-a', '/feed-b']);
  });

  it('keeps one independent cursor per range and never claims completeness per range', async () => {
    state.requests = [];
    state.failingFeed = false;
    const result = await run('feed', {}, [
      range(`${fixtureUrl}/feed-a`),
      range(`${fixtureUrl}/feed-b`),
    ]);

    // 每个 range 一个检查点，末尾再落一次汇总（complete 只可能出现在这里）。
    expect(result.checkpoints).toHaveLength(3);
    const [first, , last] = result.checkpoints;
    // 中间检查点只有第一个 range 的游标，且明确 complete=false。
    expect(Object.keys(first?.cursor ?? {})).toHaveLength(1);
    expect(first?.status.complete).toBe(false);
    expect(Object.keys(last?.cursor ?? {})).toHaveLength(2);
    // feed 是滚动窗口：即便读完两个 range 也不能证明删除。
    expect(last?.status.complete).toBe(false);
  });

  it('does not checkpoint a range that failed mid-way', async () => {
    state.requests = [];
    state.failingFeed = false;
    const collected: Collected = { items: [], checkpoints: [] };
    await expect(
      (async () => {
        for await (const item of knowledgeConnectors.feed.sync({
          connectionId: 'src_conn',
          config: {},
          secrets: {},
          ranges: [range(`${fixtureUrl}/feed-a`), range(`${fixtureUrl}/broken`)],
          cursor: {},
          signal: new AbortController().signal,
          network,
          onCheckpoint: async (cursor, status) => {
            collected.checkpoints.push({ cursor, status });
          },
        })) {
          collected.items.push(item);
        }
      })(),
    ).rejects.toThrow(/500/);
    // 只有第一个 range 的检查点落过；失败的 range 没有游标。
    expect(collected.checkpoints).toHaveLength(1);
    expect(Object.keys(collected.checkpoints[0]?.cursor ?? {})).toHaveLength(1);
    expect(collected.checkpoints[0]?.status.complete).toBe(false);
  });

  it('rejects a feed URL that is not the configured range when user config tries loopback', async () => {
    await expect(run('feed', {}, [range(`${fixtureUrl}/feed-a`)], {}, {})).rejects.toThrow(
      /private address/,
    );
  });
});

describe('knowledgeConnectors range mapping', () => {
  it('reads each database source type through its own range config', async () => {
    const feeds = await run('feed', { baseUrl: fixtureUrl }, [range(`${fixtureUrl}/feed-a`)]);
    expect(feeds.items.map((item) => item.sourceId)).toEqual([
      withConnection(`${fixtureUrl}/feed-a:a1`),
      withConnection(`${fixtureUrl}/feed-a:a2`),
    ]);

    const wiki = await run(
      'feishu_wiki',
      { baseUrl: fixtureUrl, appId: 'cli_app' },
      [{ kind: 'wiki_node', externalId: 'nod1', ref: null, paths: [] }],
      {},
      network,
      { appSecret: 'cli_secret' },
    );
    expect(wiki.items.map((item) => item.sourceId)).toEqual([withConnection('feishu:wiki:nod1')]);
    expect(wiki.items[0]?.content.markdown).toContain('hi');

    const gitlab = await run(
      'gitlab',
      { baseUrl: fixtureUrl },
      [{ kind: 'gitlab_project', externalId: 'group/proj', ref: 'main', paths: ['docs'] }],
      {},
      network,
      { token: 'glpat-test' },
    );
    expect(gitlab.items.map((item) => item.sourceId)).toEqual([
      withConnection(`gitlab:${fixtureUrl}:42:main:docs/a.md`),
    ]);

    const github = await run(
      'github',
      { baseUrl: `${fixtureUrl}/api/v3` },
      [{ kind: 'github_repo', externalId: 'octo/proj', ref: null, paths: ['docs'] }],
      {},
      network,
      { token: 'ghp_example' },
    );
    expect(github.items.map((item) => item.sourceId)).toEqual([
      withConnection(`github:${fixtureUrl}/api/v3:77:main:docs/a.md`),
    ]);
    // paths 是 github 范围键的一部分，缩小范围不会复用旧游标。
    expect(Object.keys(github.checkpoints.at(-1)?.cursor ?? {})).toEqual([
      'github|github_repo|octo/proj||docs',
    ]);

    expect(Object.keys(knowledgeConnectors).sort()).toEqual([
      'feed',
      'feishu_drive',
      'feishu_wiki',
      'github',
      'gitlab',
    ]);
  });

  it('never inherits one GitHub range ref into another repository', async () => {
    state.requests = [];
    const result = await run(
      'github',
      // 旧版本会把第一条 range 的 ref 落到 config.ref，导致第二个仓库读错分支。
      { baseUrl: `${fixtureUrl}/api/v3`, ref: 'legacy' },
      [
        { kind: 'github_repo', externalId: 'octo/proj', ref: null, paths: ['docs'] },
        { kind: 'github_repo', externalId: 'octo/other', ref: null, paths: ['docs'] },
      ],
      {},
      network,
      { token: 'ghp_example' },
    );
    expect(result.items.map((item) => item.sourceId)).toEqual([
      withConnection(`github:${fixtureUrl}/api/v3:77:main:docs/a.md`),
      withConnection(`github:${fixtureUrl}/api/v3:78:dev:docs/x.md`),
    ]);
    const paths = state.requests.map((request) => request.path);
    expect(paths).toContain('/api/v3/repos/octo/proj/git/trees/main');
    expect(paths).toContain('/api/v3/repos/octo/other/git/trees/dev');
    expect(paths.some((path) => path.includes('legacy'))).toBe(false);
  });

  it('lets only the deployment trusted hosts, never user config, allow private hosts', async () => {
    const port = new URL(fixtureUrl).port;
    const trusted = await run(
      'feed',
      {},
      [range(`${fixtureUrl}/feed-a`)],
      {},
      {
        trustedHosts: [`127.0.0.1:${port}`],
      },
    );
    expect(trusted.items).toHaveLength(2);

    // 用户 config 的 allowLoopback 不再透传到读取层。
    await expect(
      run('feed', { allowLoopback: true }, [range(`${fixtureUrl}/feed-a`)], {}, {}),
    ).rejects.toThrow(/private address/);
  });
});
