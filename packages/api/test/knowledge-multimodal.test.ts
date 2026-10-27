import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type KnowledgeDeps, runReindex } from '../../worker/src/knowledge/ingestion.js';
import { createParsingAdapter } from '../../worker/src/knowledge/parsing-adapter.js';
import { buildApp } from '../src/app.js';
import {
  exportKnowledgePackage,
  importKnowledgePackage,
} from '../src/features/knowledge/package.js';
import { readKnowledgeImage } from '../src/features/knowledge/read-image.js';
import { searchKnowledge } from '../src/features/knowledge/retrieval.js';
import { infraReady, inject, loginCookie, testConfig, unique } from './helpers.js';

const ready = await infraReady;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as KnowledgeDeps['logger'];

function vectorFor(text: string): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = text.includes('token') || text.includes('令牌') ? 1 : 0.01;
  return vector;
}

let fixtureUrl = '';
let cohereRoot = '';
const cohereBodies: Array<Record<string, unknown>> = [];
const servers: ReturnType<typeof createServer>[] = [];

async function startFixture(): Promise<void> {
  const fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.url === '/v2/embed') {
        cohereBodies.push(body);
        const inputs = (body.texts ?? body.images ?? []) as string[];
        return respond(200, {
          embeddings: { float: inputs.map((input) => vectorFor(String(input))) },
        });
      }
      if (req.url === '/embeddings') {
        const inputs = (body.input ?? []) as string[];
        return respond(200, { data: inputs.map((input) => ({ embedding: vectorFor(input) })) });
      }
      return respond(404, { error: 'not found' });
    });
  });
  servers.push(fixture);
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address() as AddressInfo;
  fixtureUrl = `http://127.0.0.1:${address.port}`;
  cohereRoot = `${fixtureUrl}/v2`;
}

