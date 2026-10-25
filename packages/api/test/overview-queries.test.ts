import type { DbPool } from '@agentport/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { expect, it } from 'vitest';
import { registerOverviewRoutes } from '../src/features/overview/routes.js';

it('loads overview with three concurrent queries and one combined counts statement', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const releases: (() => void)[] = [];
  const client = {
    async query(query: { text: string }, values: unknown[]) {
      queries.push({ text: query.text, values });
      await new Promise<void>((resolve) => releases.push(resolve));
      if (query.text.includes('percentile_cont') || query.text.includes('limit'))
        return { rows: [] };
      return { rows: [[0, 0, 0, 0, 0, 0, 0, null]] };
    },
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('requireAuth', async () => {});
  app.decorate('db', drizzle(client as unknown as DbPool));
  registerOverviewRoutes(app);
  await app.ready();
  try {
    const response = app.inject('/api/overview?days=7');
    // Drain pending I/O until the route has submitted its first batch.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstBatch = queries.map(({ text }) => text);
    for (const release of releases.splice(0)) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const release of releases.splice(0)) release();
    const result = await response;
    expect(result.statusCode, result.body).toBe(200);
    expect(queries).toHaveLength(3);
    expect(firstBatch).toHaveLength(3);
    expect(firstBatch.some((text) => text.includes('percentile_cont'))).toBe(true);
    expect(firstBatch.some((text) => text.includes('limit'))).toBe(true);
    const counts = queries.find(
      ({ text }) => text.includes('"servers"') && text.includes('"agents"'),
    );
    expect(counts).toBeDefined();
    expect(counts?.text.match(/from "agent_runs"/g)).toHaveLength(1);
    expect(counts?.text).toContain('filter (where');
    expect(counts?.values.some((value) => value instanceof Date)).toBe(true);
    expect(result.json().counts).toEqual({
      servers: 0,
      agents: 0,
      runs: 0,
      running: 0,
      failed: 0,
      tokens: 0,
      costUsd: 0,
      avgLatencyMs: null,
    });
  } finally {
    for (const release of releases) release();
    await app.close();
  }
});
