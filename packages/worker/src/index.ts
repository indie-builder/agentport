import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decryptSecrets, hashMcpToken, installProcessGuards, isAppError } from '@agentport/core';
import { logEvent } from '@agentport/core/logger';
import { createDb, repo, schema } from '@agentport/db';
import {
  ACTIVE_RUN_STATUSES,
  agentRunJobSchema,
  EVAL_RUNS_QUEUE,
  RUNS_QUEUE,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  type RuntimeEnvironmentBuildJob,
  SESSION_CLEANUP_TIMEOUT_MS,
} from '@agentport/shared';
import { createBunRedisClient, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { inArray } from 'drizzle-orm';
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
import { runEvalJob } from './eval-job.js';
import { closeEvalRunQueue } from './eval-runner.js';
import {
  cleanupSandboxIdOf,
  createEvalFailedHandler,
  createLoadAgentPlugins,
  createSandboxEnvFactory,
  denyQueuedRun,
  toEntry,
} from './handlers.js';
import { startWebhookDeliveryReconciler } from './integrations/deliver.js';
import { startKnowledgeWorker } from './knowledge/queue.js';
import { startKnowledgeReconciler } from './knowledge/reconcile.js';
import { startKnowledgeScheduler } from './knowledge/scheduler.js';
import { createWorkerLogger } from './logger.js';
import { startMaintenanceWorker } from './maintenance.js';
import { resolveProviderUpstreams } from './model-providers.js';
import { startModelProxy } from './model-proxy.js';
import { registerNativePlugins } from './native-plugins.js';
import { closeRunnerClient, configureRunnerClient } from './runner-client.js';
import { runAgentJob } from './runs/execute.js';
import { createWorkspaceAssembly } from './runs/workspace-assembly.js';
import { startRuntimeEnvironmentBuildWorker } from './runtime-environments/build.js';
import {
  ensureDefaultEnvironment,
  startDefaultEnvironmentRetry,
} from './runtime-environments/default.js';
import { startRuntimeEnvironmentBuildReconciler } from './runtime-environments/reconcile.js';
import { createRuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { syncStaleRuntimeEnvironments } from './runtime-environments/sync-base.js';
import { DockerSandboxProvider, resolveLocalImageId } from './sandbox/docker.js';
import { closeSessionRuntime, startSessionCleanupChannel } from './sandbox/session-cleanup.js';
import { SessionSandboxes } from './sandbox/sessions.js';
import { registerSandboxProbe } from './sandbox-probe.js';
import { startReconciler } from './scheduling/reconcile.js';
import { startScheduleScheduler } from './scheduling/scheduler.js';
import { isRunWorkspaceName, runWorkspaceDir } from './session-workspace.js';
import { runShutdown } from './shutdown.js';
import { modelProxyUpstream } from './upstream.js';

const config = loadConfig();
const logger = createWorkerLogger(config);

configureRunnerClient(config.REDIS_URL, logger);

const workspacesDir = resolve(config.WORKSPACES_DIR);
const hostWorkspacesDir = resolve(config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR);

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

const loadAgentPlugins = createLoadAgentPlugins(db, logger);
const writeWorkspace = createWorkspaceAssembly({ db, workspacesDir, logger });

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
  checkOutbound: async ({ runId, agentId, body }) => {
    const effectiveAgentId =
      agentId ?? (await repo.chat.getRun(db, runId).then((run) => run?.agentId));
    if (effectiveAgentId === undefined || effectiveAgentId === null) {
      return { blocked: true, body: Buffer.alloc(0) };
    }
    const text = body.toString('utf8');
    const checked = await checkOutboundPolicy(db, logger, {
      agentId: effectiveAgentId,
      runId,
      text,
      sourceId: runId,
    });
    return {
      blocked: checked.blocked,
      body: checked.text === text ? body : Buffer.from(checked.text),
    };
  },
  resolveProviders: (run, model) =>
    resolveProviderUpstreams(
      db,
      config,
      model,
      run.runId,
      modelProxyUpstream(envUpstream, false),
      run.conversationId,
    ),
  recordProviderServed: ({ runId, providerId }) =>
    repo.modelProviders.markRunServedProvider(db, runId, providerId),
  recordProviderResult: (result) => repo.modelProviders.recordProviderRequest(db, result),
});
if (!modelProxy) throw new Error('model proxy failed to start');
const sandboxEnv = createSandboxEnvFactory(config, modelProxy);
logger.info('model credentials stay in the worker; sandbox gets a per-run proxy token');

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

