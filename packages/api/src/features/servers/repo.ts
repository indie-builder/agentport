import { randomBytes } from 'node:crypto';
import { AppError, fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import type { ServerRow } from '@agentport/db/repo/servers.js';
import * as serverRepo from '@agentport/db/repo/servers.js';
import type { ApiTool, ApiToolInput, Server, ServerInput } from '@agentport/shared';
import { decryptSecrets, encryptSecrets, maskServer, SECRET_MASK } from './secrets.js';

type Db = Database;

/** jsonb 里的配置是不可信输入：类型不对就当空值，而不是把 undefined 写进响应。 */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** DB 行 + 解密后的 env/headers → 共享 Server 形状（仍含明文 secret）。 */
export function toApiServer(row: ServerRow, keyB64url: string): Server {
  const secrets = row.secretsEncrypted ? decryptSecrets(row.secretsEncrypted, keyB64url) : {};
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const config = row.config;
  if (row.kind === 'stdio') {
    const args = config.args;
    return {
      ...base,
      kind: 'stdio',
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
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

/** 拆分输入：非敏感字段进 config，env/headers 进加密列。 */
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
        // PATCH 时沿用旧 token，否则改个描述就会让已配置的沙盒全部 401。
        config: { baseUrl: input.baseUrl, mcpToken: mcpToken ?? randomToken() },
        secretsEncrypted:
          Object.keys(input.headers).length > 0 ? encryptSecrets(input.headers, keyB64url) : null,
      };
  }
}

/** generated server 的访问令牌：给沙盒/其他 host 用，明文存 config。 */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function listServers(db: Db, key: string): Promise<Server[]> {
  const rows = await serverRepo.listServers(db);
  return rows.map((row) => maskServer(toApiServer(row, key)));
}

export async function getServerRow(db: Db, id: string): Promise<ServerRow | null> {
  return serverRepo.getServer(db, id);
}

export async function getServer(db: Db, id: string, key: string): Promise<Server | null> {
  const row = await serverRepo.getServer(db, id);
  return row ? maskServer(toApiServer(row, key)) : null;
}

/** 未脱敏版本，仅供服务端内部使用（test / MCP 端点）。 */
export async function getServerWithSecrets(
  db: Db,
  id: string,
  key: string,
): Promise<Server | null> {
  const row = await serverRepo.getServer(db, id);
  return row ? toApiServer(row, key) : null;
}

export async function createServer(db: Db, input: ServerInput, key: string): Promise<Server> {
  const split = splitInput(input, key);
  const row = await serverRepo.createServer(db, {
    name: input.name,
    kind: input.kind,
    description: input.description,
    config: split.config,
    secretsEncrypted: split.secretsEncrypted,
  });
  return maskServer(toApiServer(row, key));
}

/** PATCH 是三种 kind 字段的并集：kind 只用于校验不可变，其余按当前 kind 取用。 */
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

/** PATCH 语义：kind 不可变；env/headers 整体替换，值为 '••••' 的键沿用旧值。 */
function stale(): AppError {
  return new AppError('CONFLICT_STALE', '配置已被修改，请刷新');
}

export async function updateServer(
  db: Db,
  id: string,
  patch: ServerPatch,
  key: string,
  expectedUpdatedAt?: Date,
): Promise<Server | null> {
  const row = await serverRepo.getServer(db, id);
  if (!row) return null;
  // 并发编辑：调用方带上首次加载的 updatedAt，不匹配就不写。
  if (expectedUpdatedAt !== undefined && row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw stale();
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
  } else {
    next = {
      kind: 'generated',
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      headers: mergedSecrets(patch.headers, current.headers),
    };
  }

  const split = splitInput(
    next,
    key,
    typeof row.config.mcpToken === 'string' ? row.config.mcpToken : undefined,
  );
  const updated = await serverRepo.updateServer(
    db,
    id,
    {
      name: next.name,
      description: next.description,
      config: { ...row.config, ...split.config },
      secretsEncrypted: split.secretsEncrypted,
    },
    expectedUpdatedAt,
  );
  return updated ? maskServer(toApiServer(updated, key)) : null;
}

export async function deleteServer(db: Db, id: string): Promise<boolean> {
  return serverRepo.deleteServer(db, id);
}

export function toApiTool(row: serverRepo.ApiToolRow): ApiTool {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    description: row.description,
    method: row.method as ApiTool['method'],
    pathTemplate: row.pathTemplate,
    inputSchema: row.inputSchema,
    paramsIn: row.paramsIn,
    enabled: row.enabled,
    requiresApproval: row.requiresApproval,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTools(db: Db, serverId: string): Promise<ApiTool[]> {
  const rows = await serverRepo.listApiTools(db, serverId);
  return rows.map(toApiTool);
}

export async function createTool(db: Db, serverId: string, input: ApiToolInput): Promise<ApiTool> {
  const row = await serverRepo.createApiTool(db, {
    serverId,
    name: input.name,
    description: input.description,
    method: input.method,
    pathTemplate: input.pathTemplate,
    inputSchema: input.inputSchema,
    paramsIn: input.paramsIn,
    requiresApproval: input.requiresApproval,
  });
  return toApiTool(row);
}

export async function updateTool(
  db: Db,
  serverId: string,
  toolId: string,
  patch: serverRepo.ApiToolPatch,
): Promise<ApiTool | null> {
  const row = await serverRepo.updateApiTool(db, serverId, toolId, patch);
  return row ? toApiTool(row) : null;
}

export async function deleteTool(db: Db, serverId: string, toolId: string): Promise<boolean> {
  return serverRepo.deleteApiTool(db, serverId, toolId);
}

/** 只读 mcpToken，供测试连接与平台内部使用。 */
export async function getMcpToken(db: Db, id: string): Promise<string | null> {
  const row = await serverRepo.getServer(db, id);
  const token = row?.config.mcpToken;
  return typeof token === 'string' ? token : null;
}

/** 重新生成 mcpToken 并返回明文（仅此一次）；旧 token 立即失效。 */
export async function rotateMcpToken(db: Db, id: string): Promise<string | null> {
  const row = await serverRepo.getServer(db, id);
  if (row?.kind !== 'generated') return null;
  const token = randomToken();
  const updated = await serverRepo.updateServer(db, id, {
    config: { ...row.config, mcpToken: token },
  });
  return updated ? token : null;
}
