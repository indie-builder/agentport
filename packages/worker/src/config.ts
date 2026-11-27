import { isAbsolute, resolve } from 'node:path';
import {
  commonEnvSchema,
  DEFAULT_SANDBOX_API_URL,
  DEFAULT_SANDBOX_MAX_FIELD_BYTES,
  parseEnv,
  RETENTION_DEFAULTS,
  serviceEnvShape,
} from '@agentport/shared';
import { z } from 'zod';

const repoRoot = Bun.fileURLToPath(new URL('../../../', import.meta.url));

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const { NODE_ENV, LOG_LEVEL, REDIS_URL } = commonEnvSchema.shape;

const optionalModelEnv = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const envSchema = z
  .object({
    NODE_ENV,
    LOG_LEVEL,
    DATABASE_URL: serviceEnvShape.DATABASE_URL,
    REDIS_URL,
    WORKSPACES_DIR: serviceEnvShape.WORKSPACES_DIR,
    /**
     * 宿主视角的 WORKSPACES_DIR。容器部署时 WORKSPACES_DIR 是命名卷挂载点（如 /workspaces），
     * 而 docker -v 的源路径由宿主 daemon 解析，必须换成该卷的宿主目录。默认与 WORKSPACES_DIR 相同。
     */
    HOST_WORKSPACES_DIR: z.string().min(1).optional(),
    SANDBOX_IMAGE: serviceEnvShape.SANDBOX_IMAGE,
    SANDBOX_EGRESS: z.enum(['open', 'none', 'proxy']).default('open'),
    HTTPS_PROXY: z.string().optional(),
    HTTP_PROXY: z.string().optional(),
    NO_PROXY: z.string().optional(),
    no_proxy: z.string().optional(),
    SANDBOX_MEMORY: z
      .string()
      .regex(/^[1-9]\d*[bkmg]?$/i, 'expected a docker memory value such as 1g')
      .default('1g'),
    SANDBOX_CPUS: z.coerce.number().positive().default(1),
    SANDBOX_PIDS: z.coerce.number().int().positive().default(128),
    SANDBOX_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    SANDBOX_MAX_ACTIVE: z.coerce.number().int().positive().default(6),
    AGENT_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
    RETAIN_RUN_DAYS: z.coerce.number().int().positive().default(RETENTION_DEFAULTS.runDays),
    RETAIN_MESSAGE_DAYS: z.coerce.number().int().positive().default(RETENTION_DEFAULTS.messageDays),
    RETAIN_AGENT_VERSIONS: z.coerce
      .number()
      .int()
      .positive()
      .default(RETENTION_DEFAULTS.agentVersions),
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    SCHEDULE_RECONCILE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
    SANDBOX_MAX_FIELD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(
        DEFAULT_SANDBOX_MAX_FIELD_BYTES,
        'SANDBOX_MAX_FIELD_BYTES 不能超过 1MiB：JSON 转义后要落在宿主 8MiB 单行上限内',
      )
      .default(DEFAULT_SANDBOX_MAX_FIELD_BYTES),
    SANDBOX_API_URL: z.string().min(1).default(DEFAULT_SANDBOX_API_URL),
    APP_SECRET_KEY: serviceEnvShape.APP_SECRET_KEY,
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_AUTH_TOKEN: z.string().optional(),
    ANTHROPIC_BASE_URL: serviceEnvShape.ANTHROPIC_BASE_URL,
    /**
     * 模型代理监听端口。compose 需要把它发布到宿主，沙盒才能经 host.docker.internal 访问；
     * 宿主机直跑 worker 时随意。
     */
    MODEL_PROXY_PORT: z.coerce.number().int().positive().default(3426),
    MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST: serviceEnvShape.MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST,
    /** Docling HTTP base URL；不给对应任务直接失败，避免解析静默降级。compose 的 `${DOCLING_URL:-}` 会传空串，按未配置处理。 */
    DOCLING_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional(),
    ),
    DOCLING_TOKEN: z.string().optional(),
    WREN_RUNTIME_URL: serviceEnvShape.WREN_RUNTIME_URL,
    KNOWLEDGE_DIR: serviceEnvShape.KNOWLEDGE_DIR,
    KNOWLEDGE_WIKI_MODEL: z.string().optional(),
    KNOWLEDGE_SUMMARY_MODEL: optionalModelEnv,
    EVAL_JUDGE_MODEL: optionalModelEnv,
    DATA_DOMAIN_ENRICH_MODEL: z.string().optional(),
    KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: serviceEnvShape.KNOWLEDGE_PRIVATE_HOST_ALLOWLIST,
    WEBHOOK_PRIVATE_HOST_ALLOWLIST: serviceEnvShape.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
  })
  .superRefine((env, ctx) => {
    if (env.SANDBOX_EGRESS === 'proxy' && !env.HTTPS_PROXY && !env.HTTP_PROXY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SANDBOX_EGRESS'],
        message:
          'SANDBOX_EGRESS=proxy 需要 HTTPS_PROXY 或 HTTP_PROXY；要么设置代理，要么显式设 SANDBOX_EGRESS=open（open 不隔离出站，容器可直连外网）',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = parseEnv(envSchema, env);
  return {
    ...config,
    WORKSPACES_DIR: fromRepoRoot(config.WORKSPACES_DIR),
    ...(config.HOST_WORKSPACES_DIR === undefined
      ? {}
      : { HOST_WORKSPACES_DIR: fromRepoRoot(config.HOST_WORKSPACES_DIR) }),
    KNOWLEDGE_DIR: fromRepoRoot(config.KNOWLEDGE_DIR),
  };
}
