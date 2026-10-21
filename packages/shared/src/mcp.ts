import { z } from 'zod';

/** 用户配置的 MCP Server；密钥字段在 API 层加密，返回时脱敏。 */
export const serverKindSchema = z.enum(['stdio', 'http', 'generated']);
export type ServerKind = z.infer<typeof serverKindSchema>;

export const PREVIEW_SECRET = '<已配置>';

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
  return { type: 'http' as const, url: typeof url === 'string' ? url : '', headers: values };
}

const baseServer = {
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _'),
  description: z.string().max(500).default(''),
};

export const stdioServerSchema = z.object({
  ...baseServer,
  kind: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

/** 只允许 http/https；ftp/file/javascript 等在 schema 层就被拦下。 */
export const httpUrlSchema = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), '仅支持 http/https 地址');

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
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _'),
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
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type ServerTestResult = z.infer<typeof serverTestResultSchema>;
