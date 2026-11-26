import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  chatEventSchema,
  createNdjsonReader,
  type ExecutionSettlement,
  errorText,
  type NdjsonReader as LineReader,
  type SandboxInputCommand,
  SUPERVISOR_CANCEL_GRACE_MS,
  SUPERVISOR_INPUT_MAX_BYTES,
  type SupervisorInput,
  type SupervisorOutput,
  supervisorInputSchema,
} from '@agentport/shared';
import * as Bun from 'bun';

interface SupervisorOptions {
  stdin: Readable;
  stdout: Writable;
  runnerPath?: string;
  graceMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_GRACE_MS = SUPERVISOR_CANCEL_GRACE_MS;
const START_DECISION_MS = 1_000;
const POLL_MS = 50;

interface RunExit {
  code: number | null;
  signal: string | null;
}

interface ActiveRun {
  runId: string;
  proc: Bun.PipedSubprocess;
  started: boolean;
  startSettled: boolean;
  startError?: string;
  cancelling: boolean;
  exited: boolean;
  rootExit: Promise<RunExit>;
  startDecision: Promise<void>;
  pumpDone: Promise<void>;
  finish: Promise<void>;
  outputReader?: NdjsonReader;
  outputError?: string;
  cancelStderr: () => void;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
}

type RejectCode = Extract<SupervisorOutput, { type: 'rejected' }>['code'];
type StartInput = Extract<SupervisorInput, { type: 'start' }>;

interface NdjsonReaderOptions {
  signal?: AbortSignal | undefined;
  onOverflow?: ((maxBytes: number) => void) | undefined;
  cancel?: (() => void) | undefined;
}

class NdjsonReader {
  private readonly lines: string[] = [];
  private readonly parser: LineReader;
  private ended = false;
  private closed = false;
  private waiter: (() => void) | undefined;
  private readonly cancel: (() => void) | undefined;

