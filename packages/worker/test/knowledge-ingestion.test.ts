import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeModelError } from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { KnowledgeBaseSettings } from '@agentport/shared';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImageQueryFn } from '../src/knowledge/image-processing.js';
import {
  type ChunkDraft,
  KnowledgeCancelled,
  type KnowledgeConnector,
  type KnowledgeDeps,
  runCleanup,
  runIngest,
  runReindex,
  runSync,
} from '../src/knowledge/ingestion.js';
import { KnowledgeParseError } from '../src/knowledge/parsing.js';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';
import { SourceAuthError } from '../src/knowledge/sources.js';
import { createIsolatedDatabase } from './isolated-db.js';

const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// 套件写入大量知识库数据：独享随机库，不能复用当前共享库中的迁移和行。
const isolated = await createIsolatedDatabase('worker_knowledge_ingestion');
if (!isolated) throw new Error('knowledge ingestion tests require a reachable DATABASE_URL');
const dbHandle = createDb(isolated.url);
const { db } = dbHandle;
const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as KnowledgeDeps['logger'];

const chunkStub = (markdown: string): ChunkDraft[] =>
  markdown
    .split(/\n{2,}/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({
      kind: 'text' as const,
      heading: null,
      content,
      pageFrom: null,
      pageTo: null,
    }));

// 真实本地 HTTP fixture：embedding/rerank 的协议与失败分类都在这里走真网络。
let fixture: Server;
let fixtureUrl = '';
let embeddingBehaviour: { status: number; body?: unknown; delayMs?: number } = { status: 200 };
let embeddingCalls = 0;
let cohereCalls: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const respond = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/embeddings') {
        embeddingCalls += 1;
        const parsed = JSON.parse(raw) as { input: string[] };
        if (embeddingBehaviour.delayMs) {
          setTimeout(
            () => respond(embeddingBehaviour.status, embeddingBehaviour.body ?? {}),
            embeddingBehaviour.delayMs,
          );
          return;
        }
        if (embeddingBehaviour.body) {
          respond(embeddingBehaviour.status, embeddingBehaviour.body);
          return;
        }
        respond(200, {
          data: parsed.input.map((_, index) => ({
            index,
            embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
          })),
        });
        return;
      }
      if (req.url === '/embed') {
        const parsed = JSON.parse(raw) as { texts?: string[]; images?: string[] };
        cohereCalls.push(parsed);
        // 只让图片请求失败：文字向量必须仍可写入，才是真正「向量降级」。
        const failing = parsed.images !== undefined ? embeddingBehaviour : { status: 200 };
        if (failing.delayMs) {
          setTimeout(() => respond(failing.status, failing.body ?? {}), failing.delayMs);
          return;
        }
        if (failing.body) {
          respond(failing.status, failing.body);
          return;
        }
        const count = (parsed.texts ?? parsed.images ?? []).length;
        respond(200, {
          embeddings: {
            float: Array.from({ length: count }, (_, index) =>
              Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
            ),
          },
        });
        return;
      }
      respond(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await dbHandle.pool.end();
  await isolated.close();
});

let knowledgeDir = '';
beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
  embeddingBehaviour = { status: 200 };
  embeddingCalls = 0;
  cohereCalls = [];
});
afterEach(async () => {
  await rm(knowledgeDir, { recursive: true, force: true });
});

const suffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
  baseId: string;
  serverId: string;
  profileId: string;
  deps: KnowledgeDeps;
}

async function makeBase(
  endpoints: {
    endpointUrl?: string;
    embeddingProtocol?: 'openai' | 'cohere_v2';
    model?: string;
    imageInputEnabled?: boolean;
  } = {},
  connectors: Partial<KnowledgeDeps['connectors']> = {},
): Promise<Fixture> {
  const id = suffix();
  const serverId = newId('server');
  await db.insert(schema.servers).values({
    id: serverId,
    name: `kb-test-${id}`,
    kind: 'knowledge',
    config: { knowledgeBaseId: `pending-${id}` },
  });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-${id}`,
    endpointUrl: endpoints.endpointUrl ?? fixtureUrl,
    model: endpoints.model ?? 'test-embed',
    dimensions: 1024,
    ...(endpoints.embeddingProtocol ? { embeddingProtocol: endpoints.embeddingProtocol } : {}),
    ...(endpoints.imageInputEnabled ? { imageInputEnabled: endpoints.imageInputEnabled } : {}),
    secretsEncrypted: 'encrypted-placeholder',
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-${id}`,
    name: `kb ${id}`,
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
  return {
    baseId: base.id,
    serverId,
    profileId,
    deps: {
      db,
      logger: quiet,
      knowledgeDir,
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: chunkStub,
      connectors: connectors as KnowledgeDeps['connectors'],
      decrypt: () => ({ apiKey: 'test-key' }),
    },
  };
}

async function makeUploadedDocument(
  fixtureBase: Fixture,
  body = '# 标题\n\n第一段内容。\n\n第二段内容。',
): Promise<{ documentId: string; jobId: string }> {
  const data = Buffer.from(body, 'utf8');
  const sha = createHash('sha256').update(data).digest('hex');
  const documentId = newId('knowledgeDocument');
  await db.insert(schema.knowledgeDocuments).values({
    id: documentId,
    baseId: fixtureBase.baseId,
    title: 'doc.md',
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: data.length,
    status: 'pending',
    contentHash: sha,
    metadata: { originalFilename: 'doc.md' },
  });
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
  await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId: fixtureBase.baseId,
    documentId,
    sourceId: null,
    payload: { type: 'ingest', documentId },
  });
  await repo.knowledge.claimJob(db, job.id);
  return { documentId, jobId: job.id };
}

