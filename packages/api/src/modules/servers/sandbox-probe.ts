import {
  SANDBOX_PROBE_WAIT_TIMEOUT_MS,
  SANDBOX_PROBES_QUEUE,
  type SandboxProbeJob,
  type ServerTestResult,
  SHORT_JOB_RETENTION,
} from '@agentport/shared';
import { createBunRedisClient, Queue, QueueEvents } from 'bullmq';
import { RedisClient } from 'bun';

export interface ProbeLogger {
  warn: (obj: object, msg: string) => void;
}

const TIMEOUT = Symbol('timeout');

export interface StdioProbeOptions {
  runtimeEnvironmentId?: string | null;
  timeoutMs?: number;
  redisUrl: string;
}

export async function testStdioInSandbox(
  serverId: string,
  logger: ProbeLogger,
  options: StdioProbeOptions,
): Promise<ServerTestResult> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_PROBE_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const raw = new RedisClient(options.redisUrl, {
    autoReconnect: false,
    enableOfflineQueue: false,
    connectionTimeout: Math.min(2000, timeoutMs),
  });
  const connection = createBunRedisClient(raw);
  const job: SandboxProbeJob = {
    serverId,
    ...(options.runtimeEnvironmentId === undefined || options.runtimeEnvironmentId === null
      ? {}
      : { runtimeEnvironmentId: options.runtimeEnvironmentId }),
  };
  const queue = new Queue<SandboxProbeJob>(SANDBOX_PROBES_QUEUE, { connection });
  const events = new QueueEvents(SANDBOX_PROBES_QUEUE, {
    connection,
    // 首个 XREAD 若在 job 完成之后才开始，默认 $ 会在执行时跳过完成事件。
    lastEventId: '0-0',
  });
  events.on('error', (error) => logger.warn({ err: error }, 'sandbox probe queue error'));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  try {
    const result = await Promise.race([
      (async () => {
        const queued = await queue.add('probe', job, {
          attempts: 1,
          ...SHORT_JOB_RETENTION,
        });
        return (await queued.waitUntilFinished(events, timeoutMs)) as ServerTestResult;
      })(),
      idle,
    ]);
    if (result !== TIMEOUT) return result;
    logger.warn({ serverId, timeoutMs }, 'sandbox probe timed out before returning a result');
    return {
      ok: false,
      tools: [],
      error: `连接测试等待超时（${Math.round(timeoutMs / 1000)} 秒），请确认 worker 与 Docker 正常`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    logger.warn({ err, serverId }, 'sandbox probe failed before returning a result');
    return {
      ok: false,
      tools: [],
      error: '连接测试队列不可用，请确认 worker 正在运行后重试',
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    await Promise.allSettled([queue.close(), events.close()]);
    await connection.quit();
  }
}
