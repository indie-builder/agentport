import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WorkspacePlugin } from '@agentport/core';
import {
  decryptSecrets,
  hashMcpToken,
  installProcessGuards,
  RunFailure,
  renderPlugin,
} from '@agentport/core';
import { createServiceLogger } from '@agentport/core/logger';
import { createDb, plugins as pluginsTable, repo, schema } from '@agentport/db';
import {
  ACTIVE_RUN_STATUSES,
  type Agent,
  type AgentDefinition,
  type AgentDefinitionServer,
  agentRunJobSchema,
  CONFIG_CONTAINER_DIR,
  EVAL_RUNS_QUEUE,
  generatedMcpEntry,
  knowledgeMcpEntry,
  type McpJsonArtifactEntry,
  previewMcpEntry,
  RUNS_QUEUE,
  SESSION_CLEANUP_TIMEOUT_MS,
  serverInputSchema,
} from '@agentport/shared';
import { createBunRedisClient, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { loadConfig } from './config.js';
import { checkOutboundPolicy } from './content-policy.js';
import {
  startDataDomainBuildReconciler,
  startDataDomainBuildWorker,
} from './data-domains/build.js';
import {
  startDataDomainEnrichmentReconciler,
  startDataDomainEnrichmentWorker,
} from './data-domains/enrich.js';
import { handleEvalJobFailed, runEvalJob } from './eval-job.js';
import { closeEvalRunQueue, evalFailureDiagnostics } from './eval-runner.js';
import { startWebhookDeliveryReconciler } from './integrations/deliver.js';
import { startKnowledgeWorker } from './knowledge/queue.js';
import { startKnowledgeReconciler } from './knowledge/reconcile.js';
import { startKnowledgeScheduler } from './knowledge/scheduler.js';
import { startMaintenanceWorker } from './maintenance.js';
import { resolveProviderUpstreams } from './model-providers.js';
import { type ModelProxy, startModelProxy } from './model-proxy.js';
import { registerNativePlugins } from './native-plugins.js';
import { closeRunnerClient, configureRunnerClient } from './runner-client.js';
import { runAgentJob } from './runs/execute.js';
import type { RunAccessDenial } from './runs/run-access.js';
import { finalizeRun } from './runs/run-finish.js';
import { createWorkspaceAssembly } from './runs/workspace-assembly.js';
import { startRuntimeEnvironmentBuildWorker } from './runtime-environments/build.js';
import {
  ensureDefaultEnvironment,
  startDefaultEnvironmentRetry,
} from './runtime-environments/default.js';
import { startRuntimeEnvironmentBuildReconciler } from './runtime-environments/reconcile.js';
import { createRuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { DockerSandboxProvider, resolveLocalImageId } from './sandbox/docker.js';
import { SandboxCleanupError } from './sandbox/provider.js';
import { closeSessionRuntime, startSessionCleanupChannel } from './sandbox/session-cleanup.js';
import { SessionSandboxes } from './sandbox/sessions.js';
import { registerSandboxProbe } from './sandbox-probe.js';
import { startReconciler } from './scheduling/reconcile.js';
import { startScheduleScheduler } from './scheduling/scheduler.js';
import { isRunWorkspaceName, runWorkspaceDir } from './session-workspace.js';
import { runShutdown } from './shutdown.js';
import { modelProxyUpstream } from './upstream.js';
import { version } from './version.js';

const config = loadConfig();
const logger = createServiceLogger({
  service: 'worker',
  env: config.NODE_ENV,
  version,
  level: config.LOG_LEVEL,
});

configureRunnerClient(config.REDIS_URL, logger);

const workspacesDir = resolve(config.WORKSPACES_DIR);
const hostWorkspacesDir = resolve(config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR);

// 沙盒在 bridge 网络里访问宿主 API；compose 部署时用服务名或宿主网关覆盖。
const sandboxApiUrl = config.SANDBOX_API_URL;

if (config.SANDBOX_EGRESS === 'none') {
  logger.warn(
    'SANDBOX_EGRESS=none: 沙盒无网络，HTTP MCP server、平台 /mcp 端点与模型 API 都将不可用',
  );
}

const { db, client } = createDb(config.DATABASE_URL);
await repo.ops.ensureRetentionDefaults(db, {
  runDays: config.RETAIN_RUN_DAYS,
  messageDays: config.RETAIN_MESSAGE_DAYS,
  agentVersions: config.RETAIN_AGENT_VERSIONS,
});
const runConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));
const evalConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));
type Db = typeof db;
const resolveRuntimeEnvironment = createRuntimeEnvironmentResolver((environmentId, versionId) =>
  repo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, environmentId, versionId),
);
const sandboxClosing = new AbortController();
const provider = new DockerSandboxProvider({
  memory: config.SANDBOX_MEMORY,
  cpus: config.SANDBOX_CPUS,
  pids: config.SANDBOX_PIDS,
  egress: config.SANDBOX_EGRESS,
  closing: sandboxClosing.signal,
});

