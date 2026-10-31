import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecrets, encryptSecrets } from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import {
  type KnowledgeSourceInput,
  knowledgeReadInputSchema,
  knowledgeSearchQuerySchema,
  knowledgeSourceInputSchema,
} from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readKnowledgeTarget } from '../../api/src/features/knowledge/mcp.js';
import { searchKnowledge } from '../../api/src/features/knowledge/retrieval.js';
import { knowledgeConnectors } from '../src/knowledge/connector-adapter.js';
import { type KnowledgeDeps, runSync } from '../src/knowledge/ingestion.js';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';
import { createIsolatedDatabase } from './isolated-db.js';

// 全链路写入 documents/versions/chunks：独享随机库，避免和其它源同步套件互相收敛。
const isolated = await createIsolatedDatabase('worker_knowledge_source_expansion');
const ready = isolated !== null;
if (isolated) process.env.DATABASE_URL = isolated.url;

const SECRET_KEY = process.env.APP_SECRET_KEY ?? '';
const EMBED_ORIGIN = 'http://embed.integration';
const PARSER_ORIGIN = 'http://parser.integration';
const LARK_TOKEN = 'lark-token';
const LARK_SECRET = 'lark-secret';
const NOTION_TOKEN = 'secret-token';
const REPO = '11111111-2222-3333-4444-555555555555';
const SEAFILE_SITE = 'http://127.0.0.1:9';

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as KnowledgeDeps['logger'];

function fixture<T = unknown>(path: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/knowledge-sources/${path}`, import.meta.url), 'utf8'),
  ) as T;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fileResponse(bytes: Uint8Array, objectId: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'x-seafile-object-id': objectId },
  });
}

type Call = { method: string; url: URL; headers: Headers; body: unknown };
type FetchHandler = (url: URL, init: RequestInit, call: Call) => Response | Promise<Response>;

let calls: Call[] = [];
let handler: FetchHandler = () => new Response('not mocked', { status: 599 });

beforeEach(() => {
  calls = [];
  handler = () => new Response('not mocked', { status: 599 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const request = init ?? {};
      const call: Call = {
        method: request.method ?? 'GET',
        url,
        headers: new Headers(request.headers),
        body: request.body,
      };
      calls.push(call);
      // 摄取/检索都要真实走 embedding 协议；向量固定 1024 维，避免命中不存在的上游。
      if (url.origin === EMBED_ORIGIN && url.pathname === '/embeddings') {
        const parsed = JSON.parse(String(request.body ?? '{}')) as { input?: string[] };
        return json({
          data: (parsed.input ?? []).map((_, index) => ({
            index,
            embedding: Array.from({ length: 1024 }, (_, position) =>
              position === 0 ? index + 1 : 0,
            ),
          })),
        });
      }
      return handler(url, request, call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FixtureBase {
  baseId: string;
  deps: KnowledgeDeps;
}

let dbHandle: ReturnType<typeof createDb> | undefined;
let db: ReturnType<typeof createDb>['db'];
let knowledgeDir = '';

beforeAll(() => {
  if (isolated) {
    dbHandle = createDb(isolated.url);
    db = dbHandle.db;
  }
});

afterAll(async () => {
  await dbHandle?.pool.end();
  await isolated?.close();
});

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-source-expansion-'));
});

afterEach(async () => {
  await rm(knowledgeDir, { recursive: true, force: true });
});

async function makeBase(parserUrl = PARSER_ORIGIN): Promise<FixtureBase> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const serverId = newId('server');
  await db.insert(schema.servers).values({
    id: serverId,
    name: `kb-source-expansion-${id}`,
    kind: 'knowledge',
    config: { knowledgeBaseId: `pending-${id}` },
  });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-${id}`,
    endpointUrl: EMBED_ORIGIN,
    model: 'test-embed',
    dimensions: 1024,
    secretsEncrypted: null,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-source-expansion-${id}`,
    name: `kb source expansion ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: {
      chunkTokens: 400,
      chunkOverlap: 40,
      wikiAutoUpdate: false,
      imageProcessing: {
        enabled: false,
        model: null,
        ocrEnabled: true,
        captionEnabled: true,
        descriptionLanguage: 'zh-CN',
        customInstructions: '',
        imageVectorEnabled: false,
        imageVectorMinScore: 0.3,
      },
    },
  });
  const adapter = createParsingAdapter({ parserUrl });
  return {
    baseId: base.id,
    deps: {
      db,
      logger: quiet,
      knowledgeDir,
      ...adapter,
      connectors: knowledgeConnectors,
      decrypt: (payload) => decryptSecrets(payload, SECRET_KEY),
      allowLoopback: true,
      trustedHosts: ['open.larksuite.com', 'api.notion.com'],
    },
  };
}

