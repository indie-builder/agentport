import { z } from 'zod';

/** 用户配置的 MCP Server；密钥字段在 API 层加密，返回时脱敏。 */
export const serverKindSchema = z.enum(['stdio', 'http']);

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

export const httpServerSchema = z.object({
  ...baseServer,
  kind: z.literal('http'),
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const serverInputSchema = z.discriminatedUnion('kind', [
  stdioServerSchema,
  httpServerSchema,
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

/** 测试连接的结果，回显到页面。 */
export const serverTestResultSchema = z.object({
  ok: z.boolean(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type ServerTestResult = z.infer<typeof serverTestResultSchema>;
