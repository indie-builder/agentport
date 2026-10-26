import { commonEnvSchema, parseEnv } from '@agentport/shared';
import { z } from 'zod';

const { NODE_ENV, LOG_LEVEL, REDIS_URL } = commonEnvSchema.shape;

const envSchema = z
  .object({
    NODE_ENV,
    LOG_LEVEL,
    DATABASE_URL: z.string().min(1),
    REDIS_URL,
    /** 与宿主机同一路径：worker 把该目录挂进沙盒，路径必须对宿主 daemon 有效。 */
    WORKSPACES_DIR: z.string().min(1).default('./data/workspaces'),
    /**
     * 宿主视角的 WORKSPACES_DIR。容器部署时 WORKSPACES_DIR 是命名卷挂载点（如 /workspaces），
     * 而 docker -v 的源路径由宿主 daemon 解析，必须换成该卷的宿主目录。默认与 WORKSPACES_DIR 相同。
     */
    HOST_WORKSPACES_DIR: z.string().min(1).optional(),
    SANDBOX_IMAGE: z.string().min(1).default('agentport/sandbox:dev'),
    /**
     * open=bridge 直连（不隔离出站）；none=断网；proxy=仍用 bridge，由 HTTPS_PROXY 指向宿主代理。
     * 默认 open 是为了不阻塞本地开发；production 要出站管控时显式设 proxy 并配代理。
     */
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
    AGENT_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
    /** 维护任务的保留天数；0 不合法，要保留更久就调大。 */
    RETAIN_RUN_DAYS: z.coerce.number().int().positive().default(90),
    RETAIN_MESSAGE_DAYS: z.coerce.number().int().positive().default(30),
    RETAIN_AGENT_VERSIONS: z.coerce.number().int().positive().default(50),
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    /**
     * 沙盒单块文本/工具负载上限（字节）。超限只截断该块并标记 truncated，默认 1MiB。
     * 最坏 JSON 转义约为原值的 6 倍：1MiB 对应约 6MiB，仍在宿主 8MiB 单行上限内；
     * 因此这里封顶 1MiB，避免调到会产生「整块被宿主静默丢弃」的值。
     */
    SANDBOX_MAX_FIELD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(
        1024 * 1024,
        'SANDBOX_MAX_FIELD_BYTES 不能超过 1MiB：JSON 转义后要落在宿主 8MiB 单行上限内',
      )
      .default(1024 * 1024),
    SANDBOX_API_URL: z.string().min(1).default('http://host.docker.internal:3000'),
    /** 与 API 相同的密钥派生源：用来解密 server 的 env/headers 并注入工作区。 */
    APP_SECRET_KEY: z.string().min(32),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_AUTH_TOKEN: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().optional(),
    /**
     * 模型代理监听端口。compose 需要把它发布到宿主，沙盒才能经 host.docker.internal 访问；
     * 宿主机直跑 worker 时随意。
     */
    MODEL_PROXY_PORT: z.coerce.number().int().positive().default(3426),
    /** Docling HTTP base URL；不给对应任务直接失败，避免解析静默降级。compose 的 `${DOCLING_URL:-}` 会传空串，按未配置处理。 */
    DOCLING_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional(),
    ),
    DOCLING_TOKEN: z.string().optional(),
    /** 原件与解析产物卷；api/worker 共用同一挂载点。 */
    KNOWLEDGE_DIR: z.string().min(1).default('./data/knowledge'),
    KNOWLEDGE_WIKI_MODEL: z.string().optional(),
    /** 逗号分隔的私网主机名（可含端口）；知识出站只在这些主机上放行内网地址。 */
    KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    // fail-closed：proxy 没配代理时宁可不启动，也不静默降级成不隔离出站的 open。
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
  return parseEnv(envSchema, env);
}