const stopKnowledgeReconciler = await startKnowledgeReconciler({
  db,
  logger,
  redisUrl: config.REDIS_URL,
});

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
  nodeEnv: config.NODE_ENV,
});

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
  const finalAttempt = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
  if (parsed?.success && job !== undefined && finalAttempt) {
    logEvent(
      logger,
      'run failed',
      {
        runId: parsed.data.runId,
        attemptsMade: job.attemptsMade,
        ...(isAppError(err) ? { code: err.code } : {}),
      },
      'error',
      {
        err,
        ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
      },
    );
  } else {
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
  }
  if (!finalAttempt) return;
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

evalWorker.on('failed', createEvalFailedHandler({ db, logger }));

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

const sandboxProbe = await registerSandboxProbe({
  db,
  logger,
  provider,
  resolveRuntimeEnvironment,
  workspacesDir,
  hostWorkspacesDir,
  secretKey: config.APP_SECRET_KEY,
  redisUrl: config.REDIS_URL,
  concurrency: config.AGENT_MAX_CONCURRENT,
  closingSignal: sandboxClosing.signal,
});
const nativePlugins = await registerNativePlugins({
  provider,
  resolveRuntimeEnvironment,
  workspacesDir,
  hostWorkspacesDir,
  logger,
  redisUrl: config.REDIS_URL,
  closingSignal: sandboxClosing.signal,
});

const runtimeEnvironmentBuildStore = {
  claimBuild: async (versionId: string) => {
    const version = await repo.runtimeEnvironments.claimRuntimeEnvironmentBuild(db, versionId);
    return version === null
      ? null
      : {
          environmentId: version.environmentId,
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
  publishIfOnlineMatches: (
    environmentId: string,
    versionId: string,
    expectedOnlineVersionId: string,
  ) =>
    repo.runtimeEnvironments.publishRuntimeEnvironmentVersionIfOnlineMatches(
      db,
      environmentId,
      versionId,
      expectedOnlineVersionId,
    ),
};
const runtimeEnvironmentBuilds = await startRuntimeEnvironmentBuildWorker({
  store: runtimeEnvironmentBuildStore,
  logger,
  redisUrl: config.REDIS_URL,
  sandboxImage: config.SANDBOX_IMAGE,
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

const runtimeEnvironmentBaseSyncDone = (async () => {
  if (sandboxClosing.signal.aborted) return;
  const connection = createBunRedisClient(new RedisClient(config.REDIS_URL));
  const queue = new Queue<RuntimeEnvironmentBuildJob>(RUNTIME_ENVIRONMENT_BUILDS_QUEUE, {
    connection,
  });
  queue.on('error', () => logger.warn('runtime environment base sync queue connection failed'));
  try {
    await syncStaleRuntimeEnvironments({
      sandboxImage: config.SANDBOX_IMAGE,
      resolveImageId: resolveLocalImageId,
      listStale: (currentBaseImageId, sandboxImage) =>
        repo.runtimeEnvironments.listStaleOnlineRuntimeEnvironments(
          db,
          currentBaseImageId,
          sandboxImage,
        ),
      enqueueBuild: (environmentId, baseImageId) =>
        repo.runtimeEnvironments.enqueueRuntimeEnvironmentBuild(db, environmentId, baseImageId),
      failBuild: (versionId, error) =>
        repo.runtimeEnvironments.failRuntimeEnvironmentBuild(db, versionId, error),
      queue,
      logger,
      signal: sandboxClosing.signal,
    });
  } catch (err) {
    logger.warn({ err }, 'runtime environment base sync failed');
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
})();

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
  reconcileMs: config.SCHEDULE_RECONCILE_MS,
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
      {
        label: 'runtime environment base sync',
        close: () => runtimeEnvironmentBaseSyncDone,
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
      { label: 'model proxy', close: () => modelProxy.close() },
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
  logEvent(logger, 'worker stopped', {});
  process.exit(code);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
logEvent(logger, 'worker started', {});
