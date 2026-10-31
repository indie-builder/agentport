import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeSegment, trimSlash, uniquePath } from '../src/knowledge/source-paths.js';
import {
  probeSource,
  readSource,
  SourceAuthError,
  type SourceConfig,
  validateSourceUrl,
} from '../src/knowledge/sources.js';

type RequestRecord = {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * Flushes headers and a partial body but never ends the response, so the server
 * only observes `close` after the client cancels the body or drops the connection.
 */
async function startHoldingServer(
  status: number,
  body = 'held response body',
): Promise<{
  url: string;
  responseClosed: Promise<void>;
  close: () => Promise<void>;
}> {
  let markClosed: () => void = () => undefined;
  const responseClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createServer((_request, response) => {
    response.on('close', markClosed);
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.write(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    responseClosed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // 客户端未取消时兜底断开，保证测试清理有界。
        server.closeAllConnections();
      }),
  };
}

/** Bounded wait so a leaked connection fails the test instead of hanging the suite. */
async function within(ms: number, promise: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function xml(response: ServerResponse, value: string): void {
  response.writeHead(200, { 'content-type': 'application/xml' });
  response.end(value);
}

const gitlabPage2Default = [{ path: 'src/b.txt', type: 'blob' }];

const state = {
  mainRequests: [] as RequestRecord[],
  articleRequests: [] as RequestRecord[],
  gitlabForbidden: false,
  gitlabTreeError: false,
  gitlabRepeatPage: false,
  gitlabPage2: [...gitlabPage2Default],
  githubForbidden: false,
  githubRateLimited: false,
  githubSecondaryRateLimited: false,
  githubTooManyRequests: false,
  githubNotFound: false,
  githubTreeError: false,
  githubTruncated: false,
  githubNoDefaultBranch: false,
  feishuTokenStatus: 200,
  feishuTokenCode: 0,
  feishuNodesStatus: 200,
  feishuUnsupported: false,
  feishuDriveUnsupported: false,
  feishuDriveMissingMime: false,
  feishuDriveMultiPage: false,
  feishuDocxTruncated: false,
};

function resetState(): void {
  state.mainRequests = [];
  state.articleRequests = [];
  state.gitlabForbidden = false;
  state.gitlabTreeError = false;
  state.gitlabRepeatPage = false;
  state.gitlabPage2 = [...gitlabPage2Default];
  state.githubForbidden = false;
  state.githubRateLimited = false;
  state.githubSecondaryRateLimited = false;
  state.githubTooManyRequests = false;
  state.githubNotFound = false;
  state.githubTreeError = false;
  state.githubTruncated = false;
  state.githubNoDefaultBranch = false;
  state.feishuTokenStatus = 200;
  state.feishuTokenCode = 0;
  state.feishuNodesStatus = 200;
  state.feishuUnsupported = false;
  state.feishuDriveUnsupported = false;
  state.feishuDriveMissingMime = false;
  state.feishuDriveMultiPage = false;
  state.feishuDocxTruncated = false;
}

let mainUrl = '';
let articleBase = '';
let mainServer: Awaited<ReturnType<typeof startServer>>;
let articleServer: Awaited<ReturnType<typeof startServer>>;

function rssXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed</title>
    <item>
      <guid isPermaLink="false">post-1</guid>
      <title>First &amp; Post</title>
      <link>${articleBase}/articles/first</link>
      <description><![CDATA[<p>Feed summary one</p>]]></description>
    </item>
    <item>
      <guid isPermaLink="false">post-2</guid>
      <title>Second Post</title>
      <link>${articleBase}/articles/missing</link>
      <description>Feed summary two</description>
    </item>
  </channel>
</rss>`;
}

function atomXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <id>atom-1</id>
    <title>Atom One</title>
    <link rel="alternate" href="${articleBase}/articles/atom"/>
    <content type="html">&lt;p&gt;Atom summary&lt;/p&gt;</content>
  </entry>
</feed>`;
}

function jsonFeed(): string {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON Feed',
    items: [
      {
        id: 'json-1',
        url: `${articleBase}/articles/missing`,
        title: 'JSON One',
        content_html: '<p>JSON body</p>',
      },
    ],
  });
}

function rssWrongTypeXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Wrong Type Feed</title><item><guid>wrong-1</guid><title>Wrong Type</title><link>${articleBase}/articles/missing</link><description>Wrong type summary</description></item></channel></rss>`;
}

function rdfXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="${mainUrl}/rdf">
    <title>RDF Feed</title>
    <link>${mainUrl}/rdf</link>
    <description>RDF feed</description>
    <items><rdf:Seq><rdf:li rdf:resource="${mainUrl}/rdf#item-1"/></rdf:Seq></items>
  </channel>
  <item rdf:about="${mainUrl}/rdf#item-1">
    <title>RDF One</title>
    <link>${articleBase}/articles/missing</link>
    <description>RDF summary</description>
  </item>
</rdf:RDF>`;
}

function atomLinksXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Links Feed</title>
  <entry>
    <id>atom-links-1</id>
    <title>Atom Links</title>
    <link rel="self" href="${mainUrl}/self"/>
    <link rel="alternate" href="${articleBase}/articles/missing"/>
    <content type="html">&lt;p&gt;Atom links summary&lt;/p&gt;</content>
  </entry>
  <entry>
    <summary>No id or title</summary>
  </entry>