describe('runIngest', () => {
  it('indexes a document and switches to the new version in one step', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');

    await runIngest(fixtureBase.deps, job, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('ready');
    expect(document?.currentVersionId).not.toBeNull();
    const chunks = await repo.knowledge.listChunks(db, document?.currentVersionId ?? '');
    expect(chunks.items.length).toBe(3);
    expect(chunks.items[0]?.embedding?.length).toBe(1024);
    expect(chunks.items[0]?.searchText).toContain('标题');
    const markdown = await stat(
      join(knowledgeDir, 'docs', documentId, document?.currentVersionId ?? '', 'markdown.md'),
    );
    expect(markdown.size).toBeGreaterThan(0);
    expect(embeddingCalls).toBe(1);
  });

  it('marks the document failed when parsing fails and keeps no current version', async () => {
    const fixtureBase = await makeBase();
    fixtureBase.deps.parse = async () => {
      throw new Error('docling exploded');
    };
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');

    await expect(runIngest(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      'docling exploded',
    );
    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('failed');
    expect(document?.currentVersionId).toBeNull();
  });

  it('surfaces embedding auth failures as auth category without retrying', async () => {
    const fixtureBase = await makeBase();
    embeddingBehaviour = { status: 401, body: { error: 'bad key' } };
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');

    const error = await runIngest(fixtureBase.deps, job, new AbortController().signal).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ kind: 'auth' });
    expect((error as Error).message).toContain('401');
    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('failed');
    expect(embeddingCalls).toBe(1);
  });

  it('stops after cancellation without writing a version', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    const controller = new AbortController();
    controller.abort();

    await expect(runIngest(fixtureBase.deps, job, controller.signal)).rejects.toBeInstanceOf(
      KnowledgeCancelled,
    );
    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.currentVersionId).toBeNull();
    const versions = await repo.knowledge.listVersions(db, documentId);
    expect(versions.items).toHaveLength(0);
  });

  it('does not publish a new version when aborted during chunk insertion', async () => {
    const fixtureBase = await makeBase();
    const first = await makeUploadedDocument(fixtureBase);
    const firstJob = await repo.knowledge.getJob(db, first.jobId);
    if (!firstJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, firstJob, new AbortController().signal);
    const before = await repo.knowledge.getDocument(db, first.documentId);
    const oldVersionId = before?.currentVersionId ?? '';
    expect(oldVersionId).not.toBe('');

    // 新原件 + 新 job；在真正 await 的 chunk 插入过程中触发 abort。
    const { mkdir, writeFile } = await import('node:fs/promises');
    const data = Buffer.from('# 新标题\n\n新的正文。', 'utf8');
    const sha = createHash('sha256').update(data).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
    await repo.knowledge.updateDocument(db, first.documentId, { contentHash: sha });
    const job = await repo.knowledge.createJob(db, {
      type: 'ingest',
      baseId: fixtureBase.baseId,
      documentId: first.documentId,
      sourceId: null,
      payload: { type: 'ingest', documentId: first.documentId },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');
    // 归因：还源 DB 确认失败确在切版前由 abort 触发，而不是被守卫的其它条件拒绝。
    let inserted = false;
    const signalForCall = new AbortController();
    const depsForCall: KnowledgeDeps = {
      ...fixtureBase.deps,
      db: new Proxy(fixtureBase.deps.db, {
        get(target, prop) {
          if (prop === 'insert') {
            return (table: Parameters<typeof target.insert>[0]) => {
              inserted = true;
              signalForCall.abort();
              return target.insert(table);
            };
          }
          return Reflect.get(target, prop, target);
        },
      }),
    };

    await expect(runIngest(depsForCall, claimed, signalForCall.signal)).rejects.toBeInstanceOf(
      KnowledgeCancelled,
    );
    expect(signalForCall.signal.aborted).toBe(true);
    expect(inserted).toBe(true);
    // abort 发生在 chunk 插入之后：守卫之前就已观察，绝不能再切版。
    const after = await repo.knowledge.getDocument(db, first.documentId);
    expect(after?.currentVersionId).toBe(oldVersionId);
    expect(after?.status).toBe('ready');
  });

  it('does not publish when cancellation lands while the publish guard reads job/base', async () => {
    const fixtureBase = await makeBase();
    const first = await makeUploadedDocument(fixtureBase);
    const firstJob = await repo.knowledge.getJob(db, first.jobId);
    if (!firstJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, firstJob, new AbortController().signal);
    const before = await repo.knowledge.getDocument(db, first.documentId);
    const oldVersionId = before?.currentVersionId ?? '';
    expect(oldVersionId).not.toBe('');

    const { mkdir, writeFile } = await import('node:fs/promises');
    const data = Buffer.from('# 再一版\n\n取消发生在守卫读库期间。', 'utf8');
    const sha = createHash('sha256').update(data).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
    await repo.knowledge.updateDocument(db, first.documentId, { contentHash: sha });
    const job = await repo.knowledge.createJob(db, {
      type: 'ingest',
      baseId: fixtureBase.baseId,
      documentId: first.documentId,
      sourceId: null,
      payload: { type: 'ingest', documentId: first.documentId },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    // 切版事务第二次 SELECT（读库配置）发出时取消：此时事务入口的 abort 检查已经过去，
    // 取消恰好落在 job/base 两次读取之间，正是守卫必须在 update 前再看一次 signal 的窗口。
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const controller = new AbortController();
    let baseReadStarted = false;
    const wrappedTx = (tx: Tx): Tx => {
      let selects = 0;
      return new Proxy(tx, {
        get(txTarget, prop) {
          if (prop !== 'select') return Reflect.get(txTarget, prop, txTarget);
          return (...args: Parameters<typeof txTarget.select>) => {
            selects += 1;
            if (selects === 2) {
              baseReadStarted = true;
              controller.abort();
            }
            return txTarget.select(...args);
          };
        },
      });
    };
    const depsForCall: KnowledgeDeps = {
      ...fixtureBase.deps,
      db: new Proxy(fixtureBase.deps.db, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop, target);
          return (fn: (tx: Tx) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrappedTx(tx)));
        },
      }),
    };

    await expect(runIngest(depsForCall, claimed, controller.signal)).rejects.toThrow(
      '未发布本次结果',
    );
    expect(baseReadStarted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // 旧实现只在事务入口看一次 signal：这里会切版；新守卫必须保持旧 currentVersionId。
    const after = await repo.knowledge.getDocument(db, first.documentId);
    expect(after?.currentVersionId).toBe(oldVersionId);
    expect(after?.status).toBe('ready');
  });

  it('passes the job abort signal into parse so a slow Docling request is released', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    // 解析桩模拟 Docling 长请求：只有收到 abort 才结束，否则永远挂起。
    let seen: AbortSignal | undefined;
    fixtureBase.deps.parse = ({ signal }) =>
      new Promise((_resolve, reject) => {
        seen = signal;
        if (!signal) return; // 未传 signal 时永远挂起，正是要修的缺陷
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const controller = new AbortController();
    const pending = runIngest(fixtureBase.deps, job, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(KnowledgeCancelled);
    expect(seen?.aborted).toBe(true);
    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.currentVersionId).toBeNull();
  });
});

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const imageSettings = (patch: Partial<KnowledgeBaseSettings['imageProcessing']> = {}) => ({
  enabled: true,
  model: 'vision-test-model',
  ocrEnabled: true,
  captionEnabled: true,
  descriptionLanguage: 'zh-CN',
  customInstructions: '',
  imageVectorEnabled: false,
  imageVectorMinScore: 0.3,
  ...patch,
});

/** 每张图各做 OCR/caption 两次 query；按 action 指令返回内容或抛错。 */
function fakeImageQuery(
  outcome: Array<{ ocr?: string | null; caption?: string | null; error?: string }>,
  seen: Array<{ prompt: string; options: Options }> = [],
) {
  return ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => {
    async function* run(): AsyncGenerator<SDKMessage, void> {
      if (typeof params.prompt === 'string') return;
      // 从真实 prompt 里取文字指令，判断这是 OCR 还是 caption 动作。
      let prompt = '';
      for await (const message of params.prompt) {
        const content = message.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'text') prompt = block.text;
        }
      }
      seen.push({ prompt, options: params.options });
      const index = seen.length - 1;
      const step = outcome[index] ?? {};
      if (step.error) throw new Error(step.error);
      const value = prompt.includes('识别图片中的全部文字')
        ? (step.ocr ?? '')
        : (step.caption ?? '');
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: { text: value },
      } as SDKMessage;
    }
    return run();
  }) as ImageQueryFn;
}

async function makeImageDocument(
  fixtureBase: Fixture,
  data: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ documentId: string; jobId: string }> {
  const base = await makeUploadedDocument(fixtureBase, 'placeholder');
  const sha = createHash('sha256').update(data).digest('hex');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
  await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
  await db
    .update(schema.knowledgeDocuments)
    .set({
      contentHash: sha,
      mimeType,
      sizeBytes: data.length,
      metadata: { originalFilename: filename },
    })
    .where(eq(schema.knowledgeDocuments.id, base.documentId));
  return base;
}