const sessionSandboxes = new SessionSandboxes({
  provider,
  idleTimeoutMs: config.SANDBOX_IDLE_TIMEOUT_MS,
  maxActive: config.SANDBOX_MAX_ACTIVE,
  resolveRuntimeEnvironment,
  logger,
});

const sessionCleanup = await startSessionCleanupChannel({
  redisUrl: config.REDIS_URL,
  logger,
  sessions: sessionSandboxes,
});

type ServerRow = AgentDefinitionServer;
type AgentRow = typeof schema.agents.$inferSelect;

function toEntry(
  server: ServerRow,
  apiUrl: string,
  secretKey: string,
  runId: string,
  runToken: string,
): McpJsonArtifactEntry {
  if (server.kind === 'knowledge') {
    return knowledgeMcpEntry({ apiUrl, serverId: server.id, runId, runToken });
  }
  if (server.kind === 'data_domain') {
    return knowledgeMcpEntry({ apiUrl, serverId: server.id, runId, runToken });
  }
  const secrets = server.secretsEncrypted ? decryptSecrets(server.secretsEncrypted, secretKey) : {};
  const input = serverInputSchema.parse({
    ...server.config,
    name: server.name,
    kind: server.kind,
  });
  if (input.kind === 'generated') {
    return generatedMcpEntry({ apiUrl, serverId: server.id, runId, runToken }, input.headers);
  }
  return previewMcpEntry(
    { kind: input.kind, config: input },
    { ...(input.kind === 'stdio' ? input.env : input.headers), ...secrets },
  );
}

async function loadAgentPlugins(
  agent: AgentRow,
  bindings: Agent['pluginBindings'],
  snapshotPlugins: AgentDefinition['resources']['plugins'] | null,
): Promise<WorkspacePlugin[]> {
  if (agent.parentId !== null) {
    logger.warn({ agentId: agent.id }, 'sub-agent cannot bind plugins; ignoring bindings');
    return [];
  }
  if (bindings.length === 0) return [];
  const pluginIds = bindings.map((binding) => binding.pluginId);
  const [pluginRows, filesByPlugin] =
    snapshotPlugins === null
      ? await Promise.all([
          db
            .select({
              id: pluginsTable.id,
              slug: pluginsTable.slug,
              runtimeName: pluginsTable.runtimeName,
            })
            .from(pluginsTable)
            .where(inArray(pluginsTable.id, pluginIds)),
          repo.plugins.getPluginFilesByPluginIds(db, pluginIds),
        ])
      : [snapshotPlugins, new Map(snapshotPlugins.map((plugin) => [plugin.id, plugin.files]))];
  const pluginsById = new Map(pluginRows.map((plugin) => [plugin.id, plugin]));
  const plugins = bindings.flatMap(({ pluginId, allowHooks, allowMcp }) => {
    const plugin = pluginsById.get(pluginId);
    if (plugin === undefined) return [];
    return [
      renderPlugin({
        slug: plugin.slug,
        runtimeName: plugin.runtimeName,
        allowHooks,
        allowMcp,
        files: (filesByPlugin.get(plugin.id) ?? []).map((file) => ({
          path: file.path,
          content: file.content,
          executable: file.executable,
        })),
      }),
    ];
  });
  return plugins.filter((plugin) => {
    if (plugin.files.length > 0) return true;
    logger.warn({ agentId: agent.id, slug: plugin.slug }, 'plugin has nothing authorized; skipped');
    return false;
  });
}

