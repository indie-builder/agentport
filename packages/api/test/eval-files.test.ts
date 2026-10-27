import type { Agent, EvalDataset, EvalDatasetImportResult } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface EvalCaseRow {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
}

interface ExportedDataset {
  format: string;
  exportedAt: string;
  cases: Array<Record<string, unknown>>;
}

describe.skipIf(!ready)('eval dataset files', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('eval-file'), track: createdAgents })
    ).json<Agent>();

  const dataset = (cases: EvalDataset['cases']): EvalDataset => ({
    format: 'agentport/eval@1',
    exportedAt: new Date().toISOString(),
    cases,
  });

  const exportCases = (agentId: string, withCookie = true) =>
    inject(app, {
      method: 'GET',
      url: `/api/eval/cases/export?agentId=${encodeURIComponent(agentId)}`,
      headers: withCookie ? { cookie } : {},
    });

  const importCases = (agentId: string, file: unknown, withCookie = true) =>
    inject(app, {
      method: 'POST',
      url: '/api/eval/cases/import',
      headers: withCookie ? { cookie } : {},
      payload: { agentId, dataset: file },
    });

  const listCases = async (agentId: string): Promise<EvalCaseRow[]> =>
    (
      await inject(app, {
        method: 'GET',
        url: `/api/eval/cases?agentId=${encodeURIComponent(agentId)}`,
        headers: { cookie },
      })
    ).json<EvalCaseRow[]>();

  const countCases = async (agentId: string): Promise<number> => {
    const res = await app.pool.query<{ n: number }>(
      'select count(*)::int as n from eval_cases where agent_id = $1',
      [agentId],
    );
    return res.rows[0]?.n ?? -1;
  };

  const createCase = (
    agentId: string,
    input: { name: string; prompt: string; expectation: string },
  ) =>
    inject(app, {
      method: 'POST',
      url: '/api/eval/cases',
      headers: { cookie },
      payload: { agentId, ...input },
    });

  /** 直接落库超过上限的用例，避免为造数据跑 500 次请求。 */
  const seedCases = (agentId: string, count: number, prompt?: string) =>
    app.pool.query(
      `insert into eval_cases (id, agent_id, name, prompt, expectation)
       select $1 || '-seed-' || g, $1, 'seeded-' || g, coalesce($3, 'p' || g), ''
       from generate_series(1, $2) g`,
      [agentId, count, prompt ?? null],
    );

  it('requires auth on export and import', async () => {
    expectProblem(await exportCases('agt_any', false), 'UNAUTHORIZED');
    expectProblem(await importCases('agt_any', dataset([]), false), 'UNAUTHORIZED');
  });

  it('rejects export without agentId', async () => {
    expectProblem(
      await inject(app, { method: 'GET', url: '/api/eval/cases/export', headers: { cookie } }),
      'INVALID_INPUT',
    );
  });

  it('returns AGENT_NOT_FOUND for an unknown agent on both endpoints', async () => {
    expectProblem(await exportCases('agt_missing'), 'AGENT_NOT_FOUND');
    expectProblem(await importCases('agt_missing', dataset([])), 'AGENT_NOT_FOUND');
  });

  it('accepts an empty dataset', async () => {
    const agent = await newAgent();
    const res = await importCases(agent.id, dataset([]));
    expect(res.statusCode).toBe(201);
    expect(res.json<EvalDatasetImportResult>()).toEqual({ imported: 0, skipped: 0, warnings: [] });
  });

  it('rejects a malformed case late in the array without writing earlier cases', async () => {
    const agent = await newAgent();
    const file = dataset([
      { name: 'valid', prompt: 'ok', expectation: '' },
      { name: '', prompt: 'broken', expectation: '' },
    ]);
    expectProblem(await importCases(agent.id, file), 'INVALID_INPUT');
    expect(await countCases(agent.id)).toBe(0);
  });

  it('rejects the wrong format and invalid fields', async () => {
    const agent = await newAgent();
    const wrongFormat = { ...dataset([]), format: 'agentport/eval@2' };
    expectProblem(await importCases(agent.id, wrongFormat), 'INVALID_INPUT');
    expectProblem(
      await importCases(agent.id, dataset([{ name: 'n', prompt: '', expectation: '' }])),
      'INVALID_INPUT',
    );
    expect(await countCases(agent.id)).toBe(0);
  });

  it('rejects a dataset with more than 500 cases', async () => {
    const agent = await newAgent();
    const cases = Array.from({ length: 501 }, (_, i) => ({
      name: `case-${i}`,
      prompt: `prompt-${i}`,
      expectation: '',
    }));
    expectProblem(await importCases(agent.id, dataset(cases)), 'INVALID_INPUT');
    expect(await countCases(agent.id)).toBe(0);
  });

  it('refuses to export more than 500 cases instead of truncating', async () => {
    const agent = await newAgent();
    await seedCases(agent.id, 501);
    expectProblem(await exportCases(agent.id), 'CONFLICT');
  });

  it('refuses to export more than 1 MiB instead of truncating', async () => {
    const agent = await newAgent();
    await seedCases(agent.id, 60, 'x'.repeat(20_000));
    expectProblem(await exportCases(agent.id), 'CONFLICT');
  });

  it('round-trips cases to another agent with safe headers and no ids', async () => {
    const source = await newAgent();
    const target = await newAgent();
    const unicodeName = `问候-${unique('name')}`;
    await createCase(source.id, {
      name: unicodeName,
      prompt: '第一行\n第二行 with ✨',
      expectation: '期望\n结果',
    });
    await createCase(source.id, { name: 'plain', prompt: 'hello', expectation: '' });

    const exported = await exportCases(source.id);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toBe('attachment; filename="eval-cases.json"');
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.headers['x-content-type-options']).toBe('nosniff');
    expect(exported.headers['content-type']).toContain('application/json');

    const body = exported.json<ExportedDataset>();
    expect(Object.keys(body).sort()).toEqual(['cases', 'exportedAt', 'format']);
    expect(body.format).toBe('agentport/eval@1');
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(Object.keys(body.cases[0] ?? {}).sort()).toEqual(['expectation', 'name', 'prompt']);
    expect(exported.body).not.toContain('"id"');
    expect(exported.body).not.toContain(source.id);

    const imported = await importCases(target.id, body);
    expect(imported.statusCode).toBe(201);
    expect(imported.json<EvalDatasetImportResult>()).toEqual({
      imported: 2,
      skipped: 0,
      warnings: [],
    });

    const byName = new Map((await listCases(target.id)).map((row) => [row.name, row]));
    expect(byName.get(unicodeName)).toMatchObject({
      prompt: '第一行\n第二行 with ✨',
      expectation: '期望\n结果',
    });
    expect(byName.get('plain')).toMatchObject({ prompt: 'hello', expectation: '' });
  });

  it('applies the expectation default when the file omits it', async () => {
    const agent = await newAgent();
    const file = dataset([{ name: 'no-expectation', prompt: 'p' } as never]);
    const res = await importCases(agent.id, file);
    expect(res.statusCode).toBe(201);
    const [row] = await listCases(agent.id);
    expect(row?.expectation).toBe('');
  });

  it('skips duplicates from the target agent and within the file without overwriting', async () => {
    const agent = await newAgent();
    await createCase(agent.id, { name: 'dup', prompt: 'original', expectation: 'keep' });
    const res = await importCases(
      agent.id,
      dataset([
        { name: 'dup', prompt: 'overwrite attempt', expectation: 'new' },
        { name: 'fresh', prompt: 'first', expectation: '' },
        { name: 'fresh', prompt: 'second', expectation: '' },
      ]),
    );
    expect(res.statusCode).toBe(201);
    const result = res.json<EvalDatasetImportResult>();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.warnings.join('\n')).toContain('dup');
    expect(result.warnings.join('\n')).toContain('fresh');

    const byName = new Map((await listCases(agent.id)).map((row) => [row.name, row]));
    expect(byName.get('dup')?.prompt).toBe('original');
    expect(byName.get('fresh')?.prompt).toBe('first');
    expect(await countCases(agent.id)).toBe(2);
  });

  it('checks only candidate names when importing into a large dataset', async () => {
    const agent = await newAgent();
    const other = await newAgent();
    await seedCases(agent.id, 1000, 'original');

    const candidates = [
      { name: 'seeded-2', prompt: 'overwrite-2', expectation: 'new' },
      { name: 'brand-new', prompt: 'first', expectation: '' },
      { name: 'seeded-1', prompt: 'overwrite-1', expectation: 'new' },
      { name: 'brand-new', prompt: 'second', expectation: '' },
    ];

    type TxClient = { query: (...args: unknown[]) => unknown };
    const captured: Array<{ sql: string; params: unknown[]; rows: number }> = [];
    // 池会复用 client，必须按 client 记录原始 query 才能在 finally 还原，避免污染后续请求。
    const wrappedClients: Array<{ client: TxClient; originalQuery: TxClient['query'] }> = [];
    const originalConnect = app.pool.connect.bind(app.pool) as (
      callback?: (...args: unknown[]) => void,
    ) => unknown;
    const connectSpy = vi.spyOn(app.pool, 'connect').mockImplementation(((
      callback?: (...args: unknown[]) => void,
    ) => {
      // Pool.query 走回调式 connect；只包裹事务直接取到的 client。
      if (callback) return originalConnect(callback);
      return (originalConnect() as Promise<TxClient>).then((client) => {
        if (wrappedClients.some((entry) => entry.client === client)) return client;
        const originalQuery = client.query;
        wrappedClients.push({ client, originalQuery });
        client.query = (...args: unknown[]) => {
          const result = originalQuery.apply(client, args);
          // Drizzle 带字段的查询把 SQL 放进 QueryConfig 对象，而不是第一个字符串参数。
          const first = args[0] as { text?: unknown } | undefined;
          const sql =
            typeof first === 'string' ? first : typeof first?.text === 'string' ? first.text : '';
          if (!/^select "name" from "eval_cases"/i.test(sql)) return result;
          // 透传真实查询结果，只读取返回行数作为过滤生效的证据。
          return Promise.resolve(result).then((res) => {
            captured.push({
              sql,
              params: Array.isArray(args[1]) ? args[1] : [],
              rows: (res as { rows: unknown[] }).rows.length,
            });
            return res;
          });
        };
        return client;
      });
    }) as never);

    let res: Awaited<ReturnType<typeof importCases>>;
    try {
      res = await importCases(agent.id, dataset(candidates));
    } finally {
      for (const { client, originalQuery } of wrappedClients) client.query = originalQuery;
      connectSpy.mockRestore();
    }

    for (const { client, originalQuery } of wrappedClients) {
      expect(client.query).toBe(originalQuery);
    }

    expect(res.statusCode).toBe(201);
    expect(res.json<EvalDatasetImportResult>()).toEqual({
      imported: 1,
      skipped: 3,
      warnings: [
        '用例「seeded-2」已存在，已跳过',
        '用例「seeded-1」已存在，已跳过',
        '用例「brand-new」已存在，已跳过',
      ],
    });

    expect(captured).toHaveLength(1);
    const [nameQuery] = captured;
    expect(nameQuery?.sql).toMatch(/"name"\s+in\s+\(\$/i);
    expect(nameQuery?.params.length).toBeLessThan(10);
    expect(nameQuery?.rows).toBe(2);

    const byName = new Map((await listCases(agent.id)).map((row) => [row.name, row]));
    expect(byName.get('seeded-1')).toMatchObject({ prompt: 'original', expectation: '' });
    expect(byName.get('seeded-2')).toMatchObject({ prompt: 'original', expectation: '' });
    expect(byName.get('brand-new')).toMatchObject({ prompt: 'first', expectation: '' });
    expect(await countCases(agent.id)).toBe(1001);

    const otherRes = await importCases(
      other.id,
      dataset([{ name: 'seeded-1', prompt: 'other', expectation: '' }]),
    );
    expect(otherRes.statusCode).toBe(201);
    expect(otherRes.json<EvalDatasetImportResult>()).toEqual({
      imported: 1,
      skipped: 0,
      warnings: [],
    });
    // 还原证据：后续请求复用池 client 时不能再写入旧的 captured 数组。
    expect(captured).toHaveLength(1);
  });

  it('serializes concurrent imports of the same file', async () => {
    const agent = await newAgent();
    const file = dataset(
      Array.from({ length: 5 }, (_, i) => ({
        name: `concurrent-${i}`,
        prompt: `prompt-${i}`,
        expectation: '',
      })),
    );
    const [first, second] = await Promise.all([
      importCases(agent.id, file),
      importCases(agent.id, file),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const total = [first, second]
      .map((res) => res.json<EvalDatasetImportResult>().imported)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
    expect(await countCases(agent.id)).toBe(5);
  });

  it('import creates no eval runs or results', async () => {
    const agent = await newAgent();
    const res = await importCases(
      agent.id,
      dataset([{ name: 'no-run', prompt: 'p', expectation: '' }]),
    );
    expect(res.statusCode).toBe(201);
    const runs = await app.pool.query<{ n: number }>(
      'select count(*)::int as n from eval_runs where agent_id = $1',
      [agent.id],
    );
    expect(runs.rows[0]?.n).toBe(0);
    const results = await app.pool.query<{ n: number }>(
      `select count(*)::int as n from eval_results r
       join eval_runs e on e.id = r.eval_run_id where e.agent_id = $1`,
      [agent.id],
    );
    expect(results.rows[0]?.n).toBe(0);
  });
});
