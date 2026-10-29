import {
  SANDBOX_PROBE_WAIT_TIMEOUT_MS,
  SANDBOX_PROBES_QUEUE,
  type SandboxProbeJob,
  type ServerTestResult,
} from '@agentport/shared';
import { Queue, QueueEvents } from 'bullmq';

// 与 queue/producer.ts 同一读法：进程启动时注入，测试由 vitest env 覆盖。
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** 只依赖 warn 的形状，`request.log` 与 pino 都满足（与 test-connection 一致）。 */
export interface ProbeLogger {
  warn: (obj: object, msg: string) => void;
}

const TIMEOUT = Symbol('timeout');

export interface StdioProbeOptions {
  /** 缺省/null 用平台默认环境；只影响这次试连实际使用的容器镜像。 */
  runtimeEnvironmentId?: string | null;
  timeoutMs?: number;
  /** 缺省用进程 REDIS_URL；路由不传，测试可指向隔离 Redis。 */
  redisUrl?: string;
}

/**
 * stdio 试连在 worker 的沙盒镜像里执行：API 只投递 serverId 与可选运行环境并等结果。
 * worker 侧把连接失败收敛成结果对象（不 reject），这里只兜底队列与等待超时。
 *
 * 连接按次建立、按次关闭：试连有速率限制，不值得为它常驻两条 Redis 连接，
 * 也不需要给 API 关停额外接线。外部再套一层超时，Redis 半死时响应也不会挂住。
 */
export async function testStdioInSandbox(
  serverId: string,
  logger: ProbeLogger,
  options: StdioProbeOptions = {},
): Promise<ServerTestResult> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_PROBE_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const connection = { url: options.redisUrl ?? REDIS_URL };
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
    // 从流起点回放（默认保留 1 万条），waitUntilFinished 只监听本 jobId。
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
        const queued = await queue.add(
          'probe',
          job,
          // 结果即返回值；试连不自动重试。
          { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
        );
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
    // 队列错误可能带连接串与密码：原文只进日志，响应给固定可读文案。
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
  }
}
