import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

interface ExportedItem {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  status: string;
  durationMs: number | null;
  requestId: string | null;
  inputDigest: string | null;
  createdAt: string;
}

interface ExportBody {
  format: string;
  exportedAt: string;
  items: ExportedItem[];
}

describe.skipIf(!ready)('audit export', () => {
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

  const exportAudit = (query = '', withCookie = true) =>
    inject(app, {
      method: 'GET',
      url: `/api/audit/export${query}`,
      headers: withCookie ? { cookie } : {},
    });

  const listAudit = (query = '') =>
    inject(app, { method: 'GET', url: `/api/audit${query}`, headers: { cookie } });

  /** 直接落库：写入路径已在别处覆盖，这里只验证读路径。 */
  async function seedAudit(options: {
    action: string;
    target: string;
    inputDigest?: string | null;
    actor?: string;
    status?: string;
    durationMs?: number | null;
    requestId?: string | null;
  }): Promise<string> {
    const id = `audit-export-${unique('row')}`;
    createdIds.push(id);
    await app.pool.query(
      `insert into audit_log (id, actor, action, target, input_digest, status, duration_ms, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        options.actor ?? 'admin',
        options.action,
        options.target,
        options.inputDigest ?? null,
        options.status ?? 'ok',
        options.durationMs ?? null,
        options.requestId ?? null,
      ],
    );
    return id;
  }

  it('requires authentication', async () => {
    expectProblem(await exportAudit('', false), 'UNAUTHORIZED');
  });

  it('filters by target exactly, without matching unrelated rows', async () => {
    const ownTarget = unique('target');
    const unrelated = unique('target');
    createdTargets.push(ownTarget, unrelated);
    const ownId = await seedAudit({ action: 'agent.run', target: ownTarget });
    const unrelatedId = await seedAudit({ action: 'agent.run', target: unrelated });

    const res = await exportAudit(`?target=${encodeURIComponent(ownTarget)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<ExportBody>();
    expect(body.items.map((row) => row.id)).toEqual([ownId]);
    expect(body.items.map((row) => row.id)).not.toContain(unrelatedId);
  });

  it('filters the list endpoint by target too', async () => {
    const ownTarget = unique('target');
    const unrelated = unique('target');
    createdTargets.push(ownTarget, unrelated);
    const ownId = await seedAudit({ action: 'agent.run', target: ownTarget });
    const unrelatedId = await seedAudit({ action: 'agent.run', target: unrelated });

    const res = await listAudit(`?target=${encodeURIComponent(ownTarget)}`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json<{ items: { id: string }[] }>().items.map((row) => row.id);
    expect(ids).toEqual([ownId]);
    expect(ids).not.toContain(unrelatedId);
  });

  it('returns an empty list for an unknown target', async () => {
    const res = await exportAudit(`?target=${encodeURIComponent(unique('nothing'))}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ExportBody>().items).toEqual([]);
  });

  it('returns only audit columns with ISO dates and no raw prompt', async () => {
    const target = unique('target');
    createdTargets.push(target);
    const id = await seedAudit({
      action: 'agent.run',
      target,
      inputDigest: 'a'.repeat(32),
      status: 'error',
      durationMs: 42,
      requestId: 'req-1',
    });

    const res = await exportAudit(`?target=${encodeURIComponent(target)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/json');

    const body = res.json<ExportBody>();
    expect(Object.keys(body).sort()).toEqual(['exportedAt', 'format', 'items']);
    expect(body.format).toBe('agentport/audit@1');
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(body.items).toEqual([
      {
        id,
        actor: 'admin',
        action: 'agent.run',
        target,
        status: 'error',
        durationMs: 42,
        requestId: 'req-1',
        inputDigest: 'a'.repeat(32),
        createdAt: expect.any(String),
      },
    ]);
    expect(Number.isNaN(Date.parse(body.items[0]?.createdAt ?? ''))).toBe(false);
    expect(res.body).not.toContain('prompt');
    expect(res.body).not.toContain('input":');
  });

  it('exports at most 1000 rows by default and rejects an explicit larger limit', async () => {
    const target = unique('target');
    createdTargets.push(target);
    await app.pool.query(
      `insert into audit_log (id, action, target, status)
       select $1 || '-' || g, 'audit.export.bulk', $2, 'ok' from generate_series(1, 1001) g`,
      [`audit-export-bulk-${target}`, target],
    );

    // 超过上限必须明确拒绝，不能把 1000 条当成完整结果静默导出。
    expectProblem(await exportAudit(`?target=${encodeURIComponent(target)}`), 'CONFLICT');

    const exactly = unique('target');
    createdTargets.push(exactly);
    await app.pool.query(
      `insert into audit_log (id, action, target, status)
       select $1 || '-' || g, 'audit.export.bulk', $2, 'ok' from generate_series(1, 1000) g`,
      [`audit-export-exact-${exactly}`, exactly],
    );
    const bounded = await exportAudit(`?target=${encodeURIComponent(exactly)}`);
    expect(bounded.statusCode, bounded.body).toBe(200);
    expect(bounded.json<ExportBody>().items).toHaveLength(1000);

    expectProblem(
      await exportAudit(`?target=${encodeURIComponent(exactly)}&limit=1001`),
      'INVALID_INPUT',
    );
  });

  it('does not mutate stored audit rows', async () => {
    const target = unique('target');
    createdTargets.push(target);
    const id = await seedAudit({ action: 'agent.run', target });
    const row = async () =>
      (
        await app.pool.query(
          'select id, actor, action, target, input_digest, status, duration_ms, request_id, created_at from audit_log where id = $1',
          [id],
        )
      ).rows[0];
    const before = await row();

    expect((await exportAudit(`?target=${encodeURIComponent(target)}`)).statusCode).toBe(200);

    expect(await row()).toEqual(before);
  });
});
