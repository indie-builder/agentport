import { waitClose } from './close-wait.js';

/** 关停排空等待：先等在跑任务，再在关 Redis/PG 前给其余关闭有界时间。 */
const SHUTDOWN_WAIT_MS = 10_000;
const CLOSE_WAIT_MS = 5_000;
const POOL_WAIT_MS = 2_000;

export interface ShutdownStep {
  label: string;
  close: () => Promise<unknown>;
}

export interface ShutdownWaits {
  shutdownMs: number;
  closeMs: number;
  poolMs: number;
}

export interface ShutdownOptions {
  abort: () => void;
  logError: (label: string, err: unknown) => void;
  /** run worker：先等排空，超时不再等待。 */
  workers: ShutdownStep[];
  /** run 宽限期后无条件强杀沙盒，不排在其余队列后面等它们排空。 */
  provider: ShutdownStep;
  /** 与 provider 强杀并发的其余关闭。 */
  steps: ShutdownStep[];
  /** 其余关闭之后按序执行的收尾，每步有界。 */
  finalSteps: ShutdownStep[];
  pool: ShutdownStep;
  waits?: ShutdownWaits;
}

/** 返回进程退出码：任一清理失败为 1。 */
export async function runShutdown(options: ShutdownOptions): Promise<number> {
  const waits = options.waits ?? {
    shutdownMs: SHUTDOWN_WAIT_MS,
    closeMs: CLOSE_WAIT_MS,
    poolMs: POOL_WAIT_MS,
  };
  let failed = false;

  // attempt 自己吞掉 rejection 并记录失败，waitClose 只负责截止时间，不留 unhandled rejection。
  const attempt = async (step: ShutdownStep): Promise<boolean> => {
    try {
      await step.close();
      return true;
    } catch (err) {
      failed = true;
      options.logError(step.label, err);
      return false;
    }
  };

  options.abort();
  // 先并发发起所有关闭：知识任务硬超时可达 2h，不能排在沙盒清理前面等它排空。
  const runs = Promise.all(options.workers.map(attempt));
  const others = Promise.all(options.steps.map(attempt));

  const runsClosed = await waitClose(runs, waits.shutdownMs);
  // 沙盒必须等 stop 完（含 pending create 的取消），不能提前 exit 0 留下运行中的容器；
  // 其余队列不排在它后面等它们无界排空。
  const providerClosed = await attempt(options.provider);
  const othersClosed = await waitClose(others, waits.closeMs);

  let finalClosed = true;
  for (const step of options.finalSteps) {
    finalClosed = (await waitClose(attempt(step), waits.closeMs)) && finalClosed;
  }

  // 仍有后台任务在用连接时不能 pool.end：提前关池会打断它正在跑的查询。
  // 超时就直接退出，由进程回收连接。
  if (runsClosed && providerClosed && othersClosed && finalClosed) {
    await waitClose(attempt(options.pool), waits.poolMs);
  }
  return failed ? 1 : 0;
}