describe.skipIf(!ready)('knowledge multimodal API', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createProfile(payload: Record<string, unknown>) {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload,
    });
    if (res.statusCode === 201) profileIds.push(res.json<{ id: string }>().id);
    return res;
  }

  async function createBase(payload: Record<string, unknown>) {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload,
    });
    if (res.statusCode === 201) baseIds.push(res.json<{ id: string }>().id);
    return res;
  }

  async function textProfile() {
    const res = await createProfile({
      kind: 'embedding',
      name: unique('text-emb'),
      endpointUrl: fixtureUrl,
      model: 'test-embed',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function imageProfile() {
    const res = await createProfile({
      kind: 'embedding',
      name: unique('image-emb'),
      endpointUrl: cohereRoot,
      model: 'embed-v4.0',
      embeddingProtocol: 'cohere_v2',
      imageInputEnabled: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const profile = res.json<{
      id: string;
      embeddingProtocol: string;
      imageInputEnabled: boolean;
    }>();
    expect(profile.embeddingProtocol).toBe('cohere_v2');
    expect(profile.imageInputEnabled).toBe(true);
    return profile.id;
  }

  beforeAll(async () => {
    await startFixture();
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-multimodal-'));
    app = await buildApp(testConfig({ KNOWLEDGE_DIR: knowledgeDir }));
    await app.ready();
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
    await Promise.all(servers.map((server) => new Promise((r) => server.close(r))));
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  describe('base settings and model profiles', () => {
    it('saves image processing settings and rejects enabled without a model', async () => {
      const profileId = await textProfile();
      const saved = await createBase({
        slug: unique('mm-kb'),
        name: '多模态库',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: 'claude-vision-test' },
        },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const base = saved.json<{ id: string; settings: { imageProcessing: { model: string } } }>();
      expect(base.settings.imageProcessing.model).toBe('claude-vision-test');
      const fetched = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${base.id}`,
        headers: { cookie },
      });
      expect(
        fetched.json<{ settings: { imageProcessing: { enabled: boolean } } }>().settings
          .imageProcessing.enabled,
      ).toBe(true);

      const invalid = await createBase({
        slug: unique('mm-kb'),
        name: '坏设置',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: null },
        },
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('rejects image vectors unless the embedding profile supports them', async () => {
      const profileId = await textProfile();
      const rejected = await createBase({
        slug: unique('mm-kb'),
        name: '无图片能力',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: 'vision', imageVectorEnabled: true },
        },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json<{ message: string }>().message).toContain('图片向量');

      const cohereId = await imageProfile();
      const accepted = await createBase({
        slug: unique('mm-kb'),
        name: '有图片能力',
        embeddingProfileId: cohereId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: 'vision', imageVectorEnabled: true },
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
    });

    it('rejects in-place model/protocol/capability changes on a referenced profile', async () => {
      const cohereId = await imageProfile();
      const baseRes = await createBase({
        slug: unique('mm-kb'),
        name: '引用库',
        embeddingProfileId: cohereId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: 'vision' },
        },
      });
      expect(baseRes.statusCode, baseRes.body).toBe(201);

      // 保持能力组合合法，确保命中「已被引用不可原地更换」而不是输入校验。
      for (const payload of [
        { model: 'other-model', imageInputEnabled: false },
        { embeddingProtocol: 'openai', imageInputEnabled: false },
        { imageInputEnabled: false },
      ]) {
        const res = await inject(app, {
          method: 'PATCH',
          url: `/api/knowledge/model-profiles/${cohereId}`,
          headers: { cookie },
          payload,
        });
        expect(res.statusCode, `${JSON.stringify(payload)} ${res.body}`).toBe(409);
      }
      const rename = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/model-profiles/${cohereId}`,
        headers: { cookie },
        payload: { name: unique('renamed-emb') },
      });
      expect(rename.statusCode, rename.body).toBe(200);
    });

    it('rejects switching to a rerank or disabled profile on both embedding and rerank slots', async () => {
      const textId = await textProfile();
      const base = await createBase({
        slug: unique('mm-kb'),
        name: '切 profile 库',
        embeddingProfileId: textId,
      });
      expect(base.statusCode, base.body).toBe(201);
      const baseId = base.json<{ id: string }>().id;

      const rerankRes = await createProfile({
        kind: 'rerank',
        name: unique('rerank'),
        endpointUrl: fixtureUrl,
        model: 'test-rerank',
      });
      expect(rerankRes.statusCode, rerankRes.body).toBe(201);
      const rerankId = rerankRes.json<{ id: string }>().id;

      const disabledRes = await createProfile({
        kind: 'embedding',
        name: unique('disabled-emb'),
        endpointUrl: fixtureUrl,
        model: 'test-embed',
        enabled: false,
      });
      expect(disabledRes.statusCode, disabledRes.body).toBe(201);
      const disabledId = disabledRes.json<{ id: string }>().id;

      for (const payload of [
        { embeddingProfileId: rerankId },
        { embeddingProfileId: disabledId },
        { rerankProfileId: textId },
        { rerankProfileId: disabledId },
      ]) {
        const res = await inject(app, {
          method: 'PATCH',
          url: `/api/knowledge/bases/${baseId}`,
          headers: { cookie },
          payload,
        });
        expect(res.statusCode, `${JSON.stringify(payload)} ${res.body}`).toBe(400);
      }

      const unchanged = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${baseId}`,
        headers: { cookie },
      });
      expect(unchanged.json()).toMatchObject({
        embeddingProfileId: textId,
        rerankProfileId: null,
      });

      // 不换绑时仍可改名/停用：已绑 profile 后来被停用，不能卡住库自身的维护。
      const afterDisable = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/model-profiles/${textId}`,
        headers: { cookie },
        payload: { enabled: false },
      });
      expect(afterDisable.statusCode, afterDisable.body).toBe(200);
      const rename = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${baseId}`,
        headers: { cookie },
        payload: { name: '已停用 profile 的库', status: 'disabled' },
      });
      expect(rename.statusCode, rename.body).toBe(200);
      await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/model-profiles/${textId}`,
        headers: { cookie },
        payload: { enabled: true },
      });
    });

    it('rejects content/heading edits on vector chunks but still allows enable/disable', async () => {
      const profileId = await imageProfile();
      const base = await createBase({
        slug: unique('mm-vec-patch'),
        name: '向量分块库',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: true, model: 'vision', imageVectorEnabled: true },
        },
      });
      const baseId = base.json<{ id: string }>().id;
      const document = await repo.knowledge.createDocument(app.db, {
        baseId,
        folderId: null,
        title: '图册',
        sourceType: 'upload',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });
      const version = await repo.knowledge.createVersion(app.db, {
        documentId: document.id,
        blobSha256: 'a'.repeat(64),
        markdownSha256: 'b'.repeat(64),
        originalFilename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [
          {
            name: 'fig-1.png',
            sha256: 'c'.repeat(64),
            mimeType: 'image/png',
            page: 1,
            warnings: [],
          },
        ],
        embeddingProfileId: profileId,
      });
      const [chunk] = await repo.knowledge.insertChunks(app.db, {
        baseId,
        documentId: document.id,
        versionId: version.id,
        folderId: null,
        chunks: [
          {
            ordinal: 0,
            kind: 'image',
            heading: null,
            content: '图中显示令牌轮换',
            searchText: '',
            embedding: vectorFor('token'),
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 0,
            metadata: {
              image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
              imageRole: 'vector',
            },
          },
        ],
      });
      await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);

      for (const payload of [{ content: '把描述改掉' }, { heading: '新标题' }]) {
        const res = await inject(app, {
          method: 'PATCH',
          url: `/api/knowledge/chunks/${chunk!.id}`,
          headers: { cookie },
          payload,
        });
        expect(res.statusCode, `${JSON.stringify(payload)} ${res.body}`).toBe(409);
      }

      // 图片定位不可由用户改：PATCH body 没有 metadata 字段，传入也被 schema 丢弃。
      const located = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/chunks/${chunk!.id}`,
        headers: { cookie },
        payload: {
          metadata: {
            image: { name: 'other.png', mimeType: 'image/png', page: 2 },
            imageRole: 'caption',
          },
        },
      });
      expect(located.statusCode, located.body).toBe(200);
      expect(located.json<{ metadata: unknown }>().metadata).toMatchObject({
        image: { name: 'fig-1.png' },
        imageRole: 'vector',
      });

      const toggled = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/chunks/${chunk!.id}`,
        headers: { cookie },
        payload: { enabled: false },
      });
      expect(toggled.statusCode, toggled.body).toBe(200);
      expect(toggled.json<{ enabled: boolean }>().enabled).toBe(false);

      const row = await repo.knowledge.getChunk(app.db, chunk!.id);
      expect(row?.content).toBe('图中显示令牌轮换');
      expect(row?.metadata).toMatchObject({ image: { name: 'fig-1.png' }, imageRole: 'vector' });
    });

    it('rejects unsupported image capability combinations and probes images on test', async () => {
      const rerank = await createProfile({
        kind: 'rerank',
        name: unique('rerank'),
        endpointUrl: fixtureUrl,
        model: 'test-rerank',
        imageInputEnabled: true,
      });
      expect(rerank.statusCode).toBe(400);

      const wrongModel = await createProfile({
        kind: 'embedding',
        name: unique('bad-image'),
        endpointUrl: cohereRoot,
        model: 'embed-v3',
        embeddingProtocol: 'cohere_v2',
        imageInputEnabled: true,
      });
      expect(wrongModel.statusCode).toBe(400);

      const cohereId = await imageProfile();
      const before = cohereBodies.length;
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/model-profiles/${cohereId}/test`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
      const bodies = cohereBodies.slice(before);
      expect(bodies.some((body) => Array.isArray(body.images))).toBe(true);
      expect(bodies.some((body) => Array.isArray(body.texts))).toBe(true);
    });
  });

  describe('retrieval with image chunks', () => {
    async function seedImageLibrary(
      profileId: string,
      options: { minScore?: number; imageVectorEnabled?: boolean } = {},
    ) {
      const base = await createBase({
        slug: unique('mm-search'),
        name: '检索库',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: {
            enabled: true,
            model: 'vision',
            imageVectorEnabled: options.imageVectorEnabled ?? true,
            ...(options.minScore === undefined ? {} : { imageVectorMinScore: options.minScore }),
          },
        },
      });
      expect(base.statusCode, base.body).toBe(201);
      const baseId = base.json<{ id: string }>().id;
      const document = await repo.knowledge.createDocument(app.db, {
        baseId,
        folderId: null,
        title: '图册',
        sourceType: 'upload',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'application/pdf',
        sizeBytes: 100,
      });
      const version = await repo.knowledge.createVersion(app.db, {
        documentId: document.id,
        blobSha256: 'a'.repeat(64),
        markdownSha256: 'b'.repeat(64),
        originalFilename: '图册.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [
          {
            name: 'fig-1.png',
            sha256: 'c'.repeat(64),
            mimeType: 'image/png',
            page: 1,
            warnings: [],
          },
        ],
        embeddingProfileId: profileId,
      });
      const chunks = await repo.knowledge.insertChunks(app.db, {
        baseId,
        documentId: document.id,
        versionId: version.id,
        folderId: null,
        chunks: [
          {
            ordinal: 0,
            kind: 'text',
            heading: null,
            content: '访问令牌需要轮换',
            searchText: '访问 令牌 需要 轮换',
            embedding: vectorFor('token'),
            pageFrom: null,
            pageTo: null,
            tokenCount: 4,
          },
          {
            ordinal: 1,
            kind: 'image',
            heading: null,
            content: '图 1 展示令牌轮换流程',
            searchText: '图 展示 令牌 轮换 流程',
            embedding: vectorFor('token'),
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 6,
            metadata: {
              image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
              imageRole: 'caption',
            },
          },
          {
            ordinal: 2,
            kind: 'image',
            heading: null,
            content: '图 1 展示令牌轮换流程',
            searchText: '',
            // 与文本查询向量方向不同：cos≈0.707，可区分 0.95 / 0.5 两个阈值。
            embedding: Array.from({ length: 1024 }, (_, i) => (i < 2 ? 1 : 0)),
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 0,
            metadata: {
              image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
              imageRole: 'vector',
            },
          },
        ],
      });
      await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);
      await mkdir(join(knowledgeDir, 'docs', document.id, version.id, 'images'), {
        recursive: true,
      });
      await writeFile(
        join(knowledgeDir, 'docs', document.id, version.id, 'images', 'fig-1.png'),
        PNG,
      );
      return { baseId, document, version, chunks };
    }

    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: false };

    it('rejects REST search on a disabled base with 409', async () => {
      const profileId = await imageProfile();
      const { baseId } = await seedImageLibrary(profileId, { imageVectorEnabled: false });
      const url = `/api/knowledge/bases/${baseId}/search?q=${encodeURIComponent('令牌')}`;
      const active = await inject(app, { method: 'GET', url, headers: { cookie } });
      expect(active.statusCode, active.body).toBe(200);

      await app.pool.query("update knowledge_bases set status = 'disabled' where id = $1", [
        baseId,
      ]);
      const disabled = await inject(app, { method: 'GET', url, headers: { cookie } });
      expect(disabled.statusCode, disabled.body).toBe(409);
      expect(disabled.json<{ message: string }>().message).toContain('禁用');
    });

    it('projects image metadata to hits and keeps vector-role chunks out of keyword results', async () => {
      const profileId = await imageProfile();
      const { baseId, chunks } = await seedImageLibrary(profileId, { imageVectorEnabled: false });
      const result = await searchKnowledge(
        app.db,
        baseId,
        { ...query, q: '令牌' },
        {
          secretKey: app.config.APP_SECRET_KEY,
        },
      );
      const caption = result.hits.find((hit) => hit.chunkId === chunks[1]!.id);
      expect(caption?.image).toEqual({ name: 'fig-1.png', mimeType: 'image/png', page: 1 });
      expect(result.hits.map((hit) => hit.chunkId)).not.toContain(chunks[2]!.id);
      expect(result.hits.find((hit) => hit.chunkId === chunks[0]!.id)?.image).toBeNull();
    });

    it('recalls image vectors on their own path with the min score cutoff', async () => {
      const profileId = await imageProfile();
      const below = await seedImageLibrary(profileId, { minScore: 0.95 });
      const belowResult = await searchKnowledge(
        app.db,
        below.baseId,
        { ...query, q: '图片' },
        {
          secretKey: app.config.APP_SECRET_KEY,
        },
      );
      expect(belowResult.hits.map((hit) => hit.chunkId)).not.toContain(below.chunks[2]!.id);

      const above = await seedImageLibrary(profileId, { minScore: 0.5 });
      const aboveResult = await searchKnowledge(
        app.db,
        above.baseId,
        { ...query, q: '图片' },
        {
          secretKey: app.config.APP_SECRET_KEY,
        },
      );
      expect(aboveResult.hits.map((hit) => hit.chunkId)).toContain(above.chunks[2]!.id);
    });

    it('does not mix spaces after switching the library profile', async () => {
      const first = await imageProfile();
      const { baseId } = await seedImageLibrary(first);
      const second = await textProfile();
      const patch = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${baseId}`,
        headers: { cookie },
        payload: {
          embeddingProfileId: second,
          settings: { imageProcessing: { imageVectorEnabled: false } },
        },
      });
      expect(patch.statusCode, patch.body).toBe(200);
      const result = await searchKnowledge(
        app.db,
        baseId,
        { ...query, q: 'token rotation' },
        { secretKey: app.config.APP_SECRET_KEY },
      );
      expect(result.hits).toHaveLength(0);
    });
  });

  describe('read image', () => {
    async function seedReadable(options: { enabled?: boolean; mimeType?: string } = {}) {
      const profileId = await imageProfile();
      const base = await createBase({
        slug: unique('mm-read'),
        name: '读图库',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: { enabled: options.enabled ?? true, model: 'vision' },
        },
      });
      expect(base.statusCode, base.body).toBe(201);
      const baseId = base.json<{ id: string }>().id;
      const document = await repo.knowledge.createDocument(app.db, {
        baseId,
        folderId: null,
        title: '图册',
        sourceType: 'upload',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });
      const mimeType = options.mimeType ?? 'image/png';
      const version = await repo.knowledge.createVersion(app.db, {
        documentId: document.id,
        blobSha256: 'a'.repeat(64),
        markdownSha256: 'b'.repeat(64),
        originalFilename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [{ name: 'fig-1.png', sha256: 'c'.repeat(64), mimeType, page: 1, warnings: [] }],
        embeddingProfileId: profileId,
      });
      const [chunk] = await repo.knowledge.insertChunks(app.db, {
        baseId,
        documentId: document.id,
        versionId: version.id,
        folderId: null,
        chunks: [
          {
            ordinal: 0,
            kind: 'image',
            heading: null,
            content: '图中显示令牌轮换流程',
            searchText: '图 显示 令牌 轮换 流程',
            embedding: null,
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 5,
            metadata: {
              image: { name: 'fig-1.png', mimeType, page: 1 },
              imageRole: 'caption',
            },
          },
        ],
      });
      await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);
      const dir = join(knowledgeDir, 'docs', document.id, version.id);
      await mkdir(join(dir, 'images'), { recursive: true });
      await writeFile(join(dir, 'images', 'fig-1.png'), PNG);
      return { baseId, document, version, chunk: chunk!, profileId };
    }

    const input = (baseId: string) => ({
      db: app.db,
      baseId,
      serverId: 'srv',
      runId: 'run',
      secretKey: app.config.APP_SECRET_KEY,
      knowledgeDir,
    });

    it('returns description by default and the image when asked', async () => {
      const seeded = await seedReadable();
      const description = await readKnowledgeImage(input(seeded.baseId), {
        chunkId: seeded.chunk.id,
        format: 'description',
      });
      expect(description.image).toBeUndefined();
      expect(description.result.description).toBe('图中显示令牌轮换流程');
      expect(description.result.hit.image).toEqual({
        name: 'fig-1.png',
        mimeType: 'image/png',
        page: 1,
      });

      const withImage = await readKnowledgeImage(input(seeded.baseId), {
        chunkId: seeded.chunk.id,
        format: 'image',
      });
      expect(withImage.image).toEqual({ mimeType: 'image/png', data: PNG_BASE64 });
      expect(withImage.result).toEqual(description.result);
    });

    it('rejects disabled base, disabled processing, disabled chunk and stale versions', async () => {
      const seeded = await seedReadable();
      await expect(
        readKnowledgeImage(
          input(
            (
              await createBase({
                slug: unique('mm-read-off'),
                name: '关图库',
                embeddingProfileId: seeded.profileId,
                settings: {
                  chunkTokens: 800,
                  chunkOverlap: 120,
                  wikiAutoUpdate: false,
                  imageProcessing: { enabled: false },
                },
              })
            ).json<{ id: string }>().id,
          ),
          { chunkId: seeded.chunk.id, format: 'description' },
        ),
      ).rejects.toMatchObject({ code: 'IMAGE_PROCESSING_DISABLED' });

      await app.pool.query("update knowledge_bases set status = 'disabled' where id = $1", [
        seeded.baseId,
      ]);
      await expect(
        readKnowledgeImage(input(seeded.baseId), {
          chunkId: seeded.chunk.id,
          format: 'description',
        }),
      ).rejects.toMatchObject({ code: 'BASE_DISABLED' });
      await app.pool.query("update knowledge_bases set status = 'active' where id = $1", [
        seeded.baseId,
      ]);

      await repo.knowledge.patchChunk(app.db, seeded.chunk.id, { enabled: false });
      await expect(
        readKnowledgeImage(input(seeded.baseId), {
          chunkId: seeded.chunk.id,
          format: 'description',
        }),
      ).rejects.toMatchObject({ code: 'CHUNK_NOT_FOUND' });
      await repo.knowledge.patchChunk(app.db, seeded.chunk.id, { enabled: true });

      const newer = await repo.knowledge.createVersion(app.db, {
        documentId: seeded.document.id,
        blobSha256: 'd'.repeat(64),
        markdownSha256: 'e'.repeat(64),
        originalFilename: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        embeddingProfileId: seeded.profileId,
      });
      await repo.knowledge.setCurrentVersion(app.db, seeded.document.id, newer.id);
      await expect(
        readKnowledgeImage(input(seeded.baseId), {
          chunkId: seeded.chunk.id,
          format: 'description',
        }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_READY' });
    });

    it('rejects non-visual mime types and oversized images for the image format', async () => {
      const tiff = await seedReadable({ mimeType: 'image/tiff' });
      await expect(
        readKnowledgeImage(input(tiff.baseId), { chunkId: tiff.chunk.id, format: 'image' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });

      const large = await seedReadable();
      await writeFile(
        join(knowledgeDir, 'docs', large.document.id, large.version.id, 'images', 'fig-1.png'),
        Buffer.alloc(5 * 1024 * 1024 + 1),
      );
      await expect(
        readKnowledgeImage(input(large.baseId), { chunkId: large.chunk.id, format: 'image' }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });
  });

  describe('knowledge package', () => {
    async function seedPackageLibrary(options: { imageVectorEnabled?: boolean } = {}) {
      const profileId = await imageProfile();
      const base = await createBase({
        slug: unique('mm-pkg'),
        name: '打包图库',
        embeddingProfileId: profileId,
        settings: {
          chunkTokens: 800,
          chunkOverlap: 120,
          wikiAutoUpdate: false,
          imageProcessing: {
            enabled: true,
            model: 'vision',
            imageVectorEnabled: options.imageVectorEnabled ?? false,
          },
        },
      });
      expect(base.statusCode, base.body).toBe(201);
      const { id: baseId, serverId } = base.json<{ id: string; serverId: string }>();
      const document = await repo.knowledge.createDocument(app.db, {
        baseId,
        folderId: null,
        title: '图册',
        sourceType: 'upload',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'text/markdown',
        sizeBytes: 1,
      });
      const original = Buffer.from('# 图册\n');
      const sha = createHash('sha256').update(original).digest('hex');
      await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
      await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), original);
      const imageSha = createHash('sha256').update(PNG).digest('hex');
      const version = await repo.knowledge.createVersion(app.db, {
        documentId: document.id,
        blobSha256: sha,
        markdownSha256: 'b'.repeat(64),
        originalFilename: 'x.md',
        mimeType: 'text/markdown',
        sizeBytes: original.length,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [
          { name: 'fig-1.png', sha256: imageSha, mimeType: 'image/png', page: 1, warnings: [] },
        ],
        embeddingProfileId: profileId,
      });
      const chunks = await repo.knowledge.insertChunks(app.db, {
        baseId,
        documentId: document.id,
        versionId: version.id,
        folderId: null,
        chunks: [
          {
            ordinal: 0,
            kind: 'image',
            heading: null,
            content: '图中显示令牌轮换',
            searchText: '图 显示 令牌 轮换',
            embedding: null,
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 5,
            metadata: {
              image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
              imageRole: 'caption',
            },
          },
          {
            ordinal: 1,
            kind: 'image',
            heading: null,
            content: '图中显示令牌轮换',
            searchText: '',
            embedding: vectorFor('token'),
            pageFrom: 1,
            pageTo: 1,
            tokenCount: 0,
            metadata: {
              image: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
              imageRole: 'vector',
            },
          },
        ],
      });
      await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);
      const dir = join(knowledgeDir, 'docs', document.id, version.id);
      await mkdir(join(dir, 'images'), { recursive: true });
      await writeFile(join(dir, 'images', 'fig-1.png'), PNG);
      return { baseId, profileId, chunks, serverId };
    }

    type PackageImage = {
      name: string;
      sha256: string;
      mimeType: string;
      page: number;
      path: string;
    };
    type PackageVersion = {
      id: string;
      version: number;
      originalPath: string;
      markdownPath: string | null;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      blobSha256: string;
      markdownSha256: string | null;
      sourceRevision: string | null;
      parseStatus: string;
      pageMap: unknown[];
      images: PackageImage[];
      chunks: Array<{ id: string; kind: string; metadata: Record<string, unknown> }>;
    };
    type PackageManifest = {
      documents: Array<{ versions: PackageVersion[] }>;
      files: Array<{ path: string; sha256: string; size: number }>;
    };

    async function editPackage(
      baseId: string,
      mutate: (manifest: PackageManifest, files: Record<string, Uint8Array>) => void,
    ): Promise<Buffer> {
      const pkg = await exportKnowledgePackage(app.db, knowledgeDir, baseId);
      const files = unzipSync(new Uint8Array(pkg!.body));
      const manifest = JSON.parse(
        Buffer.from(files['manifest.json']!).toString('utf8'),
      ) as PackageManifest;
      mutate(manifest, files);
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
      return Buffer.from(zipSync(files, { level: 6 }));
    }

    it('keeps vector chunk identity/metadata on export and imports it without an embedding', async () => {
      const seeded = await seedPackageLibrary();
      // 停用状态不在导出/导入中丢失：vector 身份复用的是同一行。
      await repo.knowledge.patchChunk(app.db, seeded.chunks[1]!.id, { enabled: false });
      const pkg = await exportKnowledgePackage(app.db, knowledgeDir, seeded.baseId);
      expect(pkg).not.toBeNull();
      const files = unzipSync(new Uint8Array(pkg!.body));
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')) as {
        base: {
          embeddingProfile: { embeddingProtocol: string; imageInputEnabled: boolean };
          settings: { imageProcessing: { enabled: boolean } };
        };
        documents: Array<{
          versions: Array<{
            chunks: Array<{
              enabled: boolean;
              metadata: { imageRole?: string; image?: unknown };
            }>;
          }>;
        }>;
      };
      expect(manifest.base.embeddingProfile.embeddingProtocol).toBe('cohere_v2');
      expect(manifest.base.embeddingProfile.imageInputEnabled).toBe(true);
      expect(manifest.base.settings.imageProcessing.enabled).toBe(true);
      const chunks = manifest.documents[0]!.versions[0]!.chunks;
      expect(chunks.map((chunk) => chunk.metadata.imageRole)).toEqual(['caption', 'vector']);
      expect(chunks.map((chunk) => chunk.enabled)).toEqual([true, false]);

      await app.pool.query('delete from servers where id = $1', [seeded.serverId]);
      const imported = await importKnowledgePackage(app.db, knowledgeDir, pkg!.body);
      baseIds.push(imported.baseId);
      const rows = await app.pool.query<{
        kind: string;
        enabled: boolean;
        metadata: { imageRole: string; image: { name: string } };
        search_text: string;
        embedding: unknown;
      }>(
        'select kind, enabled, metadata, search_text, embedding from knowledge_chunks where base_id = $1 order by ordinal',
        [imported.baseId],
      );
      expect(rows.rows.map((row) => row.metadata.imageRole)).toEqual(['caption', 'vector']);
      // 描述保留、向量不迁移：导入后靠 reindex chunksOnly 按原图补，不在这里调模型。
      expect(rows.rows.every((row) => row.embedding === null)).toBe(true);
      // vector chunk 身份与原图绑定保留，但不进关键词索引；停用状态同样保留。
      expect(rows.rows[1]).toMatchObject({
        kind: 'image',
        enabled: false,
        search_text: '',
        metadata: { image: { name: 'fig-1.png' } },
      });
    });

    it('rejects image metadata without an image, non-image kinds, and mismatched MIME/page', async () => {
      const seeded = await seedPackageLibrary();

      // 只有 imageRole、没有 image：导入后既没有可读图也没有检索路径，必须拒绝。
      await expect(
        importKnowledgePackage(
          app.db,
          knowledgeDir,
          await editPackage(seeded.baseId, (manifest) => {
            const chunk = manifest.documents[0]!.versions[0]!.chunks[0]!;
            delete chunk.metadata.image;
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // kind=text 却带图片定位：检索给出图片身份，read_image 又因 kind 拒绝，必须拒绝。
      await expect(
        importKnowledgePackage(
          app.db,
          knowledgeDir,
          await editPackage(seeded.baseId, (manifest) => {
            manifest.documents[0]!.versions[0]!.chunks[0]!.kind = 'text';
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      // 页码与清单不符：原图定位会被篡改。
      await expect(
        importKnowledgePackage(
          app.db,
          knowledgeDir,
          await editPackage(seeded.baseId, (manifest) => {
            const metadata = manifest.documents[0]!.versions[0]!.chunks[0]!.metadata as {
              image: { page: number };
            };
            metadata.image.page = 9;
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('页码') });

      // MIME 与清单不符：同名图片存在，但定位到的是另一份内容。
      await expect(
        importKnowledgePackage(
          app.db,
          knowledgeDir,
          await editPackage(seeded.baseId, (manifest) => {
            const metadata = manifest.documents[0]!.versions[0]!.chunks[0]!.metadata as {
              image: { mimeType: string };
            };
            metadata.image.mimeType = 'image/jpeg';
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('MIME') });

      // 同时篡改 MIME 与页码时先报 MIME，保持既有检查顺序。
      await expect(
        importKnowledgePackage(
          app.db,
          knowledgeDir,
          await editPackage(seeded.baseId, (manifest) => {
            const metadata = manifest.documents[0]!.versions[0]!.chunks[0]!.metadata as {
              image: { mimeType: string; page: number };
            };
            metadata.image.mimeType = 'image/jpeg';
            metadata.image.page = 9;
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('MIME') });
    });

    it('rejects duplicate image names within one version even when mime/page differ', async () => {
      const seeded = await seedPackageLibrary();
      const count = async () =>
        (
          await app.pool.query<{ count: string }>(
            'select count(*) from knowledge_bases where embedding_profile_id = $1',
            [seeded.profileId],
          )
        ).rows[0]?.count;
      const before = await count();

      const duplicate = await editPackage(seeded.baseId, (manifest) => {
        const version = manifest.documents[0]!.versions[0]!;
        version.images.push({ ...version.images[0]!, mimeType: 'image/jpeg', page: 9 });
      });
      await expect(importKnowledgePackage(app.db, knowledgeDir, duplicate)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('重复'),
      });

      // 校验在事务前完成：被拒绝的包不会留下任何新库。
      expect(await count()).toBe(before);
    });

    it('allows the same image name across versions with their own page/mime', async () => {
      const seeded = await seedPackageLibrary();
      const archive = await editPackage(seeded.baseId, (manifest, files) => {
        const document = manifest.documents[0]!;
        const first = document.versions[0]!;
        const image = first.images[0]!;
        const firstDir = first.originalPath.slice(0, first.originalPath.lastIndexOf('/'));
        const secondDir = `${firstDir}-v2`;
        const secondOriginal = `${secondDir}/original`;
        const secondImage = `${secondDir}/images/${image.name}`;
        files[secondOriginal] = files[first.originalPath]!;
        files[secondImage] = files[image.path]!;
        for (const path of [first.originalPath, image.path]) {
          manifest.files.push({
            ...manifest.files.find((file) => file.path === path)!,
            path: path === first.originalPath ? secondOriginal : secondImage,
          });
        }
        document.versions.push({
          ...first,
          id: `${first.id}-v2`,
          version: first.version + 1,
          originalPath: secondOriginal,
          markdownPath: null,
          markdownSha256: null,
          images: [{ ...image, path: secondImage, mimeType: 'image/jpeg', page: 7 }],
          chunks: [
            {
              ...first.chunks[0]!,
              id: `${first.chunks[0]!.id}-v2`,
              metadata: {
                image: { name: image.name, mimeType: 'image/jpeg', page: 7 },
                imageRole: 'caption',
              },
            },
          ],
        });
      });

      await app.pool.query('delete from servers where id = $1', [seeded.serverId]);
      const imported = await importKnowledgePackage(app.db, knowledgeDir, archive);
      baseIds.push(imported.baseId);

      const rows = await app.pool.query<{
        version: number;
        images: Array<{ name: string; mimeType: string; page: number }>;
        chunks: Array<{ image: { name: string; mimeType: string; page: number } }>;
      }>(
        `select v.version, v.images,
                (select json_agg(c.metadata order by c.ordinal)
                   from knowledge_chunks c where c.version_id = v.id) as chunks
           from knowledge_document_versions v
           join knowledge_documents d on d.id = v.document_id
          where d.base_id = $1
          order by v.version`,
        [imported.baseId],
      );
      expect(
        rows.rows.map((row) => ({
          images: row.images.map(({ name, mimeType, page }) => ({ name, mimeType, page })),
          chunk: row.chunks[0]!.image,
        })),
      ).toEqual([
        {
          images: [{ name: 'fig-1.png', mimeType: 'image/png', page: 1 }],
          chunk: { name: 'fig-1.png', mimeType: 'image/png', page: 1 },
        },
        {
          images: [{ name: 'fig-1.png', mimeType: 'image/jpeg', page: 7 }],
          chunk: { name: 'fig-1.png', mimeType: 'image/jpeg', page: 7 },
        },
      ]);
    });

    it('rejects a valid-looking chunk image name missing from the version image list', async () => {
      const seeded = await seedPackageLibrary();
      const count = async () =>
        (
          await app.pool.query<{ count: string }>(
            'select count(*) from knowledge_bases where embedding_profile_id = $1',
            [seeded.profileId],
          )
        ).rows[0]?.count;
      const before = await count();

      // missing.png 是合法单段文件名，能过 schema，但不在本版本的图片清单里。
      const missing = await editPackage(seeded.baseId, (manifest) => {
        const metadata = manifest.documents[0]!.versions[0]!.chunks[0]!.metadata as {
          image: { name: string };
        };
        metadata.image.name = 'missing.png';
      });
      await expect(importKnowledgePackage(app.db, knowledgeDir, missing)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/清单外的图片.*missing\.png/),
      });

      // 校验在事务前完成：清单外的图片不会留下新库。
      expect(await count()).toBe(before);
    });

    it('rejects packages whose chunk metadata points outside the version image list', async () => {
      const seeded = await seedPackageLibrary();
      const pkg = await exportKnowledgePackage(app.db, knowledgeDir, seeded.baseId);
      const files = unzipSync(new Uint8Array(pkg!.body));
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')) as {
        documents: Array<{
          versions: Array<{ chunks: Array<{ metadata: { image: { name: string } } }> }>;
        }>;
      };
      manifest.documents[0]!.versions[0]!.chunks[0]!.metadata.image.name = '../escape.png';
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
      const tampered = Buffer.from(zipSync(files, { level: 6 }));
      await expect(importKnowledgePackage(app.db, knowledgeDir, tampered)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it('refuses to pretend ready when the local profile lacks image capability', async () => {
      const seeded = await seedPackageLibrary();
      const pkg = await exportKnowledgePackage(app.db, knowledgeDir, seeded.baseId);
      const files = unzipSync(new Uint8Array(pkg!.body));
      const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')) as {
        base: { settings: { imageProcessing: { enabled: boolean; imageVectorEnabled: boolean } } };
      };
      manifest.base.settings.imageProcessing.enabled = true;
      manifest.base.settings.imageProcessing.imageVectorEnabled = true;
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
      await expect(
        importKnowledgePackage(app.db, knowledgeDir, Buffer.from(zipSync(files, { level: 6 }))),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('refills the imported vector chunk via chunksOnly without running image description', async () => {
      const seeded = await seedPackageLibrary({ imageVectorEnabled: true });
      const pkg = await exportKnowledgePackage(app.db, knowledgeDir, seeded.baseId);
      await app.pool.query('delete from servers where id = $1', [seeded.serverId]);
      const imported = await importKnowledgePackage(app.db, knowledgeDir, pkg!.body);
      baseIds.push(imported.baseId);

      // 导入的库保持「图片语义启用 + 图片向量启用」；描述模型不允许被调用。
      const importedBase = await repo.knowledge.getBase(app.db, imported.baseId);
      expect(importedBase?.settings.imageProcessing).toMatchObject({
        enabled: true,
        imageVectorEnabled: true,
      });
      const deps: KnowledgeDeps = {
        db: app.db,
        logger: quiet,
        knowledgeDir,
        parse: createParsingAdapter().parse,
        chunkMarkdown: createParsingAdapter().chunkMarkdown,
        connectors: {},
        decrypt: () => {
          throw new Error('chunksOnly 不应解密凭证');
        },
        imageQueryFn: () => {
          throw new Error('chunksOnly 不应生成图片描述');
        },
      };
      const job = await repo.knowledge.createJob(app.db, {
        type: 'reindex',
        baseId: imported.baseId,
        documentId: null,
        sourceId: null,
        payload: { type: 'reindex', baseId: imported.baseId, chunksOnly: true },
      });
      await repo.knowledge.claimJob(app.db, job.id);
      const claimed = await repo.knowledge.getJob(app.db, job.id);
      if (!claimed) throw new Error('job missing');
      await runReindex(deps, claimed, new AbortController().signal);

      const rows = await app.pool.query<{
        kind: string;
        metadata: { imageRole: string; image: { name: string } };
        search_text: string;
        embedding: string | null;
      }>(
        'select kind, metadata, search_text, embedding from knowledge_chunks where base_id = $1 order by ordinal',
        [imported.baseId],
      );
      // 描述 chunk 走文字 embedding，vector chunk 由原图字节补回 1024 维并仍指向同一张图。
      expect(rows.rows[0]!.embedding).not.toBeNull();
      expect(rows.rows[1]!.embedding).toMatch(/^\[/);
      expect(rows.rows[1]!.metadata.image.name).toBe('fig-1.png');
      expect(rows.rows[1]!.search_text).toBe('');
      const vector = JSON.parse(rows.rows[1]!.embedding!) as number[];
      expect(vector).toHaveLength(1024);
      // fixture 对含「令牌」的文字返回 [1,...]，图片 data URI 返回 [0.01,...]；这里必须走图片路径。
      expect(vector[0]).toBeCloseTo(0.01);
      expect(cohereBodies.some((body) => Array.isArray(body.images))).toBe(true);
    });
  });
});
