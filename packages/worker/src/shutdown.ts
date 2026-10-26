/** 关停排空等待：先等在跑任务，再在关 Redis/PG 前给 worker 第二次机会。 */
export const SHUTDOWN_WAIT_MS = 10_000;
export const POOL_WAIT_MS = 2_000;

export interface ShutdownStep {
  label: string;
  close: () => Promise<unknown>;
}

export interface ShutdownWaits {
  shutdownMs: number;
  poolMs: number;
}

export interface ShutdownOptions {
  abort: () => void;
  logError: (label: string, err: unknown) => void;
  /** 并排发起、只等有界时间；失败不阻塞后续关停。 */
  workers: ShutdownStep[];
  /** worker 首轮等待后按序关闭。 */
  steps: ShutdownStep[];
  /** worker 第二轮等待后按序关闭。 */
  finalSteps: ShutdownStep[];
  pool: ShutdownStep;
  waits?: ShutdownWaits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms).unref());
}

/** 返回进程退出码：任一清理失败为 1。 */
export async function runShutdown(options: ShutdownOptions): Promise<number> {
  const waits = options.waits ?? { shutdownMs: SHUTDOWN_WAIT_MS, poolMs: POOL_WAIT_MS };
  let failed = false;
  const attempt = async (step: ShutdownStep): Promise<void> => {
    try {
      await step.close();
    } catch (err) {
      failed = true;
      options.logError(step.label, err);
    }
  };

  options.abort();
  // attempt 自己吞掉 rejection，并行发起后即使超时也不会留下 unhandled rejection。
  const closing = Promise.all(options.workers.map(attempt));
  await Promise.race([closing, sleep(waits.shutdownMs)]);
  for (const step of options.steps) await attempt(step);
  await Promise.race([closing, sleep(waits.poolMs)]);
  for (const step of options.finalSteps) await attempt(step);
  await attempt({
    label: options.pool.label,
    close: () => Promise.race([options.pool.close(), sleep(waits.poolMs)]),
  });
  return failed ? 1 : 0;
}
