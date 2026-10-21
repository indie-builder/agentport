import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { McpJsonEntry } from '@agentport/core';
import {
  decryptSecrets,
  hashMcpToken,
  installProcessGuards,
  renderWorkspace,
  toMcpJsonEntry,
  toWorkspaceInput,
  WORKSPACE_DIR_MODE,
  WORKSPACE_FILE_MODE,
} from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import {
  agentRunJobSchema,
  type ChatEvent,
  EVAL_RUNS_QUEUE,
  evalRunJobSchema,
  serverInputSchema,
  wireFailureKind,
} from '@agentport/shared';
import { Worker } from 'bullmq';
import { and, asc, eq, ne } from 'drizzle-orm';
import pino from 'pino';
import { loadConfig } from './config.js';
import { closeEvalRunQueue, executeEvalRun } from './eval-runner.js';
import { startMaintenanceWorker } from './maintenance.js';
import { buildMessageRows } from './messages.js';
import { type ModelProxy, startModelProxy } from './model-proxy.js';
import { startReconciler } from './reconcile.js';
import type { SandboxRunOutcome } from './runner-client.js';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  publishRun,
  runInSandbox,
} from './runner-client.js';
import { DockerSandboxProvider } from './sandbox/docker.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// 缺关键配置时 loadConfig 已抛错，进程直接退出。
configureRunnerClient(config.REDIS_URL);

const workspacesDir = resolve(config.WORKSPACES_DIR);
// 沙盒挂载的源路径按宿主 daemon 解析；容器里写文件仍用 workspacesDir。
const hostWorkspacesDir = resolve(config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR);

/** 容器内工作区路径 → 宿主路径，供 docker -v 使用。 */
function toHostWorkspacePath(dir: string): string {
  return join(hostWorkspacesDir, relative(workspacesDir, dir));
}
// 沙盒在 bridge 网络里访问宿主 API；compose 部署时用服务名或宿主网关覆盖。
const sandboxApiUrl = config.SANDBOX_API_URL;

if (config.SANDBOX_EGRESS === 'none') {
  logger.warn(
    'SANDBOX_EGRESS=none: 沙盒无网络，HTTP MCP server、平台 /mcp 端点与模型 API 都将不可用',
  );
} else if (config.SANDBOX_EGRESS === 'proxy' && !config.HTTPS_PROXY && !config.HTTP_PROXY) {
  logger.warn('SANDBOX_EGRESS=proxy but HTTPS_PROXY/HTTP_PROXY is unset: egress stays open');
}

/** proxy 模式没配代理时实际按 open 跑：别让日志声称在走代理。 */
const sandboxEgress =
  config.SANDBOX_EGRESS === 'proxy' && !config.HTTPS_PROXY && !config.HTTP_PROXY
    ? 'open'
    : config.SANDBOX_EGRESS;

const { db, pool } = createDb(config.DATABASE_URL);
const provider = new DockerSandboxProvider({
  memory: config.SANDBOX_MEMORY,
  cpus: config.SANDBOX_CPUS,
  pids: config.SANDBOX_PIDS,
  egress: sandboxEgress,
});

type ServerRow = typeof schema.servers.$inferSelect;
type AgentRow = typeof schema.agents.$inferSelect;

function toEntry(
  server: ServerRow,
  apiUrl: string,
  secretKey: string,
  runId: string,
  runToken: string,
): McpJsonEntry {
  const secrets = server.secretsEncrypted ? decryptSecrets(server.secretsEncrypted, secretKey) : {};
  const input = serverInputSchema.parse({
    ...server.config,
    name: server.name,
    description: server.description,
    kind: server.kind,
  });
  const entry = toMcpJsonEntry(
    input,
    input.kind === 'generated'
      ? { Authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId }
      : secrets,
  );
  return input.kind === 'generated' && 'url' in entry
    ? { ...entry, url: `${apiUrl}/mcp/${server.id}` }
    : entry;
}