async function enableImages(
  fixtureBase: Fixture,
  patch: Partial<KnowledgeBaseSettings['imageProcessing']> = {},
): Promise<void> {
  const base = await repo.knowledge.getBase(db, fixtureBase.baseId);
  if (!base) throw new Error('base missing');
  await repo.knowledge.updateBase(db, base.id, {
    settings: { ...base.settings, imageProcessing: imageSettings(patch) },
  });
}

describe('runIngest image processing', () => {
  it('indexes an uploaded PNG through the same images path and writes OCR/caption chunks', async () => {
    const fixtureBase = await makeBase();
    await enableImages(fixtureBase);
    const parse = fixtureBase.deps.parse;
    // 真实 parser 负责图片 magic 校验与 ParsedDocument.images 投影。
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    fixtureBase.deps.imageQueryFn = fakeImageQuery([
      { ocr: '发票号码 12345' },
      { caption: '一张发票照片' },
    ]);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runIngest(fixtureBase.deps, job, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('ready');
    const version = await repo.knowledge.getVersion(db, document?.currentVersionId ?? '');
    expect(version?.images).toEqual([
      {
        name: 'image-1.png',
        sha256: sha256Of(TINY_PNG),
        mimeType: 'image/png',
        page: 1,
        warnings: [],
      },
    ]);
    const chunks = await repo.knowledge.listChunks(db, document?.currentVersionId ?? '');
    const imageChunks = chunks.items.filter((chunk) => chunk.kind === 'image');
    expect(
      imageChunks.map((chunk) => [
        (chunk.metadata as { imageRole: string }).imageRole,
        chunk.content,
        chunk.embedding?.length,
      ]),
    ).toEqual([
      ['ocr', '发票号码 12345', 1024],
      ['caption', '一张发票照片', 1024],
    ]);
    const metadataOf = (index: number) => imageChunks[index]?.metadata as { image: unknown };
    expect(metadataOf(0).image).toEqual({
      name: 'image-1.png',
      mimeType: 'image/png',
      page: 1,
    });
    // 原图与版本清单同一条磁盘路径，读图/下载共用。
    expect(
      await stat(
        join(
          knowledgeDir,
          'docs',
          documentId,
          document?.currentVersionId ?? '',
          'images',
          'image-1.png',
        ),
      ),
    ).toBeDefined();
    expect(parse).toBeDefined();
  });

  it('publishes with a warning when one action fails and both output when both fail', async () => {
    const fixtureBase = await makeBase();
    await enableImages(fixtureBase);
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    fixtureBase.deps.imageQueryFn = fakeImageQuery([
      { error: 'ocr unavailable' },
      { caption: '一张发票照片' },
    ]);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runIngest(fixtureBase.deps, job, new AbortController().signal);
    const document = await repo.knowledge.getDocument(db, documentId);
    const version = await repo.knowledge.getVersion(db, document?.currentVersionId ?? '');
    expect(version?.images[0]?.warnings).toEqual([expect.stringContaining('ocr')]);
    const chunks = await repo.knowledge.listChunks(db, document?.currentVersionId ?? '');
    expect(chunks.items.filter((chunk) => chunk.kind === 'image')).toHaveLength(1);

    const second = await makeBase();
    await enableImages(second);
    second.deps.parse = (input) => createParsingAdapter().parse(input);
    const failing = await makeImageDocument(second, TINY_PNG, 'image/png', 'shot.png');
    second.deps.imageQueryFn = fakeImageQuery([{ error: 'boom' }, { error: 'boom' }]);
    const failingJob = await repo.knowledge.getJob(db, failing.jobId);
    if (!failingJob) throw new Error('job missing');
    await expect(runIngest(second.deps, failingJob, new AbortController().signal)).rejects.toThrow(
      /没有可用的 OCR 或描述/,
    );
    const failedDoc = await repo.knowledge.getDocument(db, failing.documentId);
    expect(failedDoc?.currentVersionId).toBeNull();
    expect(await repo.knowledge.listVersions(db, failing.documentId)).toMatchObject({
      items: [],
    });
  });

  it('refuses an uploaded image while image processing is disabled and does not publish', async () => {
    const base = await makeBase();
    base.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(base, TINY_PNG, 'image/png', 'shot.png');
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runIngest(base.deps, job, new AbortController().signal)).rejects.toThrow(
      /图片处理未启用/,
    );
    expect((await repo.knowledge.getDocument(db, documentId))?.currentVersionId).toBeNull();
  });

  it('adds an opt-in image vector chunk on the same space and degrades on failure', async () => {
    const fixtureBase = await makeBase({
      embeddingProtocol: 'cohere_v2',
      model: 'embed-v4.0',
      imageInputEnabled: true,
    });
    await enableImages(fixtureBase, { imageVectorEnabled: true });
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    fixtureBase.deps.imageQueryFn = fakeImageQuery([
      { ocr: '发票号码 12345' },
      { caption: '一张发票照片' },
    ]);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runIngest(fixtureBase.deps, job, new AbortController().signal);

    const imageCall = cohereCalls.find((call) => Array.isArray(call.images));
    expect(imageCall).toMatchObject({
      model: 'embed-v4.0',
      input_type: 'image',
      output_dimension: 1024,
      images: [`data:image/png;base64,${TINY_PNG.toString('base64')}`],
    });
    const document = await repo.knowledge.getDocument(db, documentId);
    const chunks = await repo.knowledge.listChunks(db, document?.currentVersionId ?? '');
    const vectors = chunks.items.filter(
      (chunk) => (chunk.metadata as { imageRole?: string }).imageRole === 'vector',
    );
    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.embedding?.length).toBe(1024);
    // vector chunk 只做图片向量检索，不进关键词索引。
    expect(vectors[0]?.searchText).toBe('');

    // 向量失败只降级描述检索并记 warning，整版仍可发布。
    const second = await makeBase({
      embeddingProtocol: 'cohere_v2',
      model: 'embed-v4.0',
      imageInputEnabled: true,
    });
    await enableImages(second, { imageVectorEnabled: true });
    second.deps.parse = (input) => createParsingAdapter().parse(input);
    const degraded = await makeImageDocument(second, TINY_PNG, 'image/png', 'shot.png');
    second.deps.imageQueryFn = fakeImageQuery([
      { ocr: '发票号码 12345' },
      { caption: '一张发票照片' },
    ]);
    embeddingBehaviour = { status: 429, body: { error: 'rate limited' } };
    const secondJob = await repo.knowledge.getJob(db, degraded.jobId);
    if (!secondJob) throw new Error('job missing');
    await runIngest(second.deps, secondJob, new AbortController().signal);
    const degradedDoc = await repo.knowledge.getDocument(db, degraded.documentId);
    expect(degradedDoc?.status).toBe('ready');
    const degradedVersion = await repo.knowledge.getVersion(
      db,
      degradedDoc?.currentVersionId ?? '',
    );
    expect(degradedVersion?.images[0]?.warnings.join(' ')).toMatch(/图片向量失败/);
  });

  it('keeps a vector draft with no embedding on vector failure and restores it without visual work', async () => {
    const fixtureBase = await makeBase({
      embeddingProtocol: 'cohere_v2',
      model: 'embed-v4.0',
      imageInputEnabled: true,
    });
    await enableImages(fixtureBase, { imageVectorEnabled: true });
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    let imageQueries = 0;
    const inner = fakeImageQuery([{ ocr: '发票号码 12345' }, { caption: '一张发票照片' }]);
    fixtureBase.deps.imageQueryFn = (params) => {
      imageQueries += 1;
      return inner(params);
    };
    embeddingBehaviour = { status: 429, body: { error: 'rate limited' } };
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runIngest(fixtureBase.deps, job, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('ready');
    const versionId = document?.currentVersionId ?? '';
    const chunks = await repo.knowledge.listChunks(db, versionId);
    const imageChunks = chunks.items.filter((chunk) => chunk.kind === 'image');
    expect(
      imageChunks.map((chunk) => [
        (chunk.metadata as { imageRole: string }).imageRole,
        chunk.content,
        chunk.embedding?.length ?? null,
      ]),
    ).toEqual([
      ['ocr', '发票号码 12345', 1024],
      ['caption', '一张发票照片', 1024],
      ['vector', '一张发票照片', null],
    ]);
    const vector = imageChunks[2];
    expect(vector?.searchText).toBe('');
    expect(((vector?.metadata ?? {}) as { image: unknown }).image).toEqual({
      name: 'image-1.png',
      mimeType: 'image/png',
      page: 1,
    });
    // 降级的 vector 草稿不能再次进入文字 embedding，否则就把它当成普通文本了。
    const textInputs = cohereCalls
      .filter((call) => Array.isArray(call.texts))
      .flatMap((call) => call.texts as string[]);
    expect(textInputs.filter((text) => text === '一张发票照片')).toHaveLength(1);

    // 上游恢复后，chunksOnly 从原图补建 vector，且不再调用视觉生成。
    embeddingBehaviour = { status: 200 };
    cohereCalls = [];
    const queriesBefore = imageQueries;
    const reindexJob = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: null,
      payload: { type: 'reindex', baseId: fixtureBase.baseId, chunksOnly: true },
    });
    await repo.knowledge.claimJob(db, reindexJob.id);
    const claimed = await repo.knowledge.getJob(db, reindexJob.id);
    if (!claimed) throw new Error('job missing');
    await runReindex(fixtureBase.deps, claimed, new AbortController().signal);

    const restored = (await repo.knowledge.listChunks(db, versionId)).items.find(
      (chunk) => (chunk.metadata as { imageRole?: string }).imageRole === 'vector',
    );
    expect(restored?.embedding?.length).toBe(1024);
    expect(cohereCalls.some((call) => Array.isArray(call.images))).toBe(true);
    expect(imageQueries).toBe(queriesBefore);
  });

  it('does not publish when the base is disabled or the image settings changed mid-run', async () => {
    const fixtureBase = await makeBase();
    await enableImages(fixtureBase);
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    const base = await repo.knowledge.getBase(db, fixtureBase.baseId);
    if (!base) throw new Error('base missing');
    // 生成期间管理员改了图片处理配置：发布前必须重核，不用旧配置覆盖新决定。
    const inner = fakeImageQuery([{ ocr: 'a' }, { caption: 'b' }]);
    let changed = false;
    fixtureBase.deps.imageQueryFn = (params) => {
      async function* run(): AsyncGenerator<SDKMessage, void> {
        if (!changed) {
          changed = true;
          await repo.knowledge.updateBase(db, base.id, {
            settings: { ...base.settings, imageProcessing: imageSettings({ ocrEnabled: false }) },
          });
        }
        yield* inner(params);
      }
      return run();
    };
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runIngest(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      /配置已变化/,
    );
    expect((await repo.knowledge.getDocument(db, documentId))?.currentVersionId).toBeNull();
  });
});

