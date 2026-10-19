import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { McpJsonEntry } from '@agentport/core';
import { renderWorkspace } from '@agentport/core';
import { createDb, schema } from '@agentport/db';
import { agentRunJobSchema } from '@agentport/shared';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import type { SandboxRunOutcome } from './runner-client.js';
import { closeRunnerClient, publishRun, runInSandbox } from './runner-client.js';
import { DockerSandboxProvider } from './sandbox/docker.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const workspacesDir = resolve(process.env.WORKSPACES_DIR ?? './data/workspaces');
const sandboxImage = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
// 沙盒在 bridge 网络里访问宿主 API；compose 部署时用服务名覆盖。
const sandboxApiUrl = process.env.SANDBOX_API_URL ?? 'http://host.docker.internal:3000';

const { db, pool } = createDb(databaseUrl);
const provider = new DockerSandboxProvider();

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
 * stdio/env 与 headers 里的密钥仅 API 侧能解密，这里不带密钥。
 */
function toEntry(server: ServerRow, apiUrl: string): McpJsonEntry {
  const config = server.config;
  if (server.kind === 'stdio') {
    return {
      command: str(config.command) ?? '',
      args: strArray(config.args),
      env: strRecord(config.env),
    };
  }
  if (server.kind === 'http') {
    return { type: 'http', url: str(config.url) ?? '', headers: strRecord(config.headers) };
  }
  const token = str(config.mcpToken);
  return {
    type: 'http',
    url: `${apiUrl}/mcp/${server.id}`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

/** 每次 run 重写工作区：文件是 DB 的只读快照，prompt 只走 stdin。 */
async function writeWorkspace(
  agent: AgentRow,
  servers: Array<{ name: string; entry: McpJsonEntry }>,
): Promise<string> {
  const files = renderWorkspace({
    agent: {
      slug: agent.slug,
      name: agent.name,
      model: agent.model,
      systemPrompt: agent.systemPromptMd,
      maxTurns: agent.maxTurns,
    },
    servers,
  });

  const dir = join(workspacesDir, agent.slug);
  await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(dir, '.mcp.json'), files.mcpJson, 'utf8');
  await writeFile(join(dir, 'CLAUDE.md'), files.claudeMd, 'utf8');
  await writeFile(join(dir, '.claude', 'agents', `${agent.slug}.md`), files.agentMd, 'utf8');
  return dir;
}

/** 容器只拿凭证与 API 地址；密钥不落盘。 */
function sandboxEnv(apiUrl: string): Record<string, string> {
  const env: Record<string, string> = { SANDBOX_API_URL: apiUrl };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  // 本机代理常监听 127.0.0.1，容器内该地址指向容器自身。
  // 改写为宿主别名，容器才能访问宿主上的模型代理。
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl.replace(
      /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
      '//host.docker.internal',
    );
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
    const { runId, agentId, conversationId, prompt } = parsed.data;

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

      const workspaceDir = await writeWorkspace(
        agent,
        rows.map(({ server }) => ({ name: server.name, entry: toEntry(server, sandboxApiUrl) })),
      );
      logger.info({ runId, agentId, workspaceDir }, 'agent run started');

      outcome = await runInSandbox({
        runId,
        timeoutMs: agent.timeoutMs || Number(process.env.AGENT_TIMEOUT_MS ?? 600_000),
        task: {
          prompt,
          model: agent.model,
          maxTurns: agent.maxTurns,
          maxBudgetUsd: Number(agent.maxBudgetUsd),
          mcpServers: rows.map(({ server }) => server.name),
        },
        workspaceDir,
        image: sandboxImage,
        env: sandboxEnv(sandboxApiUrl),
        provider,
        logger: logger.child({ runId }),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, runId }, 'agent run crashed');
      outcome = { status: 'failed', sandboxId: '', error };
    }

    await db
      .update(schema.agentRuns)
      .set({
        status: outcome.status,
        ...(outcome.sandboxId ? { sandboxId: outcome.sandboxId } : {}),
        endedAt: new Date(),
        costUsd: outcome.costUsd === undefined ? null : String(outcome.costUsd),
        turns: outcome.turns ?? null,
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
    logger.info({ runId, status: outcome.status, costUsd: outcome.costUsd }, 'agent run finished');
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.AGENT_MAX_CONCURRENT ?? 2) },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});

logger.info('worker started');

const shutdown = async (): Promise<void> => {
  await worker.close();
  await closeRunnerClient();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
