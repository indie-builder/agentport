import { fail, isAppError } from '@agentport/core';
import {
  NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type NativePluginOutput,
  nativePluginOutputSchema,
} from '@agentport/shared';
import { Queue, QueueEvents } from 'bullmq';

/** 只依赖 warn 的形状，`request.log` 与 pino 都满足。 */
export interface NativePluginLogger {
  warn: (obj: object, msg: string) => void;
}

const TIMEOUT = Symbol('timeout');

/**
 * 安装/读取在 worker 的一次性沙盒里执行：API 只投递受限动作并等结果。
 * 连接按次建立、按次关闭，URL 取自 `app.config`，测试可以指向隔离 Redis。
 *
 * 队列错误原文可能带 Redis 连接串与密码：只进日志，响应固定为 503。
 * 结果先按 shared schema 重新校验，沙盒输出不合契约时也变成可读失败。
 */
export async function runNativePluginAction(
  redisUrl: string,
  logger: NativePluginLogger,
  action: NativePluginAction,
  timeoutMs: number = NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
): Promise<NativePluginOutput> {
  // 连接拒绝时立即失败：不排队、不重试，并把建连限制在本次预算内。
  // QueueEvents 是阻塞读，BullMQ 要求其 maxRetriesPerRequest 为 null。
  const connection = {
    url: redisUrl,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    connectTimeout: Math.min(2000, timeoutMs),
  };
  const queue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, {
    connection: { ...connection, maxRetriesPerRequest: 1 },
  });
  const events = new QueueEvents(NATIVE_PLUGINS_QUEUE, {
    connection: { ...connection, maxRetriesPerRequest: null },
    // 首个 XREAD 若在 job 完成之后才开始，默认 $ 会在执行时跳过完成事件。
    // 从流起点回放（默认保留 1 万条），waitUntilFinished 只监听本 jobId。
    lastEventId: '0-0',
  });
  const onError = (error: Error) => logger.warn({ err: error }, 'native plugin queue error');
  // Queue 也会转发 backend error；没有 listener 时 EventEmitter 会把它抛成 uncaught。
  queue.on('error', onError);
  events.on('error', onError);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  try {
    const result = await Promise.race([
      (async () => {
        const job = await queue.add(action.action, action, {
          attempts: 1,
          removeOnComplete: 50,
          removeOnFail: 50,
        });
        // 事件等待比外层预算长，保证超时总是由这里统一收敛成 SERVICE_UNAVAILABLE。
        return (await job.waitUntilFinished(events, timeoutMs + 1000)) as unknown;
      })(),
      idle,
    ]);
    if (result === TIMEOUT) {
      logger.warn({ action: action.action, timeoutMs }, 'native plugin action timed out');
      return fail(
        'SERVICE_UNAVAILABLE',
        `插件安装等待超时（${Math.round(timeoutMs / 1000)} 秒），请确认 worker 与 Docker 正常`,
      );
    }
    const parsed = nativePluginOutputSchema.safeParse(result);
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
    clearTimeout(timer);
    // close() 在连接拒绝时会等 ready 而挂住；disconnect 直接断开，且不 reject。
    await Promise.allSettled([queue.disconnect(), events.disconnect()]);
  }
}
