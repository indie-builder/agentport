import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecrets, NOT_FOUND_MESSAGES } from '@agentport/core';
import { createDb, repo } from '@agentport/db';
import {
  errorText,
  limitToolCatalog,
  parseJsonAs,
  type ResolvedRuntimeEnvironment,
  redactSecrets,
  SANDBOX_PROBE_STARTUP_TIMEOUT_MS,
  SANDBOX_PROBE_STDERR_MAX_BYTES,
  SANDBOX_PROBES_QUEUE,
  type SandboxProbeJob,
  type SandboxProbeOutput,
  type ServerTestResult,
  sandboxProbeJobSchema,
  sandboxProbeOutputSchema,
  sandboxProbeTaskSchema,
} from '@agentport/shared';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { createWorkerLogger } from './logger.js';
import { startRedisWorker } from './queue-worker.js';
import type { RuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { DockerSandboxProvider } from './sandbox/docker.js';
import { runSandboxTask, SANDBOX_TASK_OUTPUT_MAX_BYTES } from './sandbox/one-shot.js';
import type { Sandbox, SandboxCreateOptions } from './sandbox/provider.js';

export interface ProbeSandboxOptions extends SandboxCreateOptions {
  entrypoint: string;
  command: string[];
}

interface ProbeProvider {
  create(options: ProbeSandboxOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
  destroyAll?(): Promise<void>;
}

export interface SandboxProbeDeps {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  provider: ProbeProvider;
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
  workspacesDir: string;
  hostWorkspacesDir: string;
  secretKey: string;
  closing?: AbortSignal;
}

interface ProbeOutcome extends ServerTestResult {
  stderr?: string;
}

function parseResultLine(line: string): SandboxProbeOutput | null {
  return parseJsonAs(line, sandboxProbeOutputSchema);
}

export async function runSandboxProbe(
  deps: SandboxProbeDeps,
  serverId: string,
  timeoutMs: number = SANDBOX_PROBE_STARTUP_TIMEOUT_MS,
  runtimeEnvironmentId: string | null = null,
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const elapsed = (): { durationMs: number } => ({ durationMs: Date.now() - startedAt });
  let runtimeEnvironment: ResolvedRuntimeEnvironment | undefined;
  const failure = (error: string, stderr?: string): ProbeOutcome => ({
    ok: false,
    tools: [],
    error,
    ...(stderr ? { stderr } : {}),
    ...(runtimeEnvironment === undefined ? {} : { runtimeEnvironment }),
    ...elapsed(),
  });

  const row = await repo.servers.getServer(deps.db, serverId);
  if (!row) return failure(NOT_FOUND_MESSAGES.server);
  if (row.kind !== 'stdio') return failure('只支持 stdio 类型的连接测试');
  const secrets = row.secretsEncrypted ? decryptSecrets(row.secretsEncrypted, deps.secretKey) : {};
  const task = sandboxProbeTaskSchema.safeParse({
    kind: 'stdio',
    command: row.config.command,
    args: row.config.args,
    env: secrets,
  });
  if (!task.success) return failure('连接配置不完整，请检查命令后再测试');

  let resolved: ResolvedRuntimeEnvironment;
  try {
    resolved = await deps.resolveRuntimeEnvironment(runtimeEnvironmentId);
  } catch (err) {
    deps.logger.warn({ err, serverId, runtimeEnvironmentId }, 'sandbox probe environment failed');
    return failure(`无法解析运行环境：${redactSecrets(errorText(err))}`);
  }
  runtimeEnvironment = resolved;

  const workspaceDir = join(deps.hostWorkspacesDir, 'sandbox-probes');
  await mkdir(join(deps.workspacesDir, 'sandbox-probes'), { recursive: true, mode: 0o700 });

  return runSandboxTask<SandboxProbeOutput, ProbeOutcome>(
    {
      provider: deps.provider,
      logger: deps.logger,
      closing: deps.closing,
      create: {
        image: resolved.imageId,
        workspaceDir,
        env: { HOME: '/tmp' },
        name: `agentport-probe-${crypto.getRandomValues(new Uint8Array(4)).toHex()}`,
        entrypoint: 'bun',
        command: ['dist/probe.js'],
      },
      payload: task.data,
      parseLine: parseResultLine,
      startupMs: timeoutMs,
      totalMs: timeoutMs,
      stderrMaxBytes: SANDBOX_PROBE_STDERR_MAX_BYTES,
      stderrKeep: 'head',
      logContext: { serverId },
      cleanupLog: 'sandbox probe cleanup failed',
      lateCleanupLog: 'sandbox probe cleanup failed after timeout',
    },
    {
      complete: (outcome) => {
        if (!outcome.started) {
          return failure(
            outcome.exited === '__closing__'
              ? 'worker 正在关停，连接测试已取消'
              : `沙盒启动超时（${timeoutMs}ms），请检查 Docker 服务与镜像后重试`,
          );
        }
        const stderrTail =
          redactSecrets(outcome.stderr.trim()).split('\n').at(-1)?.slice(0, 300) ?? '';
        if (outcome.result) {
          const output = outcome.result;
          if (!output.ok) {
            deps.logger.warn(
              {
                serverId,
                durationMs: Date.now() - startedAt,
                stderr: redactSecrets(outcome.stderr),
              },
              'sandbox probe reported failure',
            );
            return failure(
              redactSecrets(output.error ?? 'connection failed'),
              stderrTail || undefined,
            );
          }
          let tools: ProbeOutcome['tools'];
          try {
            tools = limitToolCatalog(output.tools);
          } catch (err) {
            return failure(redactSecrets(errorText(err)), stderrTail || undefined);
          }
          return {
            ok: true,
            ...(output.serverInfo ? { serverInfo: output.serverInfo } : {}),
            tools,
            runtimeEnvironment,
            ...elapsed(),
          };
        }

        const reason =
          outcome.exited === '__closing__'
            ? 'worker 正在关停，连接测试已取消'
            : outcome.exited === '__timeout__'
              ? `连接测试超时（${timeoutMs}ms），请检查 Server 是否能正常启动`
              : outcome.exited === '__output_too_large__'
                ? `沙盒输出超过 ${SANDBOX_TASK_OUTPUT_MAX_BYTES} 字节上限`
                : `沙盒没有返回结果（${outcome.exited ?? 'unknown'}）`;
        deps.logger.warn(
          {
            serverId,
            durationMs: Date.now() - startedAt,
            stderr: redactSecrets(outcome.stderr),
          },
          'sandbox probe failed',
        );
        return failure(stderrTail ? `${reason}: ${stderrTail}` : reason, stderrTail || undefined);
      },
      fail: (err, closing) => {
        if (closing) {
          deps.logger.warn({ serverId }, 'sandbox probe cancelled by shutdown');
          return failure('worker 正在关停，连接测试已取消');
        }
        deps.logger.warn({ err, serverId }, 'sandbox probe crashed');
        return failure(`无法启动沙盒：${redactSecrets(errorText(err))}`);
      },
    },
  );
}

export async function registerSandboxProbe(
  config: Config,
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver,
): Promise<{ close(): Promise<void> }> {
  const handle = createDb(config.DATABASE_URL);
  const closing = new AbortController();
  const provider: ProbeProvider = new DockerSandboxProvider({
    memory: config.SANDBOX_MEMORY,
    cpus: config.SANDBOX_CPUS,
    pids: config.SANDBOX_PIDS,
    egress: config.SANDBOX_EGRESS,
    closing: closing.signal,
  });
  const deps: SandboxProbeDeps = {
    db: handle.db,
    logger: createWorkerLogger(config),
    provider,
    resolveRuntimeEnvironment,
    workspacesDir: config.WORKSPACES_DIR,
    hostWorkspacesDir: config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR,
    secretKey: config.APP_SECRET_KEY,
  };

  const worker = startRedisWorker<SandboxProbeJob>({
    queue: SANDBOX_PROBES_QUEUE,
    redisUrl: config.REDIS_URL,
    logger: deps.logger,
    failureMessage: 'sandbox probe job failed',
    concurrency: config.AGENT_MAX_CONCURRENT,
    externalSignal: closing.signal,
    processor: (signal) => async (job) => {
      const parsed = sandboxProbeJobSchema.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid sandbox probe payload');
      return runSandboxProbe(
        { ...deps, closing: signal },
        parsed.data.serverId,
        undefined,
        parsed.data.runtimeEnvironmentId ?? null,
      );
    },
  });

  return {
    close: async () => {
      closing.abort();
      const results = await Promise.allSettled([worker.close(), provider.destroyAll?.()]);
      await handle.client.close();
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'sandbox probe shutdown failed');
      }
    },
  };
}