  constructor(
    input: AsyncIterable<Uint8Array | string>,
    maxBytes: number,
    options: NdjsonReaderOptions = {},
  ) {
    this.cancel = options.cancel;
    this.parser = createNdjsonReader({
      maxBytes,
      onLine: (line) => {
        if (this.closed) return;
        this.lines.push(line);
        this.wake();
      },
      ...(options.onOverflow === undefined
        ? {}
        : {
            onOversize: (limit) => {
              if (!this.closed) options.onOverflow?.(limit);
            },
          }),
    });
    void this.pump(input);
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) this.close();
      else signal.addEventListener('abort', () => this.close(), { once: true });
    }
  }

  private async pump(input: AsyncIterable<Uint8Array | string>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of input) {
        if (this.closed) continue;
        this.parser.push(
          typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }),
        );
      }
      if (!this.closed) this.parser.push(decoder.decode());
    } catch {}
    this.finish();
  }

  async next(): Promise<string | null> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.ended) return null;
      await new Promise<void>((resolveNext) => {
        this.waiter = resolveNext;
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.length = 0;
    this.cancel?.();
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}

class Supervisor {
  private readonly stdout: Writable;
  private readonly runnerPath: string;
  private readonly graceMs: number;
  private readonly reader: NdjsonReader;
  private active: ActiveRun | undefined;

  constructor(options: SupervisorOptions) {
    this.stdout = options.stdout;
    this.runnerPath =
      options.runnerPath ?? Bun.fileURLToPath(new URL('./runner.js', import.meta.url));
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.reader = new NdjsonReader(options.stdin, SUPERVISOR_INPUT_MAX_BYTES, {
      signal: options.signal,
      onOverflow: (maxBytes) => {
        this.reject('', 'INVALID_COMMAND', `input line exceeds ${maxBytes} bytes`);
      },
    });
  }

  async run(): Promise<void> {
    this.emit({ type: 'ready' });
    try {
      for (;;) {
        const line = await this.reader.next();
        if (line === null) break;
        this.handleLine(line);
      }
    } finally {
      await this.shutdownActive();
      this.reader.close();
    }
  }

  private emit(output: SupervisorOutput): void {
    this.stdout.write(`${JSON.stringify(output)}\n`);
  }

  private reject(runId: string, code: RejectCode, message: string): void {
    this.emit({ type: 'rejected', runId, code, message });
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.reject('', 'INVALID_COMMAND', 'input is not valid JSON');
      return;
    }
    const parsed = supervisorInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? 'invalid supervisor input';
      this.reject(runIdOf(raw), 'INVALID_COMMAND', issue);
      return;
    }
    const input = parsed.data;
    if (input.type === 'start') {
      this.start(input);
      return;
    }
    const run = this.active;
    if (run === undefined || run.runId !== input.runId) {
      this.reject(input.runId, 'NOT_ACTIVE', `run ${input.runId} is not active`);
      return;
    }
    if (input.type === 'cancel') {
      this.cancel(run);
      return;
    }
    this.forward(run, input.command);
  }

  private start(input: StartInput): void {
    if (this.active !== undefined) {
      this.reject(input.runId, 'BUSY', `run ${this.active.runId} is still active`);
      return;
    }
    try {
      this.active = this.spawnRun(input);
    } catch (error) {
      this.reject(input.runId, 'SPAWN_FAILED', errorText(error));
    }
  }

  private spawnRun(input: StartInput): ActiveRun {
    const proc = Bun.spawn([process.execPath, this.runnerPath], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...input.env },
    });

    let resolveExit!: (exit: RunExit) => void;
    const rootExit = new Promise<RunExit>((resolveExitPromise) => {
      resolveExit = resolveExitPromise;
    });
    let resolveStart!: () => void;
    const startDecision = new Promise<void>((resolveStartPromise) => {
      resolveStart = resolveStartPromise;
    });
    const output = chunkSource(proc.stdout);
    const errors = chunkSource(proc.stderr);
    const run: ActiveRun = {
      runId: input.runId,
      proc,
      started: false,
      startSettled: false,
      cancelling: false,
      exited: false,
      rootExit,
      startDecision,
      pumpDone: Promise.resolve(),
      finish: Promise.resolve(),
      cancelStderr: errors.cancel,
    };
    const failStart = (error: string): void => {
      if (run.startSettled) return;
      run.startSettled = true;
      run.startError = error;
      resolveStart();
    };
    const acceptStart = (): void => {
      if (run.startSettled) return;
      run.startSettled = true;
      run.started = true;
      this.emit({ type: 'started', runId: run.runId });
      resolveStart();
    };

    run.outputReader = new NdjsonReader(output.chunks, SUPERVISOR_INPUT_MAX_BYTES, {
      onOverflow: () => this.outputOverflow(run),
      cancel: output.cancel,
    });
    const stderrPump = this.pumpStderr(run, errors.chunks);
    const outputPump = this.pump(run, run.outputReader);
    run.pumpDone = Promise.all([outputPump, stderrPump]).then(() => undefined);

    void proc.exited.then((code) => {
      run.exited = true;
      resolveExit({
        code: proc.signalCode === null ? code : null,
        signal: typeof proc.signalCode === 'string' ? proc.signalCode : null,
      });
    });

    void writeLine(proc.stdin, `${JSON.stringify(input.task)}\n`).then(
      () => acceptStart(),
      (error: unknown) => failStart(errorText(error)),
    );

    run.finish = this.finalize(run, failStart);
    return run;
  }

  private async pumpStderr(run: ActiveRun, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of chunks) {
        this.emit({
          type: 'stderr',
          runId: run.runId,
          text: decoder.decode(chunk, { stream: true }),
        });
      }
      const rest = decoder.decode();
      if (rest.length > 0) this.emit({ type: 'stderr', runId: run.runId, text: rest });
    } catch {}
  }

  private async finalize(run: ActiveRun, failStart: (error: string) => void): Promise<void> {
    const exit = await run.rootExit;
    await Promise.race([run.startDecision, Bun.sleep(START_DECISION_MS)]);
    failStart(run.startError ?? 'runner exited before accepting the task');
    if (!run.started) {
      run.outputReader?.close();
      run.cancelStderr();
      if (!run.exited) {
        try {
          run.proc.kill('SIGTERM');
        } catch {}
      }
      await run.pumpDone;
      this.reject(run.runId, 'SPAWN_FAILED', run.startError ?? 'runner failed to start');
      this.clear(run);
      return;
    }

    let settlement = await settleRun(run.proc.pid, this.graceMs, exit);
    const drained = await Promise.race([
      run.pumpDone.then(() => true),
      Bun.sleep(this.graceMs).then(() => false),
    ]);
    if (!drained) {
      run.outputReader?.close();
      run.cancelStderr();
      await run.pumpDone;
      if (settlement.state === 'stopped') {
        settlement = {
          state: 'unconfirmed',
          error: `runner stdio stayed open after ${this.graceMs}ms`,
        };
      }
    }
    if (run.outputError !== undefined) {
      settlement = { state: 'unconfirmed', error: run.outputError };
    }

    if (settlement.state === 'stopped') {
      this.emit({
        type: 'settled',
        runId: run.runId,
        code: settlement.code,
        signal: settlement.signal,
        stopped: true,
      });
    } else {
      this.emit({
        type: 'settled',
        runId: run.runId,
        code: exit.code,
        signal: exit.signal,
        stopped: false,
        error: settlement.error,
      });
    }
    this.clear(run);
  }

  private outputOverflow(run: ActiveRun): void {
    if (run.outputError !== undefined) return;
    run.outputError = `runner output line exceeds ${SUPERVISOR_INPUT_MAX_BYTES} bytes`;
    run.outputReader?.close();
    try {
      run.proc.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      if (!run.exited) signalGroup(run.proc.pid, 'SIGKILL');
    }, this.graceMs).unref();
  }

  private async pump(run: ActiveRun, reader: NdjsonReader): Promise<void> {
    for (;;) {
      const line = await reader.next();
      if (line === null) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.runnerOutputError(run, 'runner emitted non-JSON output');
        continue;
      }
      const parsed = chatEventSchema.safeParse(raw);
      if (!parsed.success) {
        this.runnerOutputError(run, 'runner emitted a non-contract event');
        continue;
      }
      this.emit({ type: 'event', runId: run.runId, event: parsed.data });
    }
  }

  private runnerOutputError(run: ActiveRun, message: string): void {
    this.emit({ type: 'stderr', runId: run.runId, text: `[supervisor] ${message}\n` });
  }

  private cancel(run: ActiveRun): void {
    if (run.cancelling || run.exited) return;
    run.cancelling = true;
    try {
      run.proc.kill('SIGTERM');
    } catch {}
  }

  private forward(run: ActiveRun, command: SandboxInputCommand): void {
    if (run.exited || run.proc.exitCode !== null) {
      this.reject(run.runId, 'NOT_ACTIVE', `run ${run.runId} is no longer accepting input`);
      return;
    }
    void writeLine(run.proc.stdin, `${JSON.stringify(command)}\n`).then(undefined, (error) => {
      this.reject(run.runId, 'NOT_ACTIVE', `failed to forward input: ${errorText(error)}`);
    });
  }

  private async shutdownActive(): Promise<void> {
    const run = this.active;
    if (run === undefined) return;
    if (!run.exited) {
      run.cancelling = true;
      try {
        run.proc.kill('SIGTERM');
      } catch {}
      await Promise.race([run.rootExit, Bun.sleep(this.graceMs)]);
      if (!run.exited) signalGroup(run.proc.pid, 'SIGKILL');
      await run.rootExit;
    }
    await run.finish;
  }

  private clear(run: ActiveRun): void {
    endSink(run.proc.stdin);
    if (this.active === run) this.active = undefined;
  }
}

