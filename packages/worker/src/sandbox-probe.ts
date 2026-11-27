import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecrets, NOT_FOUND_MESSAGES } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
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
import { startRedisWorker } from './queue-worker.js';
import { runSandboxTask, SANDBOX_TASK_OUTPUT_MAX_BYTES } from './sandbox/one-shot.js';
import type { Sandbox, SandboxCreateOptions } from './sandbox/provider.js';
import type { RuntimeEnvironmentResolver } from './sandbox/sessions.js';

export interface ProbeSandboxOptions extends SandboxCreateOptions {
  entrypoint: string;
  command: string[];
}

interface ProbeProvider {
  create(options: ProbeSandboxOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
}

export interface SandboxProbeDeps {
  db: Database;
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
  const secrets = row.secretsEncrypted
    ? await decryptSecrets(row.secretsEncrypted, deps.secretKey)
    : {};
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
            outcome.exit.kind === 'closing'
              ? 'worker 正在关停，连接测试已取消'
              : `沙盒启动超时（${timeoutMs}ms），请检查 Docker 服务与镜像后重试`,
          );
        }
        const stderrTail =
          redactSecrets(outcome.stderr.trim()).split('\n').at(-1)?.slice(0, 300) ?? '';
        if (outcome.result !== undefined) {
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
          outcome.exit.kind === 'closing'
            ? 'worker 正在关停，连接测试已取消'
            : outcome.exit.kind === 'timeout' || outcome.exit.kind === 'startup_timeout'
              ? `连接测试超时（${timeoutMs}ms），请检查 Server 是否能正常启动`
              : outcome.exit.kind === 'output_too_large'
                ? `沙盒输出超过 ${SANDBOX_TASK_OUTPUT_MAX_BYTES} 字节上限`
                : `沙盒没有返回结果（${outcome.exit.detail}）`;
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

export async function registerSandboxProbe(input: {
  db: Database;
  logger: Logger;
  provider: ProbeProvider;
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
  workspacesDir: string;
  hostWorkspacesDir: string;
  secretKey: string;
  redisUrl: string;
  concurrency: number;
  closingSignal: AbortSignal;
}): Promise<{ close(): Promise<void> }> {
  const deps: SandboxProbeDeps = {
    db: input.db,
    logger: input.logger,
    provider: input.provider,
    resolveRuntimeEnvironment: input.resolveRuntimeEnvironment,
    workspacesDir: input.workspacesDir,
    hostWorkspacesDir: input.hostWorkspacesDir,
    secretKey: input.secretKey,
  };

  return startRedisWorker<SandboxProbeJob>({
    queue: SANDBOX_PROBES_QUEUE,
    redisUrl: input.redisUrl,
    logger: input.logger,
    failureMessage: 'sandbox probe job failed',
    concurrency: input.concurrency,
    externalSignal: input.closingSignal,
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
}
