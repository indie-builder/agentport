import { fail } from '@agentport/core';
import {
  NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type NativePluginOutput,
  nativePluginOutputSchema,
} from '@agentport/shared';
import { type QueueJobLogger, runQueueJobAndWait } from '../../queue/job-wait.js';

export async function runNativePluginAction(
  redisUrl: string,
  logger: QueueJobLogger,
  action: NativePluginAction,
  timeoutMs: number = NATIVE_PLUGIN_WAIT_TIMEOUT_MS,
): Promise<NativePluginOutput> {
  const result = await runQueueJobAndWait({
    redisUrl,
    queueName: NATIVE_PLUGINS_QUEUE,
    jobName: action.action,
    payload: action,
    timeoutMs,
    logger: { warn: (obj: object) => logger.warn(obj, 'native plugin queue error') },
  });
  if (result.status === 'timeout') {
    logger.warn({ action: action.action, timeoutMs }, 'native plugin action timed out');
    return fail(
      'SERVICE_UNAVAILABLE',
      `插件安装等待超时（${Math.round(timeoutMs / 1000)} 秒），请确认 worker 与 Docker 正常`,
    );
  }
  if (result.status === 'failed' || result.status === 'error') {
    logger.warn(
      {
        err: result.status === 'failed' ? new Error(result.message) : result.error,
        action: action.action,
      },
      'native plugin queue failed',
    );
    return fail('SERVICE_UNAVAILABLE', '插件安装队列不可用，请确认 worker 正在运行后重试');
  }
  const parsed = nativePluginOutputSchema.safeParse(result.value);
  if (!parsed.success) {
    logger.warn(
      { action: action.action, issues: parsed.error.issues },
      'native plugin worker returned invalid output',
    );
    return fail('UPSTREAM_FAILED', '插件安装器返回了无法识别的结果，请稍后重试');
  }
  return parsed.data;
}
