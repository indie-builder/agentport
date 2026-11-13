import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface ExportedItem {
  id: string;
  actor: string;
  actorKind: string;
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
  let app: TestApp;
  let cookie: string;
  const createdIds: string[] = [];
  const createdTargets: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await app.client.unsafe('delete from audit_log where id = any($1::text[])', [
        app.client.array(createdIds, 'TEXT'),
      ]);
    }
    if (createdTargets.length > 0) {
      await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
        app.client.array(createdTargets, 'TEXT'),
      ]);
    }
    await app.close();
  });

  const exportAudit = (query = '', withCookie = true) =>
    request(app, {
      method: 'GET',
      url: `/api/audit/export${query}`,
      headers: withCookie ? { cookie } : {},
    });

  const listAudit = (query = '') =>
    request(app, { method: 'GET', url: `/api/audit${query}`, headers: { cookie } });

  const parseLines = (body: string) =>
    body
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as ExportedItem & {
            chainSeq: number;
            prevHash: string | null;
            hash: string | null;
          },
      );

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
    await app.client.unsafe(
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
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit.json"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = res.json<ExportBody>();
    expect(Object.keys(body).sort()).toEqual(['exportedAt', 'format', 'items']);
    expect(body.format).toBe('agentport/audit@1');
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(body.items).toEqual([
      {
        id,
        actor: 'admin',
        actorKind: 'service',
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
    await app.client.unsafe(
      `insert into audit_log (id, action, target, status)
       select $1 || '-' || g, 'audit.export.bulk', $2, 'ok' from generate_series(1, 1001) g`,
      [`audit-export-bulk-${target}`, target],
    );

    // 超过上限必须明确拒绝，不能把 1000 条当成完整结果静默导出。
    expectProblem(await exportAudit(`?target=${encodeURIComponent(target)}`), 'CONFLICT');

    const exactly = unique('target');
    createdTargets.push(exactly);
    await app.client.unsafe(
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
        await app.client.unsafe(
          'select id, actor, action, target, input_digest, status, duration_ms, request_id, created_at from audit_log where id = $1',
          [id],
        )
      )[0];
    const before = await row();

    expect((await exportAudit(`?target=${encodeURIComponent(target)}`)).statusCode).toBe(200);

    expect(await row()).toEqual(before);
  });

  it('exports NDJSON rows in chain_seq order with chain fields', async () => {
    const target = unique('target');
    createdTargets.push(target);
    const first = await seedAudit({ action: 'agent.run', target });
    const second = await seedAudit({ action: 'agent.run', target });

    const res = await exportAudit(`?target=${encodeURIComponent(target)}&format=ndjson`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit.ndjson"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const rows = parseLines(res.body);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual([first, second].sort());
    for (const [index, row] of rows.entries()) {
      if (index > 0) expect(row.chainSeq).toBeGreaterThan(rows[index - 1]!.chainSeq);
      expect(typeof row.chainSeq).toBe('number');
      expect(Object.hasOwn(row, 'prevHash')).toBe(true);
      expect(Object.hasOwn(row, 'hash')).toBe(true);
      expect(row.prevHash === null || typeof row.prevHash === 'string').toBe(true);
      expect(row.hash === null || typeof row.hash === 'string').toBe(true);
    }
  });

  it('pages NDJSON exports with the afterSeq cursor', async () => {
    const target = unique('target');
    createdTargets.push(target);
    const ids = [
      await seedAudit({ action: 'agent.run', target }),
      await seedAudit({ action: 'agent.run', target }),
      await seedAudit({ action: 'agent.run', target }),
    ];
    const query = `?target=${encodeURIComponent(target)}&format=ndjson&limit=2`;

    const firstPage = await exportAudit(query);
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const firstRows = parseLines(firstPage.body);
    expect(firstRows).toHaveLength(2);
    const cursor = firstRows.at(-1)!.chainSeq;
    expect(firstPage.headers.get('x-next-after-seq')).toBe(String(cursor));

    const secondPage = await exportAudit(`${query}&afterSeq=${cursor}`);
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    const secondRows = parseLines(secondPage.body);
    expect(secondRows).toHaveLength(1);

    const exported = [...firstRows, ...secondRows].map((row) => row.id);
    expect(new Set(exported).size).toBe(3);
    expect(exported.sort()).toEqual([...ids].sort());
  });

  it('requires authentication for NDJSON exports', async () => {
    expectProblem(await exportAudit('?format=ndjson', false), 'UNAUTHORIZED');
  });

  it('filters by actor, actorKind and since on list and export', async () => {
    const actorTarget = unique('target');
    createdTargets.push(actorTarget);
    const aliceId = await seedAudit({ action: 'agent.run', target: actorTarget, actor: 'alice' });
    const bobId = await seedAudit({ action: 'agent.run', target: actorTarget, actor: 'bob' });

    const actorQuery = `?target=${encodeURIComponent(actorTarget)}&actor=alice`;
    const actorExport = await exportAudit(actorQuery);
    expect(actorExport.statusCode, actorExport.body).toBe(200);
    expect(actorExport.json<ExportBody>().items.map((row) => row.id)).toEqual([aliceId]);
    expect(actorExport.json<ExportBody>().items.map((row) => row.id)).not.toContain(bobId);
    const actorList = await listAudit(actorQuery);
    expect(actorList.statusCode, actorList.body).toBe(200);
    expect(actorList.json<{ items: { id: string }[] }>().items.map((row) => row.id)).toEqual([
      aliceId,
    ]);
    const actorNdjson = await exportAudit(`${actorQuery}&format=ndjson`);
    expect(actorNdjson.statusCode, actorNdjson.body).toBe(200);
    const actorRows = parseLines(actorNdjson.body);
    expect(actorRows).toHaveLength(1);
    expect(actorRows[0]?.id).toBe(aliceId);
    expect(actorRows[0]?.id).not.toBe(bobId);

    const kindTarget = unique('target');
    createdTargets.push(kindTarget);
    const userId = `audit-export-${unique('row')}`;
    const serviceId = `audit-export-${unique('row')}`;
    createdIds.push(userId, serviceId);
    await app.client.unsafe(
      `insert into audit_log (id, actor, actor_kind, action, target, status)
       values ($1, 'alice', 'user', 'agent.run', $3, 'ok'), ($2, 'alice', 'service', 'agent.run', $3, 'ok')`,
      [userId, serviceId, kindTarget],
    );

    const kindQuery = `?target=${encodeURIComponent(kindTarget)}&actorKind=user`;
    const kindExport = await exportAudit(kindQuery);
    expect(kindExport.statusCode, kindExport.body).toBe(200);
    expect(kindExport.json<ExportBody>().items.map((row) => row.id)).toEqual([userId]);
    const kindList = await listAudit(kindQuery);
    expect(kindList.statusCode, kindList.body).toBe(200);
    expect(kindList.json<{ items: { id: string }[] }>().items.map((row) => row.id)).toEqual([
      userId,
    ]);

    const sinceTarget = unique('target');
    createdTargets.push(sinceTarget);
    const oldId = `audit-export-${unique('row')}`;
    const newId = `audit-export-${unique('row')}`;
    createdIds.push(oldId, newId);
    await app.client.unsafe(
      `insert into audit_log (id, actor, action, target, status, created_at)
       values ($1, 'admin', 'agent.run', $3, 'ok', now() - interval '2 hours'), ($2, 'admin', 'agent.run', $3, 'ok', now())`,
      [oldId, newId, sinceTarget],
    );

    const sinceQuery = `?target=${encodeURIComponent(sinceTarget)}&since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`;
    const sinceExport = await exportAudit(sinceQuery);
    expect(sinceExport.statusCode, sinceExport.body).toBe(200);
    expect(sinceExport.json<ExportBody>().items.map((row) => row.id)).toEqual([newId]);
    expect(sinceExport.json<ExportBody>().items.map((row) => row.id)).not.toContain(oldId);
    const sinceList = await listAudit(sinceQuery);
    expect(sinceList.statusCode, sinceList.body).toBe(200);
    expect(sinceList.json<{ items: { id: string }[] }>().items.map((row) => row.id)).toEqual([
      newId,
    ]);
  });
});
