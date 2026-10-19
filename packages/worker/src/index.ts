import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { McpJsonEntry } from '@agentport/core';
import { decryptSecrets, renderWorkspace } from '@agentport/core';
import { createDb, newId, schema } from '@agentport/db';
import { agentRunJobSchema, type ChatEvent } from '@agentport/shared';
import { Worker } from 'bullmq';
import { and, asc, eq, ne } from 'drizzle-orm';
import pino from 'pino';
import { loadConfig } from './config.js';
import { startMaintenanceWorker } from './maintenance.js';
import { startReconciler } from './reconcile.js';
import { redactSecrets } from './redact.js';
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
} else if (
  config.SANDBOX_EGRESS === 'proxy' &&
  !process.env.HTTPS_PROXY &&
  !process.env.HTTP_PROXY
) {
  logger.warn('SANDBOX_EGRESS=proxy but HTTPS_PROXY/HTTP_PROXY is unset: egress stays open');
}

/** proxy 模式没配代理时实际按 open 跑：别让日志声称在走代理。 */
const sandboxEgress =
  config.SANDBOX_EGRESS === 'proxy' && !process.env.HTTPS_PROXY && !process.env.HTTP_PROXY
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function strRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * 把 DB 中的 server 渲染成 `.mcp.json` 条目。
 * generated server 的 URL 指向平台自身，必须换成本次运行可达的沙盒视角地址；
 * stdio/env 与 headers 里的密钥仅以加密列存在，运行时解密后注入。
 */
function toEntry(
  server: ServerRow,
  apiUrl: string,
  secretKey: string,
  runId: string,
): McpJsonEntry {
  // 密钥只存在加密列里；运行时必须在这里解密注入，否则 .mcp.json 会丢 env/headers。
  const secrets = server.secretsEncrypted ? decryptSecrets(server.secretsEncrypted, secretKey) : {};
  const serverConfig = server.config;
  if (server.kind === 'stdio') {
    return {
      command: str(serverConfig.command) ?? '',
      args: strArray(serverConfig.args),
      env: { ...strRecord(serverConfig.env), ...secrets },
    };
  }
  if (server.kind === 'http') {
    return {
      type: 'http',
      url: str(serverConfig.url) ?? '',
      headers: { ...strRecord(serverConfig.headers), ...secrets },
    };
  }
  const token = str(serverConfig.mcpToken);
  return {
    type: 'http',
    url: `${apiUrl}/mcp/${server.id}`,
    // 平台 MCP 端点靠这个 header 识别 run，才能查到该 run 的工具审批。
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-agentport-run-id': runId,
    },
  };
}

/** 每次 run 重写工作区：文件是 DB 的只读快照，prompt 只走 stdin。 */
async function writeWorkspace(
  agent: AgentRow,
  runId: string,
  servers: Array<{ name: string; entry: McpJsonEntry }>,
  skills: Array<{ slug: string; name: string; description: string; body: string }>,
  subAgents: AgentRow[],
): Promise<string> {
  const files = renderWorkspace({
    agent: {
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      systemPrompt: agent.systemPromptMd,
      maxTurns: agent.maxTurns,
      ...(agent.effort === null ? {} : { effort: agent.effort }),
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
    },
    servers,
    skills,
    subAgents: subAgents.map((child) => ({
      slug: child.slug,
      name: child.name,
      description: child.description,
      model: child.model,
      systemPrompt: child.systemPromptMd,
      maxTurns: child.maxTurns,
      ...(child.effort === null ? {} : { effort: child.effort }),
      allowedTools: child.allowedTools,
      disallowedTools: child.disallowedTools,
    })),
  });

  // 按 run 隔离：同一智能体并发运行时不能互相覆盖 .mcp.json / 技能 / 子智能体。
  const dir = join(workspacesDir, agent.slug, runId);
  const agentsDir = join(dir, '.claude', 'agents');
  // 子智能体每次重建：解绑后旧文件不能残留，否则 SDK 仍会发现它。
  await rm(agentsDir, { recursive: true, force: true });
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(dir, '.mcp.json'), files.mcpJson, 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  await writeFile(join(agentsDir, `${agent.slug}.md`), files.agentMd, 'utf8');
  for (const subAgent of files.subAgents) {
    await writeFile(join(agentsDir, `${subAgent.slug}.md`), subAgent.content, 'utf8');
  }

  // 技能每次重建：先清掉旧目录，避免已解绑的技能残留。
  const skillsDir = join(dir, '.claude', 'skills');
  await rm(skillsDir, { recursive: true, force: true });
  for (const skill of files.skills) {
    const target = join(skillsDir, skill.slug);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill.content, 'utf8');
  }
  return dir;
}