</feed>`;
}

function jsonNumericFeed(): string {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Numeric Feed',
    items: [
      { id: 42, title: 'Numeric', content_text: 'Numeric body' },
      {
        id: 'json-fallback',
        url: `${articleBase}/articles/missing`,
        title: 'Fallback',
        summary: 'Summary only',
      },
    ],
  });
}

function jsonRssMarkupFeed(): string {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON RSS Markup Feed',
    items: [
      {
        id: 'json-rss-markup',
        url: `${articleBase}/articles/missing`,
        title: 'JSON RSS Markup',
        content_html:
          '<pre><code><rss><channel><title>Example</title></channel></rss></code></pre>',
      },
    ],
  });
}

function docxBlocks(docToken: string, pageToken: string | undefined): unknown {
  const pageId = `${docToken}-page`;
  const block = (id: string, blockType: number, extra: Record<string, unknown> = {}) => ({
    block_id: id,
    parent_id: pageId,
    block_type: blockType,
    ...extra,
  });
  const text = (content: string) => ({ elements: [{ text_run: { content } }] });

  if (docToken === 'long1') {
    const page = Number(pageToken?.replace('lp', '') ?? '0');
    return {
      items: Array.from({ length: 500 }, (_, index) => ({
        block_id: `long-${page}-${index}`,
        block_type: 2,
        text: { elements: [{ text_run: { content: `PAGE-${page + 1}-ITEM-${index}` } }] },
      })),
      has_more: true,
      page_token: `lp${page + 1}`,
    };
  }

  if (docToken === 'doc1') {
    if (!pageToken) {
      return {
        items: [
          {
            block_id: pageId,
            block_type: 1,
            children: [`${docToken}-h`, `${docToken}-p`, `${docToken}-b`, `${docToken}-tbl`],
          },
          block(`${docToken}-h`, 3, { heading1: text('Heading') }),
          block(`${docToken}-p`, 2, { text: text('Body text') }),
        ],
        has_more: true,
        page_token: 'bp2',
      };
    }
    return {
      items: [
        block(`${docToken}-b`, 12, { bullet: text('Bullet item') }),
        block(`${docToken}-tbl`, 31, {
          table: { cells: ['c1', 'c2', 'c3', 'c4'], property: { column_size: 2 } },
        }),
        { block_id: 'c1', parent_id: `${docToken}-tbl`, block_type: 32, children: ['t1'] },
        { block_id: 'c2', parent_id: `${docToken}-tbl`, block_type: 32, children: ['t2'] },
        { block_id: 'c3', parent_id: `${docToken}-tbl`, block_type: 32, children: ['t3'] },
        { block_id: 'c4', parent_id: `${docToken}-tbl`, block_type: 32, children: ['t4'] },
        { block_id: 't1', parent_id: 'c1', block_type: 2, text: text('A1') },
        { block_id: 't2', parent_id: 'c2', block_type: 2, text: text('B1') },
        { block_id: 't3', parent_id: 'c3', block_type: 2, text: text('A2') },
        { block_id: 't4', parent_id: 'c4', block_type: 2, text: text('B2') },
      ],
      has_more: false,
    };
  }

  return {
    items: [
      {
        block_id: pageId,
        block_type: 1,
        children: [`${docToken}-p`],
      },
      block(`${docToken}-p`, 2, { text: text(`Content for ${docToken}`) }),
    ],
    has_more: false,
  };
}

function wikiNode(
  nodeToken: string,
  objToken: string,
  title: string,
  hasChild = false,
  objType = 'docx',
): Record<string, unknown> {
  return {
    node_token: nodeToken,
    obj_token: objToken,
    obj_type: objType,
    title,
    has_child: hasChild,
  };
}

function wikiNodesPage(query: URLSearchParams): Record<string, unknown> {
  if (query.get('parent_node_token') === 'nod1') {
    return { items: [wikiNode('nod3', 'doc3', 'Child')], has_more: false };
  }
  if (query.get('page_token') === 'np2') {
    return { items: [wikiNode('nod2', 'doc2', 'Second')], has_more: false };
  }
  const items: Record<string, unknown>[] = [wikiNode('nod1', 'doc1', 'Guide', true)];
  if (state.feishuUnsupported) {
    items.push(wikiNode('nodSheet', 'sht1', 'Budget', false, 'sheet'));
  }
  return { items, has_more: true, page_token: 'np2' };
}

function driveFilesPage(query: URLSearchParams): Record<string, unknown> {
  if (query.get('folder_token') === 'fldA') {
    return {
      files: [
        {
          token: 'docE',
          name: 'Doc E',
          type: 'docx',
          url: `${mainUrl}/doc/e`,
        },
      ],
      has_more: false,
      next_page_token: '',
    };
  }
  if (state.feishuDriveMultiPage && !query.get('page_token')) {
    return {
      files: [{ token: 'docD', name: 'Doc D', type: 'docx', url: `${mainUrl}/doc/d` }],
      has_more: true,
      next_page_token: 'dp2',
    };
  }
  if (state.feishuDriveMultiPage && query.get('page_token') === 'dp2') {
    return { files: [], has_more: false, next_page_token: '' };
  }
  if (state.feishuDocxTruncated && !query.get('page_token')) {
    return {
      files: [{ token: 'long1', name: 'Long document', type: 'docx' }],
      has_more: false,
      next_page_token: '',
    };
  }
  const files: Record<string, unknown>[] = [
    { token: 'fldA', name: 'Projects', type: 'folder' },
    { token: 'docD', name: 'Doc D', type: 'docx', url: `${mainUrl}/doc/d` },
    {
      token: 'txt1',
      name: 'notes.md',
      type: 'file',
      url: `${mainUrl}/file/txt1`,
    },
  ];
  if (state.feishuDriveUnsupported) {
    files.push({ token: 'pdf1', name: 'manual.pdf', type: 'file', url: `${mainUrl}/file/pdf1` });
  }
  if (state.feishuDriveMissingMime) {
    files.push({ token: 'raw1', name: 'report.pdf', type: 'file', url: `${mainUrl}/file/raw1` });
  }
  return { files, has_more: false, next_page_token: '' };
}

async function handleMain(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = request.method === 'POST' ? await readRequestBody(request) : '';
  const url = new URL(request.url ?? '/', 'http://fixture');
  const path = decodeURIComponent(url.pathname);
  state.mainRequests.push({
    method: request.method ?? '',
    path,
    headers: request.headers,
    body,
  });

  if (path === '/rss') {
    xml(response, rssXml());
    return;
  }
  if (path === '/atom') {
    xml(response, atomXml());
    return;
  }
  if (path === '/feed.json') {
    json(response, 200, JSON.parse(jsonFeed()));
    return;
  }
  if (path === '/rss-wrong-type') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(rssWrongTypeXml());
    return;
  }
  if (path === '/rdf') {
    xml(response, rdfXml());
    return;
  }
  if (path === '/atom-links') {
    xml(response, atomLinksXml());
    return;
  }
  if (path === '/feed-numeric.json') {
    json(response, 200, JSON.parse(jsonNumericFeed()));
    return;
  }
  if (path === '/feed-json-rss-markup.json') {
    json(response, 200, JSON.parse(jsonRssMarkupFeed()));
    return;
  }
  if (path === '/feed-binary') {
    xml(
      response,
      `<rss version="2.0"><channel><title>Binary Feed</title><item><guid>bin-1</guid><title>Binary</title><link>${articleBase}/articles/binary</link><description>Feed summary for binary</description></item></channel></rss>`,
    );
    return;
  }
  if (path === '/redirect-feed') {
    response.writeHead(302, { location: `${articleBase}/redirect-feed` });
    response.end();
    return;
  }
  if (path === '/unauthorized-feed') {
    response.writeHead(401).end('unauthorized');
    return;
  }

  if (path.startsWith('/gitlab/')) {
    if (state.gitlabForbidden) {
      json(response, 403, { message: '403 Forbidden' });
      return;
    }
    if (path === '/gitlab/api/v4/projects/group/proj') {
      json(response, 200, {
        id: 42,
        default_branch: 'main',
        path_with_namespace: 'group/proj',
        name: 'proj',
        web_url: `${mainUrl}/group/proj`,
      });
      return;
    }
    if (path === '/gitlab/api/v4/projects/42/repository/tree') {
      if (state.gitlabTreeError) {
        json(response, 500, { message: 'tree failed' });
        return;
      }
      const page = url.searchParams.get('page') ?? '1';
      if (page === '1') {
        response.setHeader('x-next-page', state.gitlabRepeatPage ? '1' : '2');
        json(response, 200, [
          { path: 'docs', type: 'tree' },
          { path: 'docs/a.md', type: 'blob' },
          { path: 'image.png', type: 'blob' },
          { path: 'other/c.md', type: 'blob' },
        ]);
        return;
      }
      response.setHeader('x-next-page', '');
      json(response, 200, state.gitlabPage2);
      return;
    }
    const raw = /^\/gitlab\/api\/v4\/projects\/42\/repository\/files\/(.+)\/raw$/.exec(path);
    if (raw?.[1]) {
      const file = raw[1];
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`content of ${file}`);
      return;
    }
  }

  if (path.startsWith('/github/')) {
    if (state.githubForbidden) {
      json(response, 403, { message: '403 Forbidden' });
      return;
    }
    if (state.githubRateLimited) {
      response.writeHead(403, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'retry-after': '60',
      });
      response.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    if (state.githubSecondaryRateLimited) {
      // 官方次级限流：403、配额未耗尽、无 retry-after，只在 body 里说明。
      response.writeHead(403, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '4999',
      });
      response.end(
        JSON.stringify({
          message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
        }),
      );
      return;
    }
    if (state.githubTooManyRequests) {
      json(response, 429, { message: 'secondary rate limit' });
      return;
    }
    if (state.githubNotFound) {
      json(response, 404, { message: 'Not Found' });
      return;
    }
    if (path === '/github/api/v3/repos/octo/proj') {
      json(response, 200, {
        id: 1001,
        default_branch: state.githubNoDefaultBranch ? undefined : 'trunk',
        html_url: `${mainUrl}/octo/proj`,
      });
      return;
    }
    if (path === '/github/api/v3/repos/octo/proj/git/trees/trunk') {
      if (state.githubTreeError) {
        json(response, 500, { message: 'tree failed' });
        return;
      }
      json(response, 200, {
        tree: [
          { path: 'docs', type: 'tree', sha: 'shaDocs' },
          { path: 'docs/a.md', type: 'blob', sha: 'shaA' },
          { path: 'docs/FAQ#setup.md', type: 'blob', sha: 'shaFaq' },
          { path: 'docs/empty.txt', type: 'blob', sha: 'shaEmpty' },
          { path: 'docs/link.md', type: 'blob', sha: 'shaLink', mode: '120000' },
          { path: 'docs/image.png', type: 'blob', sha: 'shaPng' },
          { path: 'src/b.txt', type: 'blob', sha: 'shaB' },
          { path: 'other/c.md', type: 'blob', sha: 'shaC' },
        ],
        truncated: state.githubTruncated,
      });
      return;
    }
    if (path.startsWith('/github/api/v3/repos/octo/proj/git/trees/')) {
      json(response, 200, {
        tree: [{ path: 'docs/a.md', type: 'blob', sha: 'shaA' }],
        truncated: false,
      });
      return;
    }
    const blob = /^\/github\/api\/v3\/repos\/octo\/proj\/git\/blobs\/([^/]+)$/.exec(path);
    if (blob?.[1]) {
      if (blob[1] === 'shaPng') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return;
      }
      const bodies: Record<string, string> = {
        shaA: '# GitHub doc\n',
        shaFaq: '# FAQ setup\n',
        shaEmpty: '',
        shaB: 'b text',
      };
      const body = bodies[blob[1]];
      if (body === undefined) {
        json(response, 404, { message: 'Not Found' });
        return;
      }
      response.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      response.end(body);
      return;
    }
  }

  if (path.startsWith('/feishu/')) {
    if (path === '/feishu/open-apis/auth/v3/tenant_access_token/internal') {
      if (state.feishuTokenStatus !== 200) {
        response.writeHead(state.feishuTokenStatus).end('denied');
        return;
      }
      json(response, 200, {
        code: state.feishuTokenCode,
        msg: state.feishuTokenCode === 0 ? 'ok' : 'invalid app',
        tenant_access_token: 'tenant-token',
        expire: 7200,
      });
      return;
    }
    if (state.feishuNodesStatus !== 200) {
      response.writeHead(state.feishuNodesStatus).end('denied');
      return;
    }
    if (path === '/feishu/open-apis/wiki/v2/spaces/spc1/nodes') {
      json(response, 200, { code: 0, data: wikiNodesPage(url.searchParams) });
      return;
    }
    if (path === '/feishu/open-apis/wiki/v2/spaces/get_node') {
      json(response, 200, { code: 0, data: { node: wikiNode('nod1', 'doc1', 'Guide', true) } });
      return;
    }
    const blocks = /^\/feishu\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks$/.exec(path);
    if (blocks?.[1]) {
      const docToken = blocks[1];
      json(response, 200, {
        code: 0,
        data: docxBlocks(docToken, url.searchParams.get('page_token') ?? undefined),
      });
      return;
    }
    if (path === '/feishu/open-apis/drive/v1/files') {
      json(response, 200, { code: 0, data: driveFilesPage(url.searchParams) });
      return;
    }
    if (path === '/feishu/open-apis/drive/v1/files/txt1/download') {
      response.writeHead(200, { 'content-type': 'text/markdown' });
      response.end('# Notes\n\nhello from txt');
      return;
    }
    if (path === '/feishu/open-apis/drive/v1/files/pdf1/download') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('%PDF-1.7');
      return;
    }
    if (path === '/feishu/open-apis/drive/v1/files/raw1/download') {
      // 故意不带 Content-Type，且 PDF 头之后有非 UTF-8 字节。
      response.writeHead(200);
      response.end(
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00, 0x80]),
      );
      return;
    }
  }

  response.writeHead(404).end('not found');
}

async function handleArticle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture');
  state.articleRequests.push({
    method: request.method ?? '',
    path: url.pathname,
    headers: request.headers,
    body: '',
  });

  if (url.pathname === '/articles/first') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<html><body><article><h1>Article title</h1><p>Article full text one.</p><script>bad()</script></article></body></html>',
    );
    return;
  }
  if (url.pathname === '/articles/atom') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body><article><p>Atom full text from page</p></article></body></html>');
    return;
  }
  if (url.pathname === '/articles/binary') {
    // 二进制页面不能被当成文本解码后拼进 markdown。
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]));
    return;
  }
  if (url.pathname === '/redirect-feed') {
    response.writeHead(200, { 'content-type': 'application/rss+xml' });
    response.end(
      '<rss version="2.0"><channel><title>Redirected Feed</title><item><guid>redir-1</guid><title>Redirected</title><description>Redirect body</description></item></channel></rss>',
    );
    return;
  }
  response.writeHead(404).end('not found');
}

beforeAll(async () => {
  articleServer = await startServer(handleArticle);
  articleBase = articleServer.url;
  mainServer = await startServer(handleMain);
  mainUrl = mainServer.url;
});

afterAll(async () => {
  await mainServer.close();
  await articleServer.close();
});

beforeEach(resetState);

function rssConfig(url: string, settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'rss',
    url,
    credentials: { authorization: 'Bearer feed-secret' },
    allowLoopback: true,
    settings,
  };
}

function gitlabConfig(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'gitlab',
    url: `${mainUrl}/gitlab`,
    credentials: { token: 'glpat-test' },
    allowLoopback: true,
    settings: {
      project: 'group/proj',
      paths: ['docs', 'src/b.txt'],
      ...settings,
    },
  };
}

function githubConfig(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'github',
    url: `${mainUrl}/github/api/v3`,
    credentials: { token: '{{SECRET_ghp_example}}' },
    allowLoopback: true,
    settings: {
      project: 'octo/proj',
      paths: ['docs', 'src/b.txt'],
      ...settings,
    },
  };
}

function feishuConfig(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'feishu',
    url: `${mainUrl}/feishu`,
    credentials: { appId: 'cli_app', appSecret: 'cli_secret' },
    allowLoopback: true,
    settings: { spaceId: 'spc1', ...settings },
  };
}

function feishuDriveConfig(settings: Record<string, unknown> = {}): SourceConfig {
  return {
    type: 'feishu',
    url: `${mainUrl}/feishu`,
    credentials: { appId: 'cli_app', appSecret: 'cli_secret' },
    allowLoopback: true,
    settings: { folderToken: 'fld1', ...settings },
  };
}

function cursorOf(snapshot: { cursor: Record<string, unknown> }): {
  initial?: unknown;
  itemHashes?: Record<string, string>;
} {
  return snapshot.cursor as { initial?: unknown; itemHashes?: Record<string, string> };
}

describe('validateSourceUrl', () => {
  it('rejects loopback, link-local and URL credentials by default', async () => {
    await expect(validateSourceUrl('http://127.0.0.1:1/')).rejects.toThrow();
    await expect(validateSourceUrl('http://[::1]:1/')).rejects.toThrow();
    await expect(validateSourceUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(validateSourceUrl('http://[::ffff:127.0.0.1]:1/')).rejects.toThrow();
    await expect(validateSourceUrl('http://[fd00::1]:1/')).rejects.toThrow();
    const withSecret = ['http://user:', 'pw', '@127.0.0.1:1/'].join('');
    await expect(validateSourceUrl(withSecret)).rejects.toThrow();
    await expect(validateSourceUrl('file:///etc/passwd')).rejects.toThrow();
  });

  it('allows loopback only when explicitly requested', async () => {
    const parsed = await validateSourceUrl(`${mainUrl}/path`, { allowLoopback: true });
    expect(parsed.origin).toBe(mainUrl);
  });

  it('matches allowed origins exactly', async () => {
    await expect(
      validateSourceUrl(`${mainUrl}/x`, { allowedOrigins: [mainUrl], allowLoopback: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validateSourceUrl(`${articleBase}/x`, { allowedOrigins: [mainUrl], allowLoopback: true }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      validateSourceUrl(`${mainUrl}/x`, {
        allowedOrigins: [`${mainUrl}/sub`],
        allowLoopback: true,
      }),
    ).rejects.toThrow(/exact origin/);
  });

  it('lets only an exactly matched trusted host resolve to a private address', async () => {
    const port = new URL(mainUrl).port;
    await expect(
      validateSourceUrl(`${mainUrl}/x`, { trustedHosts: [`127.0.0.1:${port}`] }),
    ).resolves.toBeInstanceOf(URL);
    // 端口不同或写法模糊（只写主机名、带路径）都不放行。
    await expect(
      validateSourceUrl(`${mainUrl}/x`, { trustedHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(/private address/);
    await expect(
      validateSourceUrl(`${mainUrl}/x`, { trustedHosts: [`${mainUrl}`] }),
    ).rejects.toThrow(/private address/);
    expect(process.env.NODE_ENV).not.toBe('production');
  });

  it('never takes loopback from user config in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(validateSourceUrl(`${mainUrl}/x`, { allowLoopback: true })).rejects.toThrow(
        /private address/,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('RSS/Atom/JSON sources', () => {
  it('parses RSS, prefers article full text, falls back to feed content, and scopes credentials', async () => {
    const snapshot = await readSource(rssConfig(`${mainUrl}/rss`));

    // A feed only shows a recent window: it must never authorise deletion derivation.
    expect(snapshot.complete).toBe(false);
    expect(snapshot.items).toHaveLength(2);

    const first = snapshot.items.find((item) => item.externalId.endsWith(':post-1'));
    expect(first?.title).toBe('First & Post');
    expect(first?.content).toContain('Article full text one');
    expect(first?.content).not.toContain('bad()');
    expect(first?.sourceUrl).toBe(`${articleBase}/articles/first`);
    expect(first?.path).toBe('Example Feed/First & Post.md');

    const second = snapshot.items.find((item) => item.externalId.endsWith(':post-2'));
    expect(second?.content).toContain('Feed summary two');

    const feedRequest = state.mainRequests.find((request) => request.path === '/rss');
    expect(feedRequest?.headers.authorization).toBe('Bearer feed-secret');
    const articleRequest = state.articleRequests.find(
      (request) => request.path === '/articles/first',
    );
    expect(articleRequest?.headers.authorization).toBeUndefined();

    expect(cursorOf(snapshot).initial).toBe(true);
    expect(Object.keys(cursorOf(snapshot).itemHashes ?? {})).toHaveLength(2);
  });

  it('marks later reads and carries stable content hashes in the cursor', async () => {
    const first = await readSource(rssConfig(`${mainUrl}/rss`));
    const second = await readSource(rssConfig(`${mainUrl}/rss`), first.cursor);

    expect(cursorOf(second).initial).toBe(false);
    expect(cursorOf(second).itemHashes).toEqual(cursorOf(first).itemHashes);
  });

  it('keeps binary article responses out of the markdown body', async () => {
    const snapshot = await readSource(rssConfig(`${mainUrl}/feed-binary`));
    const item = snapshot.items[0];
    // 二进制页面被跳过，回退到 feed 自带的摘要文本。
    expect(item?.content).toBe('Feed summary for binary');
    expect(item?.content).not.toContain('%PDF');
  });

  it('does not forward feed credentials across a redirect to another origin', async () => {
    const snapshot = await readSource({
      type: 'rss',
      url: `${mainUrl}/redirect-feed`,
      credentials: { authorization: 'Bearer redirect-secret' },
      allowLoopback: true,
      settings: {},
    });

    expect(snapshot.items).toHaveLength(1);
    const redirected = state.articleRequests.find((request) => request.path === '/redirect-feed');
    expect(redirected?.headers.authorization).toBeUndefined();
  });

  it('parses Atom and JSON Feed documents', async () => {
    const atom = await readSource(rssConfig(`${mainUrl}/atom`));
    expect(atom.items[0]?.title).toBe('Atom One');
    expect(atom.items[0]?.content).toContain('Atom full text from page');

    const json = await readSource(rssConfig(`${mainUrl}/feed.json`));
    expect(json.items[0]?.title).toBe('JSON One');
    expect(json.items[0]?.content).toContain('JSON body');
  });

  it('detects the feed format from content when Content-Type disagrees', async () => {
    const snapshot = await readSource(rssConfig(`${mainUrl}/rss-wrong-type`));
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.title).toBe('Wrong Type');
    expect(snapshot.items[0]?.content).toBe('Wrong type summary');
  });

  it('parses JSON feeds whose content embeds XML markup', async () => {
    const snapshot = await readSource(rssConfig(`${mainUrl}/feed-json-rss-markup.json`));
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.title).toBe('JSON RSS Markup');
    expect(snapshot.items[0]?.content).toContain('Example');
  });

  it('keeps RDF, Atom link priority, skipped entries and JSON id/body fallbacks', async () => {
    const rdf = await readSource(rssConfig(`${mainUrl}/rdf`));
    expect(rdf.items).toHaveLength(1);
    expect(rdf.items[0]?.title).toBe('RDF One');
    expect(rdf.items[0]?.externalId).toBe(`${mainUrl}/rdf:${articleBase}/articles/missing`);
    expect(rdf.items[0]?.content).toBe('RDF summary');

    const atom = await readSource(rssConfig(`${mainUrl}/atom-links`));
    // The entry without id and title is skipped; the alternate link wins over self.
    expect(atom.items).toHaveLength(1);
    expect(atom.items[0]?.sourceUrl).toBe(`${articleBase}/articles/missing`);
    expect(atom.items[0]?.content).toBe('Atom links summary');

    const json = await readSource(rssConfig(`${mainUrl}/feed-numeric.json`));
    const numeric = json.items.find((item) => item.externalId.endsWith(':42'));
    expect(numeric?.content).toBe('Numeric body');
    expect(numeric?.sourceUrl).toBe(`${mainUrl}/feed-numeric.json`);
    const fallback = json.items.find((item) => item.externalId.endsWith(':json-fallback'));
    expect(fallback?.content).toBe('Summary only');
  });

  it('surfaces feed HTTP errors and rejects unknown cursors', async () => {
    await expect(readSource(rssConfig(`${mainUrl}/unauthorized-feed`))).rejects.toThrow(/401/);
    // The DB cursor column defaults to {}; that must mean "first sync", not a parse error.
    const first = await readSource(rssConfig(`${mainUrl}/rss`), {});
    expect(cursorOf(first).initial).toBe(true);
    await expect(readSource(rssConfig(`${mainUrl}/rss`), { nonsense: true })).rejects.toThrow(
      /cursor/,
    );
  });
});

describe('HTTP failure responses', () => {
  it.each([
    { status: 401, auth: true },
    // A 403 body that cannot be read fully must not revoke credentials.
    { status: 403, auth: false },
    { status: 429, auth: false },
    { status: 500, auth: false },
  ])(
    'cancels a held $status body before rejecting with the original error',
    async ({ status, auth }) => {
      const upstream = await startHoldingServer(status);
      try {
        const error = await readSource(rssConfig(`${upstream.url}/held`)).catch(
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        if (auth) expect(error).toBeInstanceOf(SourceAuthError);
        else expect(error).not.toBeInstanceOf(SourceAuthError);
        expect((error as Error).message).toBe(`HTTP ${status} from ${upstream.url}/held`);
        await within(2_000, upstream.responseClosed, `upstream ${status} connection stayed open`);
      } finally {
        await upstream.close();
      }
    },
  );

  it('keeps a held 403 secondary-rate-limit body transient instead of revoked credentials', async () => {
    const upstream = await startHoldingServer(
      403,
      'You have exceeded a secondary rate limit. Please wait a few minutes.',
    );
    try {
      const error = await readSource(rssConfig(`${upstream.url}/held`)).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SourceAuthError);
      expect((error as Error).message).toContain('HTTP 403');
      await within(2_000, upstream.responseClosed, 'upstream 403 connection stayed open');
    } finally {
      await upstream.close();
    }
  });

  it('propagates caller cancellation while reading a 403 body without waiting for the timeout', async () => {
    const upstream = await startHoldingServer(403);
    const controller = new AbortController();
    const started = Date.now();
    const pending = readSource(
      rssConfig(`${upstream.url}/held`),
      undefined,
      controller.signal,
    ).catch((reason: unknown) => reason);
    setTimeout(() => controller.abort(), 50);
    try {
      const error = await pending;
      expect(error).not.toBeInstanceOf(SourceAuthError);
      expect((error as Error).name).toBe('AbortError');
      expect(Date.now() - started).toBeLessThan(1_500);
      await within(2_000, upstream.responseClosed, 'upstream 403 connection stayed open');
    } finally {
      await upstream.close();
    }
  });
});

describe('GitLab source', () => {
  it('reads project files through paginated tree and raw endpoints', async () => {
    const snapshot = await readSource(gitlabConfig());

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.path).sort()).toEqual(['docs/a.md', 'src/b.txt']);
    const file = snapshot.items.find((item) => item.path === 'docs/a.md');
    expect(file?.title).toBe('a.md');
    expect(file?.content).toBe('content of docs/a.md');
    expect(file?.mimeType).toBe('text/markdown');
    expect(file?.sourceUrl).toBe(`${mainUrl}/group/proj/-/blob/main/docs/a.md`);
    expect(file?.externalId).toBe(`gitlab:${mainUrl}/gitlab:42:main:docs/a.md`);
    expect(snapshot.items.some((item) => item.path === 'image.png')).toBe(false);

    const treeRequests = state.mainRequests.filter((request) =>
      request.path.endsWith('/repository/tree'),
    );
    expect(treeRequests).toHaveLength(2);
    expect(treeRequests[0]?.headers['private-token']).toBe('glpat-test');
    expect(cursorOf(snapshot).initial).toBe(true);

    const second = await readSource(gitlabConfig(), snapshot.cursor);
    expect(cursorOf(second).initial).toBe(false);
  });

  it('returns a full tree on every run so deletions only come from a complete snapshot', async () => {
    const first = await readSource(gitlabConfig());
    expect(first.items).toHaveLength(2);

    state.gitlabPage2 = [];
    const second = await readSource(gitlabConfig(), first.cursor);
    expect(second.complete).toBe(true);
    expect(second.items.map((item) => item.path)).toEqual(['docs/a.md']);
  });

  it('throws on HTTP 403, HTTP 500 and non-advancing pagination instead of partial success', async () => {
    state.gitlabForbidden = true;
    await expect(readSource(gitlabConfig())).rejects.toThrow(/403/);

    resetState();
    state.gitlabTreeError = true;
    await expect(readSource(gitlabConfig())).rejects.toThrow(/500/);

    resetState();
    state.gitlabRepeatPage = true;
    await expect(readSource(gitlabConfig())).rejects.toThrow(/pagination/i);
  });
});

describe('GitHub source', () => {
  it('reads text and binary blobs from the default branch tree and filters by range', async () => {
    const snapshot = await readSource(githubConfig());

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.path).sort()).toEqual([
      'docs/FAQ#setup.md',
      'docs/a.md',
      'docs/empty.txt',
      'docs/image.png',
      'src/b.txt',
    ]);
    const file = snapshot.items.find((item) => item.path === 'docs/a.md');
    expect(file?.title).toBe('a.md');
    expect(file?.content).toBe('# GitHub doc\n');
    expect(file?.mimeType).toBe('text/markdown');
    expect(file?.sourceUrl).toBe(`${mainUrl}/octo/proj/blob/trunk/docs/a.md`);
    expect(file?.externalId).toBe(`github:${mainUrl}/github/api/v3:1001:trunk:docs/a.md`);

    // URL 中含保留字符的文件名按段编码，链接可用但 externalId/path 保留原文。
    const faq = snapshot.items.find((item) => item.path === 'docs/FAQ#setup.md');
    expect(faq?.content).toBe('# FAQ setup\n');
    expect(faq?.sourceUrl).toBe(`${mainUrl}/octo/proj/blob/trunk/docs/FAQ%23setup.md`);
    expect(faq?.externalId).toBe(`github:${mainUrl}/github/api/v3:1001:trunk:docs/FAQ#setup.md`);

    // 空文件也要覆盖旧正文，而不是保留上一次内容。
    const empty = snapshot.items.find((item) => item.path === 'docs/empty.txt');
    expect(empty?.content).toBe('# docs/empty.txt\n');
    // 二进制原件以字节形式进入解析链路，不在来源层解码。
    const image = snapshot.items.find((item) => item.path === 'docs/image.png');
    expect(image?.mimeType).toBe('image/png');
    expect(image?.bytes).toBeDefined();
    // mode 120000 是符号链接，即使扩展名是 .md 也不能当普通文件读。
    expect(snapshot.items.some((item) => item.path === 'docs/link.md')).toBe(false);
    expect(state.mainRequests.some((request) => request.path.endsWith('/git/blobs/shaLink'))).toBe(
      false,
    );
    expect(snapshot.items.some((item) => item.path === 'other/c.md')).toBe(false);

    const repoRequest = state.mainRequests.find(
      (request) => request.path === '/github/api/v3/repos/octo/proj',
    );
    expect(repoRequest?.headers.authorization).toBe('Bearer {{SECRET_ghp_example}}');
    const treeRequest = state.mainRequests.find((request) =>
      request.path.endsWith('/git/trees/trunk'),
    );
    expect(treeRequest?.headers.accept).toBe('application/vnd.github+json');
    const blobRequest = state.mainRequests.find((request) =>
      request.path.endsWith('/git/blobs/shaA'),
    );
    expect(blobRequest?.headers.accept).toBe('application/vnd.github.raw+json');
    expect(cursorOf(snapshot).initial).toBe(true);

    const second = await readSource(githubConfig(), snapshot.cursor);
    expect(cursorOf(second).initial).toBe(false);
  });

  it('uses the explicit ref for the tree and blob links', async () => {
    const snapshot = await readSource(githubConfig({ ref: 'release/1.0' }));

    expect(
      state.mainRequests.some((request) => request.path.endsWith('/git/trees/release/1.0')),
    ).toBe(true);
    expect(snapshot.items[0]?.sourceUrl).toBe(`${mainUrl}/octo/proj/blob/release/1.0/docs/a.md`);
    expect(snapshot.items[0]?.externalId).toBe(
      `github:${mainUrl}/github/api/v3:1001:release/1.0:docs/a.md`,
    );
  });

  it('refuses a truncated tree instead of enumerating it partially', async () => {
    state.githubTruncated = true;
    await expect(readSource(githubConfig())).rejects.toThrow(/100,000/);
  });

  it('surfaces auth, missing repo, server and missing default-branch failures', async () => {
    state.githubForbidden = true;
    await expect(readSource(githubConfig())).rejects.toThrow(/403/);
    await expect(readSource(githubConfig())).rejects.toBeInstanceOf(SourceAuthError);

    resetState();
    state.githubNotFound = true;
    await expect(readSource(githubConfig())).rejects.toThrow(/404/);

    resetState();
    state.githubTreeError = true;
    await expect(readSource(githubConfig())).rejects.toThrow(/500/);
    await expect(readSource(githubConfig())).rejects.not.toBeInstanceOf(SourceAuthError);

    resetState();
    state.githubNoDefaultBranch = true;
    await expect(readSource(githubConfig())).rejects.toThrow(/default branch/);
  });

  it('treats rate-limited 403 and 429 as transient instead of revoked credentials', async () => {
    state.githubRateLimited = true;
    const limited = await readSource(githubConfig()).catch((reason: unknown) => reason);
    expect(limited).toBeInstanceOf(Error);
    expect(limited).not.toBeInstanceOf(SourceAuthError);
    expect((limited as Error).message).toContain('HTTP 403');
    expect((limited as Error).message).toContain('/repos/octo/proj');
    expect((limited as Error).message).toContain('retry after 60s');

    resetState();
    state.githubTooManyRequests = true;
    const throttled = await readSource(githubConfig()).catch((reason: unknown) => reason);
    expect(throttled).not.toBeInstanceOf(SourceAuthError);
    expect((throttled as Error).message).toContain('HTTP 429');
  });

  it('treats a 403 secondary rate limit body as transient even with quota left', async () => {
    state.githubSecondaryRateLimited = true;
    const error = await readSource(githubConfig()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SourceAuthError);
    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).not.toContain('retry after');
  });

  it('rejects a project that is not owner/repo and absolute range paths', async () => {
    await expect(readSource(githubConfig({ project: '/octo/proj' }))).rejects.toThrow(
      /owner\/repo/,
    );
    await expect(readSource(githubConfig({ project: 'octo/proj?x' }))).rejects.toThrow(
      /owner\/repo/,
    );
    await expect(readSource(githubConfig({ project: 'octo/..' }))).rejects.toThrow(/owner\/repo/);
    await expect(readSource(githubConfig({ project: 'octo/pro j' }))).rejects.toThrow(
      /owner\/repo/,
    );
    await expect(readSource(githubConfig({ paths: ['/abs'] }))).rejects.toThrow(
      /repository-relative/,
    );
    await expect(readSource(githubConfig({ paths: ['docs/../secret'] }))).rejects.toThrow(
      /repository-relative/,
    );
  });
});

