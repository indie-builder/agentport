import { fail, isAppError } from '@agentport/core';
import {
  NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type NativePluginOutput,
  nativePluginOutputSchema,
} from '@agentport/shared';
import { createBunRedisClient, Queue, QueueEvents } from 'bullmq';
import { RedisClient } from 'bun';

/** 只依赖 warn 的形状，`request.log` 与 pino 都满足。 */
export interface NativePluginLogger {
  warn: (obj: object, msg: string) => void;
}

const TIMEOUT = Symbol('timeout');

export async function runNativePluginAction(
  redisUrl: string,
  logger: NativePluginLogger,
  action: NativePluginAction,
  timeoutMs: number = NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
): Promise<NativePluginOutput> {
  const raw = new RedisClient(redisUrl, {
    autoReconnect: false,
    enableOfflineQueue: false,
    connectionTimeout: Math.min(2000, timeoutMs),
  });
  const connection = createBunRedisClient(raw);
  const queue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, { connection });
  const events = new QueueEvents(NATIVE_PLUGINS_QUEUE, {
    connection,
    lastEventId: '0-0',
  });
  const onError = (error: Error) => logger.warn({ err: error }, 'native plugin queue error');
  // Queue 也会转发 backend error；没有 listener 时 EventEmitter 会把它抛成 uncaught。
  queue.on('error', onError);
  events.on('error', onError);

  const outcome = Promise.withResolvers<{ value: unknown } | { error: Error } | typeof TIMEOUT>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    outcome.resolve(TIMEOUT);
  }, timeoutMs);
  const pending = (async () => {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    if (timedOut) return;
    const job = await queue.add(action.action, action, {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    const jobId = job.id;
    if (timedOut || !jobId) return;
    events.on('completed', (event) => {
      if (event.jobId === jobId) outcome.resolve({ value: event.returnvalue });
    });
    events.on('failed', (event) => {
      if (event.jobId === jobId) outcome.resolve({ error: new Error(event.failedReason) });
    });
    const state = await queue.getBackend().isFinished(jobId, true);
    if (timedOut) return;
    if (typeof state !== 'number' && state[0] !== 0) {
      outcome.resolve(
        state[0] === -1 || state[0] === 2
          ? { error: new Error(state[1]) }
          : { value: JSON.parse(state[1]) as unknown },
      );
    }
  })().catch((error: Error) => outcome.resolve({ error }));
  try {
    const result = await outcome.promise;
    if (result === TIMEOUT) {
      logger.warn({ action: action.action, timeoutMs }, 'native plugin action timed out');
      return fail(
        'SERVICE_UNAVAILABLE',
        `插件安装等待超时（${Math.round(timeoutMs / 1000)} 秒），请确认 worker 与 Docker 正常`,
      );
    }
    if ('error' in result) throw result.error;
    const parsed = nativePluginOutputSchema.safeParse(result.value);
    if (!parsed.success) {
      logger.warn(
        { action: action.action, issues: parsed.error.issues },
        'native plugin worker returned invalid output',
      );
      return fail('UPSTREAM_FAILED', '插件安装器返回了无法识别的结果，请稍后重试');
    }
    return parsed.data;
  } catch (err) {
    if (isAppError(err)) throw err;
    logger.warn({ err, action: action.action }, 'native plugin queue failed');
    return fail('SERVICE_UNAVAILABLE', '插件安装队列不可用，请确认 worker 正在运行后重试');
  } finally {
    connection.on('error', onError);
    clearTimeout(timer);
    timedOut = true;
    outcome.resolve(TIMEOUT);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(drainTimer);
    await Promise.allSettled([queue.close(), events.close()]);
    await connection.quit();
  }
}
