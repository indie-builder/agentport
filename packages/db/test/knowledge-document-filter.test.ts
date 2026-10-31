import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client.js';
import * as knowledge from '../src/repo/knowledge.js';
import * as servers from '../src/repo/servers.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const baseIds: string[] = [];
const profileIds: string[] = [];
const serverIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (baseIds.length > 0) {
    await pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    baseIds.length = 0;
  }
  if (profileIds.length > 0) {
    await pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
      profileIds,
    ]);
    profileIds.length = 0;
  }
  profileId = '';
  if (serverIds.length > 0) {
    await pool.query('delete from servers where id = any($1::text[])', [serverIds]);
    serverIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

let profileId = '';

async function seedBase(): Promise<string> {
  const suffix = randomBytes(4).toString('hex');
  if (!profileId) {
    const profile = await knowledge.createModelProfile(db, {
      kind: 'embedding',
      name: `document-filter-${suffix}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'test',
      dimensions: 1024,
      secretsEncrypted: null,
      enabled: true,
    });
    profileId = profile.id;
    profileIds.push(profile.id);
  }
  // 一个 server 只允许挂一个知识库。
  const server = await servers.createServer(db, {
    name: `document-filter-${suffix}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  serverIds.push(server.id);
  const base = await knowledge.createBase(db, {
    slug: `document-filter-${suffix}`,
    name: 'Document filter',
    description: '',
    serverId: server.id,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  });
  baseIds.push(base.id);
  return base.id;
}

let documentSeq = 0;
async function seedDocument(
  baseId: string,
  input: {
    sourceType?: 'gitlab' | 'manual' | 'upload';
    sourceId?: string | null;
    sourceConnectionId?: string | null;
    status?: 'pending' | 'processing' | 'ready' | 'failed' | 'disabled';
  } = {},
): Promise<string> {
  documentSeq += 1;
  const document = await knowledge.createDocument(db, {
    baseId,
    folderId: null,
    title: `doc-${documentSeq}`,
    sourceType: input.sourceType ?? 'gitlab',
    sourceId: input.sourceId ?? null,
    sourceUrl: null,
    sourcePath: null,
    sourceConnectionId: input.sourceConnectionId ?? null,
    mimeType: 'text/markdown',
    sizeBytes: 0,
  });
  const status = input.status ?? 'ready';
  if (status !== 'pending') {
    await knowledge.updateDocument(db, document.id, { status });
  }
  return document.id;
}

interface CapturedQuery {
  text: string;
  values: unknown[];
}

/** 保留真实执行，只旁路记录该次调用发出的 SQL 与参数。 */
async function captureQueries<T>(
  run: () => Promise<T>,
): Promise<{ value: T; queries: CapturedQuery[] }> {
  const spy = vi.spyOn(pool, 'query');
  try {
    const value = await run();
    const queries = spy.mock.calls.map((call) => {
      const query = call[0] as string | { text?: string };
      return {
        text: typeof query === 'string' ? query : (query?.text ?? ''),
        values: (call[1] ?? []) as unknown[],
      };
    });
    return { value, queries };
  } finally {
    spy.mockRestore();
  }
}

const documentQueries = (queries: CapturedQuery[]): CapturedQuery[] =>
  queries.filter((query) => query.text.includes('from "knowledge_documents"'));

describe.skipIf(!ready)('listDocuments 来源过滤', () => {
  it('把 sourceConnectionId 下推为 SQL 过滤，并保留 base/status 与无过滤全量', async () => {
    const baseId = await seedBase();
    const otherBaseId = await seedBase();
    const sourceA = `ksrc_${randomBytes(6).toString('hex')}`;
    const sourceB = `ksrc_${randomBytes(6).toString('hex')}`;

    const aReady1 = await seedDocument(baseId, {
      sourceId: 'a:1',
      sourceConnectionId: sourceA,
    });
    const aReady2 = await seedDocument(baseId, {
      sourceId: 'a:2',
      sourceConnectionId: sourceA,
    });
    const aPending = await seedDocument(baseId, {
      sourceId: 'a:3',
      status: 'pending',
      sourceConnectionId: sourceA,
    });
    const bReady = await seedDocument(baseId, {
      sourceId: 'b:1',
      sourceConnectionId: sourceB,
    });
    const manual = await seedDocument(baseId, { sourceType: 'manual' });
    const missing = await seedDocument(baseId, { sourceId: 'missing:1' });
    // 同一来源 ID 在另一个库：baseId 仍必须限定范围。
    const foreign = await seedDocument(otherBaseId, {
      sourceId: 'a:foreign',
      sourceConnectionId: sourceA,
    });

    const { value: filtered, queries } = await captureQueries(() =>
      knowledge.listDocuments(db, { baseId, sourceConnectionId: sourceA }),
    );
    const filteredIds = filtered.items.map((document) => document.id).sort();
    expect(filteredIds).toEqual([aReady1, aReady2, aPending].sort());
    expect(filtered.items.every((document) => document.sourceConnectionId === sourceA)).toBe(true);

    const sql = documentQueries(queries);
    expect(sql).toHaveLength(1);
    expect(sql[0]?.text).toContain('source_connection_id');
    expect(sql[0]?.values).toContain(sourceA);
    expect(filteredIds).not.toContain(foreign);

    const readyOnly = await knowledge.listDocuments(db, {
      baseId,
      sourceConnectionId: sourceA,
      status: 'ready',
    });
    expect(readyOnly.items.map((document) => document.id).sort()).toEqual(
      [aReady1, aReady2].sort(),
    );

    const all = await knowledge.listDocuments(db, { baseId, limit: 50 });
    expect(all.items.map((document) => document.id).sort()).toEqual(
      [aReady1, aReady2, aPending, bReady, manual, missing].sort(),
    );
    expect(all.items.map((document) => document.id)).not.toContain(foreign);
  });

  it('过滤后的分页顺序与游标和一次性读取完全一致', async () => {
    const baseId = await seedBase();
    const source = `ksrc_${randomBytes(6).toString('hex')}`;
    const ownIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ownIds.push(
        await seedDocument(baseId, {
          sourceId: `own:${index}`,
          sourceConnectionId: source,
        }),
      );
    }
    // 交错另一来源，证明分页游标不会把别的来源算进页内或页边界。
    for (let index = 0; index < 5; index += 1) {
      await seedDocument(baseId, {
        sourceId: `other:${index}`,
        sourceConnectionId: 'ksrc_other',
      });
    }

    const { value: oneShot } = await captureQueries(() =>
      knowledge.listDocuments(db, { baseId, sourceConnectionId: source, limit: 50 }),
    );

    const { value: pagedIds, queries } = await captureQueries(async () => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await knowledge.listDocuments(db, {
          baseId,
          sourceConnectionId: source,
          limit: 2,
          cursor,
        });
        pages += 1;
        ids.push(...page.items.map((document) => document.id));
        if (page.nextCursor !== null) {
          expect(page.nextCursor).toBe(page.items.at(-1)?.id);
        }
        cursor = page.nextCursor;
        if (pages > 10) throw new Error('分页没有收敛');
      } while (cursor !== null);
      return ids;
    });

    expect(pagedIds).toEqual(oneShot.items.map((document) => document.id));
    expect(pagedIds.sort()).toEqual([...ownIds].sort());
    const sql = documentQueries(queries);
    expect(sql).toHaveLength(4);
    for (const query of sql) {
      expect(query.text).toContain('source_connection_id');
      expect(query.values).toContain(source);
    }
  });
});