describe('Feishu source', () => {
  it('exchanges app credentials for a tenant token and renders a Wikipedia space tree', async () => {
    const snapshot = await readSource(feishuConfig());

    expect(snapshot.complete).toBe(true);
    expect(snapshot.items.map((item) => item.path).sort()).toEqual([
      'Guide.md',
      'Guide/Child.md',
      'Second.md',
    ]);

    const guide = snapshot.items.find((item) => item.path === 'Guide.md');
    expect(guide?.content).toContain('# Heading');
    expect(guide?.content).toContain('Body text');
    expect(guide?.content).toContain('- Bullet item');
    expect(guide?.content).toContain('| A1 | B1 |');
    expect(guide?.content).toContain('| A2 | B2 |');
    expect(guide?.sourceUrl).toBe('https://feishu.cn/wiki/nod1');
    expect(guide?.mimeType).toBe('text/markdown');

    const tokenRequest = state.mainRequests.find((request) =>
      request.path.endsWith('/tenant_access_token/internal'),
    );
    expect(JSON.parse(tokenRequest?.body ?? '{}')).toEqual({
      app_id: 'cli_app',
      app_secret: 'cli_secret',
    });
    const wikiRequest = state.mainRequests.find((request) =>
      request.path.endsWith('/wiki/v2/spaces/spc1/nodes'),
    );
    expect(wikiRequest?.headers.authorization).toBe('Bearer tenant-token');
    expect(wikiRequest?.headers.app_secret).toBeUndefined();
    expect(cursorOf(snapshot).initial).toBe(true);
  });

  it('can start from a selected wiki node', async () => {
    const snapshot = await readSource(feishuConfig({ nodeToken: 'nod1' }));
    expect(snapshot.items.map((item) => item.path).sort()).toEqual(['Guide.md', 'Guide/Child.md']);
  });

  it('supports a direct access token without exchanging app credentials', async () => {
    const snapshot = await readSource({
      ...feishuConfig(),
      credentials: { accessToken: 'direct-token' },
    });

    expect(snapshot.items).toHaveLength(3);
    expect(
      state.mainRequests.some((request) => request.path.endsWith('/tenant_access_token/internal')),
    ).toBe(false);
    expect(
      state.mainRequests.find((request) => request.path.endsWith('/wiki/v2/spaces/spc1/nodes'))
        ?.headers.authorization,
    ).toBe('Bearer direct-token');
  });

  it('reads Drive folders, docx blocks and text files', async () => {
    const snapshot = await readSource(feishuDriveConfig());

    expect(snapshot.items.map((item) => item.path).sort()).toEqual([
      'Doc D.md',
      'Projects/Doc E.md',
      'notes.md',
    ]);
    const notes = snapshot.items.find((item) => item.path === 'notes.md');
    // 文本文件也保留原件字节，由本地解析器按 MIME/扩展名分派，不在来源层直接当 Markdown。
    expect(notes?.content).toBe('');
    expect(Buffer.from(notes?.bytes ?? []).toString('utf8')).toContain('hello from txt');
    expect(notes?.mimeType).toBe('text/markdown');
    const docD = snapshot.items.find((item) => item.path === 'Doc D.md');
    expect(docD?.sourceUrl).toBe(`${mainUrl}/doc/d`);
    expect(docD?.content).toContain('Content for docD');
  });

  it('accepts appId from settings, which is where the source API stores it', async () => {
    const snapshot = await readSource({
      ...feishuConfig(),
      credentials: { appSecret: 'cli_secret' },
      settings: { ...feishuConfig().settings, appId: 'cli_app' },
    });
    expect(snapshot.items).toHaveLength(3);
    const tokenRequest = state.mainRequests.find((request) =>
      request.path.endsWith('/tenant_access_token/internal'),
    );
    expect(JSON.parse(tokenRequest?.body ?? '{}')).toEqual({
      app_id: 'cli_app',
      app_secret: 'cli_secret',
    });
  });

  it('surfaces auth, permission, unsupported-resource and pagination failures', async () => {
    state.feishuTokenStatus = 401;
    await expect(readSource(feishuConfig())).rejects.toThrow(/401/);

    resetState();
    state.feishuTokenCode = 99991663;
    await expect(readSource(feishuConfig())).rejects.toThrow(/99991663/);

    resetState();
    state.feishuNodesStatus = 403;
    await expect(readSource(feishuConfig())).rejects.toThrow(/403/);

    resetState();
    state.feishuUnsupported = true;
    // 不支持的单项记失败继续读其它条目，不再让整轮枚举抛错。
    const unsupported = await readSource(feishuConfig());
    expect(unsupported.complete).toBe(false);
    expect(unsupported.items.some((item) => item.externalId === 'feishu:wiki:nod1')).toBe(true);
    expect(unsupported.failures).toEqual([
      expect.objectContaining({ code: 'unsupported_type', retryable: false }),
    ]);
    expect(unsupported.failures?.[0]?.message).toMatch(/sheet/);

    resetState();
    state.feishuDriveUnsupported = true;
    const drive = await readSource(feishuDriveConfig());
    const pdf = drive.items.find((item) => item.externalId === 'feishu:drive:pdf1');
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.bytes).toBeDefined();
    expect(drive.complete).toBe(true);
  });

  it('keeps a download without Content-Type as original bytes and routes it by extension', async () => {
    state.feishuDriveMissingMime = true;
    const snapshot = await readSource(feishuDriveConfig());
    const raw = snapshot.items.find((item) => item.externalId === 'feishu:drive:raw1');
    if (!raw) throw new Error('raw drive item missing');
    expect(raw.mimeType).toBe('application/pdf');
    expect(raw.content).toBe('');
    expect(Buffer.from(raw.bytes ?? [])).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00, 0x80]),
    );
  });

  it('probes only the first page when a Drive folder or wiki space has more pages', async () => {
    state.feishuDriveMultiPage = true;
    await expect(probeSource(feishuDriveConfig())).resolves.toBeUndefined();

    resetState();
    // wiki fixture 的首屏固定 has_more=true 且带 next page token。
    await expect(probeSource(feishuConfig())).resolves.toBeUndefined();
  });

  it('fails the docx item instead of publishing a truncated body at the block limit', async () => {
    state.feishuDocxTruncated = true;
    const snapshot = await readSource(feishuDriveConfig());

    expect(snapshot.complete).toBe(false);
    expect(snapshot.items.some((item) => item.externalId === 'feishu:drive:long1')).toBe(false);
    expect(snapshot.failures).toEqual([
      expect.objectContaining({
        externalId: 'feishu:drive:long1',
        code: 'truncated',
        retryable: false,
      }),
    ]);
    expect(snapshot.failures?.[0]?.message).toMatch(/50,000|上限|truncat/i);
    const blockRequests = state.mainRequests.filter((request) =>
      request.path.endsWith('/documents/long1/blocks'),
    );
    expect(blockRequests).toHaveLength(100);
  });

  it('classifies revoked credentials as SourceAuthError and keeps other failures generic', async () => {
    state.feishuTokenStatus = 401;
    await expect(readSource(feishuConfig())).rejects.toBeInstanceOf(SourceAuthError);

    resetState();
    state.feishuTokenCode = 99991663;
    await expect(readSource(feishuConfig())).rejects.toBeInstanceOf(SourceAuthError);

    resetState();
    state.feishuNodesStatus = 403;
    await expect(readSource(feishuConfig())).rejects.toBeInstanceOf(SourceAuthError);

    resetState();
    state.gitlabForbidden = true;
    await expect(readSource(gitlabConfig())).rejects.toBeInstanceOf(SourceAuthError);

    // 服务端故障与限流不是撤权，不能触发停源。
    resetState();
    state.gitlabTreeError = true;
    await expect(readSource(gitlabConfig())).rejects.not.toBeInstanceOf(SourceAuthError);

    resetState();
    state.feishuUnsupported = true;
    const unsupported = await readSource(feishuConfig());
    expect(unsupported.failures?.[0]?.code).toBe('unsupported_type');
  });
});

