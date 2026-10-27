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
  if (serverIds.length > 0) {
    await pool.query('delete from servers where id = any($1::text[])', [serverIds]);
    serverIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

async function seedBase(): Promise<string> {
  const suffix = randomBytes(4).toString('hex');
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
  const server = await servers.createServer(db, {
    name: `tags-batch-${suffix}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  serverIds.push(server.id);
  const base = await knowledge.createBase(db, {
    slug: `tags-batch-${suffix}`,
    name: 'Tags',
    description: '',
    serverId: server.id,
    embeddingProfileId: profile.id,
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  });
  baseIds.push(base.id);
  return base.id;
}

/** spy 保留真实执行，只统计 Drizzle 经由 pool 发出的 SQL 条数。 */
async function queriesWhile<T>(run: () => Promise<T>): Promise<{ value: T; queries: number }> {
  const spy = vi.spyOn(pool, 'query');
  try {
    const value = await run();
    return { value, queries: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

async function tagNames(baseId: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    'select name from knowledge_tags where base_id = $1 order by name',
    [baseId],
  );
  return rows.map((row) => row.name);
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
    expect(rows.map((row) => row.id)).toEqual(['c', 'a', 'b'].map((name) => byName.get(name)));
    expect(await tagNames(baseId)).toEqual(['a', 'b', 'c']);
  });

  it('混合新旧标签时新行与旧行都按输入顺序返回', async () => {
    const baseId = await seedBase();
    const old = await knowledge.upsertTags(db, baseId, ['old-1', 'old-2']);
    const oldIds = new Map(old.map((row) => [row.name, row.id]));
    const { value: rows, queries } = await queriesWhile(() =>
      knowledge.upsertTags(db, baseId, ['new-1', 'old-2', 'new-2', 'old-1']),
    );
    // 一次批量插入，命中旧行后一次补查。
    expect(queries).toBe(2);
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
    const { rows: counts } = await pool.query<{ name: string; n: number }>(
      'select name, count(*)::int as n from knowledge_tags where base_id = $1 group by name order by name',
      [baseId],
    );
    expect(counts).toEqual([
      { name: 'dup', n: 1 },
      { name: 'one', n: 1 },
      { name: 'other', n: 1 },
    ]);
  });

  it('空数组返回空且不发出任何查询', async () => {
    const baseId = await seedBase();
    const { value, queries } = await queriesWhile(() => knowledge.upsertTags(db, baseId, []));
    expect(value).toEqual([]);
    expect(queries).toBe(0);
  });

  it('不同知识库同名标签各自独立', async () => {
    const firstBase = await seedBase();
    const secondBase = await seedBase();
    const [first, second] = await Promise.all([
      knowledge.upsertTags(db, firstBase, ['shared']),
      knowledge.upsertTags(db, secondBase, ['shared']),
    ]);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    const { rows } = await pool.query<{ base_id: string; id: string }>(
      'select base_id, id from knowledge_tags where name = $1 and base_id = any($2::text[])',
      ['shared', [firstBase, secondBase]],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.base_id))).toEqual(new Set([firstBase, secondBase]));
  });

  it('超过单批上限时完整回填并保持输入顺序', async () => {
    const baseId = await seedBase();
    for (const size of [501, 1100]) {
      const names = Array.from({ length: size }, (_, index) => `bulk-${size}-${index}`);
      // 预置首批、中段、批界、末位标签，覆盖跨批已存在行的复用。
      const existingIndexes = [...new Set([0, Math.floor(size / 2), 499, size - 1])];
      const existing = await knowledge.upsertTags(
        db,
        baseId,
        existingIndexes.map((index) => names[index] as string),
      );
      const existingIds = new Map(existing.map((row) => [row.name, row.id]));

      const { value: rows, queries } = await queriesWhile(() =>
        knowledge.upsertTags(db, baseId, names),
      );
      expect(rows.map((row) => row.name)).toEqual(names);
      for (const index of existingIndexes) {
        expect(rows[index]?.id).toBe(existingIds.get(names[index] as string));
      }
      expect(new Set(rows.map((row) => row.id)).size).toBe(size);
      // 每批一次插入，存在旧行时统一补查一次。
      expect(queries).toBe(Math.ceil(size / 500) + 1);
    }
    const { rows } = await pool.query<{ n: number; unique_names: number }>(
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

  it('单标签查询次数不退化：新增 1 次、已有 2 次', async () => {
    const baseId = await seedBase();
    const created = await queriesWhile(() => knowledge.upsertTags(db, baseId, ['solo']));
    expect(created.queries).toBe(1);
    const again = await queriesWhile(() => knowledge.upsertTags(db, baseId, ['solo']));
    expect(again.queries).toBe(2);
    expect(again.value[0]?.id).toBe(created.value[0]?.id);
  });

  it('多标签查询次数：50 个新标签不超过 2 次，全部已存在 2 次', async () => {
    const baseId = await seedBase();
    const names = Array.from({ length: 50 }, (_, index) => `count-${index}`);
    const fresh = await queriesWhile(() => knowledge.upsertTags(db, baseId, names));
    expect(fresh.value.map((row) => row.name)).toEqual(names);
    expect(fresh.queries).toBeLessThanOrEqual(2);

    const existing = await queriesWhile(() => knowledge.upsertTags(db, baseId, names));
    expect(existing.value.map((row) => row.name)).toEqual(names);
    expect(existing.queries).toBe(2);
  });
});
