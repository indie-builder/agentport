import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { KnowledgeFaq, KnowledgeFaqTransferEntry } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeConnectors } from '../../worker/src/knowledge/connector-adapter.js';
import type { KnowledgeDeps } from '../../worker/src/knowledge/ingestion.js';
import { createParsingAdapter } from '../../worker/src/knowledge/parsing-adapter.js';
import { dispatchKnowledgeJob } from '../../worker/src/knowledge/queue.js';
import { buildKnowledgeServer } from '../src/features/knowledge/mcp.js';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;
/** 2026 现代协议入口；每个请求自带版本/方法/工具名头，无需 initialize 会话。 */
const MCP_PROTOCOL_VERSION = '2026-07-28';

type SearchHit = {
  documentId: string;
  versionId: string;
  target: { kind: 'document' | 'faq' | 'wiki'; id: string };
  targetVersionId: string;
  title: string;
  quote: string;
  locator: Record<string, unknown> | null;
  faq: {
    answers: string[];
    answerStrategy: 'all' | 'random';
    isRecommended: boolean;
    matchedQuestion: string;
    questionKind: 'standard' | 'similar';
  } | null;
};

interface McpCallResult {
  isError: boolean;
  text: string;
  json: unknown;
}

interface VersionsPayload {
  items: Array<{
    id: string;
    isCurrent: boolean;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    parseStatus: string;
    metadata: Record<string, unknown>;
  }>;
}

interface FaqDetail {
  document: { id: string; status: string; currentVersionId: string | null };
  draftVersion: { id: string; faq: KnowledgeFaq } | null;
  publishedVersion: { id: string; faq: KnowledgeFaq } | null;
  faq: KnowledgeFaq | null;
}

interface FaqImportResponse {
  dryRun: boolean;
  mode: 'append' | 'replace';
  committed: boolean;
  importBatchId: string | null;
  counts: {
    total: number;
    success: number;
    failed: number;
    partialFailed: number;
    skipped: number;
    added: number;
    merged: number;
  };
  results: Array<{
    row: number;
    status: 'success' | 'failed' | 'partial_failed' | 'skipped';
    documentId?: string;
    expectedVersionId?: string | null;
    jobId?: string;
  }>;
}

const faqStandard: KnowledgeFaq = {
  question: 'How do I reset my account credential?',
  similarQuestions: ['forgot my access key help'],
  negativeQuestions: ['delete my account permanently'],
  answers: ['Open settings and use reset.'],
  answerStrategy: 'all',
  isRecommended: true,
};

const faqUpdated: KnowledgeFaq = {
  ...faqStandard,
  answers: ['Open settings and use reset.', 'Ask an administrator if it still fails.'],
};

const importAppendItems: KnowledgeFaqTransferEntry[] = [
  {
    question: 'importappendone marker question',
    similarQuestions: [],
    negativeQuestions: [],
    answers: ['append answer one'],
    answerStrategy: 'all',
    isRecommended: true,
    enabled: true,
  },
  {
    question: 'importappendtwo marker question',
    similarQuestions: [],
    negativeQuestions: [],
    answers: ['append answer two'],
    answerStrategy: 'all',
    isRecommended: true,
    enabled: true,
  },
];

const importReplaceItems: KnowledgeFaqTransferEntry[] = [
  {
    question: 'replacenewone marker question',
    similarQuestions: [],
    negativeQuestions: [],
    answers: ['replace answer one'],
    answerStrategy: 'all',
    isRecommended: true,
    enabled: true,
  },
  {
    question: 'replacenewtwo marker question',
    similarQuestions: [],
    negativeQuestions: [],
    answers: ['replace answer two'],
    answerStrategy: 'all',
    isRecommended: true,
    enabled: true,
  },
];

/** 现 core 单测已认作的合法 WAV 原件；整链只上传这一份真实字节。 */
const TONE_WAV = await readFile(
  new URL('../../core/test/fixtures/audio/tone.wav', import.meta.url),
);
const TONE_WAV_SHA256 = createHash('sha256').update(TONE_WAV).digest('hex');

const AUDIO_SEGMENTED_MARKDOWN = '你好，世界。\n\n重复句\n\n重复句 😀\n\naudiomarker 收尾。';
const AUDIO_TEXT_ONLY = 'textonlymarker 只有正文，没有段级时码。';
/** 重复句按拼接位置各算一次偏移；空白段不产块，emoji 占两个 UTF-16 单元。 */
const AUDIO_SEGMENTS = [
  { startOffset: 0, endOffset: 6, timeFromMs: 0, timeToMs: 1250 },
  { startOffset: 8, endOffset: 11, timeFromMs: 1250, timeToMs: 2500 },
  { startOffset: 13, endOffset: 19, timeFromMs: 3000, timeToMs: 4750 },
  { startOffset: 21, endOffset: 36, timeFromMs: 4750, timeToMs: 6000 },
];
const AUDIO_CHUNK_LOCATOR = {
  startOffset: 0,
  endOffset: 36,
  timeFromMs: 0,
  timeToMs: 6000,
};

/**
 * 极简 multipart 解析只服务本地 fixture 响应：实际请求由 core 原生 FormData 生成，
 * 这里读回 boundary、字段与文件字节，证明链路没被替身绕过。
 */
function parseMultipart(
  body: Buffer,
  contentType: string,
): Array<{ headers: Record<string, string>; body: Buffer }> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) throw new Error('multipart boundary missing');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ headers: Record<string, string>; body: Buffer }> = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString('latin1') === '--') break;
    if (body.subarray(start, start + 2).toString('latin1') === '\r\n') start += 2;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    let end = next;
    if (body.subarray(end - 2, end).toString('latin1') === '\r\n') end -= 2;
    const part = body.subarray(start, end);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) throw new Error('multipart part has no header separator');
    const headers = Object.fromEntries(
      part
        .subarray(0, headerEnd)
        .toString('utf8')
        .split('\r\n')
        .filter(Boolean)
        .map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as [
            string,
            string,
          ];
        }),
    );
    parts.push({ headers, body: part.subarray(headerEnd + 4) });
    cursor = next;
  }
  if (parts.length === 0) throw new Error('multipart has no parts');
  return parts;
}

