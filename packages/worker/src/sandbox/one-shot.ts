import { createNdjsonReader, errorText, SUPERVISOR_INPUT_MAX_BYTES } from '@agentport/shared';
import type { Sandbox, SandboxCreateOptions } from './provider.js';

export const SANDBOX_TASK_OUTPUT_MAX_BYTES = SUPERVISOR_INPUT_MAX_BYTES;

interface SandboxTaskLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface SandboxTaskProvider {
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
}

interface SandboxTaskOptions<TOutput> {
  provider: SandboxTaskProvider;
  logger: SandboxTaskLogger;
  closing: AbortSignal | undefined;
  create: SandboxCreateOptions;
  payload: unknown;
  parseLine: (line: string) => TOutput | null;
  startupMs?: number;
  totalMs: number;
  stderrMaxBytes: number;
  stderrKeep: 'head' | 'tail';
  logContext: Record<string, unknown>;
  cleanupLog: string;
  lateCleanupLog: string;
}

type SandboxTaskExit =
  | { kind: 'closing' }
  | { kind: 'startup_timeout' }
  | { kind: 'timeout' }
  | { kind: 'output_too_large' }
  | { kind: 'exited'; detail: string };

type SandboxTaskOutcome<TOutput> =
  | { started: false; exit: SandboxTaskExit; stderr: string }
  | { started: true; result: TOutput; stderr: string }
  | { started: true; result: undefined; exit: SandboxTaskExit; stderr: string };

type DoneState<TOutput> = { kind: 'result'; value: TOutput } | SandboxTaskExit;

interface SandboxTaskHandlers<TOutput, TResult> {
  complete(outcome: SandboxTaskOutcome<TOutput>): TResult;
  fail(error: unknown, closing: boolean): TResult;
}

export async function runSandboxTask<TOutput, TResult>(
  opts: SandboxTaskOptions<TOutput>,
  handlers: SandboxTaskHandlers<TOutput, TResult>,
): Promise<TResult> {
  let sandbox: Sandbox | undefined;
  let abandoned = false;
  let destroyed = false;
  const createAbort = new AbortController();

  const destroy = async (): Promise<void> => {
    if (!sandbox || destroyed) return;
    destroyed = true;
    sandbox.child.kill('SIGKILL');
    await opts.provider.destroy(sandbox).catch((err: unknown) => {
      opts.logger.warn({ err, ...opts.logContext }, opts.cleanupLog);
    });
  };

  let resolveDone: (value: DoneState<TOutput>) => void = () => {};
  const done = new Promise<DoneState<TOutput>>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;
  let lastExit: SandboxTaskExit | undefined;
  const finish = (state: DoneState<TOutput>): void => {
    if (settled) return;
    settled = true;
    if (state.kind !== 'result') lastExit = state;
    resolveDone(state);
  };
  const onClosing = (): void => {
    createAbort.abort();
    finish({ kind: 'closing' });
  };
  if (opts.closing?.aborted) onClosing();
  opts.closing?.addEventListener('abort', onClosing, { once: true });

  let stderr = '';
  const collectStderr = (chunk: string): void => {
    if (opts.stderrKeep === 'head') {
      if (stderr.length < opts.stderrMaxBytes) {
        stderr = (stderr + chunk).slice(0, opts.stderrMaxBytes);
      }
      return;
    }
    stderr = (stderr + chunk).slice(-opts.stderrMaxBytes);
  };

  let timer = setTimeout(
    () => finish({ kind: opts.startupMs === undefined ? 'timeout' : 'startup_timeout' }),
    opts.startupMs ?? opts.totalMs,
  );
  try {
    const creating = opts.provider.create({ ...opts.create, signal: createAbort.signal });
    void creating.then(
      (late) => {
        if (!abandoned) return;
        void opts.provider.destroy(late).catch((err: unknown) => {
          opts.logger.warn({ err, ...opts.logContext, sandboxId: late.id }, opts.lateCleanupLog);
        });
      },
      () => undefined,
    );

    const created = await Promise.race([creating, done.then(() => undefined)]);
    if (!created) {
      abandoned = true;
      createAbort.abort();
      return handlers.complete({
        started: false,
        exit: lastExit ?? { kind: 'exited', detail: 'unknown' },
        stderr,
      });
    }
    sandbox = created;
    if (opts.startupMs !== undefined) {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ kind: 'timeout' }), opts.totalMs);
    }

    const { child } = created;
    let outputTooLarge = false;
    const reader = createNdjsonReader({
      maxBytes: SANDBOX_TASK_OUTPUT_MAX_BYTES,
      onLine: (line) => {
        if (outputTooLarge) return;
        const result = opts.parseLine(line);
        if (result) finish({ kind: 'result', value: result });
      },
      onOversize: () => {
        if (outputTooLarge) return;
        outputTooLarge = true;
        finish({ kind: 'output_too_large' });
      },
    });
    const decoder = new TextDecoder();
    const stdoutDone = (async () => {
      for await (const chunk of child.stdout) reader.push(decoder.decode(chunk, { stream: true }));
      const rest = decoder.decode();
      if (rest !== '') reader.push(rest);
    })().catch((err) => {
      finish({ kind: 'exited', detail: errorText(err) });
    });
    const stderrDecoder = new TextDecoder();
    const stderrDone = (async () => {
      for await (const chunk of child.stderr) {
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text !== '') collectStderr(text);
      }
      const rest = stderrDecoder.decode();
      if (rest !== '') collectStderr(rest);
    })().catch(() => undefined);
    void Promise.all([stdoutDone, stderrDone, child.exited]).then(([, , exitCode]) => {
      const code = child.signalCode === null ? exitCode : null;
      finish({
        kind: 'exited',
        detail: `退出码 ${String(code)}${child.signalCode === null ? '' : ` (${child.signalCode})`}`,
      });
    });
    const written = child.stdin.write(`${JSON.stringify(opts.payload)}\n`);
    if (written instanceof Promise) void written.catch(() => undefined);

    const outcome = await done;
    if (outcome.kind === 'timeout' || outcome.kind === 'closing') {
      createAbort.abort();
    }
    if (outcome.kind === 'result') {
      return handlers.complete({
        started: true,
        result: outcome.value,
        stderr,
      });
    }
    return handlers.complete({
      started: true,
      result: undefined,
      exit: outcome,
      stderr,
    });
  } catch (err) {
    return handlers.fail(err, lastExit?.kind === 'closing' || opts.closing?.aborted === true);
  } finally {
    clearTimeout(timer);
    opts.closing?.removeEventListener('abort', onClosing);
    await destroy();
  }
}
