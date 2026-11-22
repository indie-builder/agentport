import { z } from 'zod';
import { HTTP_URL_ONLY_MESSAGE, URL_CREDENTIALS_MESSAGE } from './errors.js';
import { slugSchema } from './params.js';
import { resolvedRuntimeEnvironmentSchema } from './runtime-environment.js';
import { hasEmbeddedCredentials, parseUrl } from './url.js';

export const serverKindSchema = z.enum(['stdio', 'http', 'generated', 'knowledge', 'data_domain']);
export type ServerKind = z.infer<typeof serverKindSchema>;

export const MCP_APPROVAL_WAIT_MS = 355_000;
export const MCP_APPROVAL_HOOK_TIMEOUT_SECONDS = 360;

export function mcpEndpointPath(serverId: string): string {
  return `/mcp/${serverId}`;
}

export function toolApprovalPath(serverId: string, runId: string, tool: string): string {
  return `/tool-approvals/${encodeURIComponent(runId)}/${encodeURIComponent(serverId)}/${encodeURIComponent(tool)}`;
}

export const SECRET_MASK = '••••';
export const PREVIEW_SECRET = SECRET_MASK;

export function maskSecret(value: string | null | undefined): string {
  return value ? SECRET_MASK : '';
}

export function maskUrlCredentials(value: string): string {
  const url = parseUrl(value);
  if (!url) return '[无效URL]';
  if (!hasEmbeddedCredentials(url)) return value;
  if (url.username) url.username = SECRET_MASK;
  if (url.password) url.password = SECRET_MASK;
  return url.toString();
}

const isStringMap = (value: unknown): value is Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) return false;
    return 'value' in descriptor && typeof descriptor.value === 'string';
  });
};
const mcpJsonArtifactHeaders = z.custom<Record<string, string>>(isStringMap);

const mcpJsonArtifactStdioEntrySchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: mcpJsonArtifactHeaders.default({}),
});

const mcpJsonArtifactHttpBase = {
  type: z.enum(['http', 'streamable-http']),
  url: z.string(),
  headers: mcpJsonArtifactHeaders.default({}),
};

export const mcpJsonArtifactEntrySchema = z.discriminatedUnion('type', [
  mcpJsonArtifactStdioEntrySchema,
  z.strictObject(mcpJsonArtifactHttpBase),
]);

export type McpJsonArtifactEntry = z.infer<typeof mcpJsonArtifactEntrySchema> & {
  readonly _note?: never;
};

export const previewMcpJsonArtifactEntrySchema = z.discriminatedUnion('type', [
  mcpJsonArtifactStdioEntrySchema,
  z.strictObject({
    ...mcpJsonArtifactHttpBase,
    _note: z.string().optional(),
  }),
]);

export type PreviewMcpJsonArtifactEntry = z.infer<typeof previewMcpJsonArtifactEntrySchema>;

export function previewMcpEntry(
  server: { kind: ServerKind; config: Record<string, unknown> },
  values: Record<string, string> = {},
): McpJsonArtifactEntry {
  const config = server.config;
  if (server.kind === 'stdio') {
    return {
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(config.args)
        ? config.args.filter((value): value is string => typeof value === 'string')
        : [],
      env: values,
    };
  }
  if (server.kind === 'data_domain' || server.kind === 'knowledge') {
    return { type: 'http' as const, url: '', headers: values };
  }
  const url = server.kind === 'generated' ? config.baseUrl : config.url;
  return {
    type: 'http' as const,
    url: typeof url === 'string' ? maskUrlCredentials(url) : '',
    headers: values,
  };
}

/**
 * 专家包里的知识库凭据占位：导出只写这个环境变量名，run token 与密钥都不进包。
 * 官方 `.mcp.json` 支持 `${VAR}` 展开，因此包仍是标准 MCP HTTP 条目。
 */
export function knowledgeTokenEnv(serverName: string): string {
  return `KNOWLEDGE_${serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`;
}

export function knowledgeMcpEntry(input: {
  apiUrl: string;
  serverId: string;
  runId: string;
  runToken: string;
}) {
  return {
    type: 'http' as const,
    url: `${input.apiUrl.replace(/\/$/, '')}${mcpEndpointPath(input.serverId)}`,
    headers: {
      Authorization: `Bearer ${input.runToken}`,
      'x-agentport-run-id': input.runId,
    },
  };
}

export function generatedMcpEntry(
  input: Parameters<typeof knowledgeMcpEntry>[0],
  headers: Record<string, string> = {},
) {
  return {
    type: 'http' as const,
    url: `${input.apiUrl.replace(/\/$/, '')}${mcpEndpointPath(input.serverId)}`,
    headers: {
      ...headers,
      Authorization: `Bearer ${input.runToken}`,
      'x-agentport-run-id': input.runId,
    },
  };
}

