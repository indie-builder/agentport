import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, CONFIG_STALE_MESSAGE, fail } from '@agentport/core';
import { type CursorPage, type Database, newId, repo, schema } from '@agentport/db';
import type {
  ApiTool,
  ApiToolInput,
  ResourceAccessFilter,
  Server,
  ServerInput,
} from '@agentport/shared';
import { inArray } from 'drizzle-orm';
import { decryptSecrets, encryptSecrets, maskServer, SECRET_MASK } from './secrets.js';

type Db = Database;

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toApiServer(row: repo.servers.ServerRow, keyB64url: string): Server {
  const secrets = row.secretsEncrypted ? decryptSecrets(row.secretsEncrypted, keyB64url) : {};
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

function splitInput(
  input: ServerInput,
  keyB64url: string,
  mcpToken?: string,
): { config: Record<string, unknown>; secretsEncrypted: string | null } {
  switch (input.kind) {
    case 'stdio':
      return {
        config: { command: input.command, args: input.args },
        secretsEncrypted:
          Object.keys(input.env).length > 0 ? encryptSecrets(input.env, keyB64url) : null,
      };
    case 'http':
      return {
        config: { url: input.url },
        secretsEncrypted:
          Object.keys(input.headers).length > 0 ? encryptSecrets(input.headers, keyB64url) : null,
      };
    case 'generated':
      return {
        config: { baseUrl: input.baseUrl, mcpToken: mcpToken ?? randomToken() },
        secretsEncrypted:
          Object.keys(input.headers).length > 0 ? encryptSecrets(input.headers, keyB64url) : null,
      };
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
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
    items: page.items.map((row) => maskServer(toApiServer(row, key))),
    nextCursor: page.nextCursor,
  };
}

export async function getServer(db: Db, id: string, key: string): Promise<Server | null> {
  const row = await repo.servers.getServer(db, id);
  return row ? maskServer(toApiServer(row, key)) : null;
}

export async function getServerWithSecrets(
  db: Db,
  id: string,
  key: string,
): Promise<Server | null> {
  const row = await repo.servers.getServer(db, id);
  return row ? toApiServer(row, key) : null;
}

export async function createServer(
  db: Db,
  input: ServerInput,
  key: string,
  ownerBusinessId: string,
): Promise<Server> {
  const split = splitInput(input, key);
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
  return maskServer(toApiServer(row, key));
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
  const names = inputs.map((input) => input.name);
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ name: schema.servers.name })
      .from(schema.servers)
      .where(inArray(schema.servers.name, names));
    if (existing.length > 0) fail('CONFLICT', '已有同名连接器，未导入任何配置');

    const rows = inputs.map((input) => {
      const id = newId('server');
      const split = splitInput(input, key);
      return {
        values: {
          id,
          name: input.name,
          kind: input.kind,
          description: input.description,
          config: split.config,
          secretsEncrypted: split.secretsEncrypted,
          ownerBusinessId,
        },
        summary: {
          id,
          name: input.name,
          kind: input.kind,
          secretKeys: Object.keys(input.kind === 'stdio' ? input.env : input.headers),
        } satisfies ImportedServerSummary,
      };
    });
    await tx.insert(schema.servers).values(rows.map((row) => row.values));
    return rows.map((row) => row.summary);
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
    const current = toApiServer(row, key);
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

    const split = splitInput(
      next,
      key,
      typeof row.config.mcpToken === 'string' ? row.config.mcpToken : undefined,
    );
    const secretsUnchanged =
      next.kind === 'stdio'
        ? current.kind === 'stdio' && isDeepStrictEqual(next.env, current.env)
        : (current.kind === 'http' || current.kind === 'generated') &&
          isDeepStrictEqual(next.headers, current.headers);
    const updated = await repo.servers.updateServer(
      tx,
      id,
      {
        name: next.name,
        description: next.description,
        config: { ...row.config, ...split.config },
        secretsEncrypted: secretsUnchanged ? row.secretsEncrypted : split.secretsEncrypted,
      },
      expectedUpdatedAt,
    );
    return updated ? maskServer(toApiServer(updated, key)) : null;
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