async function makeSource(
  fixtureBase: FixtureBase,
  input: KnowledgeSourceInput,
): Promise<{ sourceId: string; rangeIds: string[] }> {
  const source = await repo.knowledge.createSource(db, {
    baseId: fixtureBase.baseId,
    type: input.type,
    name: input.name,
    config: { ...input.config },
    secretsEncrypted:
      Object.keys(input.secrets).length > 0
        ? encryptSecrets({ ...input.secrets }, SECRET_KEY)
        : null,
    syncCron: input.syncCron,
  });
  const ranges = await repo.knowledge.replaceRanges(
    db,
    source.id,
    input.ranges.map((range) => ({
      kind: range.kind,
      externalId: range.externalId,
      ref: range.ref,
      paths: range.paths,
      enabled: range.enabled,
    })),
  );
  return { sourceId: source.id, rangeIds: ranges.map((range) => range.id) };
}

async function runSyncJob(fixtureBase: FixtureBase, sourceId: string): Promise<string> {
  const created = await repo.knowledge.createSyncJob(db, sourceId);
  if (created.status !== 'created') throw new Error(`sync pair not created: ${created.status}`);
  const claimed = await repo.knowledge.claimJob(db, created.job.id);
  if (!claimed) throw new Error('sync job not claimed');
  const job = await repo.knowledge.getJob(db, claimed.id);
  if (!job) throw new Error('sync job missing');
  try {
    const result = await runSync(fixtureBase.deps, job, new AbortController().signal);
    await repo.knowledge.finishJob(db, claimed.id, { status: 'succeeded', result });
  } catch (err) {
    await repo.knowledge.finishJob(db, claimed.id, { status: 'failed', error: String(err) });
    throw err;
  }
  return created.run.id;
}

async function documentsOfBase(fixtureBase: FixtureBase) {
  return db
    .select()
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId));
}

async function versionsOf(documentId: string) {
  return (await repo.knowledge.listVersions(db, documentId, { limit: 50 })).items;
}

async function chunkContents(documentId: string): Promise<string[]> {
  const document = await repo.knowledge.getDocument(db, documentId);
  if (!document?.currentVersionId) throw new Error('document has no current version');
  return (await repo.knowledge.listChunks(db, document.currentVersionId, { limit: 200 })).items.map(
    (chunk) => chunk.content,
  );
}

async function readDocument(fixtureBase: FixtureBase, documentId: string) {
  return readKnowledgeTarget(
    {
      db,
      baseId: fixtureBase.baseId,
      serverId: 'server-test',
      runId: 'run-test',
      secretKey: SECRET_KEY,
      knowledgeDir,
    },
    knowledgeReadInputSchema.parse({ target: { kind: 'document', id: documentId } }),
  );
}

async function searchDocuments(fixtureBase: FixtureBase, q: string) {
  return searchKnowledge(
    db,
    fixtureBase.baseId,
    knowledgeSearchQuerySchema.parse({ q, kinds: ['document'], rerank: false, limit: 10 }),
    { secretKey: SECRET_KEY },
  );
}

