import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import * as knowledge from '../src/repo/knowledge.js';
import * as servers from '../src/repo/servers.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

let serverId = '';
let profileId = '';
let baseId = '';

afterEach(async () => {
  if (baseId) await pool.query('delete from knowledge_bases where id = $1', [baseId]);
  if (profileId)
    await pool.query('delete from knowledge_model_profiles where id = $1', [profileId]);
  if (serverId) await pool.query('delete from servers where id = $1', [serverId]);
  baseId = '';
  profileId = '';
  serverId = '';
});

afterAll(async () => {
  await pool.end();
});

async function seedChunk(text: string) {
  const profile = await knowledge.createModelProfile(db, {
    kind: 'embedding',
    name: `chunk-summary-${randomBytes(4).toString('hex')}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    secretsEncrypted: null,
    enabled: true,
  });
  profileId = profile.id;
  const server = await servers.createServer(db, {
    name: `chunk-summary-${randomBytes(4).toString('hex')}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  serverId = server.id;
  const base = await knowledge.createBase(db, {
    slug: `chunk-summary-${randomBytes(4).toString('hex')}`,
    name: 'Chunk summary',
    description: '',
    serverId: server.id,
    embeddingProfileId: profile.id,
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  });
  baseId = base.id;
  const document = await knowledge.createDocument(db, {
    baseId: base.id,
    folderId: null,
    title: '分块文档',
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: 1,
  });
  const version = await knowledge.createVersion(db, {
    documentId: document.id,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: 'chunk.md',
    mimeType: 'text/markdown',
    sizeBytes: 1,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: profile.id,
  });
  const [chunk] = await knowledge.insertChunks(db, {
    baseId: base.id,
    documentId: document.id,
    versionId: version.id,
    folderId: null,
    chunks: [
      {
        ordinal: 0,
        kind: 'text',
        heading: '标题',
        content: text,
        searchText: text,
        embedding: Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)),
        pageFrom: 1,
        pageTo: 1,
        tokenCount: 3,
      },
    ],
  });
  if (!chunk) throw new Error('chunk insert returned no row');
  return { chunk, versionId: version.id };
}

describe.skipIf(!ready)('knowledge chunk summaries', () => {
  it('listChunks 仍返回完整行，worker 能读到向量与分词', async () => {
    const { chunk, versionId } = await seedChunk('令牌 轮换');

    const page = await knowledge.listChunks(db, versionId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: chunk.id,
      content: '令牌 轮换',
      searchText: '令牌 轮换',
    });
    expect(page.items[0]?.embedding).not.toBeNull();
  });

  it('listChunkSummaries 只投影展示字段，列级权限下也能读', async () => {
    const { chunk, versionId } = await seedChunk('令牌 轮换');
    const role = `kchk_reader_${randomBytes(4).toString('hex')}`;
    const readerPassword = 'test-reader-password';
    await pool.query(`create role ${role} login password '${readerPassword}'`);
    await pool.query(
      `grant select (id, document_id, version_id, ordinal, kind, heading, content, enabled,
         edited_by_user, page_from, page_to, token_count, metadata)
       on knowledge_chunks to ${role}`,
    );
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.username = role;
    url.password = readerPassword;
    const reader = createDb(url.toString());
    try {
      const page = await knowledge.listChunkSummaries(reader.db, versionId);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: chunk.id,
        documentId: chunk.documentId,
        versionId,
        ordinal: 0,
        kind: 'text',
        heading: '标题',
        content: '令牌 轮换',
        enabled: true,
        editedByUser: false,
        pageFrom: 1,
        pageTo: 1,
        tokenCount: 3,
        metadata: {},
      });
      expect(page.items[0]).not.toHaveProperty('embedding');
    } finally {
      await reader.pool.end();
      await pool.query(`drop owned by ${role}`);
      await pool.query(`drop role if exists ${role}`);
    }
  });
});