describe('uniquePath', () => {
  it('keeps the first path as-is and records it', () => {
    const used = new Set<string>();

    expect(uniquePath('folder/notes.md', used, 'tok-1')).toBe('folder/notes.md');
    expect(used.has('folder/notes.md')).toBe(true);
  });

  it('inserts the token before the extension on a name conflict', () => {
    const used = new Set<string>(['folder/notes.md']);

    expect(uniquePath('folder/notes.md', used, 'tok-1')).toBe('folder/notes [tok-1].md');
    expect(used.has('folder/notes [tok-1].md')).toBe(true);
  });

  it('appends the token when the path has no extension', () => {
    const used = new Set<string>(['folder/notes']);

    expect(uniquePath('folder/notes', used, 'tok-1')).toBe('folder/notes [tok-1]');
  });

  it('treats case and path separators as distinct paths', () => {
    const used = new Set<string>();

    expect(uniquePath('Notes.md', used, 'tok-1')).toBe('Notes.md');
    expect(uniquePath('notes.md', used, 'tok-2')).toBe('notes.md');
    expect(uniquePath('dir\\file.md', used, 'tok-3')).toBe('dir\\file.md');
    expect(uniquePath('dir/file.md', used, 'tok-4')).toBe('dir/file.md');
  });

  it('splits at the last dot in the whole path, including dots in a directory name', () => {
    const used = new Set<string>(['release.notes/page']);

    expect(uniquePath('release.notes/page', used, 'tok-1')).toBe('release [tok-1].notes/page');
  });
});

