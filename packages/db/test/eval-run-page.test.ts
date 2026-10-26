import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as evalRepo from '../src/repo/eval.js';
import { agents } from '../src/schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

describe.skipIf(!ready)('eval run list pagination', () => {
  const agentId = newId('agent');
  const otherAgentId = newId('agent');
  const base = newId('evalRun');

  beforeAll(async () => {
    await db.insert(agents).values([
      { id: agentId, slug: `eval-page-${agentId}`, name: 'eval page', model: 'test' },
      {
        id: otherAgentId,
        slug: `eval-page-other-${otherAgentId}`,
        name: 'eval page other',
        model: 'test',
      },
    ]);
    // 原始 SQL 才能写入微秒：drizzle 的 Date 参数只有毫秒。
    const insert = (id: string, owner: string, createdAt: string, total: number) =>
      pool.query(
        `insert into eval_runs
           (id, agent_id, status, total, passed, error, created_at, claimed_at, case_snapshot)
         values ($1, $2, 'succeeded', $3, 1, null, $4, now(), $5)`,
        [
          id,
          owner,
          total,
          createdAt,
          JSON.stringify([
            { id: 'case-1', name: 'big'.repeat(2_000), prompt: 'prompt', expectation: 'ok' },
          ]),
        ],
      );
    await insert(`${base}-newest`, agentId, '2026-01-01T00:00:00.123457Z', 4);
    await insert(`${base}-same-z`, agentId, '2026-01-01T00:00:00.123456Z', 3);
    await insert(`${base}-same-a`, agentId, '2026-01-01T00:00:00.123456Z', 2);
    await insert(`${base}-oldest`, agentId, '2026-01-01T00:00:00.123455Z', 1);
    await insert(`${base}-other`, otherAgentId, '2026-01-01T00:00:00.500000Z', 9);
  });

  afterAll(async () => {
    await db.delete(agents).where(inArray(agents.id, [agentId, otherAgentId]));
    await pool.end();
  });

  it('pages by (created_at, id) at microsecond precision without gaps or duplicates', async () => {
    const totals: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await evalRepo.listRuns(db, {
        agentId,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result) throw new Error('cursor should be valid');
      totals.push(...result.items.map((row) => row.total));
      cursor = result.nextCursor ?? undefined;
    }
    // 同一毫秒内靠 id 倒序补齐，不同微秒不会被截断成同一时间。
    expect(totals).toEqual([4, 3, 2, 1]);
    expect(cursor).toBeUndefined();
  });

  it('returns only summary columns and reads one extra row to detect the next page', async () => {
    const page = await evalRepo.listRuns(db, { agentId, limit: 2 });
    expect(page?.items.map((row) => row.total)).toEqual([4, 3]);
    // 下一页游标是本次返回的最后一条，不是多读出来的那条。
    expect(page?.nextCursor).toBe(`${base}-same-z`);
    expect(Object.keys(page?.items[0] ?? {}).sort()).toEqual([
      'agentId',
      'createdAt',
      'error',
      'finishedAt',
      'id',
      'passed',
      'status',
      'total',
    ]);
    expect(page?.items[0]).not.toHaveProperty('caseSnapshot');
    expect(page?.items[0]).not.toHaveProperty('claimedAt');
  });

  it('rejects a cursor that is missing or outside the current agent filter', async () => {
    expect(
      await evalRepo.listRuns(db, { agentId, limit: 10, cursor: 'evalRun_missing' }),
    ).toBeNull();
    expect(await evalRepo.listRuns(db, { agentId, limit: 10, cursor: `${base}-other` })).toBeNull();
    // 不筛智能体时，任何已存在的游标都能继续翻页。
    const unfiltered = await evalRepo.listRuns(db, { limit: 10, cursor: `${base}-other` });
    expect(unfiltered?.items).toHaveLength(4);
    expect(unfiltered?.items.some((row) => row.id === `${base}-other`)).toBe(false);
  });
});
