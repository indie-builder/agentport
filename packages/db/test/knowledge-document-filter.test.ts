import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import * as knowledge from '../src/repo/knowledge.js';
import * as servers from '../src/repo/servers.js';
import { probeTestDb } from './db-probe.js';

const { db, client, ready } = await probeTestDb();

const baseIds: string[] = [];
const profileIds: string[] = [];
const serverIds: string[] = [];

afterEach(async () => {
  if (baseIds.length > 0) {
    await client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
      client.array(baseIds, 'TEXT'),
    ]);
    baseIds.length = 0;
  }
  if (profileIds.length > 0) {
    await client.unsafe('delete from knowledge_model_profiles where id = any($1::text[])', [
      client.array(profileIds, 'TEXT'),
    ]);
    profileIds.length = 0;
  }
  profileId = '';
  if (serverIds.length > 0) {
    await client.unsafe('delete from servers where id = any($1::text[])', [
      client.array(serverIds, 'TEXT'),
    ]);
    serverIds.length = 0;
  }
});

afterAll(async () => {
  await client.close();
});

let profileId = '';

async function seedBase(): Promise<string> {
  const suffix = crypto.getRandomValues(new Uint8Array(4)).toHex();
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
    title?: string;
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
    title: input.title ?? `doc-${documentSeq}`,
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

describe.skipIf(!ready)('listDocuments 来源过滤', () => {
  it('按 sourceConnectionId 过滤，并保留 base/status 与无过滤全量', async () => {
    const baseId = await seedBase();
    const otherBaseId = await seedBase();
    const sourceA = `ksrc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const sourceB = `ksrc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;

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
    const foreign = await seedDocument(otherBaseId, {
      sourceId: 'a:foreign',
      sourceConnectionId: sourceA,
    });

    const filtered = await knowledge.listDocuments(db, { baseId, sourceConnectionId: sourceA });
    const filteredIds = filtered.items.map((document) => document.id).sort();
    expect(filteredIds).toEqual([aReady1, aReady2, aPending].sort());
    expect(filtered.items.every((document) => document.sourceConnectionId === sourceA)).toBe(true);
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
    const source = `ksrc_${crypto.getRandomValues(new Uint8Array(6)).toHex()}`;
    const ownIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ownIds.push(
        await seedDocument(baseId, {
          sourceId: `own:${index}`,
          sourceConnectionId: source,
        }),
      );
    }
    for (let index = 0; index < 5; index += 1) {
      await seedDocument(baseId, {
        sourceId: `other:${index}`,
        sourceConnectionId: 'ksrc_other',
      });
    }

    const oneShot = await knowledge.listDocuments(db, {
      baseId,
      sourceConnectionId: source,
      limit: 50,
    });

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

    expect(ids).toEqual(oneShot.items.map((document) => document.id));
    expect(ids.sort()).toEqual([...ownIds].sort());
  });

  it('搜索词里的 % 与 _ 按字面匹配', async () => {
    const baseId = await seedBase();
    const plain = await seedDocument(baseId, { title: 'plain' });
    const percent = await seedDocument(baseId, { title: '100% done' });
    const underscore = await seedDocument(baseId, { title: 'a_b' });

    const quotedPercent = await knowledge.listDocuments(db, { baseId, q: '%' });
    expect(quotedPercent.items.map((document) => document.id)).toEqual([percent]);

    const quotedUnderscore = await knowledge.listDocuments(db, { baseId, q: '_' });
    expect(quotedUnderscore.items.map((document) => document.id)).toEqual([underscore]);

    const all = await knowledge.listDocuments(db, { baseId });
    expect(all.items.map((document) => document.id).sort()).toEqual(
      [plain, percent, underscore].sort(),
    );
  });
});