describe('runReindex', () => {
  it('keeps the previous version when reindexing fails', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const before = await repo.knowledge.getDocument(db, documentId);
    expect(before?.currentVersionId).not.toBeNull();

    // 400 是永久性的 bad_response：单文档失败继续汇总，不触发队列重试。
    embeddingBehaviour = { status: 400, body: { error: 'bad request' } };
    const job = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId,
      sourceId: null,
      payload: { type: 'reindex', baseId: fixtureBase.baseId, documentIds: [documentId] },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    await expect(
      runReindex(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toThrow(/重建失败/);
    const after = await repo.knowledge.getDocument(db, documentId);
    expect(after?.currentVersionId).toBe(before?.currentVersionId);
  });

  it('propagates a transient embedding failure so the queue can retry', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const before = await repo.knowledge.getDocument(db, documentId);

    embeddingBehaviour = { status: 503, body: { error: 'down' } };
    const job = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId,
      sourceId: null,
      payload: { type: 'reindex', baseId: fixtureBase.baseId, documentIds: [documentId] },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    // 临时错误保持原始类型，队列现有的分类器才会重试。
    await expect(
      runReindex(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toBeInstanceOf(KnowledgeModelError);
    const after = await repo.knowledge.getDocument(db, documentId);
    expect(after?.currentVersionId).toBe(before?.currentVersionId);
  });

  it('chunksOnly restores image vectors from the version whitelist and text chunks via texts', async () => {
    const fixtureBase = await makeBase({
      embeddingProtocol: 'cohere_v2',
      model: 'embed-v4.0',
      imageInputEnabled: true,
    });
    await enableImages(fixtureBase, { imageVectorEnabled: true });
    fixtureBase.deps.parse = (input) => createParsingAdapter().parse(input);
    const { documentId, jobId } = await makeImageDocument(
      fixtureBase,
      TINY_PNG,
      'image/png',
      'shot.png',
    );
    fixtureBase.deps.imageQueryFn = fakeImageQuery([
      { ocr: '发票号码 12345' },
      { caption: '一张发票照片' },
    ]);
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runIngest(fixtureBase.deps, job, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, documentId);
    const versionId = document?.currentVersionId ?? '';
    const chunks = await repo.knowledge.listChunks(db, versionId);
    for (const chunk of chunks.items) {
      await repo.knowledge.patchChunk(db, chunk.id, { embedding: null });
    }
    cohereCalls = [];
    const reindexJob = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: null,
      payload: { type: 'reindex', baseId: fixtureBase.baseId, chunksOnly: true },
    });
    await repo.knowledge.claimJob(db, reindexJob.id);
    const claimed = await repo.knowledge.getJob(db, reindexJob.id);
    if (!claimed) throw new Error('job missing');
    await runReindex(fixtureBase.deps, claimed, new AbortController().signal);

    const after = await repo.knowledge.listChunks(db, versionId);
    expect(after.items.every((chunk) => chunk.embedding?.length === 1024)).toBe(true);
    // 图片向量来自原图字节（经版本清单白名单读取），不是把 caption 当图片向量。
    expect(cohereCalls.some((call) => Array.isArray(call.images))).toBe(true);
    expect(cohereCalls.some((call) => Array.isArray(call.texts))).toBe(true);
  });

  it('refuses chunksOnly when the base profile differs from the version profile', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const document = await repo.knowledge.getDocument(db, documentId);
    const versionId = document?.currentVersionId ?? '';
    const before = await repo.knowledge.listChunks(db, versionId);
    for (const chunk of before.items) {
      await repo.knowledge.patchChunk(db, chunk.id, { embedding: null });
    }

    // 库切到另一个同维 profile；旧版本仍是 A，chunksOnly 不能把 B 向量写进 A 版本。
    const other = await makeBase();
    await repo.knowledge.updateBase(db, fixtureBase.baseId, {
      embeddingProfileId: other.profileId,
    });
    cohereCalls = [];
    const job = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId,
      sourceId: null,
      payload: {
        type: 'reindex',
        baseId: fixtureBase.baseId,
        documentIds: [documentId],
        chunksOnly: true,
      },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');
    await expect(
      runReindex(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toThrow(/profile/);

    const after = await repo.knowledge.listChunks(db, versionId);
    expect(after.items.every((chunk) => chunk.embedding === null)).toBe(true);
    expect(cohereCalls).toHaveLength(0);
  });
});

/** 仓库列表接口单页上限 200；用例必须超过一页才能证明后端会翻页。 */
const OVER_PAGE = 250;

async function allChunks(versionId: string) {
  const items: Array<{ id: string; embedding: number[] | null }> = [];
  let cursor: string | null = null;
  do {
    const page = await repo.knowledge.listChunks(db, versionId, { limit: 200, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function seedDocuments(
  fixtureBase: Fixture,
  count: number,
  values: {
    sourceType?: 'upload' | 'feed' | 'gitlab';
    sourceId?: (index: number) => string;
    metadata?: Record<string, unknown>;
    contentHash?: string;
    status?: 'ready';
  },
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId('knowledgeDocument'));
  await db.insert(schema.knowledgeDocuments).values(
    ids.map((id, index) => ({
      id,
      baseId: fixtureBase.baseId,
      title: `doc-${index}.md`,
      sourceType: values.sourceType ?? ('upload' as const),
      sourceId: values.sourceId?.(index) ?? null,
      mimeType: 'text/markdown',
      sizeBytes: 0,
      status: values.status ?? ('pending' as const),
      contentHash: values.contentHash ?? null,
      metadata: values.metadata ?? {},
    })),
  );
  return ids;
}

describe('runReindex pagination', () => {
  it('re-embeds chunks beyond the first page', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const document = await repo.knowledge.getDocument(db, documentId);
    const versionId = document?.currentVersionId ?? '';
    expect(versionId).not.toBe('');

    await repo.knowledge.insertChunks(db, {
      baseId: fixtureBase.baseId,
      documentId,
      versionId,
      folderId: null,
      chunks: Array.from({ length: OVER_PAGE - 3 }, (_, index) => ({
        ordinal: index + 3,
        kind: 'text' as const,
        heading: null,
        content: `extra chunk ${index}`,
        searchText: `extra chunk ${index}`,
        embedding: null,
        pageFrom: null,
        pageTo: null,
        tokenCount: 10,
      })),
    });
    const before = await allChunks(versionId);
    expect(before).toHaveLength(OVER_PAGE);
    expect(before.filter((chunk) => chunk.embedding === null)).toHaveLength(OVER_PAGE - 3);

    const job = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId,
      sourceId: null,
      payload: {
        type: 'reindex',
        baseId: fixtureBase.baseId,
        documentIds: [documentId],
        chunksOnly: true,
      },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    await runReindex(fixtureBase.deps, claimed, new AbortController().signal);

    const after = await allChunks(versionId);
    expect(after.filter((chunk) => chunk.embedding === null)).toHaveLength(0);
  });

  it('rebuilds documents beyond the first page', async () => {
    const fixtureBase = await makeBase();
    const data = Buffer.from('# 标题\n\n第一段内容。', 'utf8');
    const sha = createHash('sha256').update(data).digest('hex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
    const documentIds = await seedDocuments(fixtureBase, OVER_PAGE, { contentHash: sha });
    expect(documentIds).toHaveLength(OVER_PAGE);

    const job = await repo.knowledge.createJob(db, {
      type: 'reindex',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: null,
      payload: { type: 'reindex', baseId: fixtureBase.baseId },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    await runReindex(fixtureBase.deps, claimed, new AbortController().signal);

    const rebuilt = await db
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId),
          eq(schema.knowledgeDocuments.status, 'ready'),
        ),
      );
    expect(rebuilt).toHaveLength(OVER_PAGE);
    const missing = await db
      .select({ id: schema.knowledgeChunks.id })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.baseId, fixtureBase.baseId));
    // chunkStub 把该 markdown 切成 2 段。
    expect(missing).toHaveLength(OVER_PAGE * 2);
  });
});

describe('runSync', () => {
  const failingConnector: KnowledgeConnector = {
    async *sync() {
      yield {
        sourceId: 'feed:item-1',
        sourceUrl: 'https://example.com/1',
        sourcePath: null,
        title: 'item',
        mimeType: 'text/markdown',
        revision: 'r1',
        content: { markdown: '# item' },
      };
      throw new Error('list failed halfway');
    },
  };

  async function makeSource(
    fixtureBase: Fixture,
    connector: KnowledgeConnector,
    options: { type?: 'feed' | 'gitlab'; status?: 'active' | 'paused' } = {},
  ): Promise<{ sourceId: string; syncRunId: string; jobId: string }> {
    const type = options.type ?? 'feed';
    fixtureBase.deps.connectors = { ...fixtureBase.deps.connectors, [type]: connector };
    const source = await repo.knowledge.createSource(db, {
      baseId: fixtureBase.baseId,
      type,
      name: type,
      config: { syncDeletions: true },
      secretsEncrypted: null,
      syncCron: null,
    });
    if (options.status) {
      await repo.knowledge.updateSource(db, source.id, { status: options.status });
    }
    await repo.knowledge.replaceRanges(db, source.id, [
      {
        kind: type === 'feed' ? 'feed' : 'gitlab_project',
        externalId: 'https://example.com/feed',
        ref: null,
        paths: [],
        enabled: true,
      },
    ]);
    const run = await repo.knowledge.createSyncRun(db, source.id, {});
    const job = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: source.id,
      payload: { type: 'sync', sourceId: source.id, syncRunId: run.id },
    });
    await repo.knowledge.claimJob(db, job.id);
    return { sourceId: source.id, syncRunId: run.id, jobId: job.id };
  }

  it('never disables documents when listing fails', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const {
      sourceId,
      syncRunId,
      jobId: syncJobId,
    } = await makeSource(fixtureBase, failingConnector);
    // 让该已就绪文档归到本来源名下，验证失败时不会被批量 disable。
    await repo.knowledge.updateDocument(db, documentId, {
      metadata: { knowledgeSourceId: sourceId, originalFilename: 'doc.md' },
    });
    const syncJob = await repo.knowledge.getJob(db, syncJobId);
    if (!syncJob) throw new Error('job missing');

    await expect(runSync(fixtureBase.deps, syncJob, new AbortController().signal)).rejects.toThrow(
      'list failed halfway',
    );

    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('ready');
    const run = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (item) => item.id === syncRunId,
    );
    // 终态由队列的 finish 统一写；摄取本身只重抛原错，不能抢先写 failed。
    expect(run?.status).toBe('running');
    expect(run?.endedAt).toBeNull();
    const source = await repo.knowledge.getSource(db, sourceId);
    expect(source?.cursor).toEqual({});
  });

  it('disables removed documents only after a complete listing', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);

    const emptyConnector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 连接器不需要产出条目，只提供完整检查点
      async *sync({ onCheckpoint }) {
        await onCheckpoint({}, { complete: true });
      },
    };
    // 推导删除只对完整枚举来源成立；feed 是滚动窗口，必须再确认一次不能误删。
    const { sourceId, jobId: syncJobId } = await makeSource(fixtureBase, emptyConnector, {
      type: 'gitlab',
    });
    await repo.knowledge.updateDocument(db, documentId, {
      metadata: { knowledgeSourceId: sourceId, originalFilename: 'doc.md' },
      sourceId: 'feishu:gone',
    });
    const syncJob = await repo.knowledge.getJob(db, syncJobId);
    if (!syncJob) throw new Error('job missing');

    await runSync(fixtureBase.deps, syncJob, new AbortController().signal);

    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.status).toBe('disabled');
    // 只 disable，不物理删除。
    expect(document).not.toBeNull();
  });

  it('propagates remote deletions beyond the first page', async () => {
    const fixtureBase = await makeBase();
    const emptyConnector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 空列举，只提供完整检查点
      async *sync({ onCheckpoint }) {
        await onCheckpoint({}, { complete: true });
      },
    };
    const source = await repo.knowledge.createSource(db, {
      baseId: fixtureBase.baseId,
      type: 'gitlab',
      name: 'gitlab-many',
      config: { syncDeletions: true },
      secretsEncrypted: null,
      syncCron: null,
    });
    await repo.knowledge.replaceRanges(db, source.id, [
      {
        kind: 'gitlab_project',
        externalId: 'group/proj',
        ref: 'main',
        paths: [],
        enabled: true,
      },
    ]);
    fixtureBase.deps.connectors = { ...fixtureBase.deps.connectors, gitlab: emptyConnector };
    // 全部归本来源且都不在列举结果里：任何未翻到的页都会漏掉 disable。
    const documentIds = await seedDocuments(fixtureBase, OVER_PAGE, {
      status: 'ready',
      sourceType: 'upload',
      sourceId: (index) => `gitlab:gone-${index}`,
      metadata: { knowledgeSourceId: source.id },
    });
    const run = await repo.knowledge.createSyncRun(db, source.id, {});
    const job = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: source.id,
      payload: { type: 'sync', sourceId: source.id, syncRunId: run.id },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');

    await runSync(fixtureBase.deps, claimed, new AbortController().signal);

    const ready = await db
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId),
          eq(schema.knowledgeDocuments.status, 'ready'),
        ),
      );
    expect(ready).toHaveLength(0);
    expect(documentIds).toHaveLength(OVER_PAGE);
    const syncRun = (await repo.knowledge.listSyncRuns(db, source.id)).items.find(
      (item) => item.id === run.id,
    );
    expect(syncRun?.stats.disabled).toBe(OVER_PAGE);
  });

  it('does not disable untouched documents on a second sync that still lists them', async () => {
    const fixtureBase = await makeBase();
    let listed: string[] = ['item-1', 'item-2'];
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        for (const id of listed) {
          yield {
            sourceId: id,
            sourceUrl: `https://example.com/${id}`,
            sourcePath: null,
            title: id,
            mimeType: 'text/markdown',
            revision: id,
            content: { markdown: `# ${id}` },
          };
        }
        await onCheckpoint({}, { complete: true });
      },
    };
    const { sourceId, jobId } = await makeSource(fixtureBase, connector, { type: 'gitlab' });
    const first = await repo.knowledge.getJob(db, jobId);
    if (!first) throw new Error('job missing');
    await runSync(fixtureBase.deps, first, new AbortController().signal);
    expect(await documentsOfType(fixtureBase, 'gitlab')).toHaveLength(2);

    // 第二次返回完全相同的条目：文档一个都不能被 disable。
    const run = await repo.knowledge.createSyncRun(db, sourceId, {});
    const job = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId,
      payload: { type: 'sync', sourceId, syncRunId: run.id },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('job missing');
    await runSync(fixtureBase.deps, claimed, new AbortController().signal);

    const documents = await documentsOfType(fixtureBase, 'gitlab');
    expect(documents.map((doc) => doc.status).sort()).toEqual(['ready', 'ready']);

    // 第三次少了一个：只有缺失的那个被 disable。
    listed = ['item-1'];
    const thirdRun = await repo.knowledge.createSyncRun(db, sourceId, {});
    const thirdJob = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId,
      payload: { type: 'sync', sourceId, syncRunId: thirdRun.id },
    });
    await repo.knowledge.claimJob(db, thirdJob.id);
    const thirdClaimed = await repo.knowledge.getJob(db, thirdJob.id);
    if (!thirdClaimed) throw new Error('job missing');
    await runSync(fixtureBase.deps, thirdClaimed, new AbortController().signal);

    const after = await documentsOfType(fixtureBase, 'gitlab');
    const bySource = Object.fromEntries(after.map((doc) => [doc.sourceId, doc.status]));
    expect(bySource).toEqual({ 'item-1': 'ready', 'item-2': 'disabled' });
  });

  it('never derives deletions from a rolling feed window, even when syncDeletions is on', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 模拟滚动窗口，没有可产出条目
      async *sync({ onCheckpoint }) {
        await onCheckpoint({}, { complete: false });
      },
    };
    const { sourceId, jobId } = await makeSource(fixtureBase, connector);
    const documentIds = await seedDocuments(fixtureBase, 2, {
      status: 'ready',
      sourceType: 'feed',
      sourceId: (index) => `feed:old-${index}`,
      metadata: { knowledgeSourceId: sourceId },
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runSync(fixtureBase.deps, job, new AbortController().signal);

    const rows = await db
      .select({ id: schema.knowledgeDocuments.id, status: schema.knowledgeDocuments.status })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId));
    expect(rows.map((row) => row.status)).toEqual(['ready', 'ready']);
    expect(rows.map((row) => row.id).sort()).toEqual([...documentIds].sort());
  });

  it('applies an explicit remote deletion from the connector', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        yield {
          sourceId: 'victim',
          sourceUrl: null,
          sourcePath: null,
          title: 'victim',
          mimeType: 'text/markdown',
          revision: 'victim',
          content: { markdown: '# victim' },
        };
        yield {
          sourceId: 'victim',
          sourceUrl: null,
          sourcePath: null,
          title: 'victim',
          mimeType: 'text/markdown',
          revision: 'victim',
          content: { markdown: '# victim' },
          deleted: true,
        };
        await onCheckpoint({}, { complete: true });
      },
    };
    const { sourceId, jobId } = await makeSource(fixtureBase, connector, { type: 'gitlab' });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runSync(fixtureBase.deps, job, new AbortController().signal);

    const documents = await documentsOfType(fixtureBase, 'gitlab');
    expect(documents).toHaveLength(1);
    expect(documents[0]?.status).toBe('disabled');
    const run = (await repo.knowledge.listSyncRuns(db, sourceId)).items[0];
    expect(run?.stats.disabled).toBe(1);
  });

  it('keeps the cursor of a range that failed and leaves the run for the queue to fail', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 第一个 range 读完即失败
      async *sync({ onCheckpoint }) {
        await onCheckpoint(
          { 'gitlab_project|group/a||': { version: 1, initial: true } },
          { complete: false },
        );
        throw new Error('second range failed');
      },
    };
    const { sourceId, syncRunId, jobId } = await makeSource(fixtureBase, connector, {
      type: 'gitlab',
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runSync(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      'second range failed',
    );

    const source = await repo.knowledge.getSource(db, sourceId);
    // 任一 range 失败都不推进来源游标。
    expect(source?.cursor).toEqual({});
    const run = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (item) => item.id === syncRunId,
    );
    expect(run?.status).toBe('running');
    expect(run?.endedAt).toBeNull();
  });

  it('leaves the run pending when the job is aborted so the queue decides cancelled vs retry', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 模拟取消，不产出条目
      async *sync() {
        throw new KnowledgeCancelled();
      },
    };
    const { sourceId, syncRunId, jobId } = await makeSource(fixtureBase, connector, {
      type: 'gitlab',
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runSync(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      'cancelled',
    );

    const run = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (item) => item.id === syncRunId,
    );
    // SIGTERM 会让队列把 job 退回 queued：这里抢先写 cancelled 会与重试冲突。
    expect(run?.status).toBe('running');
    expect(run?.endedAt).toBeNull();
    const source = await repo.knowledge.getSource(db, sourceId);
    expect(source?.cursor).toEqual({});
  });

  it('skips non-active sources without touching their documents', async () => {
    const fixtureBase = await makeBase();
    let called = false;
    const connector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 只用来断言它根本没被调用
      async *sync() {
        called = true;
        await Promise.resolve();
      },
    };
    const { syncRunId, jobId } = await makeSource(fixtureBase, connector, {
      type: 'gitlab',
      status: 'paused',
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runSync(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      'cancelled',
    );

    expect(called).toBe(false);
    const source = await repo.knowledge.getSource(db, job.sourceId ?? '');
    const run = (await repo.knowledge.listSyncRuns(db, job.sourceId ?? '')).items.find(
      (item) => item.id === syncRunId,
    );
    // 跳过不是摄取层能定的终态：队列据 KnowledgeCancelled 写 cancelled。
    expect(run?.status).toBe('running');
    expect(run?.endedAt).toBeNull();
    expect(source?.lastSyncAt).toBeNull();
  });

  it('revokes a source on real auth failures and keeps temporary failures retryable', async () => {
    const fixtureBase = await makeBase();
    let failure: Error | null = null;
    const connector: KnowledgeConnector = {
      async *sync() {
        if (failure) throw failure;
        yield {
          sourceId: 'item-1',
          sourceUrl: 'https://example.com/1',
          sourcePath: null,
          title: 'item-1',
          mimeType: 'text/markdown',
          revision: 'r1',
          content: { markdown: '# item 1' },
        };
        yield* [];
      },
    };
    const first = await makeSource(fixtureBase, connector, { type: 'gitlab' });
    const firstJob = await repo.knowledge.getJob(db, first.jobId);
    if (!firstJob) throw new Error('job missing');
    await runSync(fixtureBase.deps, firstJob, new AbortController().signal);
    const [document] = await documentsOfType(fixtureBase, 'gitlab');
    if (!document) throw new Error('document missing');
    const page = await repo.knowledge.createWikiPage(db, {
      baseId: fixtureBase.baseId,
      slug: `auth-${document.id}`,
      title: '认证',
    });
    // 先有一次已发布版本，来源失权才应把页面标 stale；未发布草稿保持 draft。
    await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '# 认证',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    await db.insert(schema.knowledgeWikiSources).values({
      pageId: page.id,
      documentId: document.id,
      stale: false,
    });

    // 临时故障（超时/限流）不撤权，来源继续 active、文档继续可读。
    failure = new Error('network timeout');
    const transientJob = await repo.knowledge.getJob(db, first.jobId);
    if (!transientJob) throw new Error('job missing');
    await expect(
      runSync(fixtureBase.deps, transientJob, new AbortController().signal),
    ).rejects.toThrow('network timeout');
    expect((await repo.knowledge.getSource(db, first.sourceId))?.status).toBe('active');
    expect((await repo.knowledge.getDocument(db, document.id))?.status).toBe('ready');

    // 明确鉴权失败：来源停用、旧文档退出检索/read、Wiki 引用显式 stale。
    failure = new SourceAuthError('HTTP 401 from https://gitlab.example.com');
    const revokedRun = await repo.knowledge.createSyncRun(db, first.sourceId, {});
    const revokedJob = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: first.sourceId,
      payload: { type: 'sync', sourceId: first.sourceId, syncRunId: revokedRun.id },
    });
    await repo.knowledge.claimJob(db, revokedJob.id);
    const claimed = await repo.knowledge.getJob(db, revokedJob.id);
    if (!claimed) throw new Error('job missing');
    await expect(
      runSync(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toBeInstanceOf(SourceAuthError);

    expect((await repo.knowledge.getSource(db, first.sourceId))?.status).toBe('auth_error');
    expect((await repo.knowledge.getDocument(db, document.id))?.status).toBe('disabled');
    const [link] = await db
      .select({ stale: schema.knowledgeWikiSources.stale })
      .from(schema.knowledgeWikiSources)
      .where(
        and(
          eq(schema.knowledgeWikiSources.pageId, page.id),
          eq(schema.knowledgeWikiSources.documentId, document.id),
        ),
      );
    expect(link?.stale).toBe(true);
    const [pageRow] = await db
      .select({ status: schema.knowledgeWikiPages.status })
      .from(schema.knowledgeWikiPages)
      .where(eq(schema.knowledgeWikiPages.id, page.id));
    expect(pageRow?.status).toBe('stale');
  });

  it('fails the run and keeps the cursor when one item cannot be ingested', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        yield {
          sourceId: 'ok',
          sourceUrl: null,
          sourcePath: null,
          title: 'ok',
          mimeType: 'text/markdown',
          revision: 'ok',
          content: { markdown: '# ok' },
        };
        yield {
          sourceId: 'boom',
          sourceUrl: null,
          sourcePath: null,
          title: 'boom',
          mimeType: '',
          revision: 'boom',
          // 空 markdown 会在摄取时抛错，模拟单个条目解析/写入失败。
          content: { markdown: '   ' },
        };
        await onCheckpoint({ range: { version: 1 } }, { complete: true });
      },
    };
    const { sourceId, syncRunId, jobId } = await makeSource(fixtureBase, connector, {
      type: 'gitlab',
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await expect(runSync(fixtureBase.deps, job, new AbortController().signal)).rejects.toThrow(
      /1 个条目同步失败/,
    );

    const run = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (item) => item.id === syncRunId,
    );
    // 单个条目的永久失败由队列 finish 收成 failed；摄取层只汇总后抛错。
    expect(run?.status).toBe('running');
    expect(run?.endedAt).toBeNull();
    const source = await repo.knowledge.getSource(db, sourceId);
    expect(source?.cursor).toEqual({});
    expect(source?.lastSyncStatus).toBeNull();
  });

  it('reopens the same sync run as running when a retry reuses it', async () => {
    const fixtureBase = await makeBase();
    let runId = '';
    let observed: { status: string; endedAt: Date | null } | null = null;
    const connector: KnowledgeConnector = {
      // biome-ignore lint/correctness/useYield: 只观察 run 状态，不需要产出条目
      async *sync({ onCheckpoint }) {
        const [row] = await db
          .select({
            status: schema.knowledgeSyncRuns.status,
            endedAt: schema.knowledgeSyncRuns.endedAt,
          })
          .from(schema.knowledgeSyncRuns)
          .where(eq(schema.knowledgeSyncRuns.id, runId))
          .limit(1);
        observed = row ?? null;
        await onCheckpoint({}, { complete: true });
      },
    };
    const { syncRunId, jobId } = await makeSource(fixtureBase, connector, { type: 'gitlab' });
    runId = syncRunId;
    // BullMQ 重试复用同一个 job/run；上一次尝试可能已把它写成终态。
    await db
      .update(schema.knowledgeSyncRuns)
      .set({ status: 'failed', endedAt: new Date(), error: 'prior attempt' })
      .where(eq(schema.knowledgeSyncRuns.id, syncRunId));
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');

    await runSync(fixtureBase.deps, job, new AbortController().signal);

    expect(observed).toMatchObject({ status: 'running', endedAt: null });
    const run = (await repo.knowledge.listSyncRuns(db, job.sourceId ?? '')).items.find(
      (item) => item.id === syncRunId,
    );
    expect(run?.status).toBe('succeeded');
    expect(run?.endedAt).not.toBeNull();
  });

  it('propagates transient item failures so the queue can retry without re-ingesting successes', async () => {
    const fixtureBase = await makeBase();
    let parserDown = true;
    fixtureBase.deps.parse = async ({ data }) => {
      const markdown = data.toString('utf8');
      if (parserDown && markdown.includes('TRANSIENT')) {
        throw new KnowledgeParseError('parser_unavailable', 'parser down');
      }
      return { markdown, images: [], pageMap: [] };
    };
    const item = (sourceId: string, content: Buffer | { markdown: string }) => ({
      sourceId,
      sourceUrl: null,
      sourcePath: null,
      title: sourceId,
      mimeType: 'text/markdown',
      revision: 'r1',
      content,
    });
    const connector: KnowledgeConnector = {
      async *sync() {
        yield item('ok', { markdown: '# ok' });
        // Buffer 内容才会走 deps.parse；markdown 对象由连接器直接给出。
        yield item('transient', Buffer.from('# TRANSIENT', 'utf8'));
      },
    };
    const { sourceId, syncRunId, jobId } = await makeSource(fixtureBase, connector, {
      type: 'gitlab',
    });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');

    // 临时解析错误保持原类型，队列现有的分类器才会重试。
    await expect(
      runSync(fixtureBase.deps, job, new AbortController().signal),
    ).rejects.toBeInstanceOf(KnowledgeParseError);
    const firstRun = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (entry) => entry.id === syncRunId,
    );
    // 临时错误可重试：run 必须保持 running，不能抢先写 failed，否则重试期间 UI 显示已结束。
    expect(firstRun?.status).toBe('running');
    expect(firstRun?.endedAt).toBeNull();
    // 游标不推进，重试仍从同一检查点开始。
    expect((await repo.knowledge.getSource(db, sourceId))?.cursor).toEqual({});

    parserDown = false;
    await runSync(fixtureBase.deps, job, new AbortController().signal);

    const documents = await documentsOfType(fixtureBase, 'gitlab');
    const ok = documents.find((document) => document.sourceId === 'ok');
    const transient = documents.find((document) => document.sourceId === 'transient');
    if (!ok || !transient) throw new Error('documents missing');
    // 重试会重新列举 ok，但内容未变时只更新元数据，不再产生第二个版本。
    expect((await repo.knowledge.listVersions(db, ok.id)).items).toHaveLength(1);
    expect((await repo.knowledge.listVersions(db, transient.id)).items).toHaveLength(1);
    const retriedRun = (await repo.knowledge.listSyncRuns(db, sourceId)).items.find(
      (entry) => entry.id === syncRunId,
    );
    expect(retriedRun?.status).toBe('succeeded');
    expect((await repo.knowledge.getSource(db, sourceId))?.lastSyncStatus).toBe('succeeded');
  });

  it('scopes external ids per source connection so two connections never collide', async () => {
    const fixtureBase = await makeBase();
    const items = (prefix: string): KnowledgeConnector => ({
      async *sync({ connectionId, onCheckpoint }) {
        yield {
          sourceId: `${connectionId}:same-id`,
          sourceUrl: null,
          sourcePath: null,
          title: prefix,
          mimeType: 'text/markdown',
          revision: prefix,
          content: { markdown: `# ${prefix}` },
        };
        await onCheckpoint({}, { complete: true });
      },
    });
    const first = await makeSource(fixtureBase, items('first'), { type: 'gitlab' });
    const firstJob = await repo.knowledge.getJob(db, first.jobId);
    if (!firstJob) throw new Error('job missing');
    await runSync(fixtureBase.deps, firstJob, new AbortController().signal);

    const second = await makeSource(fixtureBase, items('second'), { type: 'gitlab' });
    const secondJob = await repo.knowledge.getJob(db, second.jobId);
    if (!secondJob) throw new Error('job missing');
    await runSync(fixtureBase.deps, secondJob, new AbortController().signal);

    const documents = await documentsOfType(fixtureBase, 'gitlab');
    expect(documents).toHaveLength(2);
    expect(documents.map((doc) => doc.title).sort()).toEqual(['first', 'second']);
  });

  it('refreshes title and path when content is unchanged', async () => {
    const fixtureBase = await makeBase();
    let title = 'old-name';
    let path = 'docs/old-name.md';
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        yield {
          sourceId: 'stable',
          sourceUrl: 'https://example.com/stable',
          sourcePath: path,
          title,
          mimeType: 'text/markdown',
          revision: 'stable',
          content: { markdown: '# stable' },
        };
        await onCheckpoint({}, { complete: true });
      },
    };
    const { jobId } = await makeSource(fixtureBase, connector, { type: 'gitlab' });
    const job = await repo.knowledge.getJob(db, jobId);
    if (!job) throw new Error('job missing');
    await runSync(fixtureBase.deps, job, new AbortController().signal);

    title = 'renamed';
    path = 'docs/renamed.md';
    const run = await repo.knowledge.createSyncRun(db, job.sourceId ?? '', {});
    const next = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: job.sourceId,
      payload: { type: 'sync', sourceId: job.sourceId ?? '', syncRunId: run.id },
    });
    await repo.knowledge.claimJob(db, next.id);
    const claimed = await repo.knowledge.getJob(db, next.id);
    if (!claimed) throw new Error('job missing');
    await runSync(fixtureBase.deps, claimed, new AbortController().signal);

    const documents = await documentsOfType(fixtureBase, 'gitlab');
    expect(documents).toHaveLength(1);
    expect(documents[0]?.title).toBe('renamed');
    expect(documents[0]?.sourcePath).toBe('docs/renamed.md');
  });
});

