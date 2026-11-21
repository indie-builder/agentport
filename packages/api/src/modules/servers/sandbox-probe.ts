import {
  SANDBOX_PROBE_WAIT_TIMEOUT_MS,
  SANDBOX_PROBES_QUEUE,
  type SandboxProbeJob,
  type ServerTestResult,
} from '@agentport/shared';
import { type QueueJobLogger, runQueueJobAndWait } from '../../queue/job-wait.js';

export interface StdioProbeOptions {
  runtimeEnvironmentId?: string | null;
  timeoutMs?: number;
  redisUrl: string;
}

export async function testStdioInSandbox(
  serverId: string,
  logger: QueueJobLogger,
  options: StdioProbeOptions,
): Promise<ServerTestResult> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_PROBE_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const job: SandboxProbeJob = {
    serverId,
    ...(options.runtimeEnvironmentId === undefined || options.runtimeEnvironmentId === null
      ? {}
      : { runtimeEnvironmentId: options.runtimeEnvironmentId }),
  };
  const result = await runQueueJobAndWait({
    redisUrl: options.redisUrl,
    queueName: SANDBOX_PROBES_QUEUE,
    jobName: 'probe',
    payload: job,
    timeoutMs,
    logger: { warn: (obj: object) => logger.warn(obj, 'sandbox probe queue error') },
  });
  if (result.status === 'completed') return result.value as ServerTestResult;
  if (result.status === 'timeout') {
    logger.warn({ serverId, timeoutMs }, 'sandbox probe timed out before returning a result');
    return {
      ok: false,
      tools: [],
      error: `连接测试等待超时（${Math.round(timeoutMs / 1000)} 秒），请确认 worker 与 Docker 正常`,
      durationMs: Date.now() - startedAt,
    };
  }
  logger.warn(
    { err: result.status === 'failed' ? new Error(result.message) : result.error, serverId },
    'sandbox probe failed before returning a result',
  );
  return {
    ok: false,
    tools: [],
    error: '连接测试队列不可用，请确认 worker 正在运行后重试',
    durationMs: Date.now() - startedAt,
  };
}
