import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashMcpToken } from '@agentport/core';
import { newId, schema } from '@agentport/db';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ADMIN_BUSINESS_ID,
  createAgent,
  infraReady,
  loginCookie,
  request,
  seedRun,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;

const LONG = 'x'.repeat(20_050);

describe.skipIf(!ready)('knowledge MCP endpoint', () => {
  let app: TestApp;
  let server: TestServer;
  let cookie = '';
  let baseUrl = '';
  let knowledgeDir = '';
  let embeddingId = '';
  let baseId = '';
  let serverId = '';
  let runId = '';
  let runToken = '';

  const embedFix = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'off' }));
  });
  const createdBases: string[] = [];
  const createdServers: string[] = [];
  const createdProfiles: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  async function createProfile() {
    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('emb'),
        endpointUrl: `http://127.0.0.1:${(embedFix.address() as AddressInfo).port}`,
        model: 'test',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    createdProfiles.push(id);
    return id;
  }

  async function createBase(profileId: string) {
    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('kb'), name: 'MCP 库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const base = res.json<{ id: string; serverId: string }>();
    createdBases.push(base.id);
    createdServers.push(base.serverId);
    return base;
  }

  async function seedDocument(
    targetBaseId: string,
    profileId: string,
    content: string,
    markdown = content,
  ) {
    const documentId = `kdoc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const versionId = `kdv_${documentId.slice(5)}`;
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, current_version_id)
       values ($1, $2, 'mcp 文档', 'upload', 'text/markdown', 'ready', $3)`,
      [documentId, targetBaseId, versionId],
    );
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'a.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4)`,
      [versionId, documentId, 'a'.repeat(64), profileId],
    );
    await app.client.unsafe(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text)
       values ($1, $2, $3, $4, 0, 'text', $5, $6)`,
      [`kchk_${documentId.slice(5)}`, targetBaseId, documentId, versionId, content, content],
    );
    const dir = join(knowledgeDir, 'docs', documentId, versionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'markdown.md'), markdown);
    return { documentId, versionId };
  }

  async function seedWikiPage(input: { published: boolean; markdown?: string }) {
    const pageId = `kwp_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const versionId = `kwv_${pageId.slice(4)}`;
    const markdown = input.markdown ?? '线上 Wiki 正文';
    await app.client.unsafe(
      `insert into knowledge_wiki_pages (id, base_id, slug, title, status, current_version_id)
       values ($1, $2, $3, 'Wiki 页面', $4, $5)`,
      [
        pageId,
        baseId,
        `wiki-${pageId.slice(4)}`,
        input.published ? 'published' : 'draft',
        versionId,
      ],
    );
    await app.client.unsafe(
      `insert into knowledge_wiki_versions
         (id, page_id, version, markdown, source_chunk_ids, model, generated_by)
       values ($1, $2, 1, $3, '[]', 'manual', 'manual')`,
      [versionId, pageId, markdown],
    );
    return { pageId, versionId };
  }

  async function toolCall(
    name: string,
    args: Record<string, unknown>,
    token = runToken,
  ): Promise<{ isError?: boolean; text: string; content?: unknown[] }> {
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${serverId}`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
      },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      const first = result.content[0] as { text?: string } | undefined;
      return { isError: result.isError === true, text: first?.text ?? '', content: result.content };
    } finally {
      await client.close();
    }
  }

  function mcpPost(targetServerId: string, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp/${targetServerId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'knowledge-mcp-test', version: '0.0.0' },
        },
      }),
    });
  }

  async function seedAuthRun(bind: 'self' | 'disabled-child' | 'none') {
    const slug = unique('kb-auth');
    const agentId = newId('agent');
    createdAgents.push(slug);
    await app.db.insert(schema.agents).values({
      id: agentId,
      slug,
      name: slug,
      model: 'test-model',
      createdBy: ADMIN_BUSINESS_ID,
      ownerBusinessId: ADMIN_BUSINESS_ID,
    });
    if (bind === 'self') {
      await app.db.insert(schema.agentServers).values({ agentId, serverId });
    } else if (bind === 'disabled-child') {
      const childSlug = `${slug}-child`;
      createdAgents.push(childSlug);
      const childId = newId('agent');
      await app.db.insert(schema.agents).values({
        id: childId,
        slug: childSlug,
        name: childSlug,
        model: 'test-model',
        createdBy: ADMIN_BUSINESS_ID,
        ownerBusinessId: ADMIN_BUSINESS_ID,
        parentId: agentId,
        enabled: false,
      });
      await app.db.insert(schema.agentServers).values({ agentId: childId, serverId });
    }
    const token = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: 'base64url', omitPadding: true });
    const { runId: id } = await seedRun(app, agentId, { mcpTokenHash: hashMcpToken(token) });
    runIds.push(id);
    return { token, runId: id };
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => embedFix.listen(0, '127.0.0.1', resolve));
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-mcp-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
    server = await listen(app);
    baseUrl = server.url;

    embeddingId = await createProfile();
    const base = await createBase(embeddingId);
    baseId = base.id;
    serverId = base.serverId;

    const agent = (
      await createAgent(app, cookie, {
        slug: unique('kb-agent'),
        serverIds: [serverId],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    runToken = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: 'base64url', omitPadding: true });
    const seeded = await seedRun(app, agent.id, {
      runId: unique('kb-run'),
      mcpTokenHash: hashMcpToken(runToken),
    });
    runId = seeded.runId;
    runIds.push(runId);
  });

  afterAll(async () => {
    await server.close();
    if (runIds.length > 0) {
      await app.client.unsafe('delete from agent_runs where id = any($1::text[])', [
        app.client.array(runIds, 'TEXT'),
      ]);
    }
    if (createdAgents.length > 0) {
      await app.client.unsafe('delete from agents where slug = any($1::text[])', [
        app.client.array(createdAgents, 'TEXT'),
      ]);
    }
    if (createdBases.length > 0) {
      await app.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
        app.client.array(createdBases, 'TEXT'),
      ]);
    }
    if (createdServers.length > 0) {
      await app.client.unsafe('delete from servers where id = any($1::text[])', [
        app.client.array(createdServers, 'TEXT'),
      ]);
    }
    if (createdProfiles.length > 0) {
      await app.client.unsafe('delete from knowledge_model_profiles where id = any($1::text[])', [
        app.client.array(createdProfiles, 'TEXT'),
      ]);
    }
    await app.close();
    await new Promise<void>((resolve) => embedFix.close(() => resolve()));
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  it('rejects missing, wrong and unbound run tokens with 401', async () => {
    const noToken = await mcpPost(serverId);
    expect(noToken.status).toBe(401);

    const wrong = await mcpPost(serverId, {
      authorization: 'Bearer wrong',
      'x-agentport-run-id': runId,
    });
    expect(wrong.status).toBe(401);

    const other = await createBase(embeddingId);
    const otherRes = await mcpPost(other.serverId, {
      authorization: `Bearer ${runToken}`,
      'x-agentport-run-id': runId,
    });
    expect(otherRes.status).toBe(401);
  });

  it('rejects expired, cleared, unbound and disabled-child tokens with 401', async () => {
    const expired = await seedAuthRun('self');
    await app.client.unsafe(
      "update agent_runs set mcp_token_expires_at = now() - interval '1 minute' where id = $1",
      [expired.runId],
    );
    const expiredRes = await mcpPost(serverId, {
      authorization: `Bearer ${expired.token}`,
      'x-agentport-run-id': expired.runId,
    });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.headers.get('www-authenticate')).toBe('Bearer realm="agentport-mcp"');

    const cleared = await seedAuthRun('self');
    await app.client.unsafe(
      'update agent_runs set mcp_token_hash = null, mcp_token_expires_at = null where id = $1',
      [cleared.runId],
    );
    expect(
      (
        await mcpPost(serverId, {
          authorization: `Bearer ${cleared.token}`,
          'x-agentport-run-id': cleared.runId,
        })
      ).status,
    ).toBe(401);

    const unbound = await seedAuthRun('none');
    expect(
      (
        await mcpPost(serverId, {
          authorization: `Bearer ${unbound.token}`,
          'x-agentport-run-id': unbound.runId,
        })
      ).status,
    ).toBe(401);

    const disabledChild = await seedAuthRun('disabled-child');
    expect(
      (
        await mcpPost(serverId, {
          authorization: `Bearer ${disabledChild.token}`,
          'x-agentport-run-id': disabledChild.runId,
        })
      ).status,
    ).toBe(401);
  });

  it('lists the three read-only tools and returns keyword hits', async () => {
    await seedDocument(baseId, embeddingId, '访问 令牌 需要 定期 轮换');
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${serverId}`), {
      requestInit: {
        headers: { authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId },
      },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'knowledge_list',
        'knowledge_read',
        'knowledge_search',
      ]);
    } finally {
      await client.close();
    }

    const hit = await toolCall('knowledge_search', { q: '令牌' });
    expect(hit.isError).toBeFalsy();
    const parsed = JSON.parse(hit.text) as {
      hits: Array<{ title: string; quote: string; target: { kind: string } }>;
      degraded: boolean;
      warnings: Array<{ code: string }>;
      diagnostics?: unknown;
    };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]?.quote).toContain('令牌');
    expect(parsed.hits[0]?.target.kind).toBe('document');
    expect(parsed.degraded).toBe(true);
    expect(parsed.warnings.map((warning) => warning.code)).toContain('embedding_unavailable');
    expect(parsed.diagnostics).toBeUndefined();

    const diagnosed = await toolCall('knowledge_search', { q: '令牌', diagnostics: true });
    expect(JSON.parse(diagnosed.text).diagnostics).toBeUndefined();

    const listed = await toolCall('knowledge_list', {});
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.text)).toMatchObject({
      items: [{ title: 'mcp 文档', target: { kind: 'document' } }],
    });
  });

  it('reads the current version with code-point pagination', async () => {
    const { documentId } = await seedDocument(baseId, embeddingId, LONG, LONG);
    const read = await toolCall('knowledge_read', {
      target: { kind: 'document', id: documentId },
    });
    expect(read.isError).toBeFalsy();
    const body = JSON.parse(read.text) as {
      markdown: string;
      offset: number;
      nextOffset: number | null;
      totalCharacters: number;
      citations: Array<{ target: { kind: string; id: string }; chunkId: string }>;
    };
    expect(body.offset).toBe(0);
    expect(body.markdown).toHaveLength(10_000);
    expect(body.nextOffset).toBe(10_000);
    expect(body.totalCharacters).toBe(20_050);
    expect(body.citations[0]?.target).toEqual({ kind: 'document', id: documentId });
  });

  it('reassembles long content across pages without splitting emoji code points', async () => {
    const emoji = '😀'.repeat(25_001);
    const { documentId } = await seedDocument(baseId, embeddingId, emoji, emoji);
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const read = await toolCall('knowledge_read', {
        target: { kind: 'document', id: documentId },
        offset,
        limit: 10_000,
      });
      expect(read.isError).toBeFalsy();
      const body = JSON.parse(read.text) as {
        markdown: string;
        offset: number;
        nextOffset: number | null;
        totalCharacters: number;
      };
      expect(body.offset).toBe(offset);
      expect(body.totalCharacters).toBe(25_001);
      expect(body.markdown).not.toContain('�');
      pages.push(body.markdown);
      if (body.nextOffset === null) break;
      offset = body.nextOffset;
    }
    expect(pages.join('')).toBe(emoji);
  });

  it('lists only readable targets, filters by kind and pages with a stable cursor', async () => {
    const doc = await seedDocument(baseId, embeddingId, '列表明细');
    const faq = await seedDocument(baseId, embeddingId, 'FAQ 明细');
    await app.client.unsafe("update knowledge_documents set content_kind = 'faq' where id = $1", [
      faq.documentId,
    ]);
    const disabled = await seedDocument(baseId, embeddingId, '已停用');
    await app.client.unsafe(
      "update knowledge_documents set status = 'disabled', disabled_reason = 'manual' where id = $1",
      [disabled.documentId],
    );
    const published = await seedWikiPage({ published: true });
    const draft = await seedWikiPage({ published: false });

    const docs = JSON.parse((await toolCall('knowledge_list', { kinds: ['document'] })).text) as {
      items: Array<{ target: { kind: string; id: string } }>;
    };
    expect(docs.items.some((item) => item.target.id === doc.documentId)).toBe(true);
    expect(docs.items.some((item) => item.target.id === faq.documentId)).toBe(false);
    expect(docs.items.some((item) => item.target.kind === 'wiki')).toBe(false);
    expect(docs.items.some((item) => item.target.id === disabled.documentId)).toBe(false);

    const faqs = JSON.parse((await toolCall('knowledge_list', { kinds: ['faq'] })).text) as {
      items: Array<{ target: { kind: string; id: string } }>;
    };
    expect(faqs.items.some((item) => item.target.id === faq.documentId)).toBe(true);
    expect(faqs.items.every((item) => item.target.kind === 'faq')).toBe(true);

    const wiki = JSON.parse((await toolCall('knowledge_list', { kinds: ['wiki'] })).text) as {
      items: Array<{ target: { id: string } }>;
    };
    expect(wiki.items.some((item) => item.target.id === published.pageId)).toBe(true);
    expect(wiki.items.some((item) => item.target.id === draft.pageId)).toBe(false);

    const first = JSON.parse((await toolCall('knowledge_list', { limit: 1 })).text) as {
      items: Array<{ target: { id: string; kind: string } }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = JSON.parse(
      (await toolCall('knowledge_list', { limit: 1, cursor: first.nextCursor })).text,
    ) as { items: Array<{ target: { id: string; kind: string } }> };
    expect(second.items[0]?.target).not.toEqual(first.items[0]?.target);
  });

  it('reads all FAQ answers from the published version', async () => {
    const documentId = `kdoc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const versionId = `kdv_${documentId.slice(5)}`;
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, current_version_id, content_kind)
       values ($1, $2, 'FAQ 文档', 'manual', 'text/markdown', 'ready', $3, 'faq')`,
      [documentId, baseId, versionId],
    );
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id, origin, faq)
       values ($1, $2, 1, $3, $3, 'faq.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4,
         'faq', $5)`,
      [
        versionId,
        documentId,
        'a'.repeat(64),
        embeddingId,
        JSON.stringify({
          question: '如何重置密码',
          similarQuestions: ['忘记密码'],
          negativeQuestions: ['如何注销账号'],
          answers: ['打开设置重置。', '联系管理员重置。'],
        }),
      ],
    );
    const read = await toolCall('knowledge_read', {
      target: { kind: 'faq', id: documentId },
    });
    expect(read.isError).toBeFalsy();
    const body = JSON.parse(read.text) as {
      markdown: string;
      target: { kind: string; id: string };
      citations: Array<{ target: { kind: string }; quote: string }>;
    };
    expect(body.target).toEqual({ kind: 'faq', id: documentId });
    expect(body.markdown).toContain('打开设置重置。');
    expect(body.markdown).toContain('联系管理员重置。');
    expect(body.citations[0]?.target.kind).toBe('faq');
  });

  it('accepts FAQ policy args and returns faq/directAnswer on the search wire', async () => {
    const documentId = `kdoc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const versionId = `kdv_${documentId.slice(5)}`;
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, current_version_id, content_kind)
       values ($1, $2, 'FAQ 检索文档', 'manual', 'text/markdown', 'ready', $3, 'faq')`,
      [documentId, baseId, versionId],
    );
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id, origin, faq)
       values ($1, $2, 1, $3, $3, 'faq.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4,
         'faq', $5)`,
      [
        versionId,
        documentId,
        'a'.repeat(64),
        embeddingId,
        JSON.stringify({
          question: '重置密码',
          similarQuestions: [],
          negativeQuestions: [],
          answers: ['打开设置重置。', '联系管理员重置。'],
          answerStrategy: 'all',
          isRecommended: false,
        }),
      ],
    );
    await app.client.unsafe(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
       values ($1, $2, $3, $4, 0, 'text', '重置密码', '重置 密码', $5)`,
      [
        `kchk_${documentId.slice(5)}`,
        baseId,
        documentId,
        versionId,
        JSON.stringify({
          questionKind: 'standard',
          matchedQuestion: '重置密码',
          answerOrdinal: 0,
        }),
      ],
    );

    const args = {
      q: '密码',
      kinds: ['faq'],
      onlyRecommended: false,
      faqPriority: true,
      faqDirectAnswerThreshold: 0.9,
    };
    const found = await toolCall('knowledge_search', args);
    expect(found.isError).toBeFalsy();
    const body = JSON.parse(found.text) as {
      hits: Array<{
        target: { kind: string; id: string };
        faq?: Record<string, unknown>;
      }>;
      degraded: boolean;
      directAnswer: unknown;
    };
    const hit = body.hits.find((entry) => entry.target.id === documentId);
    expect(hit?.faq).toEqual({
      answers: ['打开设置重置。', '联系管理员重置。'],
      answerStrategy: 'all',
      isRecommended: false,
      matchedQuestion: '重置密码',
      questionKind: 'standard',
    });
    expect(body.degraded).toBe(true);
    expect(body.directAnswer).toBeNull();

    const filtered = await toolCall('knowledge_search', { ...args, onlyRecommended: true });
    const filteredBody = JSON.parse(filtered.text) as {
      hits: Array<{ target: { id: string } }>;
    };
    expect(filteredBody.hits.some((entry) => entry.target.id === documentId)).toBe(false);
  });

  it('reads every FAQ answer across code-point pages without splitting emoji', async () => {
    const documentId = `kdoc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const versionId = `kdv_${documentId.slice(5)}`;
    const question = '表情问答';
    const answers = [`${'😀'.repeat(6_000)}甲`, `${'😀'.repeat(6_000)}乙`];
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, current_version_id, content_kind)
       values ($1, $2, 'FAQ 分页文档', 'manual', 'text/markdown', 'ready', $3, 'faq')`,
      [documentId, baseId, versionId],
    );
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id, origin, faq)
       values ($1, $2, 1, $3, $3, 'faq.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4,
         'faq', $5)`,
      [
        versionId,
        documentId,
        'a'.repeat(64),
        embeddingId,
        JSON.stringify({
          question,
          similarQuestions: [],
          negativeQuestions: [],
          answers,
          answerStrategy: 'random',
          isRecommended: true,
        }),
      ],
    );
    const expected = `${question}\n\n${answers.join('\n\n')}`;
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const read = await toolCall('knowledge_read', {
        target: { kind: 'faq', id: documentId },
        offset,
        limit: 7_000,
      });
      expect(read.isError).toBeFalsy();
      const body = JSON.parse(read.text) as {
        markdown: string;
        offset: number;
        nextOffset: number | null;
        totalCharacters: number;
      };
      expect(body.offset).toBe(offset);
      expect(body.totalCharacters).toBe(Array.from(expected).length);
      expect(body.markdown).not.toContain('�');
      pages.push(body.markdown);
      if (body.nextOffset === null) break;
      offset = body.nextOffset;
    }
    expect(pages.join('')).toBe(expected);
  });

  it('rejects a stale explicit version and only reads published wiki pages', async () => {
    const { documentId, versionId } = await seedDocument(baseId, embeddingId, '版本文档');
    const stale = await toolCall('knowledge_read', {
      target: { kind: 'document', id: documentId },
      versionId: 'kdv_outdated',
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('VERSION_NOT_CURRENT');

    const draft = await seedWikiPage({ published: false });
    const draftRead = await toolCall('knowledge_read', {
      target: { kind: 'wiki', id: draft.pageId },
    });
    expect(draftRead.isError).toBe(true);
    expect(draftRead.text).toContain('WIKI_NOT_FOUND');

    const published = await seedWikiPage({ published: true });
    const wikiRead = await toolCall('knowledge_read', {
      target: { kind: 'wiki', id: published.pageId },
    });
    expect(wikiRead.isError).toBeFalsy();
    expect(JSON.parse(wikiRead.text)).toMatchObject({
      target: { kind: 'wiki', id: published.pageId },
      versionId: published.versionId,
      markdown: '线上 Wiki 正文',
      totalCharacters: 10,
    });
    expect(versionId).toBeTruthy();
  });

  it('rejects a foreign baseId and documents from another base', async () => {
    const other = await createBase(embeddingId);
    const { documentId } = await seedDocument(other.id, embeddingId, '别的库');

    const search = await toolCall('knowledge_search', { q: '别的', baseId: other.id });
    expect(search.isError).toBe(true);
    expect(search.text).toContain('BASE_MISMATCH');

    const read = await toolCall('knowledge_read', {
      target: { kind: 'document', id: documentId },
    });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('DOCUMENT_NOT_FOUND');
  });

  it('returns BASE_DISABLED for every tool when the base is disabled', async () => {
    await app.client.unsafe("update knowledge_bases set status = 'disabled' where id = $1", [
      baseId,
    ]);
    try {
      for (const [name, args] of [
        ['knowledge_search', { q: '令牌' }],
        ['knowledge_read', { target: { kind: 'document', id: 'kdoc_missing' } }],
        ['knowledge_list', {}],
      ] as const) {
        const res = await toolCall(name, args);
        expect(res.isError).toBe(true);
        expect(res.text).toContain('BASE_DISABLED');
      }
    } finally {
      await app.client.unsafe("update knowledge_bases set status = 'active' where id = $1", [
        baseId,
      ]);
    }
  });

  it('serves image hits as JSON text plus an MCP image block only when asked', async () => {
    const { documentId: imageDocumentId, versionId } = await seedDocument(
      baseId,
      embeddingId,
      '图片描述：令牌轮换流程',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await app.client.unsafe('update knowledge_bases set settings = $2 where id = $1', [
      baseId,
      JSON.stringify({
        chunkTokens: 800,
        chunkOverlap: 120,
        wikiAutoUpdate: false,
        imageProcessing: { enabled: true, model: 'vision' },
      }),
    ]);
    await app.client.unsafe('update knowledge_document_versions set images = $2 where id = $1', [
      versionId,
      JSON.stringify([
        { name: 'fig-1.png', sha256: 'c'.repeat(64), mimeType: 'image/png', page: 1, warnings: [] },
      ]),
    ]);
    const chunkId = `kchk_${Math.random().toString(36).slice(2, 12)}`;
    await app.client.unsafe(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
       values ($1, $2, $3, $4, 9, 'image', '图中显示令牌轮换', '', $5)`,
      [
        chunkId,
        baseId,
        imageDocumentId,
        versionId,
        JSON.stringify({
          image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
          imageRole: 'caption',
        }),
      ],
    );
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${serverId}`), {
      requestInit: {
        headers: { authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId },
      },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('knowledge_read_image');
    } finally {
      await client.close();
    }
    await mkdir(join(knowledgeDir, 'docs', imageDocumentId, versionId, 'images'), {
      recursive: true,
    });
    await writeFile(
      join(knowledgeDir, 'docs', imageDocumentId, versionId, 'images', 'fig-1.png'),
      png,
    );
    try {
      const description = await toolCall('knowledge_read_image', { chunkId });
      expect(description.isError).toBeFalsy();
      const parsed = JSON.parse(description.text) as {
        description: string;
        hit: { image: { name: string } };
      };
      expect(parsed.description).toBe('图中显示令牌轮换');
      expect(parsed.hit.image.name).toBe('fig-1.png');
      expect(description.content).toHaveLength(1);

      const withImage = await toolCall('knowledge_read_image', { chunkId, format: 'image' });
      expect(withImage.isError).toBeFalsy();
      expect(withImage.content?.[1]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        data: png.toString('base64'),
      });
      expect(JSON.parse(withImage.text)).toEqual(parsed);
    } finally {
      await app.client.unsafe('delete from knowledge_chunks where id = $1', [chunkId]);
      await app.client.unsafe('delete from knowledge_documents where id = $1', [imageDocumentId]);
      await app.client.unsafe('update knowledge_bases set settings = $2 where id = $1', [
        baseId,
        JSON.stringify({ chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false }),
      ]);
    }
  });

  it('stops recalling a deleted document', async () => {
    await app.client.unsafe('delete from knowledge_documents where base_id = $1', [baseId]);
    const { documentId } = await seedDocument(baseId, embeddingId, '唯一 召回 词');
    const before = await toolCall('knowledge_search', { q: '召回' });
    expect(JSON.parse(before.text).hits).toHaveLength(1);
    await app.client.unsafe('delete from knowledge_documents where id = $1', [documentId]);
    const after = await toolCall('knowledge_search', { q: '召回' });
    expect(JSON.parse(after.text).hits).toHaveLength(0);
  });

  it('pages targets sharing one microsecond timestamp without skipping any', async () => {
    await app.client.unsafe('delete from knowledge_documents where base_id = $1', [baseId]);
    await app.client.unsafe('delete from knowledge_wiki_pages where base_id = $1', [baseId]);
    const stamp = '2026-01-01T12:00:00.123456Z';
    for (const [id, versionId, kind] of [
      ['kdoc_a', 'kdv_a', 'document'],
      ['kdoc_b', 'kdv_b', 'faq'],
    ] as const) {
      await app.client.unsafe(
        `insert into knowledge_documents
           (id, base_id, title, source_type, mime_type, status, current_version_id, content_kind)
         values ($1, $2, $3, 'manual', 'text/markdown', 'ready', $4, $5)`,
        [id, baseId, id, versionId, kind],
      );
      await app.client.unsafe(
        `insert into knowledge_document_versions
           (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
            size_bytes, parse_status, page_map, images, embedding_profile_id, origin, faq)
         values ($1, $2, 1, $3, $3, 'a.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4,
           'faq', $5)`,
        [
          versionId,
          id,
          'a'.repeat(64),
          embeddingId,
          kind === 'faq'
            ? JSON.stringify({
                question: '同微秒问题',
                similarQuestions: [],
                negativeQuestions: [],
                answers: ['同微秒答案'],
              })
            : null,
        ],
      );
    }
    await app.client.unsafe(
      `insert into knowledge_wiki_pages (id, base_id, slug, title, status, current_version_id)
       values ('kwp_c', $1, 'wiki-kwp-c', 'Wiki 同微秒', 'published', 'kwv_c')`,
      [baseId],
    );
    await app.client.unsafe('update knowledge_documents set updated_at = $2 where base_id = $1', [
      baseId,
      stamp,
    ]);
    await app.client.unsafe('update knowledge_wiki_pages set updated_at = $2 where base_id = $1', [
      baseId,
      stamp,
    ]);

    const listed: Array<{ target: { kind: string; id: string }; updatedAt: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body = JSON.parse(
        (await toolCall('knowledge_list', { limit: 1, ...(cursor ? { cursor } : {}) })).text,
      ) as {
        items: Array<{ target: { kind: string; id: string }; updatedAt: string }>;
        nextCursor: string | null;
      };
      listed.push(...body.items);
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(listed.map((item) => item.target)).toEqual([
      { kind: 'wiki', id: 'kwp_c' },
      { kind: 'faq', id: 'kdoc_b' },
      { kind: 'document', id: 'kdoc_a' },
    ]);
    expect(listed[0]?.updatedAt).toBe('2026-01-01T12:00:00.123Z');
  });
});