async function documentsOfType(fixtureBase: Fixture, sourceType: 'feed' | 'gitlab') {
  return db
    .select()
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId),
        eq(schema.knowledgeDocuments.sourceType, sourceType),
      ),
    );
}

describe('runCleanup', () => {
  it('deletes only blobs that are unreferenced and older than 24h', async () => {
    const fixtureBase = await makeBase();
    const { documentId, jobId } = await makeUploadedDocument(fixtureBase);
    const ingestJob = await repo.knowledge.getJob(db, jobId);
    if (!ingestJob) throw new Error('job missing');
    await runIngest(fixtureBase.deps, ingestJob, new AbortController().signal);
    const document = await repo.knowledge.getDocument(db, documentId);
    const referencedBlob = document?.contentHash ?? '';

    const { mkdir, writeFile } = await import('node:fs/promises');
    const old = Date.now() / 1000 - 48 * 60 * 60;
    const makeBlob = async (content: string, mtime: number): Promise<string> => {
      const sha = createHash('sha256').update(content).digest('hex');
      const path = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
      await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
      await writeFile(path, content);
      await utimes(path, mtime, mtime);
      return path;
    };
    const staleOrphan = await makeBlob('orphan-old', old);
    const freshOrphan = await makeBlob('orphan-new', Date.now() / 1000);

    const cleanupJob = await repo.knowledge.createJob(db, {
      type: 'cleanup',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup', baseId: fixtureBase.baseId },
    });
    await runCleanup(fixtureBase.deps, cleanupJob, new AbortController().signal);

    await expect(stat(staleOrphan)).rejects.toThrow();
    await expect(stat(freshOrphan)).resolves.toBeDefined();
    const referencedPath = join(knowledgeDir, 'blobs', referencedBlob.slice(0, 2), referencedBlob);
    await expect(stat(referencedPath)).resolves.toBeDefined();
  });
});
