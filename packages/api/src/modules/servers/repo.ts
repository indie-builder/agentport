import {
  AppError,
  CONFIG_STALE_MESSAGE,
  decryptSecrets,
  encryptSecrets,
  fail,
} from '@agentport/core';
import { type CursorPage, type Database, repo } from '@agentport/db';
import {
  type ApiTool,
  type ApiToolInput,
  maskUrlCredentials,
  type ResourceAccessFilter,
  SECRET_MASK,
  type Server,
  type ServerInput,
} from '@agentport/shared';

export function maskServer(s: Server): Server {
  if (s.kind === 'knowledge' || s.kind === 'data_domain') return s;
  const keys = Object.keys(s.kind === 'stdio' ? s.env : s.headers);
  const masked = Object.fromEntries(keys.map((k) => [k, SECRET_MASK]));
  if (s.kind === 'stdio') return { ...s, env: masked };
  if (s.kind === 'http') return { ...s, url: maskUrlCredentials(s.url), headers: masked };
  return { ...s, baseUrl: maskUrlCredentials(s.baseUrl), headers: masked };
}

type Db = Database;

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export async function toApiServer(row: repo.servers.ServerRow, keyB64url: string): Promise<Server> {
  const secrets = row.secretsEncrypted ? await decryptSecrets(row.secretsEncrypted, keyB64url) : {};
  const config = row.config;
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastToolCount: row.lastToolCount,
    lastTestRuntimeEnvironment: row.lastTestRuntimeEnvironment,
  };
  if (row.kind === 'knowledge') {
    return {
      ...base,
      kind: 'knowledge',
      config: { knowledgeBaseId: str(config.knowledgeBaseId) },
    };
  }
  if (row.kind === 'data_domain') {
    return {
      ...base,
      kind: 'data_domain',
      config: { dataDomainId: str(config.dataDomainId) },
    };
  }
  if (row.kind === 'stdio') {
    return {
      ...base,
      kind: 'stdio',
      command: str(config.command),
      args: strArray(config.args),
      env: secrets,
    };
  }
  const url =
    typeof config.url === 'string'
      ? config.url
      : typeof config.baseUrl === 'string'
        ? config.baseUrl
        : '';
  if (row.kind === 'http') return { ...base, kind: 'http', url, headers: secrets };
  return { ...base, kind: 'generated', baseUrl: url, headers: secrets };
}

async function splitInput(
  input: ServerInput,
  keyB64url: string,
  mcpToken?: string,
): Promise<{ config: Record<string, unknown>; secretsEncrypted: string | null }> {
  switch (input.kind) {
    case 'stdio':
      return {
        config: { command: input.command, args: input.args },
        secretsEncrypted:
          Object.keys(input.env).length > 0 ? await encryptSecrets(input.env, keyB64url) : null,
      };
    case 'http':
      return {
        config: { url: input.url },
        secretsEncrypted:
          Object.keys(input.headers).length > 0
            ? await encryptSecrets(input.headers, keyB64url)
            : null,
      };
    case 'generated':
      return {
        config: { baseUrl: input.baseUrl, mcpToken: mcpToken ?? randomToken() },
        secretsEncrypted:
          Object.keys(input.headers).length > 0
            ? await encryptSecrets(input.headers, keyB64url)
            : null,
      };
  }
}

function randomToken(): string {
  return crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: 'base64url', omitPadding: true });
}