/** 每次 run 重写工作区：文件是 DB 的只读快照，prompt 只走 stdin。 */
async function writeWorkspace(
  agent: AgentRow,
  runId: string,
  servers: Array<{ name: string; entry: McpJsonEntry }>,
  skills: Array<{ slug: string; name: string; description: string; body: string }>,
  subAgents: AgentRow[],
): Promise<{ dir: string; hasSubAgents: boolean }> {
  const files = renderWorkspace(toWorkspaceInput({ agent, servers, skills, subAgents }));

  // 按 run 隔离：同一智能体并发运行时不能互相覆盖 .mcp.json / 技能 / 子智能体。
  const dir = join(workspacesDir, agent.slug, runId);
  const agentsDir = join(dir, '.claude', 'agents');
  const skillsDir = join(dir, '.claude', 'skills');
  // 子智能体每次重建：解绑后旧文件不能残留，否则 SDK 仍会发现它。
  await rm(agentsDir, { recursive: true, force: true });
  await mkdir(agentsDir, { mode: WORKSPACE_DIR_MODE, recursive: true });
  await writeFile(join(dir, '.mcp.json'), files.mcpJson, {
    encoding: 'utf8',
    mode: WORKSPACE_FILE_MODE,
  });
  await writeFile(join(dir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  // 主智能体自己的 md 不落盘：放进 .claude/agents/ 会被 SDK 当成可委派子智能体，
  // 形成自我递归。它只用于 API 预览，CLAUDE.md 已承载主智能体上下文。
  for (const subAgent of files.subAgents) {
    await writeFile(join(agentsDir, `${subAgent.slug}.md`), subAgent.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }

  // 技能每次重建：先清掉旧目录，避免已解绑的技能残留。
  await rm(skillsDir, { recursive: true, force: true });
  for (const skill of files.skills) {
    const target = join(skillsDir, skill.slug);
    await mkdir(target, { mode: WORKSPACE_DIR_MODE, recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill.content, {
      encoding: 'utf8',
      mode: WORKSPACE_FILE_MODE,
    });
  }
  // mode 只在创建时生效；已存在的工作区（BullMQ 重试复用）要再 chmod 一次。
  await chmod(dir, WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.claude'), WORKSPACE_DIR_MODE);
  await chmod(join(dir, '.mcp.json'), WORKSPACE_FILE_MODE);
  logger.debug(
    { runId, dir, mode: WORKSPACE_FILE_MODE.toString(8) },
    'workspace permissions applied',
  );
  return { dir, hasSubAgents: files.subAgents.length > 0 };
}

/** 事件流 → 消息行：assistant 文本按块存，工具调用存成 tool 消息。 */
async function persistRunMessages(
  db: ReturnType<typeof createDb>['db'],
  input: { conversationId: string; runId: string; events: ChatEvent[] },
): Promise<void> {
  const rows = buildMessageRows(input.events);

  // BullMQ 重试会重放同一 run：先删本 run 已落库的输出再写，避免重复消息。
  // 用户消息也带 run_id，但由 API 写入，重试时不能删。
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.messages)
      .where(and(eq(schema.messages.runId, input.runId), ne(schema.messages.role, 'user')));
    for (const row of rows) {
      await tx.insert(schema.messages).values({
        id: newId('message'),
        conversationId: input.conversationId,
        role: row.role,
        content: row.content,
        runId: input.runId,
      });
    }
  });
}

/** 本机代理常监听 127.0.0.1，容器内该地址指向容器自身；改写成宿主别名。 */
function toHostUrl(value: string): string {
  return value.replace(
    /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
    '//host.docker.internal',
  );
}

/**
 * 模型代理（D-17）。启用后沙盒只拿到代理地址与 run token，真实凭证留在 worker。
 * 未启用时回退到直接注入，启动日志会警告。
 */
let modelProxy: ModelProxy | null = null;

/** 容器只拿凭证与 API 地址；密钥不落盘。 */
function sandboxEnv(apiUrl: string, runId: string): Record<string, string> {
  const env: Record<string, string> = {
    SANDBOX_API_URL: apiUrl,
    // 根文件系统只读；SDK 写会话缓存的目录是 tmpfs（见 docker.ts）。
    CLAUDE_CONFIG_DIR: '/home/node/.claude',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  if (modelProxy) {
    env.ANTHROPIC_BASE_URL = modelProxy.url;
    // 短期 token：run 结束即吊销；沙盒读不到真实模型密钥。
    env.ANTHROPIC_AUTH_TOKEN = modelProxy.issueToken(runId);
    env.ANTHROPIC_API_KEY = '';
  } else {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
      const value = config[key];
      if (value) env[key] = value;
    }
    if (config.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = toHostUrl(config.ANTHROPIC_BASE_URL);
  }

  // proxy 模式：把宿主上的代理地址传给沙盒，仍由容器自行出站。
  if (sandboxEgress === 'proxy') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
      const value = config[key];
      if (value) env[key] = toHostUrl(value);
    }
    const noProxy = config.NO_PROXY ?? config.no_proxy;
    if (noProxy) env.NO_PROXY = noProxy;
  }
  return env;
}

/**
 * 模型代理必须在 worker 启动前就绪：sandboxEnv 在任务里同步读取它。
 * 未配置凭证时返回 null，随后回退到直接注入并打印警告。
 */
modelProxy = await startModelProxy({
  logger,
  port: config.MODEL_PROXY_PORT,
  // worker 可能在容器里：127.0.0.1 指向容器自身，网关在宿主上。
  upstreamBaseUrl: toHostUrl(config.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'),
  ...(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {}),
  ...(config.ANTHROPIC_AUTH_TOKEN ? { authToken: config.ANTHROPIC_AUTH_TOKEN } : {}),
  resolveRun: async (token) => {
    // token 明文就是 runId；DB 只存 sha256，且要求 run 仍在 running。
    const row = await repo.runs.findRunByModelToken(db, hashMcpToken(token));
    return row;
  },
});
if (modelProxy) {
  logger.info('model credentials stay in the worker; sandbox gets a per-run proxy token');
} else {
  logger.warn(
    'model proxy disabled (no credential configured); sandbox receives the real model credential',
  );
}

const worker = new Worker(
  'agent-runs',
  async (job) => {
    const parsed = agentRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid job payload: ${parsed.error.message}`);
    }
    const { runId, agentId, conversationId, prompt, history } = parsed.data;

    const [run] = await db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    // cancel 可能发生在排队期间：不启动容器，API 侧已经写过终态。
    if (run?.status !== 'queued' && run?.status !== 'running') {
      logger.info({ runId, status: run?.status }, 'run no longer pending, skipping');
      return;
    }
    await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    await publishRun(runId, { type: 'run_started', runId, conversationId }, logger);

    let outcome: SandboxRunOutcome;
    let runStartedAt = 0;
    let runLatencyMs: number | null = null;
    let workspaceDirForRun: string | null = null;
    try {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) throw new Error(`agent ${agentId} not found`);

      const timeoutMs = agent.timeoutMs || config.AGENT_TIMEOUT_MS;
      // 按 run 签发短期 token：DB 只存 hash，明文只在本工作区的 .mcp.json 里。
      // 过期时间比 run 超时多 5 分钟，避免收尾阶段请求被截断。
      const runToken = randomBytes(32).toString('base64url');
      await repo.runs.setRunMcpToken(
        db,
        runId,
        hashMcpToken(runToken),
        new Date(Date.now() + timeoutMs + 5 * 60_000),
        modelProxy ? hashMcpToken(runId) : null,
      );

      const rows = await db
        .select({ server: schema.servers })
        .from(schema.agentServers)
        .innerJoin(schema.servers, eq(schema.agentServers.serverId, schema.servers.id))
        .where(eq(schema.agentServers.agentId, agentId));

      const skillRows = await db
        .select({
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
          body: schema.skills.body,
        })
        .from(schema.agentSkills)
        .innerJoin(schema.skills, eq(schema.agentSkills.skillId, schema.skills.id))
        .where(eq(schema.agentSkills.agentId, agentId));

      // 单层委派：只取直接子智能体；enabled 过滤在 toWorkspaceInput 里统一做。
      const subAgentRows = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.parentId, agentId))
        .orderBy(asc(schema.agents.id));

      const { dir: workspaceDir, hasSubAgents } = await writeWorkspace(
        agent,
        runId,
        rows.map(({ server }) => ({
          name: server.name,
          entry: toEntry(server, sandboxApiUrl, config.APP_SECRET_KEY, runId, runToken),
        })),
        skillRows,
        subAgentRows,
      );
      workspaceDirForRun = workspaceDir;
      logger.info({ runId, agentId, workspaceDir }, 'agent run started');

      runStartedAt = Date.now();
      outcome = await runInSandbox({
        runId,
        timeoutMs,
        task: {
          prompt,
          ...(history === undefined ? {} : { history }),
          model: agent.model,
          maxTurns: agent.maxTurns,
          maxBudgetUsd: Number(agent.maxBudgetUsd),
          permissionMode: agent.permissionMode,
          mcpServers: rows.map(({ server }) => server.name),
          ...(agent.allowedTools.length > 0 ? { extraAllowedTools: agent.allowedTools } : {}),
          ...(agent.disallowedTools.length > 0
            ? { extraDisallowedTools: agent.disallowedTools }
            : {}),
          ...(agent.effort === null ? {} : { effort: agent.effort }),
          ...(agent.maxThinkingTokens === null
            ? {}
            : { maxThinkingTokens: agent.maxThinkingTokens }),
          ...(hasSubAgents ? { allowSubAgents: true } : {}),
        },
        workspaceDir: toHostWorkspacePath(workspaceDir),
        image: config.SANDBOX_IMAGE,
        env: sandboxEnv(sandboxApiUrl, runId),
        provider,
        logger: logger.child({ runId }),
      });
      runLatencyMs = Date.now() - runStartedAt;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, runId }, 'agent run crashed');
      outcome = { status: 'failed', sandboxId: '', error, events: [] };
    }

    // run 结束（含崩溃）就吊销短期 token；reconcile 对卡死 run 也走同样的收尾。
    await repo.runs.clearRunMcpToken(db, runId).catch((err: unknown) => {
      logger.warn({ err, runId }, 'failed to clear run mcp token');
    });
    modelProxy?.revokeToken(runId);
    await repo.runs.clearModelToken(db, runId).catch((err: unknown) => {
      logger.warn({ err, runId }, 'failed to clear model token');
    });

    // 把本次 run 的 assistant 文本与工具调用写入会话，刷新后历史才完整。
    await persistRunMessages(db, {
      conversationId,
      runId,
      events: outcome.events,
    });

    await db
      .update(schema.agentRuns)
      .set({
        status: outcome.status,
        latencyMs: runLatencyMs ?? null,
        ...(outcome.sandboxId ? { sandboxId: outcome.sandboxId } : {}),
        endedAt: new Date(),
        costUsd: outcome.costUsd === undefined ? null : String(outcome.costUsd),
        turns: outcome.turns ?? null,
        sessionId: outcome.sessionId ?? null,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        error: outcome.error ?? null,
        errorKind: outcome.failure?.reason ?? null,
      })
      .where(eq(schema.agentRuns.id, runId));

    await publishRun(
      runId,
      {
        type: 'run_finished',
        status: outcome.status,
        ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
        ...(outcome.turns === undefined ? {} : { turns: outcome.turns }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.failure ? { failureKind: wireFailureKind(outcome.failure.reason) } : {}),
      },
      logger,
    );
    // 运行结果进审计表：日志会滚动，审计长期保留。
    await db
      .insert(schema.auditLog)
      .values({
        id: `aud_${runId.slice(4)}`,
        actor: 'worker',
        action: 'agent.run.finished',
        target: runId,
        status: outcome.status === 'succeeded' ? 'ok' : 'error',
        durationMs: runLatencyMs,
        inputDigest: null,
        requestId: null,
      })
      .onConflictDoNothing();

    logger.info(
      { runId, status: outcome.status, costUsd: outcome.costUsd, latencyMs: runLatencyMs },
      'agent run finished',
    );

    // 重试会复用同一 run 的工作区，因此只在最终结束（不再重试）后清理。
    if (!isRetryable(outcome) && workspaceDirForRun) {
      await rm(workspaceDirForRun, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn({ err, runId }, 'workspace cleanup failed');
      });
    }

    // 瞬时基础设施故障交给 BullMQ 重试；业务失败直接结束，避免重复计费。
    if (isRetryable(outcome)) {
      throw new Error(`retryable sandbox failure: ${outcome.error ?? 'unknown'}`);
    }
  },
  { connection: { url: config.REDIS_URL }, concurrency: config.AGENT_MAX_CONCURRENT },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});

// 评估本身串行：并发固定 1。
const evalWorker = new Worker(
  EVAL_RUNS_QUEUE,
  async (job) => {
    const parsed = evalRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid eval job payload: ${parsed.error.message}`);
    }
    await executeEvalRun({
      db,
      logger,
      redisUrl: config.REDIS_URL,
      evalRunId: parsed.data.evalRunId,
    });
  },
  { connection: { url: config.REDIS_URL }, concurrency: 1 },
);

evalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'eval job failed');
});

const maintenanceWorker = await startMaintenanceWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  retain: {
    runDays: config.RETAIN_RUN_DAYS,
    messageDays: config.RETAIN_MESSAGE_DAYS,
    agentVersions: config.RETAIN_AGENT_VERSIONS,
  },
});

const stopReconciler = startReconciler({
  db,
  logger,
  agentTimeoutMs: config.AGENT_TIMEOUT_MS,
});

installProcessGuards(logger);

logger.info('worker started');

const SHUTDOWN_WAIT_MS = 10_000;
const POOL_WAIT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms).unref());
}

let shuttingDown = false;

/**
 * SIGTERM：先让 BullMQ 排空在跑的任务（最多 10s），仍未结束的沙盒由
 * docker rm -f 兜底；容器退出会推动任务收尾，再关闭 Redis / PG。
 */
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');

  const closing = Promise.all([worker.close(), evalWorker.close()]);
  await Promise.race([closing, sleep(SHUTDOWN_WAIT_MS)]);
  await maintenanceWorker.close();
  await stopReconciler();
  await provider.destroyAll();
  await Promise.race([closing.catch(() => undefined), sleep(POOL_WAIT_MS)]);
  await closeEvalRunQueue();

  await modelProxy?.close();
  await closeRunnerClient();
  await Promise.race([pool.end(), sleep(POOL_WAIT_MS)]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
