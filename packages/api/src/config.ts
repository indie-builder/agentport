import { commonEnvSchema, parseEnv } from '@agentport/shared';
import { z } from 'zod';

/** 常见弱默认口令：默认不允许，避免配置被原样带到部署环境。 */
const WEAK_PASSWORDS = new Set(['admin-change-me', 'changeme', 'password']);

const { NODE_ENV, LOG_LEVEL, REDIS_URL } = commonEnvSchema.shape;

const envSchema = z
  .object({
    NODE_ENV,
    LOG_LEVEL,
    PORT: z.coerce.number().int().positive().default(3000),
    /** 平台自身可达地址，用于 generated server 的 MCP 端点自测 */
    SELF_URL: z.string().default('http://127.0.0.1:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL,
    APP_SECRET_KEY: z.string().min(32),
    ADMIN_USER: z.string().default('admin'),
    /** 仅本地个人开发显式设为 'true'，放行 admin/admin；默认按部署规则校验。 */
    ALLOW_WEAK_ADMIN_PASSWORD: z.enum(['true', 'false']).optional(),
    ADMIN_PASSWORD: z.string().min(1).max(128),
    JWT_SECRET: z.string().min(32),
    /** 逗号分隔的浏览器 Origin allowlist；开发默认 Vite dev server。 */
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    /** 未批准的工具调用挂起多久（D-18）；超时按拒绝处理。0 表示立即拒绝。 */
    APPROVAL_WAIT_MS: z.coerce.number().int().nonnegative().default(300_000),
    /** 用户运行环境构建时冻结的基座 tag；worker 构建时解析成不可变 image ID。 */
    SANDBOX_IMAGE: z.string().min(1).default('agentport/sandbox:dev'),
    /** 与 worker 同机共享的工作区根目录；记忆文件就落在这里的 <slug>/agent-memory/。 */
    WORKSPACES_DIR: z.string().min(1).default('./data/workspaces'),
    /** 知识库原件与解析产物根目录；与 worker 共享同一持久卷。 */
    KNOWLEDGE_DIR: z.string().min(1).default('./data/knowledge'),
    /** 逗号分隔的私网主机（`host` 或 `host:port`）；模型端点只在这些主机上放行内网地址。 */
    KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.ALLOW_WEAK_ADMIN_PASSWORD === 'true') return;
    if (env.ADMIN_PASSWORD.length < 12 || WEAK_PASSWORDS.has(env.ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PASSWORD'],
        message: 'must be at least 12 characters and not a well-known default password',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

/** 浏览器 Origin allowlist：逗号分隔的 CORS_ORIGINS 加上平台自身地址。 */
export function getTrustedOrigins(config: Pick<Config, 'CORS_ORIGINS' | 'SELF_URL'>): string[] {
  return [
    ...config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    config.SELF_URL,
  ];
}

/**
 * 通配符只支持 `protocol://*.hostname[:port]`：协议与端口必须一致，
 * 主机名必须比基域多至少一个标签。精确条目保持原有的字符串语义。
 */
export function isTrustedOrigin(origin: string, trustedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Origin 只能是纯 origin；带凭据、路径、查询或 fragment 的一律拒绝。
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    return false;
  }

  return trustedOrigins.some((entry) => {
    if (entry === '*' || !entry.includes('://*.')) return parsed.origin === entry;

    let pattern: URL;
    try {
      pattern = new URL(entry);
    } catch {
      return false;
    }
    if (pattern.username || pattern.password || pattern.pathname !== '/' || pattern.search) {
      return false;
    }
    const base = pattern.hostname.slice(2);
    return (
      parsed.protocol === pattern.protocol &&
      parsed.port === pattern.port &&
      base.length > 0 &&
      parsed.hostname.length > base.length + 1 &&
      parsed.hostname.endsWith(`.${base}`)
    );
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseEnv(envSchema, env);
}
