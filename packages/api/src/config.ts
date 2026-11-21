import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonEnvSchema, parseEnv } from '@agentport/shared';
import { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const WEAK_PASSWORDS = new Set(['admin-change-me', 'changeme', 'password']);

const { NODE_ENV, LOG_LEVEL, REDIS_URL } = commonEnvSchema.shape;

const envSchema = z
  .object({
    NODE_ENV,
    LOG_LEVEL,
    PORT: z.coerce.number().int().positive().default(3000),
    SELF_URL: z.string().default('http://127.0.0.1:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL,
    APP_SECRET_KEY: z.string().min(32),
    ADMIN_USER: z.string().default('admin'),
    ALLOW_WEAK_ADMIN_PASSWORD: z.enum(['true', 'false']).optional(),
    ADMIN_PASSWORD: z.string().min(1).max(128),
    JWT_SECRET: z.string().min(32),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    APPROVAL_WAIT_MS: z.coerce.number().int().nonnegative().default(300_000),
    SANDBOX_IMAGE: z.string().min(1).default('agentport/sandbox:dev'),
    WORKSPACES_DIR: z.string().min(1).default('./data/workspaces'),
    KNOWLEDGE_DIR: z.string().min(1).default('./data/knowledge'),
    KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
    MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
    GENERATED_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
    WEBHOOK_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
    WREN_RUNTIME_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().default(''),
    ),
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

export function getTrustedOrigins(config: Pick<Config, 'CORS_ORIGINS' | 'SELF_URL'>): string[] {
  return [
    ...config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    config.SELF_URL,
  ];
}

export function isTrustedOrigin(origin: string, trustedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
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
  const config = parseEnv(envSchema, env);
  return {
    ...config,
    WORKSPACES_DIR: fromRepoRoot(config.WORKSPACES_DIR),
    KNOWLEDGE_DIR: fromRepoRoot(config.KNOWLEDGE_DIR),
  };
}
