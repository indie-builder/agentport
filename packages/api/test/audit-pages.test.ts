import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

interface AuditItem {
  id: string;
  action: string;
  target: string | null;
  status: string;
  createdAt: string;
}

interface ItemBody {
  items: AuditItem[];
}

interface ExportBody extends ItemBody {
  format: string;
  exportedAt: string;
}

describe.skipIf(!ready)('audit ID cursor pages', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdIds: string[] = [];
  const createdTargets: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await app.pool.query('delete from audit_log where id = any($1::text[])', [createdIds]);
    }
    if (createdTargets.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [
        createdTargets,
      ]);
    }
    await app.close();
  });

  const list = (query = '') =>
    inject(app, { method: 'GET', url: `/api/audit${query}`, headers: { cookie } });
  const exportAudit = (query = '') =>
    inject(app, { method: 'GET', url: `/api/audit/export${query}`, headers: { cookie } });

  async function page(query: string): Promise<AuditItem[]> {
    const res = await list(query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ItemBody>().items;
  }

  interface SeedRow {
    id: string;
    createdAt: string;
    action?: string;
    status?: string;
  }

  /** 直接落库：写入路径已在别处覆盖，这里只验证读路径与游标。 */
  async function seed(target: string, rows: SeedRow[]): Promise<void> {
    createdTargets.push(target);
    createdIds.push(...rows.map((row) => row.id));
    await app.pool.query(
      `insert into audit_log (id, actor, action, target, status, created_at)
       select t.id, 'admin', t.action, $1, t.status, t.created_at::timestamptz
       from unnest($2::text[], $3::text[], $4::text[], $5::text[])
         as t(id, action, status, created_at)`,
      [
        target,
        rows.map((row) => row.id),
        rows.map((row) => row.action ?? 'audit.page'),
        rows.map((row) => row.status ?? 'ok'),
        rows.map((row) => row.createdAt),
      ],
    );
  }

  const cursor = (id: string) => `&beforeId=${encodeURIComponent(id)}`;
  const targetQuery = (target: string) => `?target=${encodeURIComponent(target)}`;

  it('pages 125 rows that share one timestamp without overlap', async () => {
    const target = unique('target');
    const prefix = unique('audit-tie');
    const ids = Array.from(
      { length: 125 },
      (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`,
    );
    await seed(
      target,
      ids.map((id) => ({ id, createdAt: '2026-01-01T00:00:00.500000Z' })),
    );

    const first = await page(`${targetQuery(target)}&limit=100`);
    expect(first).toHaveLength(100);
    expect(first[0]?.id).toBe(ids[124]);
    expect(first.at(-1)?.id).toBe(ids[25]);

    const second = await page(`${targetQuery(target)}&limit=100${cursor(first.at(-1)?.id ?? '')}`);
    expect(second).toHaveLength(25);
    expect(second.map((row) => row.id)).toEqual(ids.slice(0, 25).reverse());

    const third = await page(`${targetQuery(target)}&limit=100${cursor(second.at(-1)?.id ?? '')}`);
    expect(third).toEqual([]);

    const all = [...first, ...second];
    expect(all.map((row) => row.id)).toEqual([...ids].reverse());
    expect(new Set(all.map((row) => row.id)).size).toBe(125);
  });

  it('keeps microsecond ordering when every ISO string collides', async () => {
    const target = unique('target');
    const prefix = unique('audit-us');
    // 同一毫秒内的 125 个微秒：ID 顺序与时间顺序相反。
    const rows = Array.from({ length: 125 }, (_, i) => {
      const n = i + 1;
      return {
        id: `${prefix}-${String(126 - n).padStart(3, '0')}`,
        createdAt: `2026-01-02T03:04:05.${String(123000 + n).padStart(6, '0')}Z`,
      };
    });
    await seed(target, rows);

    const expected = await app.pool.query<{ id: string; ts: string }>(
      `select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts
       from audit_log where target = $1 order by created_at desc, id desc`,
      [target],
    );
    expect(expected.rows).toHaveLength(125);
    expect(new Set(expected.rows.map((row) => row.ts)).size).toBe(125);

    const first = await page(`${targetQuery(target)}&limit=100`);
    expect(first).toHaveLength(100);
    expect(first.map((row) => row.id)).toEqual(expected.rows.slice(0, 100).map((row) => row.id));

    const second = await page(`${targetQuery(target)}&limit=100${cursor(first.at(-1)?.id ?? '')}`);
    expect(second).toHaveLength(25);
    expect(second.map((row) => row.id)).toEqual(expected.rows.slice(100).map((row) => row.id));

    const third = await page(`${targetQuery(target)}&limit=100${cursor(second.at(-1)?.id ?? '')}`);
    expect(third).toEqual([]);

    const all = [...first, ...second];
    expect(all.map((row) => row.id)).toEqual(expected.rows.map((row) => row.id));
    expect(new Set(all.map((row) => row.id)).size).toBe(125);
    // wire 上仍是毫秒 ISO：时间戳游标无法区分这些行，记录游标必须读库内真实值。
    expect(new Set(all.map((row) => row.createdAt)).size).toBe(1);
  });

  it('combines a cursor with target, action, status and before filters', async () => {
    const target = unique('target');
    const other = unique('target');
    const prefix = unique('audit-filter');
    const rows = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return {
        id: `${prefix}-${String(n).padStart(3, '0')}`,
        createdAt: `2026-02-01T00:00:${String(n).padStart(2, '0')}.000000Z`,
        action: n % 2 === 1 ? 'audit.page.alpha' : 'audit.page.beta',
        status: n % 3 === 0 ? 'error' : n % 2 === 0 ? 'denied' : 'ok',
      };
    });
    await seed(target, rows);
    await seed(
      other,
      Array.from({ length: 3 }, (_, i) => ({
        id: `${prefix}-other-${i}`,
        createdAt: `2026-02-01T00:00:0${i + 1}.000000Z`,
      })),
    );

    const targetRows = await page(`${targetQuery(target)}&limit=4`);
    expect(targetRows.map((row) => row.id)).toEqual(
      ['012', '011', '010', '009'].map((n) => `${prefix}-${n}`),
    );
    const targetNext = await page(
      `${targetQuery(target)}&limit=4${cursor(targetRows.at(-1)?.id ?? '')}`,
    );
    expect(targetNext).toHaveLength(4);
    expect(targetNext.every((row) => row.target === target)).toBe(true);

    const actionFirst = await page(`${targetQuery(target)}&action=audit.page.alpha&limit=3`);
    expect(actionFirst.map((row) => row.action)).toEqual(Array(3).fill('audit.page.alpha'));
    const actionNext = await page(
      `${targetQuery(target)}&action=audit.page.alpha&limit=10${cursor(actionFirst.at(-1)?.id ?? '')}`,
    );
    expect(actionNext.map((row) => row.id)).toEqual(
      ['005', '003', '001'].map((n) => `${prefix}-${n}`),
    );

    const statusFirst = await page(`${targetQuery(target)}&status=error&limit=2`);
    expect(statusFirst.map((row) => row.id)).toEqual(['012', '009'].map((n) => `${prefix}-${n}`));
    const statusNext = await page(
      `${targetQuery(target)}&status=error&limit=10${cursor(statusFirst.at(-1)?.id ?? '')}`,
    );
    expect(statusNext.map((row) => row.id)).toEqual(['006', '003'].map((n) => `${prefix}-${n}`));

    // before（时间范围）与 beforeId（位置）同时生效，取交集。
    const both = await page(
      `${targetQuery(target)}&before=2026-02-01T00:00:08.000Z${cursor(`${prefix}-010`)}`,
    );
    expect(both.map((row) => row.id)).toEqual(
      ['007', '006', '005', '004', '003', '002', '001'].map((n) => `${prefix}-${n}`),
    );

    // 游标可以不在当前 action 过滤内：它只是一个位置，不需要属于结果集。
    const outside = await page(
      `${targetQuery(target)}&action=audit.page.beta&limit=10${cursor(`${prefix}-012`)}`,
    );
    expect(outside.map((row) => row.id)).toEqual(
      ['010', '008', '006', '004', '002'].map((n) => `${prefix}-${n}`),
    );
  });

  it('rejects unknown, blank and oversized cursors without echoing them', async () => {
    const unknown = `audit-missing-${unique('cursor')}`;
    for (const res of [
      await list(`?beforeId=${encodeURIComponent(unknown)}`),
      await exportAudit(`?beforeId=${encodeURIComponent(unknown)}`),
    ]) {
      const body = expectProblem(res, 'INVALID_INPUT');
      expect(body.message).toBe('分页游标无效');
      expect(body.message).not.toContain(unknown);
    }

    expectProblem(await list('?beforeId='), 'INVALID_INPUT');
    expectProblem(await list('?beforeId=%20'), 'INVALID_INPUT');
    expectProblem(await list(`?beforeId=${'a'.repeat(201)}`), 'INVALID_INPUT');
  });

  it('keeps the list and export limits unchanged', async () => {
    expectProblem(await list('?limit=201'), 'INVALID_INPUT');
    expectProblem(await exportAudit('?limit=1001'), 'INVALID_INPUT');
  });

  it('applies beforeId to export without changing its envelope or oversize guard', async () => {
    const target = unique('target');
    const prefix = unique('audit-export-page');
    await seed(
      target,
      Array.from({ length: 8 }, (_, i) => {
        const n = i + 1;
        return {
          id: `${prefix}-${String(n).padStart(3, '0')}`,
          createdAt: `2026-03-01T00:00:${String(n).padStart(2, '0')}.000000Z`,
        };
      }),
    );

    const first = await page(`${targetQuery(target)}&limit=3`);
    expect(first.map((row) => row.id)).toEqual(['008', '007', '006'].map((n) => `${prefix}-${n}`));
    const before = first.at(-1)?.id ?? '';

    const res = await exportAudit(`${targetQuery(target)}${cursor(before)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const body = res.json<ExportBody>();
    expect(Object.keys(body).sort()).toEqual(['exportedAt', 'format', 'items']);
    expect(body.items.map((row) => row.id)).toEqual(
      ['005', '004', '003', '002', '001'].map((n) => `${prefix}-${n}`),
    );

    // 游标之后仍超过 limit 时必须拒绝，不能把截断结果当完整导出发出。
    expectProblem(await exportAudit(`${targetQuery(target)}&limit=3${cursor(before)}`), 'CONFLICT');
  });
});
