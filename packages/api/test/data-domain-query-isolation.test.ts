import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encryptSecrets, hashMcpToken } from '@agentport/core';
import { newId, schema } from '@agentport/db';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ADMIN_BUSINESS_ID,
  infraReady,
  seedRun,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = (await infraReady) && !!process.env.WREN_RUNTIME_TEST_PYTHON;

const PYTHON = process.env.WREN_RUNTIME_TEST_PYTHON ?? '';
const RUNTIME_APP = join(import.meta.dir, '../../../infra/wren-runtime/app.py');

const MANIFEST = JSON.stringify({
  catalog: 'wren',
  schema: 'public',
  dataSource: 'duckdb',
  models: [
    {
      name: 'employees',
      tableReference: { catalog: 'warehouse', schema: 'main', table: 'employees' },
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'varchar' },
        { name: 'department', type: 'varchar' },
        {
          name: 'salary',
          type: 'integer',
          columnLevelAccessControl: {
            name: 'salary_clearance',
            requiredProperties: [{ name: 'clearance', required: true }],
            operator: 'GREATER_THAN_OR_EQUALS',
            threshold: '3',
          },
        },
        { name: 'region', type: 'varchar' },
      ],
      rowLevelAccessControls: [
        {
          name: 'dept_filter',
          requiredProperties: [{ name: 'department', required: true }],
          condition: 'department = @department',
        },
      ],
    },
  ],
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface QueryResult {
  columns: string[];
  rows: Array<Array<unknown>>;
  rowCount: number;
  truncated: boolean;
}