const writeWorkspace = createWorkspaceAssembly({ db, workspacesDir, logger });

function toHostUrl(value: string): string {
  return value.replace(
    /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
    '//host.docker.internal',
  );
}

function makeSandboxEnv(modelProxy: ModelProxy | null) {
  return (apiUrl: string, runId: string): Record<string, string> => {
    const env: Record<string, string> = {
      SANDBOX_API_URL: apiUrl,
      CLAUDE_CONFIG_DIR: CONFIG_CONTAINER_DIR,
    };
    if (modelProxy) {
      env.ANTHROPIC_BASE_URL = modelProxy.url;
      env.ANTHROPIC_AUTH_TOKEN = modelProxy.issueToken(runId);
      env.ANTHROPIC_API_KEY = '';
    } else {
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
        const value = config[key];
        if (value) env[key] = value;
      }
      if (config.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = toHostUrl(config.ANTHROPIC_BASE_URL);
    }

    if (config.SANDBOX_EGRESS === 'proxy') {
      for (const key of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
        const value = config[key];
        if (value) env[key] = toHostUrl(value);
      }
      const noProxy = config.NO_PROXY ?? config.no_proxy;
      if (noProxy) env.NO_PROXY = noProxy;
    }
    return env;
  };
}

const envUpstream = config.ANTHROPIC_BASE_URL || undefined;
const modelProxy = await startModelProxy({
  logger,
  port: config.MODEL_PROXY_PORT,
  upstreamBaseUrl: modelProxyUpstream(envUpstream),
  ...(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {}),
  ...(config.ANTHROPIC_AUTH_TOKEN ? { authToken: config.ANTHROPIC_AUTH_TOKEN } : {}),
  resolveRun: async (token) => {
    const row = await repo.runs.findRunByModelToken(db, hashMcpToken(token));
    return row;
  },
  checkOutbound: async ({ runId, body }) => {
    const run = await repo.chat.getRun(db, runId);
    if (run === null) return { blocked: true, body: Buffer.alloc(0) };
    const text = body.toString('utf8');
    const checked = await checkOutboundPolicy(db, logger, {
      agentId: run.agentId,
      runId,
      text,
      sourceId: runId,
    });
    return {
      blocked: checked.blocked,
      body: checked.text === text ? body : Buffer.from(checked.text),
    };
  },
  resolveProviders: (runId, model) =>
    resolveProviderUpstreams(db, config, model, runId, modelProxyUpstream(envUpstream, false)),
  recordProviderServed: ({ runId, providerId }) =>
    repo.modelProviders.markRunServedProvider(db, runId, providerId),
  recordProviderResult: (result) => repo.modelProviders.recordProviderRequest(db, result),
});
const sandboxEnv = makeSandboxEnv(modelProxy);
if (modelProxy) {
  logger.info('model credentials stay in the worker; sandbox gets a per-run proxy token');
} else {
  logger.warn(
    'model proxy disabled (no credential configured); sandbox receives the real model credential',
  );
}

