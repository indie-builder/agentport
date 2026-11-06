import { drizzle } from 'drizzle-orm/bun-sql';
import { expect, it } from 'bun:test';
import type { RequestContext } from '../src/http/context.js';
import { overviewRouter } from '../src/modules/overview/router.js';

it('loads overview with three concurrent queries and one combined counts statement', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const releases: (() => void)[] = [];
  const client = {
    unsafe(text: string, values: unknown[]) {
      queries.push({ text, values });
      const gate = new Promise<void>((resolve) => releases.push(resolve));
      const rows: unknown[] =
        text.includes('percentile_cont') || text.includes('limit')
          ? []
          : [[0, 0, 0, 0, 0, 0, 0, null]];
      const result = gate.then(() => rows);
      return Object.assign(result, { values: () => result });
    },
    array: (values: unknown[]) => values,
  };
  const context = {
    db: drizzle(client as never),
    client: undefined,
    config: {},
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    auth: undefined,
    principal: {
      kind: 'user',
      authUserId: 'test-auth-user',
      businessId: 'test-user',
      username: 'test-user',
      name: 'test-user',
      roles: [],
      grants: [{ permissionId: 'overview.read', scope: 'platform' }],
    },
    requestId: 'test-request',
    request: new Request('http://localhost/api/overview?days=7'),
    responseHeaders: new Headers(),
    remoteAddress: '127.0.0.1',
    limit: async () => undefined,
  } as unknown as RequestContext;

  const response = overviewRouter.snapshot['~orpc'].handler({
    context,
    input: { query: { days: 7 } },
    path: ['snapshot'],
    procedure: overviewRouter.snapshot,
    lastEventId: undefined,
    errors: {},
  } as never);
  // Drain pending I/O until the route has submitted its first batch.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstBatch = queries.map(({ text }) => text);
  for (const release of releases.splice(0)) release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const release of releases.splice(0)) release();
  const result = (await response) as { counts: unknown };
  expect(queries).toHaveLength(3);
  expect(firstBatch).toHaveLength(3);
  expect(firstBatch.some((text) => text.includes('percentile_cont'))).toBe(true);
  expect(firstBatch.some((text) => text.includes('limit'))).toBe(true);
  const counts = queries.find(
    ({ text }) => text.includes('"servers"') && text.includes('"agents"'),
  );
  expect(counts).toBeDefined();
  expect(counts?.text.match(/from "agent_runs"/g)).toHaveLength(1);
  expect(counts?.text).toContain(`<> 'knowledge'`);
  expect(counts?.text).toContain('filter (where');
  expect(
    counts?.values.some(
      (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
    ),
  ).toBe(true);
  expect(result.counts).toEqual({
    servers: 0,
    agents: 0,
    runs: 0,
    running: 0,
    failed: 0,
    tokens: 0,
    costUsd: 0,
    avgLatencyMs: null,
  });
});
