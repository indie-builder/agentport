import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashMcpToken } from '@agentport/core';
import { newId, schema } from '@agentport/db';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAgent,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const LONG = 'x'.repeat(20_050);

describe.skipIf(!ready)('knowledge MCP endpoint', () => {
  let app: FastifyInstance;
  let cookie = '';
  let baseUrl = '';
  let knowledgeDir = '';
  let embeddingId = '';
  let baseId = '';
  let serverId = '';
  let runId = '';
  let runToken = '';

  // embedding 上游固定失败：检索降级为关键词，不依赖向量 fixture。
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
    const res = await inject(app, {
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
    const res = await inject(app, {
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

  /** 直接落 ready 文档：MCP 读路径只依赖 DB 当前版本与磁盘 markdown。 */
  async function seedDocument(
    targetBaseId: string,
    profileId: string,
    content: string,
    markdown = content,
  ) {
    const documentId = `kdoc_${randomBytes(6).toString('hex')}`;
    const versionId = `kdv_${documentId.slice(5)}`;
    await app.pool.query(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, current_version_id)
       values ($1, $2, 'mcp 文档', 'upload', 'text/markdown', 'ready', $3)`,
      [documentId, targetBaseId, versionId],
    );
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'a.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4)`,
      [versionId, documentId, 'a'.repeat(64), profileId],
    );
    await app.pool.query(
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

  /** 直接发一次 JSON-RPC initialize；保留原始响应以便断言状态码与鉴权头。 */
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

  /** 按绑定形态造 run：自己的绑定、禁用的直接子级、或完全不绑定。 */
  async function seedAuthRun(bind: 'self' | 'disabled-child' | 'none') {
    const slug = unique('kb-auth');
    const agentId = newId('agent');
    createdAgents.push(slug);
    await app.db
      .insert(schema.agents)
      .values({ id: agentId, slug, name: slug, model: 'test-model' });
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
        parentId: agentId,
        enabled: false,
      });
      await app.db.insert(schema.agentServers).values({ agentId: childId, serverId });
    }
    const token = randomBytes(32).toString('base64url');
    const { runId: id } = await seedRun(app, agentId, { mcpTokenHash: hashMcpToken(token) });
    runIds.push(id);
    return { token, runId: id };
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => embedFix.listen(0, '127.0.0.1', resolve));
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-mcp-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

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

    runToken = randomBytes(32).toString('base64url');
    const seeded = await seedRun(app, agent.id, {
      runId: unique('kb-run'),
      mcpTokenHash: hashMcpToken(runToken),
    });
    runId = seeded.runId;
    runIds.push(runId);
  });

  afterAll(async () => {
    if (runIds.length > 0) {
      await app.pool.query('delete from agent_runs where id = any($1::text[])', [runIds]);
    }
    if (createdAgents.length > 0) {
      await app.pool.query('delete from agents where slug = any($1::text[])', [createdAgents]);
    }
    if (createdBases.length > 0) {
      await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [
        createdBases,
      ]);
    }
    if (createdServers.length > 0) {
      await app.pool.query('delete from servers where id = any($1::text[])', [createdServers]);
    }
    if (createdProfiles.length > 0) {
      await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
        createdProfiles,
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

    // 另一个 knowledge server：run 只绑定了 A，用 A 的 token 访问 B 也必须拒绝。
    const other = await createBase(embeddingId);
    const otherRes = await mcpPost(other.serverId, {
      authorization: `Bearer ${runToken}`,
      'x-agentport-run-id': runId,
    });
    expect(otherRes.status).toBe(401);
  });

  it('rejects expired, cleared, unbound and disabled-child tokens with 401', async () => {
    const expired = await seedAuthRun('self');
    await app.pool.query(
      "update agent_runs set mcp_token_expires_at = now() - interval '1 minute' where id = $1",
      [expired.runId],
    );
    const expiredRes = await mcpPost(serverId, {
      authorization: `Bearer ${expired.token}`,
      'x-agentport-run-id': expired.runId,
    });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.headers.get('www-authenticate')).toBe('Bearer realm="agentport-mcp"');

    // run 结束后 token 被清空：即使 header 里还带着旧 token 也不能再用。
    const cleared = await seedAuthRun('self');
    await app.pool.query(
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

  it('checks the run binding once per successful request', async () => {
    // 真实 query spy：旧实现会先取 token、再做一次 isRunBoundToServer，同样的 JOIN 执行两次。
    const spy = vi.spyOn(app.pool, 'query');
    let sql: string[] = [];
    try {
      const res = await mcpPost(serverId, {
        authorization: `Bearer ${runToken}`,
        'x-agentport-run-id': runId,
        accept: 'application/json, text/event-stream',
      });
      expect(res.status).toBe(200);
      sql = spy.mock.calls.map(([text]) =>
        typeof text === 'string' ? text : (text as { text: string }).text,
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      sql.filter((query) => query.includes('"agent_runs"') && query.includes('"agent_servers"')),
    ).toHaveLength(1);
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
      // 图片处理默认关闭：读图工具不暴露，普通工具不变。
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
    const parsed = JSON.parse(hit.text) as { hits: Array<{ title: string; quote: string }> };
    expect(parsed.hits.length).toBeGreaterThan(0);
    expect(parsed.hits[0]?.quote).toContain('令牌');

    const listed = await toolCall('knowledge_list', {});
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.text)).toMatchObject({ items: [{ title: 'mcp 文档' }] });
  });

  it('reads the current version and truncates long markdown', async () => {
    const { documentId } = await seedDocument(baseId, embeddingId, '正文', LONG);
    const read = await toolCall('knowledge_read', { documentId });
    expect(read.isError).toBeFalsy();
    const body = JSON.parse(read.text) as { markdown: string; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.markdown).toHaveLength(20_000);
  });

  it('rejects a foreign baseId and documents from another base', async () => {
    const other = await createBase(embeddingId);
    const { documentId } = await seedDocument(other.id, embeddingId, '别的库');

    const search = await toolCall('knowledge_search', { q: '别的', baseId: other.id });
    expect(search.isError).toBe(true);
    expect(search.text).toContain('BASE_MISMATCH');

    const read = await toolCall('knowledge_read', { documentId });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('DOCUMENT_NOT_FOUND');
  });

  it('returns BASE_DISABLED for every tool when the base is disabled', async () => {
    await app.pool.query("update knowledge_bases set status = 'disabled' where id = $1", [baseId]);
    try {
      for (const [name, args] of [
        ['knowledge_search', { q: '令牌' }],
        ['knowledge_read', { documentId: 'kdoc_missing' }],
        ['knowledge_list', {}],
      ] as const) {
        const res = await toolCall(name, args);
        expect(res.isError).toBe(true);
        expect(res.text).toContain('BASE_DISABLED');
      }
    } finally {
      await app.pool.query("update knowledge_bases set status = 'active' where id = $1", [baseId]);
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
    await app.pool.query('update knowledge_bases set settings = $2 where id = $1', [
      baseId,
      JSON.stringify({
        chunkTokens: 800,
        chunkOverlap: 120,
        wikiAutoUpdate: false,
        imageProcessing: { enabled: true, model: 'vision' },
      }),
    ]);
    await app.pool.query('update knowledge_document_versions set images = $2 where id = $1', [
      versionId,
      JSON.stringify([
        { name: 'fig-1.png', sha256: 'c'.repeat(64), mimeType: 'image/png', page: 1, warnings: [] },
      ]),
    ]);
    const chunkId = `kchk_${Math.random().toString(36).slice(2, 12)}`;
    await app.pool.query(
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
      await app.pool.query('delete from knowledge_chunks where id = $1', [chunkId]);
      await app.pool.query('delete from knowledge_documents where id = $1', [imageDocumentId]);
      await app.pool.query('update knowledge_bases set settings = $2 where id = $1', [
        baseId,
        JSON.stringify({ chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false }),
      ]);
    }
  });

  it('stops recalling a deleted document', async () => {
    // 前面的用例已在同一库留下含「令牌」的文档，先全部清掉再验证。
    await app.pool.query('delete from knowledge_documents where base_id = $1', [baseId]);
    const { documentId } = await seedDocument(baseId, embeddingId, '唯一 召回 词');
    const before = await toolCall('knowledge_search', { q: '召回' });
    expect(JSON.parse(before.text).hits).toHaveLength(1);
    await app.pool.query('delete from knowledge_documents where id = $1', [documentId]);
    const after = await toolCall('knowledge_search', { q: '召回' });
    expect(JSON.parse(after.text).hits).toHaveLength(0);
  });
});