function runIdOf(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const runId = (raw as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : '';
}

interface ChunkSource {
  chunks: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

function chunkSource(stream: ReadableStream<Uint8Array>): ChunkSource {
  const reader = stream.getReader();
  let released = false;
  return {
    cancel: () => {
      if (released) return;
      void reader.cancel().catch(() => undefined);
    },
    chunks: {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          released = true;
          reader.releaseLock();
        }
      },
    },
  };
}

async function writeLine(sink: Bun.FileSink, text: string): Promise<void> {
  await sink.write(text);
  await sink.flush();
}

function endSink(sink: Bun.FileSink): void {
  try {
    void Promise.resolve(sink.end()).catch(() => undefined);
  } catch {}
}

async function settleRun(
  rootPid: number | undefined,
  graceMs: number,
  exit: RunExit,
): Promise<ExecutionSettlement> {
  if (rootPid === undefined) return { state: 'stopped', code: exit.code, signal: exit.signal };
  let live = liveProcesses(rootPid);
  if (live.length > 0) {
    signalStop(rootPid, live, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
      live = liveProcesses(rootPid);
      if (live.length === 0) break;
    }
  }
  if (live.length === 0) return { state: 'stopped', code: exit.code, signal: exit.signal };
  return {
    state: 'unconfirmed',
    error: `processes still running after ${graceMs}ms: ${live.join(', ')}`,
  };
}

