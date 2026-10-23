import { z } from 'zod';
import { slugSchema } from './params.js';

/** 用户配置的 MCP Server；密钥字段在 API 层加密，返回时脱敏。 */
export const serverKindSchema = z.enum(['stdio', 'http', 'generated']);
export type ServerKind = z.infer<typeof serverKindSchema>;

export const SECRET_MASK = '••••';
export const PREVIEW_SECRET = SECRET_MASK;

// shared 不带 DOM/Node lib，这里声明跨运行时都可用的最小 URL 形状。
type ParsedUrl = { username: string; password: string; toString(): string };

function parseUrl(value: string): ParsedUrl | null {
  try {
    return new (globalThis as unknown as { URL: new (value: string) => ParsedUrl }).URL(value);
  } catch {
    return null;
  }
}

/** 空值保留为空；已配置密钥不泄露长度或前缀。 */
export function maskSecret(value: string | null | undefined): string {
  return value ? SECRET_MASK : '';
}

/** 仅用于展示：隐藏 URL 内嵌凭证；无 userinfo 时原样返回，不规范化。 */
export function maskUrlCredentials(value: string): string {
  const url = parseUrl(value);
  if (!url) return '[无效URL]';
  if (!url.username && !url.password) return value;
  if (url.username) url.username = SECRET_MASK;
  if (url.password) url.password = SECRET_MASK;
  return url.toString();
}

/** Build an MCP entry with values supplied by the caller (masked, empty, or runtime secrets). */
export function previewMcpEntry(
  server: { kind: ServerKind; config: Record<string, unknown> },
  values: Record<string, string> = {},
) {
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
  const url = server.kind === 'generated' ? config.baseUrl : config.url;
  return {
    type: 'http' as const,
    url: typeof url === 'string' ? maskUrlCredentials(url) : '',
    headers: values,
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

/** 只允许 http/https，且禁止内嵌账号密码；ftp/file/javascript 等在 schema 层就被拦下。 */
export const httpUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), '仅支持 http/https 地址')
  .refine((value) => {
    const url = parseUrl(value);
    return url !== null && !url.username && !url.password;
  }, 'URL不能包含账号密码，请通过加密headers配置凭证');

export const httpServerSchema = z.object({
  ...baseServer,
  kind: z.literal('http'),
  url: httpUrlSchema,
  headers: z.record(z.string(), z.string()).default({}),
});

/** 由平台自身把上游 HTTP API 包装成 MCP 的 server。 */
export const generatedServerSchema = z.object({
  ...baseServer,
  kind: z.literal('generated'),
  baseUrl: httpUrlSchema,
  headers: z.record(z.string(), z.string()).default({}),
});

export const serverInputSchema = z.discriminatedUnion('kind', [
  stdioServerSchema,
  httpServerSchema,
  generatedServerSchema,
]);

export type ServerInput = z.infer<typeof serverInputSchema>;

export const serverSchema = serverInputSchema.and(
  z.object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Server = z.infer<typeof serverSchema>;

/** generated server 下的单个 HTTP 工具。 */
export const apiToolInputSchema = z.object({
  name: slugSchema,
  description: z.string().max(1000).default(''),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** 相对 baseUrl 的路径模板，如 `/users/{id}` */
  pathTemplate: z.string().min(1),
  /** JSON Schema，用于生成 MCP tool 的 inputSchema */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  /** 参数放在 query 还是 body */
  paramsIn: z.enum(['query', 'body']).default('query'),
  /** 调用前需要在运行页批准；未批准时平台 MCP 端点直接返回错误。 */
  requiresApproval: z.boolean().default(false),
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

/** 测试连接的结果，回显到页面。 */
export const serverTestResultSchema = z.object({
  ok: z.boolean(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type ServerTestResult = z.infer<typeof serverTestResultSchema>;