describe('public source registry wiring', () => {
  const cases: Array<{
    type: KnowledgeSourceInput['type'];
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    ranges: Array<{ kind: string; externalId: string; paths?: string[] }>;
  }> = [
    {
      type: 'lark_wiki',
      config: { appId: 'cli_a' },
      secrets: { appSecret: 'app-secret' },
      ranges: [{ kind: 'wiki_space', externalId: 'spc_1' }],
    },
    {
      type: 'lark_drive',
      config: { appId: 'cli_a' },
      secrets: { appSecret: 'app-secret' },
      ranges: [{ kind: 'drive_folder', externalId: 'fld_1' }],
    },
    {
      type: 'notion',
      config: {},
      secrets: { apiKey: 'notion-key' },
      ranges: [{ kind: 'notion_page', externalId: '11111111-1111-4111-8111-111111111111' }],
    },
    {
      type: 'confluence',
      config: {
        authMode: 'cloud_basic',
        baseUrl: 'https://acme.atlassian.net/wiki',
        email: 'owner@example.com',
      },
      secrets: { apiToken: 'confluence-token' },
      ranges: [{ kind: 'confluence_space', externalId: '123' }],
    },
    {
      type: 'yuque',
      config: {},
      secrets: { apiToken: 'yuque-token' },
      ranges: [{ kind: 'yuque_repo', externalId: '42' }],
    },
    {
      type: 'dingtalk',
      config: { clientId: 'client-id', operatorUnionId: 'union-id' },
      secrets: { clientSecret: 'dingtalk-secret' },
      ranges: [{ kind: 'dingtalk_workspace', externalId: 'workspace-1' }],
    },
    {
      type: 'ima',
      config: { clientId: 'ima-client' },
      secrets: { apiKey: 'ima-key' },
      ranges: [{ kind: 'ima_kb', externalId: 'kb-1' }],
    },
    {
      type: 'seafile',
      config: { baseUrl: 'https://seafile.example.com' },
      secrets: { apiToken: 'seafile-token' },
      ranges: [{ kind: 'seafile_repo', externalId: REPO, paths: ['Documents'] }],
    },
    {
      type: 'nextcloud',
      config: { baseUrl: 'https://cloud.example.com', username: 'alice' },
      secrets: { appPassword: 'nextcloud-password' },
      ranges: [{ kind: 'nextcloud_path', externalId: '/Documents' }],
    },
  ];

  it.each(cases)(
    '$type parses the public wire shape and resolves its registry connector',
    (entry) => {
      const input = knowledgeSourceInputSchema.parse({
        type: entry.type,
        name: entry.type,
        config: entry.config,
        secrets: entry.secrets,
        ranges: entry.ranges,
      });
      expect(input.type).toBe(entry.type);
      expect(input.config.syncDeletions).toBe(false);
      expect(input.ranges[0]).toMatchObject({
        kind: entry.ranges[0]?.kind,
        externalId: entry.ranges[0]?.externalId,
        ref: null,
        enabled: true,
      });
      const connector = knowledgeConnectors[input.type as keyof typeof knowledgeConnectors];
      expect(connector).toBeDefined();
      expect(typeof connector.sync).toBe('function');
      expect(typeof connector.probe).toBe('function');
    },
  );
});

