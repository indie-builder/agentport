import type { Database } from '@agentport/db';
import {
  type ApiTool,
  limitToolCatalog,
  redactSecrets,
  type Server,
  type ServerTestResult,
} from '@agentport/shared';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import { type CallToolResult, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { buildGeneratedServer } from './generated.js';
import { getServerRow, listTools as listApiTools, toApiServer } from './repo.js';
import { assertSafeUrl } from './ssrf.js';

const CONNECT_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30000;
const CATALOG_TTL_MS = 30000;
const MAX_TOOLS = 200;
const MAX_TOOL_NAME_LENGTH = 64;
const UNSAFE_NAME = /[^a-z0-9_-]+/g;

interface GatewayLogger {
  warn: (obj: object, msg: string) => void;
}

interface UpstreamBase {
  id: string;
  name: string;
}

interface HttpUpstream extends UpstreamBase {
  kind: 'http';
  url: string;
  headers: Record<string, string>;
}

interface GeneratedUpstream extends UpstreamBase {
  kind: 'generated';
  baseUrl: string;
  headers: Record<string, string>;
  tools: ApiTool[];
}

type Upstream = HttpUpstream | GeneratedUpstream;

interface ToolMeta {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface CatalogTool extends ToolMeta {
  invoke: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

interface CatalogEntry {
  sig: string;
  expiresAt: number;
  tools: Map<string, Tool[]>;
}

const catalogs = new Map<string, CatalogEntry>();

function gatewayToolName(upstreamName: string, toolName: string): string {
  return `${upstreamName}__${toolName}`
    .toLowerCase()
    .replace(UNSAFE_NAME, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOOL_NAME_LENGTH);
}

function uniqueGatewayToolName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    const tail = `-${suffix++}`;
    name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - tail.length)}${tail}`;
  }
  used.add(name);
  return name;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compileInputSchema(
  schema: Record<string, unknown> | undefined,
): { inputSchema: ReturnType<typeof fromJsonSchema<Record<string, unknown>>> } | { error: string } {
  try {
    return {
      inputSchema: fromJsonSchema<Record<string, unknown>>(
        (schema ?? { type: 'object', properties: {} }) as Parameters<typeof fromJsonSchema>[0],
      ),
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function resolveUpstreams(
  db: Database,
  serverIds: string[],
  key: string,
  log: GatewayLogger,
): Promise<Upstream[]> {
  const upstreams: Upstream[] = [];
  for (const id of serverIds) {
    const row = await getServerRow(db, id);
    if (!row) {
      log.warn({ serverId: id }, 'gateway upstream missing; skipped');
      continue;
    }
    if (row.kind !== 'http' && row.kind !== 'generated') {
      log.warn({ serverId: id, kind: row.kind }, 'gateway upstream not aggregatable; skipped');
      continue;
    }
    const server = toApiServer(row, key);
    if (server.kind === 'http') {
      upstreams.push({
        kind: 'http',
        id,
        name: server.name,
        url: server.url,
        headers: server.headers,
      });
      continue;
    }
    if (server.kind !== 'generated') continue;
    const tools = (await listApiTools(db, id)).filter((tool) => tool.enabled);
    upstreams.push({
      kind: 'generated',
      id,
      name: server.name,
      baseUrl: server.baseUrl,
      headers: server.headers,
      tools,
    });
  }
  return upstreams;
}

async function withHttpClient<T>(
  upstream: HttpUpstream,
  nodeEnv: string | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  await assertSafeUrl(upstream.url, nodeEnv);
  const client = new Client({ name: 'agentport-gateway', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(upstream.url), {
        requestInit: { headers: upstream.headers, redirect: 'error' },
      }),
      { timeout: CONNECT_TIMEOUT_MS },
    );
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listHttpTools(upstream: HttpUpstream, nodeEnv: string | undefined): Promise<Tool[]> {
  return withHttpClient(upstream, nodeEnv, async (client) => {
    const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    return listed.tools;
  });
}

function errorResult(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: redactSecrets(`上游工具调用失败：${errorMessage(err)}`) }],
  };
}

async function callHttpTool(
  upstream: HttpUpstream,
  toolName: string,
  args: Record<string, unknown>,
  nodeEnv: string | undefined,
): Promise<CallToolResult> {
  try {
    return await withHttpClient(upstream, nodeEnv, (client) =>
      client.callTool({ name: toolName, arguments: args }, { timeout: CALL_TIMEOUT_MS }),
    );
  } catch (err) {
    return errorResult(err);
  }
}

async function callGeneratedTool(
  upstream: GeneratedUpstream,
  tool: ApiTool,
  args: Record<string, unknown>,
  nodeEnv: string | undefined,
): Promise<CallToolResult> {
  const built = buildGeneratedServer({
    name: upstream.name,
    baseUrl: upstream.baseUrl,
    headers: upstream.headers,
    tools: [tool],
    approvals: [],
    nodeEnv,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agentport-gateway', version: '1.0.0' });
  try {
    await built.connect(serverSide);
    await client.connect(clientSide);
    return await client.callTool(
      { name: tool.name, arguments: args },
      { timeout: CALL_TIMEOUT_MS },
    );
  } catch (err) {
    return errorResult(err);
  } finally {
    await client.close().catch(() => undefined);
    await built.close().catch(() => undefined);
  }
}

async function loadHttpCatalogs(
  gatewayId: string,
  sig: string,
  upstreams: HttpUpstream[],
  nodeEnv: string | undefined,
  log: GatewayLogger,
): Promise<Map<string, Tool[]>> {
  const now = Date.now();
  for (const [id, entry] of catalogs) {
    if (entry.expiresAt <= now) catalogs.delete(id);
  }
  const cached = catalogs.get(gatewayId);
  if (cached && cached.sig === sig && cached.expiresAt > now) return cached.tools;

  const results = await Promise.allSettled(
    upstreams.map((upstream) => listHttpTools(upstream, nodeEnv)),
  );
  const tools = new Map<string, Tool[]>();
  for (const [index, result] of results.entries()) {
    const upstream = upstreams[index];
    if (!upstream) continue;
    if (result.status === 'fulfilled') {
      tools.set(upstream.id, result.value);
      continue;
    }
    log.warn(
      { serverId: upstream.id, error: redactSecrets(errorMessage(result.reason)) },
      'gateway upstream listTools failed; skipped',
    );
  }
  catalogs.set(gatewayId, { sig, expiresAt: now + CATALOG_TTL_MS, tools });
  return tools;
}

function httpCatalogTools(
  upstream: HttpUpstream,
  tools: Tool[],
  nodeEnv: string | undefined,
): CatalogTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    invoke: (args) => callHttpTool(upstream, tool.name, args, nodeEnv),
  }));
}

function generatedCatalogTools(
  upstream: GeneratedUpstream,
  nodeEnv: string | undefined,
): CatalogTool[] {
  return upstream.tools.map((tool) => ({
    name: tool.name,
    description: tool.description || `${tool.method} ${tool.pathTemplate}`,
    inputSchema: tool.inputSchema,
    invoke: (args) => callGeneratedTool(upstream, tool, args, nodeEnv),
  }));
}

interface BuildGatewayInput {
  db: Database;
  serverId: string;
  key: string;
  nodeEnv: string | undefined;
  log: GatewayLogger;
}

export async function buildGatewayServer(input: BuildGatewayInput): Promise<McpServer> {
  const row = await getServerRow(input.db, input.serverId);
  if (row?.kind !== 'gateway') throw new Error('not a gateway server');
  const server = toApiServer(row, input.key);
  if (server.kind !== 'gateway') throw new Error('not a gateway server');
  const upstreams = await resolveUpstreams(input.db, server.serverIds, input.key, input.log);
  const httpUpstreams = upstreams.filter(
    (upstream): upstream is HttpUpstream => upstream.kind === 'http',
  );
  const httpCatalogs =
    httpUpstreams.length > 0
      ? await loadHttpCatalogs(
          input.serverId,
          row.updatedAt.toISOString(),
          httpUpstreams,
          input.nodeEnv,
          input.log,
        )
      : new Map<string, Tool[]>();

  const mcp = new McpServer({ name: server.name, version: '1.0.0' });
  const used = new Set<string>();
  let total = 0;
  outer: for (const upstream of upstreams) {
    const tools =
      upstream.kind === 'http'
        ? httpCatalogTools(upstream, httpCatalogs.get(upstream.id) ?? [], input.nodeEnv)
        : generatedCatalogTools(upstream, input.nodeEnv);
    for (const tool of tools) {
      if (total >= MAX_TOOLS) {
        input.log.warn(
          { serverId: input.serverId, limit: MAX_TOOLS },
          'gateway tool limit reached; remaining tools skipped',
        );
        break outer;
      }
      const compiled = compileInputSchema(tool.inputSchema);
      if ('error' in compiled) {
        input.log.warn(
          { serverId: upstream.id, tool: tool.name, error: redactSecrets(compiled.error) },
          'gateway tool schema invalid; skipped',
        );
        continue;
      }
      const name = uniqueGatewayToolName(gatewayToolName(upstream.name, tool.name), used);
      mcp.registerTool(
        name,
        { description: tool.description ?? '', inputSchema: compiled.inputSchema },
        tool.invoke,
      );
      total += 1;
    }
  }
  return mcp;
}

interface TestGatewayInput {
  db: Database;
  server: Extract<Server, { kind: 'gateway' }>;
  key: string;
  nodeEnv: string | undefined;
  log: GatewayLogger;
}

export async function testGatewayConnection(input: TestGatewayInput): Promise<ServerTestResult> {
  const startedAt = Date.now();
  const upstreams = await resolveUpstreams(input.db, input.server.serverIds, input.key, input.log);
  if (upstreams.length === 0) {
    return {
      ok: false,
      tools: [],
      error: '没有可聚合的连接器',
      durationMs: Date.now() - startedAt,
    };
  }

  const results = await Promise.allSettled(
    upstreams.map((upstream) =>
      upstream.kind === 'http'
        ? listHttpTools(upstream, input.nodeEnv).then((tools) => ({ upstream, tools }))
        : Promise.resolve({
            upstream,
            tools: upstream.tools.map(
              (tool): ToolMeta => ({
                name: tool.name,
                description: tool.description || `${tool.method} ${tool.pathTemplate}`,
                inputSchema: tool.inputSchema,
              }),
            ),
          }),
    ),
  );

  const tools: ServerTestResult['tools'] = [];
  const failures: string[] = [];
  const used = new Set<string>();
  let connected = 0;
  for (const [index, result] of results.entries()) {
    const upstream = upstreams[index];
    if (!upstream) continue;
    if (result.status === 'rejected') {
      const reason = redactSecrets(errorMessage(result.reason));
      failures.push(`${upstream.name}: ${reason}`);
      input.log.warn({ serverId: upstream.id, error: reason }, 'gateway upstream test failed');
      continue;
    }
    connected += 1;
    for (const tool of result.value.tools) {
      if (tools.length >= MAX_TOOLS) break;
      const compiled = compileInputSchema(tool.inputSchema);
      if ('error' in compiled) {
        failures.push(
          `${upstream.name}: 工具 ${tool.name} 的参数定义无效（${redactSecrets(compiled.error)}）`,
        );
        continue;
      }
      tools.push({
        name: uniqueGatewayToolName(gatewayToolName(upstream.name, tool.name), used),
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      });
    }
  }

  let limited: ServerTestResult['tools'];
  try {
    limited = limitToolCatalog(tools);
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: redactSecrets(errorMessage(err)),
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    ok: connected > 0,
    tools: limited,
    ...(failures.length > 0 ? { error: failures.join('；') } : {}),
    durationMs: Date.now() - startedAt,
  };
}