function liveProcesses(rootPid: number): number[] {
  const table = procTable();
  if (table === undefined) {
    // 非 Linux 没有 /proc：只能按独立进程组判断是否还有成员。
    if (rootPid <= 1 || rootPid === process.pid) return [];
    try {
      process.kill(-rootPid, 0);
      return [rootPid];
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM' ? [rootPid] : [];
    }
  }

  const byPid = new Map<number, ProcInfo>();
  for (const info of table) byPid.set(info.pid, info);
  // 只有专用容器里（supervisor 是 PID1 或 PID1 的直接子进程）才能把 PID1 的
  // 其他子进程当作本轮 setsid 后回挂的残留；宿主机/CI 上这样会误杀无关进程。
  const dedicatedContainer = process.pid === 1 || process.ppid === 1;
  const live = new Set<number>();
  for (const info of table) {
    if (info.pid === process.pid || info.pid === 1 || info.state === 'Z') continue;
    if (
      info.pgid === rootPid ||
      descendsFrom(info.pid, rootPid, byPid) ||
      (dedicatedContainer && info.ppid === 1)
    ) {
      live.add(info.pid);
    }
  }
  return [...live].sort((a, b) => a - b);
}

function descendsFrom(pid: number, ancestor: number, byPid: Map<number, ProcInfo>): boolean {
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current !== undefined && !seen.has(current.pid)) {
    if (current.ppid === ancestor) return true;
    if (current.ppid <= 1) return false;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

/** 解析 /proc/<pid>/stat：进程名可能含空格/括号，从最后一个 ')' 之后取字段。 */
function procTable(): ProcInfo[] | undefined {
  if (process.platform !== 'linux') return undefined;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return undefined;
  }
  const table: ProcInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    const end = raw.lastIndexOf(')');
    if (end === -1) continue;
    const fields = raw.slice(end + 2).split(' ');
    const state = fields[0];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (state === undefined || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
    table.push({ pid: Number(entry), ppid, pgid, state });
  }
  return table;
}

function signalStop(rootPid: number, pids: number[], signal: NodeJS.Signals): void {
  signalGroup(rootPid, signal);
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

export function runSupervisor(options: SupervisorOptions): Promise<void> {
  return new Supervisor(options).run();
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === Bun.fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  void runSupervisor({
    stdin: process.stdin,
    stdout: process.stdout,
    signal: controller.signal,
  })
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      process.stderr.write(`[supervisor] ${errorText(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      process.stdin.destroy();
    });
}