describe.skipIf(!ready)('data domain query isolation over MCP', () => {
  let app: TestApp;
  let server: TestServer;
  let baseUrl = '';
  let rootDir = '';
  let dbDir = '';
  let runtimeUrl = '';
  let runtime: ReturnType<typeof spawn> | undefined;
  let runtimeExit: Promise<void> | undefined;
  let runtimeLogs = '';

  const domainId = newId('dataDomain');
  const versionId = newId('dataDomainVersion');
  const serverId = newId('server');
  const agentId = newId('agent');
  const bizA = unique('biz-hr');
  const bizB = unique('biz-sales');
  const tokenA = randomBytes(32).toString('base64url');
  const tokenB = randomBytes(32).toString('base64url');
  let runIdA = '';
  let runIdB = '';
  let conversationIdA = '';
  let conversationIdB = '';

  async function toolCall(
    token: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> {
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${serverId}`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
      },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name, arguments: args });
      const first = result.content[0] as { text?: string } | undefined;
      return { isError: result.isError === true, text: first?.text ?? '' };
    } finally {
      await client.close();
    }
  }

  function mcpPost(headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp/${serverId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'data-domain-query-test', version: '0.0.0' },
        },
      }),
    });
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'data-domain-query-'));
    dbDir = join(rootDir, 'db');
    await mkdir(dbDir);
    const seedScript = join(rootDir, 'seed.py');
    await writeFile(
      seedScript,
      [
        'import duckdb, sys',
        'conn = duckdb.connect(sys.argv[1])',
        'conn.execute("create table employees (id integer, name varchar, department varchar, salary integer, region varchar)")',
        "conn.execute(\"insert into employees values (1, 'Alice', 'HR', 90000, 'north'), (2, 'Bob', 'HR', 80000, 'south'), (3, 'Carol', 'Sales', 70000, 'north'), (4, 'Dave', 'Sales', 60000, 'south'), (5, 'Eve', 'Sales', 95000, 'north')\")",
        'conn.close()',
      ].join('\n'),
    );
    const seeded = spawnSync(PYTHON, [seedScript, join(dbDir, 'warehouse.duckdb')], {
      encoding: 'utf8',
    });
    expect(seeded.status, seeded.stderr).toBe(0);

    try {
      const port = await freePort();
      const child = spawn(PYTHON, [RUNTIME_APP], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runtime = child;
      runtimeExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      runtime.stdout?.on('data', (chunk: Buffer) => {
        runtimeLogs += chunk.toString();
      });
      runtime.stderr?.on('data', (chunk: Buffer) => {
        runtimeLogs += chunk.toString();
      });
      runtimeUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const healthy = await fetch(`${runtimeUrl}/health`).then(
          (res) => res.status === 200,
          () => false,
        );
        if (healthy) break;
        if (Date.now() > deadline) {
          throw new Error(`wren runtime did not become healthy: ${runtimeLogs}`);
        }
        await delay(100);
      }

      app = await startApp({ WREN_RUNTIME_URL: runtimeUrl });
      server = await listen(app);
      baseUrl = server.url;

      await app.client.unsafe(
        `insert into data_domains (id, name, slug, datasource, connection_encrypted, created_by)
         values ($1, $2, $3, 'duckdb', $4, $5)`,
        [
          domainId,
          unique('dd'),
          unique('dd-slug'),
          await encryptSecrets({ url: dbDir, format: 'duckdb' }, app.config.APP_SECRET_KEY),
          ADMIN_BUSINESS_ID,
        ],
      );
      await app.client.unsafe(
        `insert into data_domain_versions (id, data_domain_id, status, project_files, mdl_manifest, log_tail)
         values ($1, $2, 'ready', '{}'::jsonb, $3, '')`,
        [versionId, domainId, MANIFEST],
      );
      await app.client.unsafe('update data_domains set online_version_id = $2 where id = $1', [
        domainId,
        versionId,
      ]);
      await app.client.unsafe(
        `insert into data_domain_identities (id, data_domain_id, business_id, properties)
         values ($1, $2, $3, $4::jsonb), ($5, $2, $6, $7::jsonb)`,
        [
          newId('dataDomainIdentity'),
          domainId,
          bizA,
          JSON.stringify({ department: "'HR'", clearance: '5' }),
          newId('dataDomainIdentity'),
          bizB,
          JSON.stringify({ department: "'Sales'", clearance: '1' }),
        ],
      );
      await app.client.unsafe(
        `insert into servers (id, name, kind, config) values ($1, $2, 'data_domain', $3::jsonb)`,
        [serverId, unique('dd-server'), JSON.stringify({ dataDomainId: domainId })],
      );

      const agentSlug = unique('m2a-agent');
      await app.db.insert(schema.agents).values({
        id: agentId,
        slug: agentSlug,
        name: agentSlug,
        model: 'test-model',
        createdBy: ADMIN_BUSINESS_ID,
        ownerBusinessId: ADMIN_BUSINESS_ID,
      });
      await app.db.insert(schema.agentServers).values({ agentId, serverId });

      const runA = await seedRun(app, agentId, {
        runId: unique('run-a'),
        mcpTokenHash: hashMcpToken(tokenA),
        subject: { kind: 'user', businessId: bizA },
      });
      runIdA = runA.runId;
      conversationIdA = runA.conversationId;
      const runB = await seedRun(app, agentId, {
        runId: unique('run-b'),
        mcpTokenHash: hashMcpToken(tokenB),
        subject: { kind: 'user', businessId: bizB },
      });
      runIdB = runB.runId;
      conversationIdB = runB.conversationId;
    } catch (err) {
      runtime?.kill('SIGKILL');
      await rm(rootDir, { recursive: true, force: true });
      throw err;
    }
  });

  afterAll(async () => {
    try {
      if (app) {
        await app.client.unsafe('delete from agent_runs where id = any($1::text[])', [
          app.client.array([runIdA, runIdB], 'TEXT'),
        ]);
        await app.client.unsafe('delete from conversations where id = any($1::text[])', [
          app.client.array([conversationIdA, conversationIdB], 'TEXT'),
        ]);
        await app.client.unsafe('delete from agent_servers where agent_id = $1', [agentId]);
        await app.client.unsafe('delete from agents where id = $1', [agentId]);
        await app.client.unsafe('delete from data_domains where id = $1', [domainId]);
        await app.client.unsafe('delete from servers where id = $1', [serverId]);
      }
    } finally {
      if (server) await server.close();
      if (app) await app.close();
      runtime?.kill('SIGKILL');
      if (runtimeExit) await Promise.race([runtimeExit, delay(3000)]);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns identity-scoped rows for the same SQL', async () => {
    const a = await toolCall(tokenA, runIdA, 'run_sql', {
      sql: 'select id, name from employees order by id',
    });
    expect(a.isError).toBeFalsy();
    const aBody = JSON.parse(a.text) as QueryResult;
    expect(aBody.columns).toEqual(['id', 'name']);
    expect(aBody.rows).toEqual([
      [1, 'Alice'],
      [2, 'Bob'],
    ]);
    expect(aBody.rowCount).toBe(2);

    const b = await toolCall(tokenB, runIdB, 'run_sql', {
      sql: 'select id, name from employees order by id',
    });
    expect(b.isError).toBeFalsy();
    const bBody = JSON.parse(b.text) as QueryResult;
    expect(bBody.columns).toEqual(['id', 'name']);
    expect(bBody.rows).toEqual([
      [3, 'Carol'],
      [4, 'Dave'],
      [5, 'Eve'],
    ]);
    expect(bBody.rowCount).toBe(3);
    expect(aBody.rows).not.toEqual(bBody.rows);
  });

  it('enforces column-level access control against the low-clearance identity', async () => {
    const sql = 'select id, name, salary from employees order by id';
    const a = await toolCall(tokenA, runIdA, 'run_sql', { sql });
    expect(a.isError).toBeFalsy();
    const aBody = JSON.parse(a.text) as QueryResult;
    expect(aBody.columns).toEqual(['id', 'name', 'salary']);
    expect(aBody.rows[0]).toEqual([1, 'Alice', 90000]);

    const b = await toolCall(tokenB, runIdB, 'run_sql', { sql });
    expect(b.isError).toBe(true);
    expect(b.text).toContain('QUERY_FAILED');
    expect(b.text).not.toContain('Alice');

    const direct = await fetch(`${runtimeUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mdlManifest: MANIFEST,
        datasource: 'duckdb',
        connection: { url: dbDir, format: 'duckdb' },
        sql,
        maxRows: 500,
        properties: { department: "'Sales'", clearance: '1' },
      }),
    });
    const denied = (await direct.json()) as { ok: boolean; error?: string };
    expect(denied.ok).toBe(false);
    expect(denied.error?.toLowerCase()).toContain('permission');
    expect(denied.error?.toLowerCase()).toContain('salary');
  });

  it('rejects client-supplied session properties', async () => {
    const forged = await toolCall(tokenA, runIdA, 'run_sql', {
      sql: 'select id from employees',
      properties: { department: "'HR'" },
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('INVALID_INPUT');
  });

  it('rejects swapped run tokens, missing tokens and unbound servers', async () => {
    const swapped = await mcpPost({
      authorization: `Bearer ${tokenA}`,
      'x-agentport-run-id': runIdB,
    });
    expect(swapped.status).toBe(401);

    const missing = await mcpPost({ 'x-agentport-run-id': runIdA });
    expect(missing.status).toBe(401);

    const missingRun = await mcpPost({ authorization: `Bearer ${tokenA}` });
    expect(missingRun.status).toBe(401);

    await app.client.unsafe('delete from agent_servers where agent_id = $1 and server_id = $2', [
      agentId,
      serverId,
    ]);
    const unbound = await mcpPost({
      authorization: `Bearer ${tokenA}`,
      'x-agentport-run-id': runIdA,
    });
    expect(unbound.status).toBe(401);
  });

  it('records the initiator identity in the query log', async () => {
    const logs = await app.client.unsafe<{ actor_business_id: string | null; status: string }[]>(
      'select actor_business_id, status from data_domain_query_logs where data_domain_id = $1',
      [domainId],
    );
    const actors = logs.map((row) => row.actor_business_id);
    expect(actors).toContain(bizA);
    expect(actors).toContain(bizB);
    expect(logs.some((row) => row.actor_business_id === bizB && row.status === 'error')).toBe(true);
  });
});
