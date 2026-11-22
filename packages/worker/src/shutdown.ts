import { waitClose } from './runs/close-wait.js';

const SHUTDOWN_WAIT_MS = 10_000;
const CLOSE_WAIT_MS = 5_000;
const DATABASE_WAIT_MS = 2_000;

export interface ShutdownStep {
  label: string;
  close: () => Promise<unknown>;
}

interface ShutdownWaits {
  shutdownMs: number;
  closeMs: number;
  databaseMs: number;
}

export interface ShutdownOptions {
  abort: () => void;
  logError: (label: string, err: unknown) => void;
  workers: ShutdownStep[];
  provider: ShutdownStep;
  steps: ShutdownStep[];
  finalSteps: ShutdownStep[];
  database: ShutdownStep;
  waits?: ShutdownWaits;
}

export async function runShutdown(options: ShutdownOptions): Promise<number> {
  const waits = options.waits ?? {
    shutdownMs: SHUTDOWN_WAIT_MS,
    closeMs: CLOSE_WAIT_MS,
    databaseMs: DATABASE_WAIT_MS,
  };
  let failed = false;

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
  const runs = Promise.all(options.workers.map(attempt));
  const others = Promise.all(options.steps.map(attempt));

  const runsClosed = await waitClose(runs, waits.shutdownMs);
  const providerClosed = await attempt(options.provider);
  const othersClosed = await waitClose(others, waits.closeMs);

  let finalClosed = true;
  for (const step of options.finalSteps) {
    finalClosed = (await waitClose(attempt(step), waits.closeMs)) && finalClosed;
  }

  if (runsClosed && providerClosed && othersClosed && finalClosed) {
    await waitClose(attempt(options.database), waits.databaseMs);
  }
  return failed ? 1 : 0;
}
