import { decryptSecrets, RunFailure, renderPlugin, type WorkspacePlugin } from '@agentport/core';
import { type Database, idSuffix, plugins as pluginsTable, repo, type schema } from '@agentport/db';
import {
  type Agent,
  type AgentDefinition,
  type AgentDefinitionServer,
  CONFIG_CONTAINER_DIR,
  generatedMcpEntry,
  knowledgeMcpEntry,
  type McpJsonArtifactEntry,
  previewMcpEntry,
  serverInputSchema,
} from '@agentport/shared';
import { inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { handleEvalJobFailed } from './eval-job.js';
import { evalFailureDiagnostics } from './eval-runner.js';
import type { ModelProxy } from './model-proxy.js';
import { finalizeRun } from './run-finish.js';
import type { RunAccessDenial } from './runs/run-access.js';
import { SandboxCleanupError } from './sandbox/provider.js';
import { toDockerHostUrl } from './upstream.js';

export async function toEntry(
  server: AgentDefinitionServer,
  apiUrl: string,
  secretKey: string,
  runId: string,
  runToken: string,
): Promise<McpJsonArtifactEntry> {
  if (server.kind === 'knowledge' || server.kind === 'data_domain') {
    return knowledgeMcpEntry({ apiUrl, serverId: server.id, runId, runToken });
  }
  const secrets = server.secretsEncrypted
    ? await decryptSecrets(server.secretsEncrypted, secretKey)
    : {};
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

export function createLoadAgentPlugins(db: Database, logger: Logger) {
  return async (
    agent: typeof schema.agents.$inferSelect,
    bindings: Agent['pluginBindings'],
    snapshotPlugins: AgentDefinition['resources']['plugins'] | null,
  ): Promise<WorkspacePlugin[]> => {
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
      logger.warn(
        { agentId: agent.id, slug: plugin.slug },
        'plugin has nothing authorized; skipped',
      );
      return false;
    });
  };
}

export function createSandboxEnvFactory(
  config: Pick<Config, 'SANDBOX_EGRESS' | 'HTTPS_PROXY' | 'HTTP_PROXY' | 'NO_PROXY' | 'no_proxy'>,
  modelProxy: Pick<ModelProxy, 'url' | 'issueToken'>,
) {
  return (apiUrl: string, runId: string): Record<string, string> => {
    const env: Record<string, string> = {
      SANDBOX_API_URL: apiUrl,
      CLAUDE_CONFIG_DIR: CONFIG_CONTAINER_DIR,
      ANTHROPIC_BASE_URL: modelProxy.url,
      ANTHROPIC_AUTH_TOKEN: modelProxy.issueToken(runId),
      ANTHROPIC_API_KEY: '',
    };

    if (config.SANDBOX_EGRESS === 'proxy') {
      for (const key of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
        const value = config[key];
        if (value) env[key] = toDockerHostUrl(value);
      }
      const noProxy = config.NO_PROXY ?? config.no_proxy;
      if (noProxy) env.NO_PROXY = noProxy;
    }
    return env;
  };
}

export function cleanupSandboxIdOf(err: unknown): string | undefined {
  if (err instanceof SandboxCleanupError) return err.sandboxId;
  if (err instanceof RunFailure && err.cause instanceof SandboxCleanupError) {
    return err.cause.sandboxId;
  }
  return undefined;
}

export async function denyQueuedRun(
  db: Database,
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
      dedupeKey: `aud_denied_${idSuffix(runId)}`,
    },
  });
  if (!won) logger.info({ runId }, 'run no longer queued, access denial skipped');
}

export function createEvalFailedHandler({
  db,
  logger,
  handleFailed = handleEvalJobFailed,
}: {
  db: Database;
  logger: Logger;
  handleFailed?: typeof handleEvalJobFailed;
}) {
  return (job: { id?: string; data: unknown } | undefined, err: unknown): void => {
    logger.error({ jobId: job?.id, ...evalFailureDiagnostics(err) }, 'eval job failed');
    handleFailed({ db, logger, job, error: err }).catch((settleError: unknown) => {
      logger.error(
        { jobId: job?.id, ...evalFailureDiagnostics(settleError) },
        'eval job failure settlement failed',
      );
    });
  };
}
