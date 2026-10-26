import { createDb } from '@agentport/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerServerRoutes } from '../src/features/servers/routes.js';
import { registerErrorHandler } from '../src/plugins/errors.js';

vi.mock('../src/plugins/audit.js', () => ({ writeAudit: vi.fn() }));

const handle = createDb(
  process.env.DATABASE_URL ??
    'postgres://pace_knowledge:pace_knowledge_local@127.0.0.1:55432/pace_knowledge',
);
let app: FastifyInstance;
const serverId = 'srv_kb_guard_test';

beforeAll(async () => {
  await handle.pool.query(
    `insert into servers (id, name, kind, config) values ($1, $2, 'knowledge', $3)
     on conflict (id) do nothing`,
    [serverId, 'kb-guard-test', JSON.stringify({ knowledgeBaseId: 'kb_missing' })],
  );
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('requireAuth', async () => undefined);
  app.decorate('config', { NODE_ENV: 'test', SELF_URL: 'http://127.0.0.1:3000' });
  app.decorate('db', handle.db);
  registerErrorHandler(app);
  await registerServerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await handle.pool.query('delete from servers where id = $1', [serverId]);
  await app.close();
  await handle.pool.end();
});

describe('knowledge server is owned by the knowledge lifecycle', () => {
  it('hides knowledge servers from the generic connector list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/servers' });
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json() as Array<{ id: string }>;
    expect(rows.some((row) => row.id === serverId)).toBe(false);
  });

  it('refuses to delete a knowledge server through the generic endpoint', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/servers/${serverId}` });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('keeps the knowledge server in the database after the refused delete', async () => {
    const { rows } = await handle.pool.query('select kind from servers where id = $1', [serverId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'knowledge' });
  });
});