async function sweepStaleWorkspaces(): Promise<number> {
  const liveRuns = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(inArray(schema.agentRuns.status, [...ACTIVE_RUN_STATUSES]));
  const liveIds = new Set(liveRuns.map((run) => run.id));
  let removed = 0;
  const agents = await readdir(workspacesDir, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    },
  );
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    for (const run of await readdir(resolve(workspacesDir, agent.name), { withFileTypes: true })) {
      if (!run.isDirectory() || !isRunWorkspaceName(run.name) || liveIds.has(run.name)) continue;
      await rm(runWorkspaceDir(workspacesDir, agent.name, run.name), {
        recursive: true,
        force: true,
      });
      removed += 1;
    }
  }
  logger.info({ removed }, 'stale workspaces removed');
  return removed;
}

await sweepStaleWorkspaces();

const defaultEnvironmentDeps = {
  store: {
    getDefault: () => repo.runtimeEnvironments.getDefaultRuntimeEnvironment(db),
    register: async (image: { imageTag: string; imageId: string }) => {
      await repo.runtimeEnvironments.ensureDefaultRuntimeEnvironment(db, image);
    },
  },
  ensureDefaultAgentPublished: () => repo.agents.publishDefaultAgentIfNeeded(db),
  ensureImage: (image: string, signal: AbortSignal) => provider.ensureImage(image, signal),
  resolveImageId: resolveLocalImageId,
  sandboxImage: config.SANDBOX_IMAGE,
  signal: sandboxClosing.signal,
  logger,
};
let stopDefaultEnvironmentRetry: (() => Promise<void>) | undefined;
try {
  await ensureDefaultEnvironment(defaultEnvironmentDeps);
} catch (err) {
  logger.error(
    { err, image: config.SANDBOX_IMAGE },
    'default runtime environment registration failed; sandbox creation will fail until it succeeds; retrying',
  );
  stopDefaultEnvironmentRetry = startDefaultEnvironmentRetry(defaultEnvironmentDeps);
}

function cleanupSandboxIdOf(err: unknown): string | undefined {
  if (err instanceof SandboxCleanupError) return err.sandboxId;
  if (err instanceof RunFailure && err.cause instanceof SandboxCleanupError) {
    return err.cause.sandboxId;
  }
  return undefined;
}

async function denyQueuedRun(
  db: Db,
  logger: Logger,
  runId: string,
  denial: RunAccessDenial,
): Promise<void> {
  const won = await finalizeRun({
    db,
    logger,
    runId,
    fromStatus: 'queued',
    event: { type: 'run_finished', status: 'failed', error: denial.message },
    values: { error: denial.message, errorKind: 'agent' },
    audit: {
      action: 'agent.run.denied',
      status: 'error',
      dedupeKey: `aud_denied_${runId.slice(4)}`,
    },
  });
  if (!won) logger.info({ runId }, 'run no longer queued, access denial skipped');
}

const worker = new Worker(
  RUNS_QUEUE,
  (job) =>
    runAgentJob(job, {
      db,
      client,
      config,
      logger,
      workspacesDir,
      hostWorkspacesDir,
      sandboxApiUrl,
      sandboxClosing,
      sessionSandboxes,
      modelProxy,
      denyQueuedRun,
      loadAgentPlugins,
      writeWorkspace,
      toEntry,
      sandboxEnv,
      cleanupSandboxIdOf,
    }),
  { connection: runConnection, concurrency: config.AGENT_MAX_CONCURRENT },
);

worker.on('failed', async (job, err) => {
  const parsed = job ? agentRunJobSchema.safeParse(job.data) : null;
  // BullMQ increments attemptsMade before emitting failed.
  logger.error(
    parsed?.success
      ? {
          runId: parsed.data.runId,
          ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
          err,
        }
      : { jobId: job?.id, err },
    'job failed',
  );
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  if (!parsed?.success) return;
  const { runId, agentId } = parsed.data;
  try {
    const slug = await repo.agents.findAgentSlug(db, agentId);
    if (slug !== null)
      await rm(runWorkspaceDir(workspacesDir, slug, runId), { recursive: true, force: true });
  } catch (cleanupError) {
    logger.warn({ err: cleanupError, runId }, 'workspace cleanup failed');
  }
});

