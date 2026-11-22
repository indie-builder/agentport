import { errorText } from '@agentport/shared';
import type { Sandbox, SandboxCreateOptions } from './provider.js';

export const SANDBOX_TASK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

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
  killChildOnDestroy?: boolean;
  logContext: Record<string, unknown>;
  cleanupLog: string;
  lateCleanupLog: string;
}

interface SandboxTaskOutcome<TOutput> {
  started: boolean;
  result: TOutput | undefined;
  exited: string | undefined;
  stderr: string;
}

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
    if (opts.killChildOnDestroy) sandbox.child.kill('SIGKILL');
    await opts.provider.destroy(sandbox).catch((err: unknown) => {
      opts.logger.warn({ err, ...opts.logContext }, opts.cleanupLog);
    });
  };

  let resolveDone: (value: { result?: TOutput; exited?: string }) => void = () => {};
  const done = new Promise<{ result?: TOutput; exited?: string }>((resolve) => {
    resolveDone = resolve;
  });
  let exitReason: string | undefined;
  const finish = (outcome: { result?: TOutput; exited?: string }): void => {
    exitReason = outcome.exited;
    resolveDone(outcome);
  };
  const onClosing = (): void => {
    exitReason = '__closing__';
    createAbort.abort();
    finish({ exited: '__closing__' });
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
    () => finish({ exited: opts.startupMs === undefined ? '__timeout__' : '__startup_timeout__' }),
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
        result: undefined,
        exited: exitReason,
        stderr,
      });
    }
    sandbox = created;
    if (opts.startupMs !== undefined) {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ exited: '__timeout__' }), opts.totalMs);
    }

    const { child } = created;
    let pending = '';
    let outputTooLarge = false;
    const consume = (chunk: string): void => {
      if (outputTooLarge) return;
      if (Buffer.byteLength(pending) + Buffer.byteLength(chunk) > SANDBOX_TASK_OUTPUT_MAX_BYTES) {
        outputTooLarge = true;
        finish({ exited: '__output_too_large__' });
        return;
      }
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const result = opts.parseLine(line);
        if (result) finish({ result });
      }
    };
    const decoder = new TextDecoder();
    const stdoutDone = (async () => {
      for await (const chunk of child.stdout) consume(decoder.decode(chunk, { stream: true }));
      const rest = decoder.decode();
      if (rest !== '') consume(rest);
    })().catch((err) => {
      finish({ exited: errorText(err) });
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
        exited: `退出码 ${String(code)}${child.signalCode === null ? '' : ` (${child.signalCode})`}`,
      });
    });
    const written = child.stdin.write(`${JSON.stringify(opts.payload)}\n`);
    if (written instanceof Promise) void written.catch(() => undefined);

    const outcome = await done;
    if (outcome.exited === '__timeout__' || outcome.exited === '__closing__') {
      createAbort.abort();
    }
    return handlers.complete({
      started: true,
      result: outcome.result,
      exited: outcome.exited,
      stderr,
    });
  } catch (err) {
    return handlers.fail(err, exitReason === '__closing__' || opts.closing?.aborted === true);
  } finally {
    clearTimeout(timer);
    opts.closing?.removeEventListener('abort', onClosing);
    await destroy();
  }
}