describe('sanitizeSegment', () => {
  it('replaces path and reserved characters with a single dash run', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j', 'fallback')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeSegment('a//b', 'fallback')).toBe('a-b');
  });

  it('turns control characters into spaces and collapses whitespace', () => {
    expect(sanitizeSegment('a\u0000b\u001fc\u007fd', 'fallback')).toBe('a b c d');
    expect(sanitizeSegment('  a \t  b  ', 'fallback')).toBe('a b');
  });

  it('strips leading dots but keeps a trailing dot', () => {
    expect(sanitizeSegment('...secret.md', 'fallback')).toBe('secret.md');
    expect(sanitizeSegment('name.', 'fallback')).toBe('name.');
  });

  it('truncates to 120 characters', () => {
    expect(sanitizeSegment('a'.repeat(130), 'fallback')).toBe('a'.repeat(120));
    expect(sanitizeSegment(`${'a'.repeat(119)}.md`, 'fallback')).toHaveLength(120);
  });

  it('returns the fallback when nothing survives cleaning', () => {
    expect(sanitizeSegment('', 'fallback')).toBe('fallback');
    expect(sanitizeSegment('...', 'fallback')).toBe('fallback');
    expect(sanitizeSegment('\u0000\t', 'fallback')).toBe('fallback');
  });

  it('keeps normal Chinese text and file extensions', () => {
    expect(sanitizeSegment('知识库 指南.md', 'fallback')).toBe('知识库 指南.md');
    expect(sanitizeSegment('知识库/指南.md', 'fallback')).toBe('知识库-指南.md');
  });
});

describe('trimSlash', () => {
  it('removes one or more trailing slashes', () => {
    expect(trimSlash('https://example.test/base/')).toBe('https://example.test/base');
    expect(trimSlash('https://example.test/base///')).toBe('https://example.test/base');
  });

  it('leaves a value without trailing slashes unchanged', () => {
    expect(trimSlash('https://example.test/base')).toBe('https://example.test/base');
    expect(trimSlash('')).toBe('');
  });

  it('turns a slash-only value into an empty string', () => {
    expect(trimSlash('/')).toBe('');
    expect(trimSlash('///')).toBe('');
  });

  it('keeps slashes that are not trailing', () => {
    expect(trimSlash('/a/b/')).toBe('/a/b');
    expect(trimSlash('https://example.test/')).toBe('https://example.test');
  });
});