const evalWorker = new Worker(
  EVAL_RUNS_QUEUE,
  (job) =>
    runEvalJob({
      db,
      logger,
      redisUrl: config.REDIS_URL,
      judgeConfig: {
        knowledgeDir: config.KNOWLEDGE_DIR,
        evalJudgeModel: config.EVAL_JUDGE_MODEL,
        summaryModel: config.KNOWLEDGE_SUMMARY_MODEL,
        anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
      },
      job,
    }),
  { connection: evalConnection, concurrency: 1 },
);

evalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, ...evalFailureDiagnostics(err) }, 'eval job failed');
  // processor 前就终止的 deferred stalled failure 也在这里条件收口；事件回调不能留 unhandled rejection。
  handleEvalJobFailed({ db, logger, job, error: err }).catch((settleError: unknown) => {
    logger.error(
      { jobId: job?.id, ...evalFailureDiagnostics(settleError) },
      'eval job failure settlement failed',
    );
  });
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
  workspacesDir: config.WORKSPACES_DIR,
});

const sandboxProbe = await registerSandboxProbe(config, resolveRuntimeEnvironment);
const nativePlugins = await registerNativePlugins(config, resolveRuntimeEnvironment);

const runtimeEnvironmentBuildStore = {
  claimBuild: async (versionId: string) => {
    const version = await repo.runtimeEnvironments.claimRuntimeEnvironmentBuild(db, versionId);
    return version === null
      ? null
      : {
          versionId: version.id,
          dockerfile: version.dockerfile,
          baseImageId: version.baseImageId,
        };
  },
  appendBuildLog: (versionId: string, chunk: string) =>
    repo.runtimeEnvironments.appendRuntimeEnvironmentBuildLog(db, versionId, chunk),
  completeBuild: async (
    versionId: string,
    image: { imageTag: string; imageId: string; baseImageId: string },
  ) => {
    await repo.runtimeEnvironments.completeRuntimeEnvironmentBuild(db, versionId, image);
  },
  failBuild: async (versionId: string, error: string) => {
    await repo.runtimeEnvironments.failRuntimeEnvironmentBuild(db, versionId, error);
  },
};
const runtimeEnvironmentBuilds = await startRuntimeEnvironmentBuildWorker({
  store: runtimeEnvironmentBuildStore,
  logger,
  redisUrl: config.REDIS_URL,
});
const dataDomainBuilds = await startDataDomainBuildWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  wrenRuntimeUrl: config.WREN_RUNTIME_URL,
  secretKey: config.APP_SECRET_KEY,
});
const dataDomainEnrichments = await startDataDomainEnrichmentWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  enrichModel: config.DATA_DOMAIN_ENRICH_MODEL,
  anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
});
const stopDataDomainBuildReconciler = startDataDomainBuildReconciler({ db, logger });
const stopDataDomainEnrichmentReconciler = startDataDomainEnrichmentReconciler({ db, logger });
const stopRuntimeEnvironmentBuildReconciler = startRuntimeEnvironmentBuildReconciler({
  store: {
    ...runtimeEnvironmentBuildStore,
    listPendingBuilds: () => repo.runtimeEnvironments.listPendingRuntimeEnvironmentBuilds(db),
  },
  logger,
  redisUrl: config.REDIS_URL,
});

const stopReconciler = startReconciler({
  db,
  logger,
  agentTimeoutMs: config.AGENT_TIMEOUT_MS,
  redisUrl: config.REDIS_URL,
  cleanup: ({ conversationId, sandboxId, runId }) =>
    sessionSandboxes.cleanup(conversationId, sandboxId, runId),
});

const stopWebhookDeliveryReconciler = startWebhookDeliveryReconciler({
  db,
  logger,
  secretKey: config.APP_SECRET_KEY,
  nodeEnv: config.NODE_ENV,
  allowlist: config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
});

