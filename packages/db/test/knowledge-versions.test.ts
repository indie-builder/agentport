import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as knowledge from '../src/repo/knowledge.js';
import * as servers from '../src/repo/servers.js';
import { schema } from '../src/schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? '',
  max: 4,
  statement_timeout: 15_000,
  connectionTimeoutMillis: 5_000,
});
// 事务走独立连接，pool.query 探针看不到 BEGIN/COMMIT，必须用 Drizzle logger。
const logged: string[] = [];
const db = drizzle(pool, { schema, logger: { logQuery: (query) => logged.push(query) } });
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

async function seedDocument(): Promise<{ documentId: string }> {
  const suffix = randomBytes(4).toString('hex');
  const profile = await knowledge.createModelProfile(db, {
    kind: 'embedding',
    name: `versions-${suffix}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    secretsEncrypted: null,
    enabled: true,
  });
  profileId = profile.id;
  const server = await servers.createServer(db, {
    name: `versions-${suffix}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  serverId = server.id;
  const base = await knowledge.createBase(db, {
    slug: `versions-${suffix}`,
    name: 'Versions',
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
    title: '版本文档',
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: 1,
  });
  return { documentId: document.id };
}

/** Drizzle 0.45 把 pg 错误包成 DrizzleQueryError，code 在 cause 上。 */
function pgCode(error: unknown): string | undefined {
  const direct = (error as { code?: string }).code;
  if (direct) return direct;
  return (error as { cause?: { code?: string } }).cause?.code;
}

function versionInput(
  documentId: string,
  inputProfileId = profileId,
  overrides: Partial<knowledge.CreateVersionInput> = {},
): knowledge.CreateVersionInput {
  return {
    documentId,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: 'doc.md',
    mimeType: 'text/markdown',
    sizeBytes: 128,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: inputProfileId,
    ...overrides,
  };
}

describe.skipIf(!ready)('knowledge document versions', () => {
  it('首版为 1 并返回全部写入字段', async () => {
    const { documentId } = await seedDocument();
    const pageMap = [{ page: 1, startOffset: 0, endOffset: 12 }];
    const images = [
      {
        name: 'figure.png',
        sha256: 'c'.repeat(64),
        mimeType: 'image/png',
        page: 2,
        warnings: ['低分辨率'],
      },
    ];

    const row = await knowledge.createVersion(
      db,
      versionInput(documentId, profileId, {
        sourceRevision: 'rev-1',
        pageMap,
        images,
      }),
    );

    expect(row.id).toMatch(/^kdv_/);
    expect(row.version).toBe(1);
    expect(row.documentId).toBe(documentId);
    expect(row.blobSha256).toBe('a'.repeat(64));
    expect(row.markdownSha256).toBe('b'.repeat(64));
    expect(row.originalFilename).toBe('doc.md');
    expect(row.mimeType).toBe('text/markdown');
    expect(row.sizeBytes).toBe(128);
    expect(row.sourceRevision).toBe('rev-1');
    expect(row.parseStatus).toBe('parsed');
    expect(row.pageMap).toEqual(pageMap);
    expect(row.images).toEqual(images);
    expect(row.embeddingProfileId).toBe(profileId);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('连续创建按 1、2、3 递增', async () => {
    const { documentId } = await seedDocument();

    const versions: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      versions.push((await knowledge.createVersion(db, versionInput(documentId))).version);
    }

    expect(versions).toEqual([1, 2, 3]);
  });

  it('不同文档各自从 1 独立计数', async () => {
    const { documentId: first } = await seedDocument();
    const secondList = await knowledge.createDocument(db, {
      baseId,
      folderId: null,
      title: '另一份',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
    });

    expect((await knowledge.createVersion(db, versionInput(first))).version).toBe(1);
    expect((await knowledge.createVersion(db, versionInput(secondList.id))).version).toBe(1);
    expect((await knowledge.createVersion(db, versionInput(first))).version).toBe(2);
    expect((await knowledge.createVersion(db, versionInput(secondList.id))).version).toBe(2);
  });

  it('外键错误原样传播，当前版本保持不变', async () => {
    const { documentId } = await seedDocument();
    const first = await knowledge.createVersion(db, versionInput(documentId));
    const published = await knowledge.setCurrentVersion(db, documentId, first.id);
    expect(published?.currentVersionId).toBe(first.id);

    let error: unknown;
    try {
      await knowledge.createVersion(db, versionInput(documentId, 'kmp_missing_profile'));
    } catch (caught) {
      error = caught;
    }
    expect(pgCode(error)).toBe('23503');

    const document = await knowledge.getDocument(db, documentId);
    expect(document?.currentVersionId).toBe(first.id);
    const versions = await knowledge.listVersions(db, documentId);
    expect(versions.items.map((row) => row.version)).toEqual([1]);
  });

  it('同文档并发按唯一约束成功或明确 23505', async () => {
    const { documentId } = await seedDocument();

    const results = await Promise.allSettled([
      knowledge.createVersion(db, versionInput(documentId)),
      knowledge.createVersion(db, versionInput(documentId)),
    ]);
    const ok = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');

    if (failed.length > 0) {
      expect(failed).toHaveLength(1);
      expect(pgCode((failed[0] as PromiseRejectedResult).reason)).toBe('23505');
      expect(ok).toHaveLength(1);
      expect((ok[0] as PromiseFulfilledResult<knowledge.KnowledgeVersionRow>).value.version).toBe(
        1,
      );
    } else {
      expect(
        ok
          .map((result) => (result as PromiseFulfilledResult<knowledge.KnowledgeVersionRow>).value)
          .map((row) => row.version)
          .sort((a, b) => a - b),
      ).toEqual([1, 2]);
    }

    const versions = await knowledge.listVersions(db, documentId);
    expect(versions.items).toHaveLength(ok.length);
    expect(new Set(versions.items.map((row) => row.version))).toEqual(
      new Set(
        ok.map(
          (result) =>
            (result as PromiseFulfilledResult<knowledge.KnowledgeVersionRow>).value.version,
        ),
      ),
    );
  });

  it('只发一次 INSERT，不再包事务也不单查 MAX', async () => {
    const { documentId } = await seedDocument();
    logged.length = 0;

    await knowledge.createVersion(db, versionInput(documentId));

    expect(logged).toHaveLength(1);
    const [statement = ''] = logged;
    expect(statement).toMatch(/^insert into "knowledge_document_versions"/i);
    expect(statement.toLowerCase()).toContain('coalesce(max(');
    expect(logged.some((query) => /^(begin|commit|rollback)\b/i.test(query.trim()))).toBe(false);
    expect(logged.some((query) => /^\s*select\b/i.test(query))).toBe(false);
  });
});