export async function listServerPage(
  db: Db,
  key: string,
  options: {
    access?: ResourceAccessFilter | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<CursorPage<Server> | null> {
  const page = await repo.servers.listServerPage(db, options);
  if (page === null) return null;
  return {
    items: await Promise.all(
      page.items.map(async (row) => maskServer(await toApiServer(row, key))),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function getServerWithSecrets(
  db: Db,
  id: string,
  key: string,
): Promise<Server | null> {
  const row = await repo.servers.getServer(db, id);
  return row ? await toApiServer(row, key) : null;
}

export async function createServer(
  db: Db,
  input: ServerInput,
  key: string,
  ownerBusinessId: string,
): Promise<Server> {
  const split = await splitInput(input, key);
  const row = await repo.servers.createServer(
    db,
    {
      name: input.name,
      kind: input.kind,
      description: input.description,
      config: split.config,
      secretsEncrypted: split.secretsEncrypted,
    },
    ownerBusinessId,
  );
  return maskServer(await toApiServer(row, key));
}

export interface ImportedServerSummary {
  id: string;
  name: string;
  kind: ServerInput['kind'];
  secretKeys: string[];
}

export async function createServers(
  db: Db,
  inputs: ServerInput[],
  key: string,
  ownerBusinessId: string,
): Promise<ImportedServerSummary[]> {
  if (inputs.length === 0) return [];
  const prepared = await Promise.all(
    inputs.map(async (input) => {
      const split = await splitInput(input, key);
      return {
        write: {
          name: input.name,
          kind: input.kind,
          description: input.description,
          config: split.config,
          secretsEncrypted: split.secretsEncrypted,
        },
        secretKeys: Object.keys(input.kind === 'stdio' ? input.env : input.headers),
      };
    }),
  );
  const byName = new Map(prepared.map((entry) => [entry.write.name, entry]));
  const rows = await repo.servers.createServers(
    db,
    prepared.map((entry) => entry.write),
    ownerBusinessId,
  );
  return rows.map((row) => {
    const entry = byName.get(row.name);
    return {
      id: row.id,
      name: row.name,
      kind: entry?.write.kind ?? (row.kind as ServerInput['kind']),
      secretKeys: entry?.secretKeys ?? [],
    };
  });
}

export interface ServerPatch {
  kind?: ServerInput['kind'] | undefined;
  name?: string | undefined;
  description?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export async function updateServer(
  db: Db,
  id: string,
  patch: ServerPatch,
  key: string,
  expectedUpdatedAt?: Date,
): Promise<Server | null> {
  return db.transaction(async (tx) => {
    const row = await repo.servers.lockServer(tx, id);
    if (!row) return null;
    if (
      expectedUpdatedAt !== undefined &&
      row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
    ) {
      throw new AppError('CONFLICT_STALE', CONFIG_STALE_MESSAGE);
    }
    const current = await toApiServer(row, key);
    if (patch.kind !== undefined && patch.kind !== current.kind) {
      fail('INVALID_INPUT', 'Server 类型创建后不能修改；需要其他类型请新建一个 Server');
    }

    const mergedSecrets = (
      next: Record<string, string> | undefined,
      prev: Record<string, string>,
    ) => {
      if (!next) return prev;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(next)) out[k] = v === SECRET_MASK ? (prev[k] ?? '') : v;
      return out;
    };

    let next: ServerInput;
    if (current.kind === 'stdio') {
      next = {
        kind: 'stdio',
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        command: patch.command ?? current.command,
        args: patch.args ?? current.args,
        env: mergedSecrets(patch.env, current.env),
      };
    } else if (current.kind === 'http') {
      next = {
        kind: 'http',
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        url: patch.url ?? current.url,
        headers: mergedSecrets(patch.headers, current.headers),
      };
    } else if (current.kind === 'generated') {
      next = {
        kind: 'generated',
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        baseUrl: patch.baseUrl ?? current.baseUrl,
        headers: mergedSecrets(patch.headers, current.headers),
      };
    } else {
      fail('FORBIDDEN', '平台托管连接由所属设置管理');
    }

    const split = await splitInput(
      next,
      key,
      typeof row.config.mcpToken === 'string' ? row.config.mcpToken : undefined,
    );
    const secretsUnchanged =
      next.kind === 'stdio'
        ? current.kind === 'stdio' && Bun.deepEquals(next.env, current.env, true)
        : (current.kind === 'http' || current.kind === 'generated') &&
          Bun.deepEquals(next.headers, current.headers, true);
    const nextConfig: Record<string, unknown> = { ...row.config, ...split.config };
    if (
      current.kind === 'http' &&
      next.kind === 'http' &&
      (next.url !== current.url || !secretsUnchanged)
    ) {
      delete nextConfig.toolCatalog;
    }
    const updated = await repo.servers.updateServer(
      tx,
      id,
      {
        name: next.name,
        description: next.description,
        config: nextConfig,
        secretsEncrypted: secretsUnchanged ? row.secretsEncrypted : split.secretsEncrypted,
      },
      expectedUpdatedAt,
    );
    return updated ? maskServer(await toApiServer(updated, key)) : null;
  });
}

function toApiTool(row: repo.servers.ApiToolRow): ApiTool {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    description: row.description,
    method: row.method as ApiTool['method'],
    pathTemplate: row.pathTemplate,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    paramsIn: row.paramsIn,
    enabled: row.enabled,
    approvalMode: row.approvalMode,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTools(db: Db, serverId: string): Promise<ApiTool[]> {
  const rows = await repo.servers.listApiTools(db, serverId);
  return rows.map(toApiTool);
}

export async function createTool(db: Db, serverId: string, input: ApiToolInput): Promise<ApiTool> {
  const row = await repo.servers.createApiTool(db, {
    serverId,
    name: input.name,
    description: input.description,
    method: input.method,
    pathTemplate: input.pathTemplate,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema ?? null,
    paramsIn: input.paramsIn,
    approvalMode: input.approvalMode,
  });
  return toApiTool(row);
}

export async function createTools(
  db: Db,
  serverId: string,
  inputs: ApiToolInput[],
): Promise<ApiTool[]> {
  const rows = await repo.servers.createApiTools(db, serverId, inputs);
  return rows.map(toApiTool);
}

export async function updateTool(
  db: Db,
  serverId: string,
  toolId: string,
  patch: repo.servers.ApiToolPatch,
): Promise<ApiTool | null> {
  const row = await repo.servers.updateApiTool(db, serverId, toolId, patch);
  return row ? toApiTool(row) : null;
}

export async function getMcpToken(db: Db, id: string): Promise<string | null> {
  const row = await repo.servers.getServer(db, id);
  const token = row?.config.mcpToken;
  return typeof token === 'string' ? token : null;
}

export async function rotateMcpToken(db: Db, id: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const row = await repo.servers.lockServer(tx, id);
    if (row?.kind !== 'generated') return null;
    const token = randomToken();
    const updated = await repo.servers.updateServer(tx, id, {
      config: { ...row.config, mcpToken: token },
    });
    return updated ? token : null;
  });
}