describe.skipIf(!ready)('knowledge source expansion public chain', () => {
  it('runs Lark export bytes through the real parser into DB versions, chunks, read and search', async () => {
    const exportFixture = fixture<{ bytesBase64: string; mimeType: string }>(
      'lark/export-docx.json',
    );
    const exportedBytes = Buffer.from(exportFixture.bytesBase64, 'base64');
    const parserRequests: Array<{ filename: string; bytes: Buffer }> = [];
    const tickets = new Map<string, string>();

    handler = async (url, init) => {
      const path = decodeURIComponent(url.pathname);
      if (url.host === 'open.larksuite.com') {
        if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
          return json({ code: 0, tenant_access_token: LARK_TOKEN });
        }
        if (path === '/open-apis/wiki/v2/spaces/get_node') {
          return json(fixture('lark/wiki-node-root.json'));
        }
        if (path === '/open-apis/wiki/v2/spaces/spc1/nodes') {
          expect(url.searchParams.get('parent_node_token')).toBe('nod1');
          return json(fixture('lark/wiki-nodes-child.json'));
        }
        if (path === '/open-apis/drive/v1/export_tasks') {
          const body = JSON.parse(String(init.body)) as { token: string; file_extension: string };
          tickets.set(body.token, body.file_extension);
          return json({ code: 0, data: { ticket: `ticket-${body.token}` } });
        }
        if (path.startsWith('/open-apis/drive/v1/export_tasks/file/')) {
          return new Response(exportedBytes, { status: 200 });
        }
        if (path.startsWith('/open-apis/drive/v1/export_tasks/')) {
          const token = url.searchParams.get('token') ?? '';
          expect(tickets.has(token)).toBe(true);
          return json({
            code: 0,
            data: { result: { job_status: 0, file_token: `file-${token}` } },
          });
        }
      }
      if (url.origin === PARSER_ORIGIN && path === '/v1/convert/file') {
        const form = init.body as FormData;
        const file = form.get('files') as File;
        parserRequests.push({
          filename: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        return json(fixture('integration/lark-docling.json'));
      }
      throw new Error(`unexpected request ${url.href}`);
    };

    const fixtureBase = await makeBase();
    const input = knowledgeSourceInputSchema.parse({
      type: 'lark_wiki',
      name: 'lark wiki',
      config: { appId: 'cli_lark' },
      secrets: { appSecret: LARK_SECRET },
      ranges: [{ kind: 'wiki_node', externalId: 'nod1' }],
    });
    const { sourceId, rangeIds } = await makeSource(fixtureBase, input);

    await runSyncJob(fixtureBase, sourceId);

    const documents = await documentsOfBase(fixtureBase);
    expect(documents.map((document) => document.title).sort()).toEqual([
      'Child.docx',
      'Guide.docx',
    ]);
    for (const document of documents) {
      expect(document.sourceType).toBe('lark_wiki');
      expect(document.sourceConnectionId).toBe(sourceId);
      expect(document.status).toBe('ready');
      expect(await versionsOf(document.id)).toHaveLength(1);
      expect((await chunkContents(document.id)).join('\n')).toContain('lark-export-marker-2048');
    }

    expect(parserRequests.map((request) => request.filename).sort()).toEqual([
      'Child.docx',
      'Guide.docx',
    ]);
    for (const request of parserRequests) {
      expect(request.bytes.equals(exportedBytes)).toBe(true);
    }
    for (const call of calls.filter((call) => call.url.host === 'open.larksuite.com')) {
      if (call.url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') continue;
      expect(call.headers.get('authorization')).toBe(`Bearer ${LARK_TOKEN}`);
    }

    const guide = documents.find((document) => document.title === 'Guide.docx');
    if (!guide) throw new Error('Guide.docx document missing');
    const memberships = await db
      .select()
      .from(schema.knowledgeDocumentSourceRanges)
      .where(eq(schema.knowledgeDocumentSourceRanges.documentId, guide.id));
    expect(memberships.map((membership) => membership.rangeId)).toEqual(rangeIds);

    const read = await readDocument(fixtureBase, guide.id);
    expect(read.markdown).toContain('lark-export-marker-2048');
    const search = await searchDocuments(fixtureBase, 'lark-export-marker-2048');
    expect(search.hits.map((hit) => hit.documentId)).toContain(guide.id);
  });

  it('keeps Notion markdown/properties on the same hash without creating a second version', async () => {
    handler = notionHandler(() => 'complete');

    const fixtureBase = await makeBase();
    const input = knowledgeSourceInputSchema.parse({
      type: 'notion',
      name: 'notion page',
      config: {},
      secrets: { apiKey: NOTION_TOKEN },
      ranges: [{ kind: 'notion_page', externalId: NOTION_ROOT }],
    });
    const { sourceId } = await makeSource(fixtureBase, input);

    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('notion document missing');
    expect(document.title).toBe('Guide');
    expect(document.status).toBe('ready');
    const firstVersionId = document.currentVersionId;
    const firstChunks = await chunkContents(document.id);
    expect(firstChunks.join('\n')).toContain('- Tags: alpha, beta');
    expect(firstChunks.join('\n')).toContain('- Score: 42');
    expect(firstChunks.join('\n')).toContain('Root body');

    const read = await readDocument(fixtureBase, document.id);
    expect(read.markdown).toContain('Root body');
    const search = await searchDocuments(fixtureBase, 'Root body');
    expect(search.hits.map((hit) => hit.documentId)).toContain(document.id);

    await runSyncJob(fixtureBase, sourceId);
    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.currentVersionId).toBe(firstVersionId);
    expect(after?.contentHash).toBe(document.contentHash);
    expect(await versionsOf(document.id)).toHaveLength(1);
    expect((await chunkContents(document.id)).map((chunk) => chunk)).toEqual(firstChunks);
  });

  it('does not infer deletion from a page-two unknown partial enumeration', async () => {
    const mode: { value: 'complete' | 'partial' } = { value: 'complete' };
    handler = notionHandler(() => mode.value);

    const fixtureBase = await makeBase();
    const input = knowledgeSourceInputSchema.parse({
      type: 'notion',
      name: 'notion partial',
      config: { syncDeletions: true },
      secrets: { apiKey: NOTION_TOKEN },
      ranges: [{ kind: 'notion_page', externalId: NOTION_ROOT }],
    });
    const { sourceId } = await makeSource(fixtureBase, input);

    await runSyncJob(fixtureBase, sourceId);
    const child = (await documentsOfBase(fixtureBase)).find(
      (document) => document.sourcePath === 'Guide/Child.md',
    );
    if (!child) throw new Error('child document missing');
    expect(child.status).toBe('ready');
    const childVersionId = child.currentVersionId;

    mode.value = 'partial';
    // 未知/不完整枚举记为不可重试 skipped，整轮仍结束但 complete=false，不能据此撤旧。
    await runSyncJob(fixtureBase, sourceId);

    const after = await repo.knowledge.getDocument(db, child.id);
    expect(after?.status).toBe('ready');
    expect(after?.disabledReason).toBeNull();
    expect(after?.currentVersionId).toBe(childVersionId);
    const search = await searchDocuments(fixtureBase, 'Child body');
    expect(search.hits.map((hit) => hit.documentId)).toContain(child.id);
  });

  it('disables stale documents only after a complete syncDeletions round and keeps manual disables', async () => {
    const round: { value: 1 | 2 } = { value: 1 };
    handler = seafileHandler(round);

    const fixtureBase = await makeBase();
    const input = knowledgeSourceInputSchema.parse({
      type: 'seafile',
      name: 'seafile documents',
      config: { baseUrl: SEAFILE_SITE, syncDeletions: true },
      secrets: { apiToken: '{{SECRET_vyfaoqfj}}' },
      ranges: [{ kind: 'seafile_repo', externalId: REPO, paths: ['Documents'] }],
    });
    const { sourceId, rangeIds } = await makeSource(fixtureBase, input);
    const [range] = await repo.knowledge.listRanges(db, sourceId);
    expect(range?.paths).toEqual(['Documents']);

    await runSyncJob(fixtureBase, sourceId);
    const first = await documentsOfBase(fixtureBase);
    expect(first.map((document) => document.sourcePath).sort()).toEqual([
      'Documents/Sub/notes.md',
      'Documents/keep.md',
      'Documents/manual.md',
      'Documents/notes.md',
      'Documents/stale.md',
    ]);
    const rootNotes = first.find((document) => document.sourcePath === 'Documents/notes.md');
    const subNotes = first.find((document) => document.sourcePath === 'Documents/Sub/notes.md');
    if (!rootNotes || !subNotes) throw new Error('same-name notes documents missing');
    expect(rootNotes.title).toBe('notes.md');
    expect(subNotes.title).toBe('notes.md');
    expect(rootNotes.id).not.toBe(subNotes.id);
    expect(rootNotes.sourceType).toBe('seafile');

    const manual = first.find((document) => document.sourcePath === 'Documents/manual.md');
    if (!manual) throw new Error('manual document missing');
    await repo.knowledge.updateDocument(db, manual.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });

    round.value = 2;
    await runSyncJob(fixtureBase, sourceId);

    const after = await repo.knowledge.getDocument(db, rootNotes.id);
    expect(after?.status).toBe('ready');
    expect(after?.currentVersionId).toBe(rootNotes.currentVersionId);
    expect((await repo.knowledge.getDocument(db, subNotes.id))?.id).toBe(subNotes.id);
    expect((await repo.knowledge.getDocument(db, subNotes.id))?.status).toBe('ready');

    const stale = first.find((document) => document.sourcePath === 'Documents/stale.md');
    if (!stale) throw new Error('stale document missing');
    const disabledStale = await repo.knowledge.getDocument(db, stale.id);
    expect(disabledStale?.status).toBe('disabled');
    expect(disabledStale?.disabledReason).toBe('source');

    const disabledManual = await repo.knowledge.getDocument(db, manual.id);
    expect(disabledManual?.status).toBe('disabled');
    expect(disabledManual?.disabledReason).toBe('manual');

    const keep = first.find((document) => document.sourcePath === 'Documents/keep.md');
    if (!keep) throw new Error('keep document missing');
    const read = await readDocument(fixtureBase, keep.id);
    expect(read.markdown).toContain('keep-marker-2048');
    expect(
      (await searchDocuments(fixtureBase, 'keep-marker-2048')).hits.map((hit) => hit.documentId),
    ).toContain(keep.id);
    expect(
      (await searchDocuments(fixtureBase, 'stale-marker-2048')).hits.map((hit) => hit.documentId),
    ).not.toContain(stale.id);

    const apiCalls = calls.filter((call) => call.url.pathname.startsWith('/api2/'));
    for (const call of apiCalls) {
      expect(call.headers.get('authorization')).toBe('Bearer {{SECRET_vyfaoqfj}}');
    }
    expect(
      apiCalls
        .filter((call) => call.url.pathname.endsWith('/dir/'))
        .map((call) => call.url.searchParams.get('p'))
        .sort(),
    ).toEqual(['/Documents', '/Documents', '/Documents/Sub', '/Documents/Sub']);
    for (const call of calls.filter((call) => call.url.pathname.startsWith('/files/'))) {
      expect(call.headers.get('authorization')).toBeNull();
    }
    const memberships = await db
      .select()
      .from(schema.knowledgeDocumentSourceRanges)
      .where(eq(schema.knowledgeDocumentSourceRanges.documentId, keep.id));
    expect(memberships.map((membership) => membership.rangeId)).toEqual(rangeIds);
  });
});