/** 附件 fixture：embedding/rerank 与 RSS 全文都走真实本地 HTTP。 */
function vectorFor(text: string): number[] {
  // 每个场景标记占一维，互不相似的文本向量正交；基线维避免零向量。
  const markers = [
    'wikimarker',
    'revokemarker',
    'forgot',
    'sourcearticlemarker',
    'alphamarker',
    'betamarker',
    'importappendone',
    'replacenewone',
    'audiomarker',
    'textonlymarker',
  ];
  const vector = Array.from({ length: 1024 }, () => 0);
  for (const [index, marker] of markers.entries()) {
    if (text.includes(marker)) vector[index] = 1;
  }
  vector[100] = 0.01;
  return vector;
}

interface AsrLatch {
  reached: Promise<void>;
  gate: Promise<void>;
  markReached: () => void;
  release: () => void;
}

describe.skipIf(!ready)(
  'knowledge publishing integration (REST + worker + DB + search/MCP)',
  () => {
    let app: FastifyInstance;
    let cookie = '';
    let knowledgeDir = '';
    let fixture: Server;
    let fixtureUrl = '';
    let embeddingCalls = 0;
    let asrCalls = 0;
    let lastAsr: {
      contentType: string;
      model: string;
      responseFormat: string;
      granularities: string;
      filename: string;
      fileSha256: string;
    } | null = null;
    let asrLatch: AsrLatch | null = null;
    const baseIds: string[] = [];
    const profileIds: string[] = [];

    const parsing = createParsingAdapter();
    /** worker 依赖；解密在测试里只服务无密钥 profile。 */
    const workerDeps: Omit<KnowledgeDeps, 'db' | 'logger'> = {
      knowledgeDir: '',
      parse: parsing.parse,
      chunkMarkdown: parsing.chunkMarkdown,
      connectors: knowledgeConnectors,
      decrypt: () => ({}),
      allowLoopback: true,
    };

    /** 让转录请求停在响应前，测试可在真实请求进行中改绑定。 */
    function armAsrLatch(): AsrLatch {
      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const latch = { reached, gate, markReached, release };
      asrLatch = latch;
      return latch;
    }

    async function handleFixture(raw: Buffer, request: IncomingMessage, response: ServerResponse) {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      const respond = (status: number, body: unknown, type = 'application/json') => {
        response.writeHead(status, { 'content-type': type });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const text = () => raw.toString('utf8');
      if (path === '/embeddings') {
        embeddingCalls += 1;
        const { input } = JSON.parse(text()) as { input: string[] };
        respond(200, {
          data: input.map((value, index) => ({ index, embedding: vectorFor(value) })),
        });
        return;
      }
      if (path === '/rerank') {
        const { documents } = JSON.parse(text()) as { documents: string[] };
        respond(200, {
          results: documents.map((_document, index) => ({
            index,
            score: documents.length - index,
          })),
        });
        return;
      }
      if (path === '/asr-transcriptions') {
        asrCalls += 1;
        const contentType = request.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
          respond(400, { error: 'expected multipart/form-data' });
          return;
        }
        let parts: ReturnType<typeof parseMultipart>;
        try {
          parts = parseMultipart(raw, contentType);
        } catch (err) {
          respond(400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const dispositionOf = (part: (typeof parts)[number]) =>
          part.headers['content-disposition'] ?? '';
        const fieldOf = (name: string) =>
          parts
            .find((part) => dispositionOf(part).includes(`name="${name}"`))
            ?.body.toString('utf8') ?? '';
        const filePart = parts.find((part) => dispositionOf(part).includes('name="file"'));
        const filenamePart = filePart ?? parts[0];
        const filename = filenamePart
          ? (/filename="([^"]*)"/.exec(dispositionOf(filenamePart))?.[1] ?? '')
          : '';
        lastAsr = {
          contentType,
          model: fieldOf('model'),
          responseFormat: fieldOf('response_format'),
          granularities: fieldOf('timestamp_granularities[]'),
          filename,
          fileSha256: createHash('sha256')
            .update(filePart?.body ?? Buffer.alloc(0))
            .digest('hex'),
        };
        const latch = asrLatch;
        if (latch) {
          asrLatch = null;
          latch.markReached();
          await latch.gate;
        }
        // 文件名决定返回形态：真实文件字节始终是同一份 tone.wav。
        if (filename.includes('textonly')) {
          respond(200, { text: AUDIO_TEXT_ONLY, duration: 3.2 });
          return;
        }
        respond(200, {
          text: AUDIO_SEGMENTED_MARKDOWN,
          duration: 6,
          segments: [
            { start: 0, end: 1.25, text: '你好，世界。' },
            { start: 1.25, end: 2.5, text: '重复句' },
            { start: 2.5, end: 3, text: '   ' },
            { start: 3, end: 4.75, text: '重复句 😀' },
            { start: 4.75, end: 6, text: 'audiomarker 收尾。' },
          ],
        });
        return;
      }
      if (path === '/feed') {
        respond(
          200,
          `<rss version="2.0"><channel><title>Integration Feed</title><item>` +
            `<guid>post-1</guid><title>Source Article</title>` +
            `<link>${fixtureUrl}/article</link>` +
            `<description>feed summary</description>` +
            `</item></channel></rss>`,
          'application/rss+xml',
        );
        return;
      }
      if (path === '/article') {
        respond(
          200,
          '<html><body><article><p>sourcearticlemarker full text body</p></article></body></html>',
          'text/html',
        );
        return;
      }
      respond(404, { error: 'not found' });
    }

    beforeAll(async () => {
      fixture = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          void handleFixture(Buffer.concat(chunks), request, response).catch((err: unknown) => {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            );
          });
        });
      });
      await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
      fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-publishing-'));
      workerDeps.knowledgeDir = knowledgeDir;
      app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
      cookie = await loginCookie(app);
    });

    afterAll(async () => {
      if (baseIds.length > 0) {
        await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
      }
      if (profileIds.length > 0) {
        await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
          profileIds,
        ]);
      }
      await app.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(knowledgeDir, { recursive: true, force: true });
    });

    async function createEmbeddingProfile(): Promise<string> {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/knowledge/model-profiles',
        headers: { cookie },
        payload: {
          kind: 'embedding',
          name: unique('integration-emb'),
          endpointUrl: fixtureUrl,
          model: 'fixture-embed',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ id: string }>().id;
      profileIds.push(id);
      return id;
    }

    async function createAsrProfile(): Promise<{ id: string; name: string }> {
      const name = unique('integration-asr');
      const res = await inject(app, {
        method: 'POST',
        url: '/api/knowledge/model-profiles',
        headers: { cookie },
        payload: {
          kind: 'asr',
          name,
          endpointUrl: `${fixtureUrl}/asr-transcriptions`,
          model: 'fixture-whisper',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      profileIds.push(res.json<{ id: string }>().id);
      return { id: res.json<{ id: string }>().id, name };
    }

    async function createBase(
      options: { asrProfileId?: string } = {},
    ): Promise<{ id: string; serverId: string }> {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/knowledge/bases',
        headers: { cookie },
        payload: {
          slug: unique('integration-kb'),
          name: '集成知识库',
          embeddingProfileId: await createEmbeddingProfile(),
          ...(options.asrProfileId === undefined ? {} : { asrProfileId: options.asrProfileId }),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const base = res.json<{ id: string; serverId: string }>();
      baseIds.push(base.id);
      return base;
    }

    /**
     * API 创建的 job 仍留在测试独享 Redis 里（没有知识 worker 消费）；
     * 这里用真实 repo 认领并从 worker 真实入口执行，终态也用真实 finishJob 写入。
     */
    async function runJob(jobId: string, parse = workerDeps.parse): Promise<void> {
      const claimed = await repo.knowledge.claimJob(app.db, jobId);
      if (!claimed) throw new Error(`job ${jobId} is not queued`);
      const controller = new AbortController();
      try {
        const result = await dispatchKnowledgeJob(claimed, {
          db: app.db,
          logger: app.log,
          ...workerDeps,
          parse,
          signal: controller.signal,
        });
        const finished = await repo.knowledge.finishJob(app.db, claimed.id, {
          status: 'succeeded',
          ...result,
        });
        if (!finished) throw new Error(`job ${jobId} finish was refused`);
      } catch (err) {
        await repo.knowledge.finishJob(app.db, claimed.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    async function jobPayload(jobId: string): Promise<Record<string, unknown>> {
      const job = await repo.knowledge.getJob(app.db, jobId);
      expect(job, `job ${jobId} missing`).not.toBeNull();
      return job?.payload ?? {};
    }

    async function search(
      baseId: string,
      q: string,
      kinds: Array<'document' | 'faq' | 'wiki'> = ['document'],
    ) {
      const params = new URLSearchParams({ q, limit: '10', rerank: 'false' });
      for (const kind of kinds) params.append('kinds', kind);
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${baseId}/search?${params.toString()}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ hits: SearchHit[]; degraded: boolean }>();
    }

    async function faqSearch(baseId: string, q: string) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/faqs/test`,
        headers: { cookie },
        payload: { q, limit: 10, rerank: false },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ hits: SearchHit[] }>();
    }

    /**
     * 直接调用 MCP handler 的 fetch 入口：现代协议头表明请求版本与工具，
     * 不经过 HTTP 授权路由，但 tools/call 走与线上完全相同的 handler 实现。
     */
    async function mcpCall(
      baseId: string,
      serverId: string,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<McpCallResult> {
      const handler = buildKnowledgeServer({
        db: app.db,
        baseId,
        serverId,
        runId: 'run_integration',
        secretKey: app.config.APP_SECRET_KEY,
        knowledgeDir,
      });
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp/integration', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': tool,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: tool,
              arguments: args,
              // 2026 协议要求每个请求携带版本与客户端能力信封。
              _meta: {
                'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
      );
      const body = await response.text();
      const rpc =
        body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
          .at(-1) ?? (JSON.parse(body) as Record<string, unknown>);
      const result = rpc.result as
        | { isError?: boolean; content?: Array<{ type: string; text?: string }> }
        | undefined;
      if (result === undefined) {
        return { isError: true, text: JSON.stringify(rpc.error ?? rpc), json: rpc };
      }
      const text = result.content?.find((entry) => entry.type === 'text')?.text ?? '';
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // 错误结果不是 JSON；保留原始文本给调用方断言。
      }
      return { isError: result.isError === true, text, json };
    }

    async function manualDetail(documentId: string) {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/manual`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ content: string; versionId: string; status: 'draft' | 'published' }>();
    }

    async function faqDetail(documentId: string): Promise<FaqDetail> {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/faqs/${documentId}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<FaqDetail>();
    }

    async function documentVersions(documentId: string): Promise<VersionsPayload> {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/versions?limit=50`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<VersionsPayload>();
    }

    async function documentState(documentId: string) {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ id: string; status: string; currentVersionId: string | null }>();
    }

    /** 真实 base64 上传入口；音频字节固定为现 core 已认作合法的 tone.wav。 */
    async function uploadAudio(baseId: string, filename: string) {
      const res = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/bases/${baseId}/documents/upload`,
        headers: { cookie },
        payload: {
          filename,
          mimeType: 'audio/wav',
          dataBase64: TONE_WAV.toString('base64'),
        },
      });
      expect(res.statusCode, res.body).toBe(202);
      return res.json<{ documentId: string; jobId: string }>();
    }

    async function faqImport(
      baseId: string,
      input: { items: KnowledgeFaqTransferEntry[]; mode: 'append' | 'replace'; dryRun: boolean },
    ) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/faqs/import`,
        headers: { cookie },
        payload: {
          format: 'json',
          content: JSON.stringify({ items: input.items }),
          mode: input.mode,
          dryRun: input.dryRun,
        },
      });
      return res;
    }

    async function recursiveFileCount(dir: string): Promise<number> {
      let count = 0;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        count += entry.isDirectory() ? await recursiveFileCount(join(dir, entry.name)) : 1;
      }
      return count;
    }

    async function writeSnapshot(baseId: string) {
      const counts = await app.pool.query<{
        documents: string;
        versions: string;
        jobs: string;
      }>(
        `select
         (select count(*) from knowledge_documents where base_id = $1) as documents,
         (select count(*) from knowledge_document_versions v
            join knowledge_documents d on d.id = v.document_id
            where d.base_id = $1) as versions,
         (select count(*) from knowledge_jobs where base_id = $1) as jobs`,
        [baseId],
      );
      return {
        documents: Number(counts.rows[0]?.documents ?? 0),
        versions: Number(counts.rows[0]?.versions ?? 0),
        jobs: Number(counts.rows[0]?.jobs ?? 0),
        files: await recursiveFileCount(knowledgeDir),
        embeddingCalls,
      };
    }

    async function wikiIndexJobId(baseId: string, pageId: string): Promise<string> {
      const row = await app.pool.query<{ id: string }>(
        `select j.id
       from knowledge_jobs j
       join knowledge_documents d on d.id = j.document_id
       where j.base_id = $1
         and j.type = 'ingest'
         and d.metadata ->> 'wikiPageId' = $2
       order by j.created_at desc
       limit 1`,
        [baseId, pageId],
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error(`wiki index job missing for page ${pageId}`);
      return id;
    }

    async function createManualDraft(
      baseId: string,
      content: string,
      title = '手写集成稿',
    ): Promise<{ documentId: string; jobId: string; versionId: string }> {
      const created = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/documents/manual`,
        headers: { cookie },
        payload: { title, content },
      });
      expect(created.statusCode, created.body).toBe(202);
      const { documentId, jobId } = created.json<{ documentId: string; jobId: string }>();
      expect(await jobPayload(jobId)).toMatchObject({ type: 'ingest', publish: 'draft' });
      await runJob(jobId);
      expect((await repo.knowledge.getJob(app.db, jobId))?.status).toBe('succeeded');
      const versionId = (await documentVersions(documentId)).items[0]?.id;
      if (!versionId) throw new Error('draft version missing');
      return { documentId, jobId, versionId };
    }

    async function publishManual(
      documentId: string,
      versionId: string,
      expectedVersionId: string | null,
    ) {
      const response = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${documentId}/publish`,
        headers: { cookie },
        payload: { versionId, expectedVersionId },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    it('manual draft stays unreadable until publish, then search and MCP read expose it', async () => {
      const base = await createBase();
      const draft = await createManualDraft(
        base.id,
        '# Manual\n\nalphamarker first published body',
      );

      expect((await search(base.id, 'alphamarker', ['document'])).hits).toHaveLength(0);
      const draftRead = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: draft.documentId },
      });
      expect(draftRead.isError).toBe(true);
      expect(draftRead.text).toContain('DOCUMENT_NOT_FOUND');

      await publishManual(draft.documentId, draft.versionId, null);
      expect(
        (await search(base.id, 'alphamarker', ['document'])).hits.map((hit) => hit.documentId),
      ).toContain(draft.documentId);
      const publishedRead = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: draft.documentId },
      });
      expect(publishedRead.isError).toBe(false);
      expect((publishedRead.json as { markdown: string }).markdown).toContain('alphamarker');
    });

    it('manual update keeps the published version until publish, then rollback restores it', async () => {
      const base = await createBase();
      const first = await createManualDraft(
        base.id,
        '# Manual\n\nalphamarker first published body',
      );
      await publishManual(first.documentId, first.versionId, null);

      const update = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/documents/${first.documentId}/manual`,
        headers: { cookie },
        payload: {
          content: '# Manual\n\nbetamarker second draft body',
          expectedVersionId: first.versionId,
        },
      });
      expect(update.statusCode, update.body).toBe(202);
      const updateJobId = update.json<{ jobId: string }>().jobId;
      await runJob(updateJobId);

      const draft = await manualDetail(first.documentId);
      expect(draft).toMatchObject({ status: 'draft' });
      expect(draft.content).toContain('betamarker');
      // 新草稿未发布：旧版本仍可检索/读取，新内容不可见。
      expect(
        (await search(base.id, 'alphamarker', ['document'])).hits.map((hit) => hit.documentId),
      ).toContain(first.documentId);
      expect((await search(base.id, 'betamarker', ['document'])).hits).toHaveLength(0);
      const stillOld = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: first.documentId },
      });
      expect((stillOld.json as { markdown: string }).markdown).toContain('alphamarker');

      await publishManual(first.documentId, draft.versionId, first.versionId);
      expect(
        (await search(base.id, 'betamarker', ['document'])).hits.map((hit) => hit.documentId),
      ).toContain(first.documentId);
      expect((await search(base.id, 'alphamarker', ['document'])).hits).toHaveLength(0);

      const rollback = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${first.documentId}/rollback`,
        headers: { cookie },
        payload: { versionId: first.versionId, expectedVersionId: draft.versionId },
      });
      expect(rollback.statusCode, rollback.body).toBe(200);
      expect(
        (await search(base.id, 'alphamarker', ['document'])).hits.map((hit) => hit.documentId),
      ).toContain(first.documentId);
      expect((await search(base.id, 'betamarker', ['document'])).hits).toHaveLength(0);
      const rolledBack = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: first.documentId },
      });
      expect((rolledBack.json as { markdown: string }).markdown).toContain('alphamarker');
    });

    it('FAQ create and update index their own draft versions, then publish exposes the similar-question match', async () => {
      const base = await createBase();
      const created = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/faqs`,
        headers: { cookie },
        payload: { faq: faqStandard },
      });
      expect(created.statusCode, created.body).toBe(202);
      const { documentId, jobId } = created.json<{ documentId: string; jobId: string }>();
      const firstDraft = (await faqDetail(documentId)).draftVersion?.id;
      if (!firstDraft) throw new Error('first FAQ draft missing');
      expect(await jobPayload(jobId)).toMatchObject({ type: 'ingest', versionId: firstDraft });
      await runJob(jobId);
      expect((await repo.knowledge.getJob(app.db, jobId))?.status).toBe('succeeded');

      const updated = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/faqs/${documentId}`,
        headers: { cookie },
        payload: { faq: faqUpdated, expectedVersionId: firstDraft },
      });
      expect(updated.statusCode, updated.body).toBe(202);
      const updateJobId = updated.json<{ jobId: string }>().jobId;
      const secondDraft = (await faqDetail(documentId)).draftVersion?.id;
      if (!secondDraft) throw new Error('second FAQ draft missing');
      expect(await jobPayload(updateJobId)).toMatchObject({
        type: 'ingest',
        versionId: secondDraft,
      });
      await runJob(updateJobId);

      const beforePublish = await faqSearch(base.id, 'forgot my access key help');
      expect(beforePublish.hits).toHaveLength(0);

      const published = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/faqs/${documentId}/publish`,
        headers: { cookie },
        payload: { versionId: secondDraft, expectedVersionId: null },
      });
      expect(published.statusCode, published.body).toBe(200);

      const result = await faqSearch(base.id, 'forgot my access key help');
      const hit = result.hits.find((entry) => entry.documentId === documentId);
      expect(hit).toBeDefined();
      expect(hit?.target).toEqual({ kind: 'faq', id: documentId });
      expect(hit?.faq).toMatchObject({
        matchedQuestion: 'forgot my access key help',
        questionKind: 'similar',
        answers: faqUpdated.answers,
        answerStrategy: 'all',
        isRecommended: true,
      });
    });

    it('FAQ import dryRun writes no database rows, files, jobs, or embeddings', async () => {
      const base = await createBase();
      const before = await writeSnapshot(base.id);
      const dryRun = await faqImport(base.id, {
        items: importAppendItems,
        mode: 'append',
        dryRun: true,
      });
      expect(dryRun.statusCode, dryRun.body).toBe(200);
      expect(dryRun.json<FaqImportResponse>()).toMatchObject({
        dryRun: true,
        committed: false,
        importBatchId: null,
        counts: { total: 2, added: 2, failed: 0 },
      });
      expect(await writeSnapshot(base.id)).toEqual(before);
    });

    it('FAQ append indexes through the worker and replace atomically swaps the set', async () => {
      const base = await createBase();
      const appended = await faqImport(base.id, {
        items: importAppendItems,
        mode: 'append',
        dryRun: false,
      });
      expect(appended.statusCode, appended.body).toBe(202);
      const appendBody = appended.json<FaqImportResponse>();
      expect(appendBody).toMatchObject({ committed: true, counts: { added: 2 } });
      if (!appendBody.importBatchId) throw new Error('append batch id missing');

      const appendPublishItems: Array<{
        documentId: string;
        versionId: string;
        expectedVersionId: string | null;
      }> = [];
      for (const result of appendBody.results) {
        if (!result.documentId || !result.jobId) continue;
        await runJob(result.jobId);
        const detail = await faqDetail(result.documentId);
        const versionId = detail.draftVersion?.id;
        if (!versionId) throw new Error('appended FAQ draft missing');
        appendPublishItems.push({
          documentId: result.documentId,
          versionId,
          expectedVersionId: result.expectedVersionId ?? null,
        });
      }
      const appendPublished = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/faqs/batch`,
        headers: { cookie },
        payload: {
          action: 'publish',
          items: appendPublishItems,
          importBatchId: appendBody.importBatchId,
        },
      });
      expect(appendPublished.statusCode, appendPublished.body).toBe(200);
      expect((await faqSearch(base.id, 'importappendone marker question')).hits).toHaveLength(1);

      // replace 校验失败：整批零写入，旧 FAQ 仍是线上可读集合。
      const conflicting = JSON.stringify({
        items: [
          { ...importAppendItems[0], answers: ['first replacement answer'] },
          { ...importAppendItems[0], answers: ['second replacement answer'] },
        ],
      });
      const failedReplace = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/faqs/import`,
        headers: { cookie },
        payload: { format: 'json', content: conflicting, mode: 'replace', dryRun: false },
      });
      expect(failedReplace.statusCode, failedReplace.body).toBe(200);
      expect(failedReplace.json<FaqImportResponse>()).toMatchObject({
        committed: false,
        importBatchId: null,
        counts: { failed: 1 },
      });
      expect((await faqSearch(base.id, 'importappendone marker question')).hits).toHaveLength(1);

      const replaced = await faqImport(base.id, {
        items: importReplaceItems,
        mode: 'replace',
        dryRun: false,
      });
      expect(replaced.statusCode, replaced.body).toBe(202);
      const replaceBody = replaced.json<FaqImportResponse>();
      expect(replaceBody).toMatchObject({ committed: true, counts: { added: 2 } });
      if (!replaceBody.importBatchId) throw new Error('replace batch id missing');

      const replacePublishItems: Array<{
        documentId: string;
        versionId: string;
        expectedVersionId: string | null;
      }> = [];
      for (const result of replaceBody.results) {
        if (!result.documentId || !result.jobId) continue;
        await runJob(result.jobId);
        const detail = await faqDetail(result.documentId);
        const versionId = detail.draftVersion?.id;
        if (!versionId) throw new Error('replacement FAQ draft missing');
        replacePublishItems.push({
          documentId: result.documentId,
          versionId,
          expectedVersionId: result.expectedVersionId ?? null,
        });
      }
      const replacePublished = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/faqs/batch`,
        headers: { cookie },
        payload: {
          action: 'publish',
          items: replacePublishItems,
          importBatchId: replaceBody.importBatchId,
        },
      });
      expect(replacePublished.statusCode, replacePublished.body).toBe(200);

      expect((await faqSearch(base.id, 'importappendone marker question')).hits).toHaveLength(0);
      expect((await faqSearch(base.id, 'replacenewone marker question')).hits).toHaveLength(1);
      const remaining = await app.pool.query<{ count: string }>(
        "select count(*) from knowledge_documents where base_id = $1 and content_kind = 'faq'",
        [base.id],
      );
      expect(Number(remaining.rows[0]?.count ?? 0)).toBe(2);
    });

    async function publishWikiDraft(baseId: string, pageId?: string) {
      if (!pageId) {
        const created = await inject(app, {
          method: 'POST',
          url: `/api/knowledge/bases/${baseId}/wiki-pages`,
          headers: { cookie },
          payload: { slug: unique('wiki-regression'), title: 'Wiki 发布回归' },
        });
        expect(created.statusCode, created.body).toBe(201);
        pageId = created.json<{ id: string }>().id;
      }
      const saved = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/wiki-pages/${pageId}`,
        headers: { cookie },
        payload: { markdown: `# Wiki\n\nwikimarker ${unique('published')}` },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const versions = await repo.knowledge.listWikiVersions(app.db, pageId, { limit: 1 });
      const versionId = versions.items[0]?.id;
      if (!versionId) throw new Error('wiki draft missing');
      const published = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${pageId}/publish`,
        headers: { cookie },
        payload: { versionId },
      });
      expect(published.statusCode, published.body).toBe(200);
      return { pageId, versionId, jobId: await wikiIndexJobId(baseId, pageId) };
    }

    it('Wiki queued w1 then w2 rejects stale w1 and makes the current publication searchable', async () => {
      const base = await createBase();
      const first = await publishWikiDraft(base.id);
      const second = await publishWikiDraft(base.id, first.pageId);
      expect(first.jobId).not.toBe(second.jobId);
      expect(await jobPayload(first.jobId)).toMatchObject({
        input: { expectedCurrentVersionId: null },
      });
      expect(await jobPayload(second.jobId)).toMatchObject({
        input: { expectedCurrentVersionId: null },
      });

      await expect(runJob(first.jobId)).rejects.toThrow('未发布本次结果');
      expect((await repo.knowledge.getJob(app.db, first.jobId))?.status).toBe('failed');
      const firstJob = await repo.knowledge.getJob(app.db, first.jobId);
      if (!firstJob?.documentId) throw new Error('wiki index document missing');
      expect(
        (await repo.knowledge.getDocument(app.db, firstJob.documentId))?.currentVersionId,
      ).toBeNull();
      await runJob(second.jobId);
      const hits = (await search(base.id, 'wikimarker', ['wiki'])).hits;
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.every(
          (hit) => hit.target.id === first.pageId && hit.targetVersionId === second.versionId,
        ),
      ).toBe(true);
    });

    it('Wiki stale w1 failure preserves ready w2 after concurrent indexing', async () => {
      const base = await createBase();
      const first = await publishWikiDraft(base.id);
      const firstJob = await repo.knowledge.getJob(app.db, first.jobId);
      if (!firstJob?.documentId) throw new Error('wiki index document missing');
      expect((await documentState(firstJob.documentId)).currentVersionId).toBeNull();

      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const firstOutcome = runJob(first.jobId, async (input) => {
        const parsed = await parsing.parse(input);
        markReached();
        await gate;
        return parsed;
      }).then(
        () => null,
        (err: unknown) => err,
      );
      try {
        await Promise.race([
          reached,
          firstOutcome.then((err) => {
            throw err ?? new Error('w1 finished before parsing pause');
          }),
        ]);
        expect((await repo.knowledge.getJob(app.db, first.jobId))?.status).toBe('running');
        const second = await publishWikiDraft(base.id, first.pageId);
        await runJob(second.jobId);
        expect((await repo.knowledge.getJob(app.db, second.jobId))?.status).toBe('succeeded');
        const indexed = await documentState(firstJob.documentId);
        expect(indexed.status).toBe('ready');
        expect(indexed.currentVersionId).not.toBeNull();
        const before = (await search(base.id, 'wikimarker', ['wiki'])).hits;
        expect(before.length).toBeGreaterThan(0);
        expect(before.every((hit) => hit.targetVersionId === second.versionId)).toBe(true);

        release();
        expect(await firstOutcome).toEqual(
          expect.objectContaining({ message: expect.stringContaining('未发布本次结果') }),
        );
        expect((await repo.knowledge.getJob(app.db, first.jobId))?.status).toBe('failed');
        const retained = await documentState(firstJob.documentId);
        const after = (await search(base.id, 'wikimarker', ['wiki'])).hits;
        expect(retained.currentVersionId).toBe(indexed.currentVersionId);
        expect(after).toEqual(before);
        expect(retained.status).toBe('ready');
      } finally {
        release();
        await firstOutcome;
      }
    });

    it('Wiki indexing uses the execution pointer when the same publication was indexed after enqueue', async () => {
      const base = await createBase();
      const first = await publishWikiDraft(base.id);
      const repeated = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${first.pageId}/publish`,
        headers: { cookie },
        payload: { versionId: first.versionId },
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      const secondJobId = await wikiIndexJobId(base.id, first.pageId);
      expect(secondJobId).not.toBe(first.jobId);
      await runJob(first.jobId);
      await runJob(secondJobId);
      const hits = (await search(base.id, 'wikimarker', ['wiki'])).hits;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.targetVersionId === first.versionId)).toBe(true);
    });

    it('Wiki full reindex keeps the immutable indexed publication metadata and remains searchable', async () => {
      const base = await createBase();
      const published = await publishWikiDraft(base.id);
      await runJob(published.jobId);
      const before = (await search(base.id, 'wikimarker', ['wiki'])).hits;
      expect(before.length).toBeGreaterThan(0);
      const index = before[0];
      if (!index) throw new Error('wiki search hit missing');
      // 文档级 metadata 可先被后续发布更新，重建只能继承当前索引版本的不可变身份。
      const document = await repo.knowledge.getDocument(app.db, index.documentId);
      await repo.knowledge.updateDocument(app.db, index.documentId, {
        metadata: { ...document?.metadata, wikiVersionId: 'kwv_mutable_metadata_must_not_be_used' },
      });
      const rebuilt = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/rebuild`,
        headers: { cookie },
        payload: { chunksOnly: false },
      });
      expect(rebuilt.statusCode, rebuilt.body).toBe(202);
      await runJob(rebuilt.json<{ jobId: string }>().jobId);
      const after = (await search(base.id, 'wikimarker', ['wiki'])).hits;
      expect(after.length).toBeGreaterThan(0);
      expect(
        after.every(
          (hit) => hit.targetVersionId === published.versionId && hit.versionId !== index.versionId,
        ),
      ).toBe(true);
      const current = await repo.knowledge.getDocument(app.db, index.documentId);
      if (!current?.currentVersionId) throw new Error('rebuilt index missing');
      expect(
        (await repo.knowledge.getVersion(app.db, current.currentVersionId))?.metadata,
      ).toMatchObject({
        wikiPageId: published.pageId,
        wikiVersionId: published.versionId,
      });
    });

    it('manual wiki publishes through a real ingest job and source-backed wiki disappears after revocation', async () => {
      const base = await createBase();
      const page = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/wiki-pages`,
        headers: { cookie },
        payload: { slug: unique('wiki-page'), title: 'Wiki 集成页' },
      });
      expect(page.statusCode, page.body).toBe(201);
      const pageId = page.json<{ id: string }>().id;

      const draft = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/wiki-pages/${pageId}`,
        headers: { cookie },
        payload: { markdown: '# Wiki\n\nwikimarker manual published page' },
      });
      expect(draft.statusCode, draft.body).toBe(200);
      const pageDetail = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/wiki-pages/${pageId}`,
        headers: { cookie },
      });
      expect(pageDetail.statusCode, pageDetail.body).toBe(200);
      const wikiVersionId = pageDetail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id;
      if (!wikiVersionId) throw new Error('wiki draft version missing');

      const publish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${pageId}/publish`,
        headers: { cookie },
        payload: { versionId: wikiVersionId },
      });
      expect(publish.statusCode, publish.body).toBe(200);
      // 发布只切线上指针；索引任务还没跑，搜索暂时不应召回旧内容。
      expect((await search(base.id, 'wikimarker', ['wiki'])).hits).toHaveLength(0);

      await runJob(await wikiIndexJobId(base.id, pageId));
      const wikiHits = await search(base.id, 'wikimarker', ['wiki']);
      expect(wikiHits.hits.map((hit) => hit.target)).toContainEqual({ kind: 'wiki', id: pageId });
      expect(wikiHits.hits.every((hit) => hit.targetVersionId === wikiVersionId)).toBe(true);

      const wikiRead = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'wiki', id: pageId },
      });
      expect(wikiRead.isError).toBe(false);
      expect((wikiRead.json as { markdown: string }).markdown).toContain('wikimarker');
      const wikiList = await mcpCall(base.id, base.serverId, 'knowledge_list', { kinds: ['wiki'] });
      expect(
        (wikiList.json as { items: Array<{ target: { kind: string; id: string } }> }).items.map(
          (item) => item.target.id,
        ),
      ).toContain(pageId);

      // 负例：固定库授权不能被参数改写。
      const crossBase = await mcpCall(base.id, base.serverId, 'knowledge_search', {
        q: 'wikimarker',
        baseId: 'kb_other',
      });
      expect(crossBase.isError).toBe(true);
      expect(crossBase.text).toContain('BASE_MISMATCH');

      // 真实来源 + 真实同步：从 RSS/HTML fixture 摄取文档，再让 Wiki 版本引用真实 chunk。
      const source = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/sources`,
        headers: { cookie },
        payload: {
          type: 'feed',
          name: '集成 RSS',
          config: {},
          secrets: {},
          ranges: [{ kind: 'feed', externalId: `${fixtureUrl}/feed` }],
        },
      });
      expect(source.statusCode, source.body).toBe(201);
      const sourceId = source.json<{ id: string }>().id;

      const sync = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/sources/${sourceId}/sync`,
        headers: { cookie },
      });
      expect(sync.statusCode, sync.body).toBe(202);
      const syncJobId = sync.json<{ jobId: string }>().jobId;
      await runJob(syncJobId);
      const syncPayload = await jobPayload(syncJobId);
      const syncRun = await app.pool.query<{ status: string; stats: Record<string, number> }>(
        'select status, stats from knowledge_sync_runs where id = $1',
        [syncPayload.syncRunId],
      );
      expect(syncRun.rows[0]).toMatchObject({
        status: 'succeeded',
        stats: { listed: 1, created: 1, updated: 0, disabled: 0, failed: 0 },
      });

      const sourceDocument = await app.pool.query<{
        id: string;
        current_version_id: string;
      }>(
        `select id, current_version_id from knowledge_documents
       where base_id = $1 and source_connection_id = $2
       order by created_at desc limit 1`,
        [base.id, sourceId],
      );
      const sourceDocumentId = sourceDocument.rows[0]?.id;
      if (!sourceDocumentId) throw new Error('synced source document missing');
      const sourceChunk = await app.pool.query<{ id: string }>(
        `select id from knowledge_chunks
       where document_id = $1 and version_id = $2 and enabled and index_role = 'leaf'
       order by ordinal limit 1`,
        [sourceDocumentId, sourceDocument.rows[0]?.current_version_id],
      );
      const sourceChunkId = sourceChunk.rows[0]?.id;
      if (!sourceChunkId) throw new Error('synced source chunk missing');

      const derivedPage = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/wiki-pages`,
        headers: { cookie },
        payload: { slug: unique('wiki-derived'), title: '来源派生 Wiki' },
      });
      expect(derivedPage.statusCode, derivedPage.body).toBe(201);
      const derivedPageId = derivedPage.json<{ id: string }>().id;
      const saved = await repo.knowledge.saveWikiDraft(app.db, derivedPageId, {
        markdown: '# Derived\n\nrevokemarker derived from source',
        sourceChunkIds: [sourceChunkId],
        model: 'manual',
        generatedBy: 'manual',
      });
      if (!saved) throw new Error('derived wiki draft missing');
      const derivedPublish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${derivedPageId}/publish`,
        headers: { cookie },
        payload: { versionId: saved.id },
      });
      expect(derivedPublish.statusCode, derivedPublish.body).toBe(200);
      await runJob(await wikiIndexJobId(base.id, derivedPageId));

      expect(
        (await search(base.id, 'revokemarker', ['wiki'])).hits.map((hit) => hit.target),
      ).toContainEqual({
        kind: 'wiki',
        id: derivedPageId,
      });
      const derivedRead = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'wiki', id: derivedPageId },
      });
      expect(derivedRead.isError).toBe(false);

      const revoked = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/sources/${sourceId}`,
        headers: { cookie },
        payload: { status: 'disabled' },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      expect((await search(base.id, 'revokemarker', ['wiki'])).hits).toHaveLength(0);
      expect((await search(base.id, 'sourcearticlemarker', ['document'])).hits).toHaveLength(0);
      const revokedRead = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'wiki', id: derivedPageId },
      });
      expect(revokedRead.isError).toBe(true);
      const revokedList = await mcpCall(base.id, base.serverId, 'knowledge_list', {
        kinds: ['wiki'],
      });
      expect(
        (revokedList.json as { items: Array<{ target: { kind: string; id: string } }> }).items.map(
          (item) => item.target.id,
        ),
      ).not.toContain(derivedPageId);
    });

    it('audio upload transcribes through the real multipart client and search/MCP cite real segment times', async () => {
      const asr = await createAsrProfile();
      const base = await createBase({ asrProfileId: asr.id });
      const asrBefore = asrCalls;

      const { documentId, jobId } = await uploadAudio(base.id, 'tone.wav');
      expect(await jobPayload(jobId)).toMatchObject({ type: 'ingest', publish: 'automatic' });
      await runJob(jobId);

      // 真实转录请求只发一次，文件字节与字段都来自 core 的原生 multipart 客户端。
      expect(asrCalls - asrBefore).toBe(1);
      expect(lastAsr).toMatchObject({
        model: 'fixture-whisper',
        responseFormat: 'verbose_json',
        granularities: 'segment',
        filename: 'tone.wav',
        fileSha256: TONE_WAV_SHA256,
      });
      expect(lastAsr?.contentType.startsWith('multipart/form-data')).toBe(true);

      const state = await documentState(documentId);
      expect(state.status).toBe('ready');
      const versions = await documentVersions(documentId);
      expect(versions.items).toHaveLength(1);
      const version = versions.items[0];
      if (!version) throw new Error('audio version missing');
      expect(version).toMatchObject({
        originalFilename: 'tone.wav',
        mimeType: 'audio/wav',
        sizeBytes: TONE_WAV.length,
        parseStatus: 'parsed',
        isCurrent: true,
      });
      expect(state.currentVersionId).toBe(version.id);
      expect(version.metadata.audio).toEqual({
        protocol: 'openai_transcriptions',
        profileName: asr.name,
        model: 'fixture-whisper',
        durationMs: 6000,
        segments: AUDIO_SEGMENTS,
      });

      // 检索命中带真实时码；重复句与 emoji 不破坏定位。
      const hit = (await search(base.id, 'audiomarker', ['document'])).hits.find(
        (entry) => entry.documentId === documentId,
      );
      expect(hit?.versionId).toBe(version.id);
      expect(hit?.targetVersionId).toBe(version.id);
      expect(hit?.locator).toEqual(AUDIO_CHUNK_LOCATOR);

      // MCP 读引用同一版本与时码，正文与解析产物一致。
      const read = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: documentId },
      });
      expect(read.isError).toBe(false);
      const readJson = read.json as {
        versionId: string;
        markdown: string;
        citations: Array<{ versionId: string; locator: Record<string, unknown> | null }>;
      };
      expect(readJson.versionId).toBe(version.id);
      expect(readJson.markdown).toBe(AUDIO_SEGMENTED_MARKDOWN);
      expect(readJson.citations).toHaveLength(1);
      expect(readJson.citations[0]?.versionId).toBe(version.id);
      expect(readJson.citations[0]?.locator).toEqual(AUDIO_CHUNK_LOCATOR);

      // 原件下载必须是上传的同一份字节，且只对应这个精确发布版本。
      const download = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/versions/${version.id}/content`,
        headers: { cookie },
      });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.headers['content-type']).toBe('audio/wav');
      expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(TONE_WAV_SHA256);
    });

    it('text-only ASR response never fabricates time in version, search, or MCP read', async () => {
      const asr = await createAsrProfile();
      const base = await createBase({ asrProfileId: asr.id });
      const asrBefore = asrCalls;

      const { documentId, jobId } = await uploadAudio(base.id, 'textonly.wav');
      await runJob(jobId);
      expect(asrCalls - asrBefore).toBe(1);
      expect(lastAsr?.filename).toBe('textonly.wav');

      const versions = await documentVersions(documentId);
      const version = versions.items[0];
      if (!version) throw new Error('text-only audio version missing');
      expect(version.metadata.audio).toEqual({
        protocol: 'openai_transcriptions',
        profileName: asr.name,
        model: 'fixture-whisper',
        durationMs: 3200,
        segments: [],
      });
      const expectedLocator = { startOffset: 0, endOffset: AUDIO_TEXT_ONLY.length };

      const hit = (await search(base.id, 'textonlymarker', ['document'])).hits.find(
        (entry) => entry.documentId === documentId,
      );
      expect(hit?.versionId).toBe(version.id);
      expect(hit?.locator).toEqual(expectedLocator);

      const read = await mcpCall(base.id, base.serverId, 'knowledge_read', {
        target: { kind: 'document', id: documentId },
      });
      expect(read.isError).toBe(false);
      const readJson = read.json as {
        markdown: string;
        citations: Array<{ locator: Record<string, unknown> | null }>;
      };
      expect(readJson.markdown).toBe(AUDIO_TEXT_ONLY);
      expect(readJson.citations[0]?.locator).toEqual(expectedLocator);
    });

    it('unbinding during real transcription keeps the published version and chunksOnly never retranscribes', async () => {
      const asr = await createAsrProfile();
      const base = await createBase({ asrProfileId: asr.id });
      const uploaded = await uploadAudio(base.id, 'tone.wav');
      await runJob(uploaded.jobId);
      const before = await documentVersions(uploaded.documentId);
      const currentVersionId = before.items[0]?.id;
      if (!currentVersionId) throw new Error('audio version missing');
      const asrBeforeReprocess = asrCalls;

      const reprocess = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${uploaded.documentId}/reprocess`,
        headers: { cookie },
        payload: {},
      });
      expect(reprocess.statusCode, reprocess.body).toBe(202);
      const reprocessJobId = reprocess.json<{ jobId: string }>().jobId;

      // 转录请求已到达 fixture 但尚未返回：此时关闭库的 ASR 绑定。
      const latch = armAsrLatch();
      const processed = runJob(reprocessJobId).then(
        () => null,
        (err: unknown) => err,
      );
      await latch.reached;
      const unbound = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${base.id}`,
        headers: { cookie },
        payload: { asrProfileId: null },
      });
      expect(unbound.statusCode, unbound.body).toBe(200);
      latch.release();

      const failure = await processed;
      expect(failure).toBeInstanceOf(Error);
      // reindex 对单个文档失败按聚合失败收尾，旧版本照旧保留。
      expect((failure as Error).message).toContain('1 个文档重建失败，旧版本保留');
      expect(asrCalls - asrBeforeReprocess).toBe(1);
      expect((await repo.knowledge.getJob(app.db, reprocessJobId))?.status).toBe('failed');

      // 旧发布版本、正文与时码全部保持不变，也没有多出版本行。
      const retained = await documentVersions(uploaded.documentId);
      expect(retained.items.map((item) => item.id)).toEqual([currentVersionId]);
      expect(retained.items[0]?.metadata.audio).toMatchObject({ segments: AUDIO_SEGMENTS });
      expect((await documentState(uploaded.documentId)).currentVersionId).toBe(currentVersionId);
      const retainedHit = (await search(base.id, 'audiomarker', ['document'])).hits.find(
        (entry) => entry.documentId === uploaded.documentId,
      );
      expect(retainedHit?.versionId).toBe(currentVersionId);
      expect(retainedHit?.locator).toEqual(AUDIO_CHUNK_LOCATOR);

      // 重新绑定后只补向量：不重新解析/转录，也不新建版本。
      const rebound = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${base.id}`,
        headers: { cookie },
        payload: { asrProfileId: asr.id },
      });
      expect(rebound.statusCode, rebound.body).toBe(200);
      const asrBeforeRebuild = asrCalls;
      const embeddingBeforeRebuild = embeddingCalls;
      const rebuild = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/rebuild`,
        headers: { cookie },
        payload: { chunksOnly: true, documentIds: [uploaded.documentId] },
      });
      expect(rebuild.statusCode, rebuild.body).toBe(202);
      const rebuildJobId = rebuild.json<{ jobId: string }>().jobId;
      await runJob(rebuildJobId);
      expect((await repo.knowledge.getJob(app.db, rebuildJobId))?.status).toBe('succeeded');
      expect(asrCalls).toBe(asrBeforeRebuild);
      expect(embeddingCalls).toBe(embeddingBeforeRebuild);
      expect((await documentVersions(uploaded.documentId)).items.map((item) => item.id)).toEqual([
        currentVersionId,
      ]);
      const afterRebuildHit = (await search(base.id, 'audiomarker', ['document'])).hits.find(
        (entry) => entry.documentId === uploaded.documentId,
      );
      expect(afterRebuildHit?.versionId).toBe(currentVersionId);
      expect(afterRebuildHit?.locator).toEqual(AUDIO_CHUNK_LOCATOR);
    });
  },
);