/** 事件流 → 消息行：assistant 文本按块存，工具调用存成 tool 消息。 */
/** 工具入参在事件里是 JSON 字符串；落库时还原成对象，前端与 trace 都按对象渲染。 */
function parseToolInput(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function persistRunMessages(
  db: ReturnType<typeof createDb>['db'],
  input: { conversationId: string; runId: string; events: ChatEvent[] },
): Promise<void> {
  const rows: Array<{ role: string; content: unknown }> = [];
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, string>();

  for (const event of input.events) {
    if (event.type === 'assistant_text' && event.text.trim().length > 0) {
      rows.push({
        role: 'assistant',
        content: { type: 'text', text: redactSecrets(event.text) },
      });
    } else if (event.type === 'tool_start') {
      toolNames.set(event.toolUseId, event.name);
    } else if (event.type === 'tool_input') {
      toolInputs.set(event.toolUseId, redactSecrets(event.json));
    } else if (event.type === 'tool_result') {
      // tool_use 也要落库：否则刷新后前端无法重建工具卡片（只有 result 没有卡片）。
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_use',
          id: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          input: parseToolInput(toolInputs.get(event.toolUseId)),
        },
      });
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_result',
          toolUseId: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          content: redactSecrets(event.content),
        },
      });
    }
  }

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

/** 容器只拿凭证与 API 地址；密钥不落盘。 */
function sandboxEnv(apiUrl: string): Record<string, string> {
  const env: Record<string, string> = {
    SANDBOX_API_URL: apiUrl,
    // 根文件系统只读；SDK 写会话缓存的目录是 tmpfs（见 docker.ts）。
    CLAUDE_CONFIG_DIR: '/home/node/.claude',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
    const value = config[key];
    if (value) env[key] = value;
  }
  if (config.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = toHostUrl(config.ANTHROPIC_BASE_URL);

  // proxy 模式：把宿主上的代理地址传给沙盒，仍由容器自行出站。
  if (sandboxEgress === 'proxy') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
      const value = process.env[key];
      if (value) env[key] = toHostUrl(value);
    }
    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
    if (noProxy) env.NO_PROXY = noProxy;
  }
  return env;
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

      // 单层委派：只取直接子智能体，且忽略已停用的。
      const subAgentRows = await db
        .select()
        .from(schema.agents)
        .where(and(eq(schema.agents.parentId, agentId), eq(schema.agents.enabled, true)))
        .orderBy(asc(schema.agents.id));

      const workspaceDir = await writeWorkspace(
        agent,
        runId,
        rows.map(({ server }) => ({
          name: server.name,
          entry: toEntry(server, sandboxApiUrl, config.APP_SECRET_KEY, runId),
        })),
        skillRows,
        subAgentRows,
      );
      workspaceDirForRun = workspaceDir;
      logger.info({ runId, agentId, workspaceDir }, 'agent run started');

      runStartedAt = Date.now();
      outcome = await runInSandbox({
        runId,
        timeoutMs: agent.timeoutMs || config.AGENT_TIMEOUT_MS,
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
          ...(subAgentRows.length > 0 ? { allowSubAgents: true } : {}),
        },
        workspaceDir: toHostWorkspacePath(workspaceDir),
        image: config.SANDBOX_IMAGE,
        env: sandboxEnv(sandboxApiUrl),
        provider,
        logger: logger.child({ runId }),
      });
      runLatencyMs = Date.now() - runStartedAt;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, runId }, 'agent run crashed');
      outcome = { status: 'failed', sandboxId: '', error, events: [] };
    }

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

  const closing = worker.close();
  await Promise.race([closing, sleep(SHUTDOWN_WAIT_MS)]);
  await maintenanceWorker.close();
  stopReconciler();
  await provider.destroyAll();
  await Promise.race([closing.catch(() => undefined), sleep(POOL_WAIT_MS)]);

  await closeRunnerClient();
  await Promise.race([pool.end(), sleep(POOL_WAIT_MS)]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