installProcessGuards(logger);

const knowledgeWorker = await startKnowledgeWorker({
  db,
  logger,
  redisUrl: config.REDIS_URL,
  knowledgeDir: config.KNOWLEDGE_DIR,
  wikiModel: config.KNOWLEDGE_WIKI_MODEL,
  summaryModel: config.KNOWLEDGE_SUMMARY_MODEL,
  anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
  decrypt: (payload) => decryptSecrets(payload, config.APP_SECRET_KEY),
  parser: { url: config.DOCLING_URL, key: config.DOCLING_TOKEN },
  trustedHosts: config.KNOWLEDGE_PRIVATE_HOST_ALLOWLIST.split(',')
    .map((host) => host.trim())
    .filter((host) => host !== ''),
});

const stopKnowledgeReconciler = startKnowledgeReconciler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});

const knowledgeScheduler = startKnowledgeScheduler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});
await knowledgeScheduler.sync().catch((err: unknown) => {
  logger.error({ err }, 'knowledge scheduler sync failed');
});

const scheduleScheduler = startScheduleScheduler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});
await scheduleScheduler.sync().catch((err: unknown) => {
  logger.error({ err }, 'schedule reconcile failed');
});

let shuttingDown = false;

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');

  const code = await runShutdown({
    abort: () => sandboxClosing.abort(),
    logError: (label, err) => logger.error({ err }, `${label} cleanup failed`),
    workers: [
      { label: 'main worker', close: () => worker.close() },
      { label: 'eval worker', close: () => evalWorker.close() },
    ],
    provider: {
      label: 'sandbox provider',
      close: () =>
        closeSessionRuntime({
          channel: sessionCleanup,
          sessions: sessionSandboxes,
          provider,
          timeoutMs: SESSION_CLEANUP_TIMEOUT_MS,
        }),
    },
    steps: [
      { label: 'maintenance worker', close: () => maintenanceWorker.close() },
      { label: 'knowledge worker', close: () => knowledgeWorker.close() },
      { label: 'knowledge scheduler', close: () => knowledgeScheduler.close() },
      { label: 'knowledge reconciler', close: () => stopKnowledgeReconciler() },
      { label: 'sandbox probe', close: () => sandboxProbe.close() },
      { label: 'native plugins', close: () => nativePlugins.close() },
      {
        label: 'default runtime environment retry',
        close: async () => stopDefaultEnvironmentRetry?.(),
      },
      { label: 'runtime environment builds', close: () => runtimeEnvironmentBuilds.close() },
      { label: 'data domain builds', close: () => dataDomainBuilds.close() },
      { label: 'data domain enrichments', close: () => dataDomainEnrichments.close() },
      {
        label: 'data domain build reconciler',
        close: () => stopDataDomainBuildReconciler(),
      },
      {
        label: 'data domain enrichment reconciler',
        close: () => stopDataDomainEnrichmentReconciler(),
      },
      {
        label: 'runtime environment build reconciler',
        close: () => stopRuntimeEnvironmentBuildReconciler(),
      },
      { label: 'schedule scheduler', close: () => scheduleScheduler.close() },
      {
        label: 'webhook delivery reconciler',
        close: () => stopWebhookDeliveryReconciler(),
      },
      { label: 'reconciler', close: () => stopReconciler() },
    ],
    finalSteps: [
      { label: 'eval queue', close: () => closeEvalRunQueue() },
      { label: 'model proxy', close: () => modelProxy?.close() ?? Promise.resolve() },
      { label: 'runner client', close: () => closeRunnerClient() },
    ],
    database: {
      label: 'redis/postgres connections',
      close: async () => {
        await Promise.all([runConnection.quit(), evalConnection.quit()]);
        await client.close();
      },
    },
  });
  process.exit(code);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
logger.info('worker started');