const baseServer = {
  name: slugSchema,
  description: z.string().max(500).default(''),
};

export const stdioServerSchema = z.object({
  ...baseServer,
  kind: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const httpUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), HTTP_URL_ONLY_MESSAGE)
  .refine((value) => {
    const url = parseUrl(value);
    return url !== null && !hasEmbeddedCredentials(url);
  }, URL_CREDENTIALS_MESSAGE);

/** 入口即拒绝 `${...}`：SDK 可能展开模板，导入的配置不能把展开时机留到运行时。 */
const mcpJsonPlainString = z.string().refine((value) => !value.includes('${'), '不支持模板占位符');

const mcpJsonStdioEntrySchema = z.strictObject({
  type: z.literal('stdio'),
  command: mcpJsonPlainString.min(1),
  args: z.array(mcpJsonPlainString).default([]),
  env: z.record(mcpJsonPlainString, mcpJsonPlainString).default({}),
});

const mcpJsonHttpEntrySchema = z.strictObject({
  type: z.enum(['http', 'streamable-http']),
  url: httpUrlSchema.refine((value) => !value.includes('${'), '不支持模板占位符'),
  headers: z.record(mcpJsonPlainString, mcpJsonPlainString).default({}),
});

export const mcpJsonEntrySchema = z.preprocess(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === undefined
      ? { ...value, type: 'stdio' as const }
      : value,
  z.discriminatedUnion('type', [mcpJsonStdioEntrySchema, mcpJsonHttpEntrySchema]),
);

export const httpServerSchema = z.object({
  ...baseServer,
  kind: z.literal('http'),
  url: httpUrlSchema,
  headers: z.record(z.string(), z.string()).default({}),
});

export const generatedServerSchema = z.object({
  ...baseServer,
  kind: z.literal('generated'),
  baseUrl: httpUrlSchema,
  headers: z.record(z.string(), z.string()).default({}),
});

export const knowledgeServerSchema = z.object({
  kind: z.literal('knowledge'),
  name: slugSchema,
  description: z.string().default(''),
  config: z.object({ knowledgeBaseId: z.string() }),
});

export const dataDomainServerSchema = z.object({
  kind: z.literal('data_domain'),
  name: slugSchema,
  description: z.string().default(''),
  config: z.object({ dataDomainId: z.string() }),
});

export const serverInputSchema = z.discriminatedUnion('kind', [
  stdioServerSchema,
  httpServerSchema,
  generatedServerSchema,
]);

export type ServerInput = z.infer<typeof serverInputSchema>;

const serverIdFields = {
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastTestedAt: z.string().nullable().optional(),
  lastTestOk: z.boolean().nullable().optional(),
  lastToolCount: z.number().int().nullable().optional(),
  lastTestRuntimeEnvironment: resolvedRuntimeEnvironmentSchema.nullable().optional(),
};

const maskedHttpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => maskUrlCredentials(value) === value, 'URL凭证必须脱敏');

export const serverSchema = z.discriminatedUnion('kind', [
  stdioServerSchema.extend(serverIdFields),
  httpServerSchema.extend({ ...serverIdFields, url: maskedHttpUrlSchema }),
  generatedServerSchema.extend({ ...serverIdFields, baseUrl: maskedHttpUrlSchema }),
  knowledgeServerSchema.extend(serverIdFields),
  dataDomainServerSchema.extend(serverIdFields),
]);

export type Server = z.infer<typeof serverSchema>;

export const apiToolParamsInSchema = z.enum(['query', 'body']);
export type ApiToolParamsIn = z.infer<typeof apiToolParamsInSchema>;

export const apiToolApprovalModeSchema = z.enum(['allow', 'ask', 'deny']);
export type ApiToolApprovalMode = z.infer<typeof apiToolApprovalModeSchema>;

export const apiToolInputSchema = z.object({
  name: slugSchema,
  description: z.string().max(1000).default(''),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  pathTemplate: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  paramsIn: apiToolParamsInSchema.default('query'),
  approvalMode: apiToolApprovalModeSchema.default('allow'),
});

export type ApiToolInput = z.infer<typeof apiToolInputSchema>;

export const apiToolSchema = apiToolInputSchema.and(
  z.object({
    id: z.string(),
    serverId: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
  }),
);

export type ApiTool = z.infer<typeof apiToolSchema>;

export const toolApprovalResponseSchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  approvalId: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

export const mcpToolSummarySchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type McpToolSummary = z.infer<typeof mcpToolSummarySchema>;

export const serverTestResultSchema = z.object({
  ok: z.boolean(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  tools: z.array(mcpToolSummarySchema).default([]),
  error: z.string().optional(),
  runtimeEnvironment: resolvedRuntimeEnvironmentSchema.optional(),
  durationMs: z.number(),
});

export type ServerTestResult = z.infer<typeof serverTestResultSchema>;
