import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { knowledgeBaseSettingsSchema } from '@agentport/shared';
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

async function seedBase(): Promise<string> {
  const suffix = crypto.getRandomValues(new Uint8Array(4)).toHex();
  const profile = await knowledge.createModelProfile(db, {
    kind: 'embedding',
    name: `tags-batch-${suffix}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    secretsEncrypted: null,
    enabled: true,
  });
  profileIds.push(profile.id);
  const server = await servers.createServer(
    db,
    {
      name: `tags-batch-${suffix}`,
      kind: 'knowledge' as never,
      description: '',
      config: {},
      secretsEncrypted: null,
    },
    null,
  );
  serverIds.push(server.id);
  const base = await knowledge.createBase(db, {
    slug: `tags-batch-${suffix}`,
    name: 'Tags',
    description: '',
    serverId: server.id,
    embeddingProfileId: profile.id,
    rerankProfileId: null,
    settings: knowledgeBaseSettingsSchema.parse({
      chunkTokens: 800,
      chunkOverlap: 120,
      wikiAutoUpdate: false,
    }),
  });
  baseIds.push(base.id);
  return base.id;
}

async function tagNames(baseId: string): Promise<string[]> {
  const rows = await client.unsafe<{ name: string }[]>(
    'select name from knowledge_tags where base_id = $1 order by name',
    [baseId],
  );
  return rows.map((row) => row.name);
}

async function seedDocument(baseId: string): Promise<string> {
  const document = await knowledge.createDocument(db, {
    baseId,
    folderId: null,
    title: 'origin.md',
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: 3,
  });
  return document.id;
}

describe.skipIf(!ready)('knowledge tags batch upsert', () => {
  it('全新标签按输入顺序返回并各建一行', async () => {
    const baseId = await seedBase();
    const names = ['gamma', 'alpha', 'beta'];
    const rows = await knowledge.upsertTags(db, baseId, names);
    expect(rows.map((row) => row.name)).toEqual(names);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(await tagNames(baseId)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('全部已存在时仍按本次输入顺序返回且复用原行', async () => {
    const baseId = await seedBase();
    const created = await knowledge.upsertTags(db, baseId, ['a', 'b', 'c']);
    const byName = new Map(created.map((row) => [row.name, row.id]));
    const rows = await knowledge.upsertTags(db, baseId, ['c', 'a', 'b']);
    expect(rows.map((row) => row.name)).toEqual(['c', 'a', 'b']);
    const expectedIds = ['c', 'a', 'b'].map((name) => {
      const id = byName.get(name);
      if (!id) throw new Error(`missing tag ${name}`);
      return id;
    });
    expect(rows.map((row) => row.id)).toEqual(expectedIds);
    expect(await tagNames(baseId)).toEqual(['a', 'b', 'c']);
  });

  it('混合新旧标签时新行与旧行都按输入顺序返回', async () => {
    const baseId = await seedBase();
    const old = await knowledge.upsertTags(db, baseId, ['old-1', 'old-2']);
    const oldIds = new Map(old.map((row) => [row.name, row.id]));
    const rows = await knowledge.upsertTags(db, baseId, ['new-1', 'old-2', 'new-2', 'old-1']);
    expect(rows.map((row) => row.name)).toEqual(['new-1', 'old-2', 'new-2', 'old-1']);
    expect(rows[1]?.id).toBe(oldIds.get('old-2'));
    expect(rows[3]?.id).toBe(oldIds.get('old-1'));
    expect(await tagNames(baseId)).toEqual(['new-1', 'new-2', 'old-1', 'old-2']);
  });

  it('重复输入按首次出现的顺序去重，不产生重复行', async () => {
    const baseId = await seedBase();
    const rows = await knowledge.upsertTags(db, baseId, ['dup', 'one', 'dup', 'other', 'one']);
    expect(rows.map((row) => row.name)).toEqual(['dup', 'one', 'other']);
    expect(await tagNames(baseId)).toEqual(['dup', 'one', 'other']);
    const counts = await client.unsafe<{ name: string; n: number }[]>(
      'select name, count(*)::int as n from knowledge_tags where base_id = $1 group by name order by name',
      [baseId],
    );
    expect([...counts]).toEqual([
      { name: 'dup', n: 1 },
      { name: 'one', n: 1 },
      { name: 'other', n: 1 },
    ]);
  });

  it('空数组返回空', async () => {
    const baseId = await seedBase();
    expect(await knowledge.upsertTags(db, baseId, [])).toEqual([]);
  });

  it('不同知识库同名标签各自独立', async () => {
    const firstBase = await seedBase();
    const secondBase = await seedBase();
    const [first, second] = await Promise.all([
      knowledge.upsertTags(db, firstBase, ['shared']),
      knowledge.upsertTags(db, secondBase, ['shared']),
    ]);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    const rows = await client.unsafe<{ base_id: string; id: string }[]>(
      'select base_id, id from knowledge_tags where name = $1 and base_id = any($2::text[])',
      ['shared', client.array([firstBase, secondBase], 'TEXT')],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.base_id))).toEqual(new Set([firstBase, secondBase]));
  });

  it('超过单批上限时完整回填并保持输入顺序', async () => {
    const baseId = await seedBase();
    for (const size of [501, 1100]) {
      const names = Array.from({ length: size }, (_, index) => `bulk-${size}-${index}`);
      const existingIndexes = [...new Set([0, Math.floor(size / 2), 499, size - 1])];
      const existing = await knowledge.upsertTags(
        db,
        baseId,
        existingIndexes.map((index) => names[index] as string),
      );
      const existingIds = new Map(existing.map((row) => [row.name, row.id]));

      const rows = await knowledge.upsertTags(db, baseId, names);
      expect(rows.map((row) => row.name)).toEqual(names);
      for (const index of existingIndexes) {
        expect(rows[index]?.id).toBe(existingIds.get(names[index] as string));
      }
      expect(new Set(rows.map((row) => row.id)).size).toBe(size);
    }
    const rows = await client.unsafe<{ n: number; unique_names: number }[]>(
      'select count(*)::int as n, count(distinct name)::int as unique_names from knowledge_tags where base_id = $1',
      [baseId],
    );
    expect(rows[0]?.n).toBe(1601);
    expect(rows[0]?.unique_names).toBe(1601);
  });

  it('并发同一批只创建一套标签且不抛错', async () => {
    const baseId = await seedBase();
    const names = ['race-a', 'race-b', 'race-c'];
    const [first, second] = await Promise.all([
      knowledge.upsertTags(db, baseId, names),
      knowledge.upsertTags(db, baseId, names),
    ]);
    expect(first.map((row) => row.name)).toEqual(names);
    expect(second.map((row) => row.name)).toEqual(names);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3);
    expect(await tagNames(baseId)).toEqual(['race-a', 'race-b', 'race-c']);
  });
});

describe.skipIf(!ready)('knowledge document tag origin', () => {
  it('reconcileDocumentTags 保留已有 origin，只把新增项记为 manual', async () => {
    const baseId = await seedBase();
    const documentId = await seedDocument(baseId);
    const seeded = await knowledge.upsertTags(db, baseId, ['keep', 'drop', 'manual-existing']);
    const ids = new Map(seeded.map((row) => [row.name, row.id]));
    const keep = ids.get('keep');
    const drop = ids.get('drop');
    const manual = ids.get('manual-existing');
    if (!keep || !drop || !manual) throw new Error('seed tags missing');
    await client.unsafe(
      `insert into knowledge_document_tags (document_id, tag_id, origin)
       values ($1, $2, 'auto'), ($1, $3, 'auto'), ($1, $4, 'manual')`,
      [documentId, keep, drop, manual],
    );

    await knowledge.reconcileDocumentTags(db, documentId, baseId, ['keep', 'new']);

    const rows = await knowledge.getDocumentTagRows(db, documentId);
    const byName = new Map(rows.map((row) => [row.name, row.origin]));
    expect(byName.get('keep')).toBe('auto');
    expect(byName.get('new')).toBe('manual');
    expect(byName.has('drop')).toBe(false);
    expect(byName.has('manual-existing')).toBe(false);
  });

  it('setDocumentTags 仍把全部标签写成 manual', async () => {
    const baseId = await seedBase();
    const documentId = await seedDocument(baseId);
    const rows = await knowledge.upsertTags(db, baseId, ['a', 'b']);

    await knowledge.setDocumentTags(
      db,
      documentId,
      rows.map((row) => row.id),
    );

    const stored = await knowledge.getDocumentTagRows(db, documentId);
    expect(stored.map((row) => row.origin)).toEqual(['manual', 'manual']);
  });
});