const NOTION_ROOT = '11111111-1111-4111-8111-111111111111';
const NOTION_CHILD = '22222222-2222-4222-8222-222222222222';

type NotionBlocks = {
  childOnly: unknown;
  partialPage1: unknown;
  incompletePage2: unknown;
};

function notionHandler(mode: () => 'complete' | 'partial'): FetchHandler {
  const pageRoot = fixture('notion/page-root.json');
  const pageChild = fixture('notion/page-child.json');
  const markdownRoot = fixture('notion/markdown-root.json');
  const markdownChild = fixture('notion/markdown-child.json');
  const blocksEmpty = fixture('notion/blocks-empty.json');
  const blocks = fixture<NotionBlocks>('integration/notion-blocks.json');
  const titleItems = (text: string) => ({
    object: 'list',
    type: 'property_item',
    property_item: { id: 'title', type: 'title', next_url: null },
    results: [
      {
        object: 'property_item',
        id: 'title',
        type: 'title',
        title: { type: 'text', text: { content: text, link: null }, plain_text: text, href: null },
      },
    ],
    has_more: false,
    next_cursor: null,
  });

  return (url) => {
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/pages/${NOTION_ROOT}`) return json(pageRoot);
    if (path === `/v1/pages/${NOTION_ROOT}/properties/title`) return json(titleItems('Guide'));
    if (path === `/v1/pages/${NOTION_ROOT}/markdown`) return json(markdownRoot);
    if (path === `/v1/pages/${NOTION_CHILD}`) return json(pageChild);
    if (path === `/v1/pages/${NOTION_CHILD}/properties/title`) return json(titleItems('Child'));
    if (path === `/v1/pages/${NOTION_CHILD}/markdown`) return json(markdownChild);
    if (path === `/v1/blocks/${NOTION_CHILD}/children`) return json(blocksEmpty);
    if (path === `/v1/blocks/${NOTION_ROOT}/children`) {
      if (mode() === 'partial') {
        return json(
          url.searchParams.get('start_cursor') === 'p2'
            ? blocks.incompletePage2
            : blocks.partialPage1,
        );
      }
      return json(blocks.childOnly);
    }
    throw new Error(`unexpected notion request ${url.href}`);
  };
}

function seafileHandler(round: { value: 1 | 2 }): FetchHandler {
  const contents = new Map<string, string>([
    ['Documents/keep.md', 'keep-marker-2048'],
    ['Documents/stale.md', 'stale-marker-2048'],
    ['Documents/manual.md', 'manual-marker-2048'],
    ['Documents/notes.md', 'notes-root-marker-2048'],
    ['Documents/Sub/notes.md', 'notes-sub-marker-2048'],
  ]);
  const entry = (path: string) => ({
    type: 'file',
    name: path.split('/').at(-1) ?? path,
    size: Buffer.byteLength(contents.get(path) ?? '', 'utf8'),
    mtime: 10,
    id: `oid-${path}`,
  });
  const documentsRoundOne = [
    entry('Documents/keep.md'),
    entry('Documents/stale.md'),
    entry('Documents/manual.md'),
    entry('Documents/notes.md'),
    { type: 'dir', name: 'Sub' },
  ];
  const documentsRoundTwo = [
    entry('Documents/keep.md'),
    entry('Documents/notes.md'),
    { type: 'dir', name: 'Sub' },
  ];

  return (url) => {
    const path = decodeURIComponent(url.pathname);
    if (path === `/api2/repos/${REPO}/dir/`) {
      const target = url.searchParams.get('p');
      if (target === '/Documents') {
        return json(round.value === 1 ? documentsRoundOne : documentsRoundTwo);
      }
      if (target === '/Documents/Sub') return json([entry('Documents/Sub/notes.md')]);
      throw new Error(`unexpected seafile directory ${target ?? ''}`);
    }
    if (path === `/api2/repos/${REPO}/file/`) {
      const target = (url.searchParams.get('p') ?? '').replace(/^\//, '');
      if (!contents.has(target)) throw new Error(`unexpected seafile file ${target}`);
      return new Response(JSON.stringify(`${SEAFILE_SITE}/files/${target}`), {
        status: 200,
        headers: { 'content-type': 'application/json', oid: `oid-${target}` },
      });
    }
    if (path.startsWith('/files/')) {
      const target = path.slice('/files/'.length);
      const content = contents.get(target);
      if (content === undefined) throw new Error(`unexpected seafile bytes ${target}`);
      return fileResponse(Buffer.from(content, 'utf8'), `oid-${target}`);
    }
    throw new Error(`unexpected seafile request ${url.href}`);
  };
}
