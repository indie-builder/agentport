import { RunFailure } from '@agentport/core';
import {
  type ChatEvent,
  CONFIG_CONTAINER_DIR,
  createNdjsonReader,
  type ExecutionSettlement,
  errorText,
  INPUTS_CONTAINER_DIR,
  MEMORY_CONTAINER_DIR,
  type MemoryPolicy,
  memoryWritable,
  OUTPUTS_CONTAINER_DIR,
  type ResolvedRuntimeEnvironment,
  redactSecrets,
  type SandboxInputCommand,
  type SandboxTaskInput,
  SUBAGENT_MEMORY_CONTAINER_DIR,
  SUPERVISOR_CANCEL_GRACE_MS,
  SUPERVISOR_INPUT_MAX_BYTES,
  type SupervisorInputFrame,
  type SupervisorOutput,
  supervisorOutputSchema,
  USER_CONTAINER_DIR,
} from '@agentport/shared';
import type { Logger } from 'pino';
import type { RuntimeEnvironmentResolver } from '../runtime-environments/resolve.js';
import type { Sandbox, SandboxProvider } from './provider.js';
import { SandboxCleanupError } from './provider.js';

export interface SessionSandboxSpec {
  agentId: string;
  conversationId: string;
  runtimeEnvironmentId: string | null;
  runtimeEnvironmentVersionId?: string | null;
  workspaceDir: string;
  outputsDir: string;
  inputsDir: string;
  memoryDir?: string;
  memoryWritable?: boolean;
  sessionsDir: string;
  personalDir?: string;
  subAgentMemoryDirs?: Array<{ slug: string; memoryDir: string }>;
}

export interface SandboxExecution {
  done: Promise<ExecutionSettlement>;
  send(command: SandboxInputCommand): boolean;
  cancel(): Promise<ExecutionSettlement>;
}

export interface SessionSandboxLease {
  sandboxId: string;
  runtimeEnvironment: ResolvedRuntimeEnvironment;
  start(input: {
    runId: string;
    task: SandboxTaskInput;
    env: Record<string, string>;
    onEvent(event: ChatEvent): void;
    onStderr(text: string): void;
  }): Promise<SandboxExecution>;
  release(input: { reuse: boolean }): Promise<void>;
}

interface SessionSandboxesOptions {
  provider: SandboxProvider;
  idleTimeoutMs: number;
  maxActive: number;
  logger: Logger;
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
}

export const CANCEL_GRACE_MS = SUPERVISOR_CANCEL_GRACE_MS + 2_000;

const IDLE_DESTROY_RETRY_MS = 30_000;

function abortError(): Error {
  const error = new Error('session sandbox acquire aborted');
  error.name = 'AbortError';
  return error;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function cleanupFailure(sandboxId: string, reason: string, cause: unknown): SandboxCleanupError {
  return new SandboxCleanupError(
    sandboxId,
    `session sandbox ${sandboxId} cleanup failed after ${reason}: ${errorText(cause)}`,
    cause,
  );
}

function unconfirmed(error: string): ExecutionSettlement {
  return { state: 'unconfirmed', error };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface LeaseState {
  released: boolean;
  releasing: Promise<void> | null;
}

interface ActiveExecution {
  runId: string;
  started: Deferred<void>;
  startedAcked: boolean;
  done: Deferred<ExecutionSettlement>;
  settlement: ExecutionSettlement | null;
  cancelling: Promise<ExecutionSettlement> | null;
  onEvent(event: ChatEvent): void;
  onStderr(text: string): void;
}

interface SessionEntry {
  conversationId: string;
  agentId: string;
  spec: SessionSandboxSpec;
  sandbox: Sandbox | null;
  runtimeEnvironment: ResolvedRuntimeEnvironment | null;
  currentRunId: string | null;
  leaseHeld: boolean;
  acquirePending: boolean;
  alive: boolean;
  broken: Error | null;
  destroying: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  active: ActiveExecution | null;
  ready: boolean;
  readyWaiter: ReadyWaiter | null;
  lastUsedSeq: number;
}

type SessionPhase =
  | 'creating'
  | 'starting'
  | 'ready-idle'
  | 'leased'
  | 'running'
  | 'destroying'
  | 'broken'
  | 'destroyed';

function sessionPhase(entry: SessionEntry): SessionPhase {
  if (entry.destroying !== null) return 'destroying';
  if (entry.broken !== null) return 'broken';
  if (entry.alive === false) return 'destroyed';
  if (entry.active !== null) return 'running';
  if (entry.sandbox !== null && entry.ready === true) {
    return entry.leaseHeld ? 'leased' : 'ready-idle';
  }
  if (entry.sandbox !== null && entry.ready === false) return 'starting';
  return 'creating';
}

export function memoryMountFor(
  policy: MemoryPolicy,
  memoryDir: string,
): Pick<SessionSandboxSpec, 'memoryDir' | 'memoryWritable'> {
  if (!policy.enabled) return {};
  return { memoryDir, memoryWritable: memoryWritable(policy) };
}

function mountsFor(
  spec: SessionSandboxSpec,
): NonNullable<Parameters<SandboxProvider['create']>[0]['extraMounts']> {
  return [
    { hostPath: spec.outputsDir, containerPath: OUTPUTS_CONTAINER_DIR },
    { hostPath: spec.inputsDir, containerPath: INPUTS_CONTAINER_DIR, readonly: true },
    ...(spec.memoryDir === undefined
      ? []
      : [
          {
            hostPath: spec.memoryDir,
            containerPath: MEMORY_CONTAINER_DIR,
            readonly: spec.memoryWritable !== true,
          },
        ]),
    { hostPath: spec.sessionsDir, containerPath: CONFIG_CONTAINER_DIR },
    ...(spec.personalDir === undefined
      ? []
      : [{ hostPath: spec.personalDir, containerPath: USER_CONTAINER_DIR, readonly: true }]),
    ...(spec.subAgentMemoryDirs ?? []).map((dir) => ({
      hostPath: dir.memoryDir,
      containerPath: `${SUBAGENT_MEMORY_CONTAINER_DIR}/${dir.slug}`,
      readonly: spec.memoryWritable !== true,
    })),
  ];
}

function specMatches(current: SessionSandboxSpec, next: SessionSandboxSpec): boolean {
  const currentMounts = mountsFor(current);
  const nextMounts = mountsFor(next);
  return (
    current.runtimeEnvironmentId === next.runtimeEnvironmentId &&
    current.runtimeEnvironmentVersionId === next.runtimeEnvironmentVersionId &&
    current.workspaceDir === next.workspaceDir &&
    currentMounts.length === nextMounts.length &&
    currentMounts.every((mount, index) => {
      const other = nextMounts[index];
      return (
        mount.hostPath === other?.hostPath &&
        mount.containerPath === other.containerPath &&
        mount.readonly === other.readonly
      );
    })
  );
}

export class SessionSandboxes {
  private readonly provider: SandboxProvider;
  private readonly idleTimeoutMs: number;
  private readonly maxActive: number;
  private readonly logger: Logger;
  private readonly resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closed = new AbortController();
  private useSeq = 0;
  private closePromise: Promise<void> | null = null;

  constructor(options: SessionSandboxesOptions) {
    this.provider = options.provider;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxActive = options.maxActive;
    this.logger = options.logger;
    this.resolveRuntimeEnvironment = options.resolveRuntimeEnvironment;
  }

  acquire(
    spec: SessionSandboxSpec,
    signal: AbortSignal,
    runId: string,
  ): Promise<SessionSandboxLease> {
    const acquiring = this.doAcquire(spec, signal, runId);
    this.pending.add(acquiring);
    void acquiring.then(
      () => this.pending.delete(acquiring),
      () => this.pending.delete(acquiring),
    );
    return acquiring;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed.abort();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async cleanup(conversationId: string, sandboxId: string, expectedRunId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (entry !== undefined && entry.sandbox?.id === sandboxId) {
      const heldByOtherRun =
        entry.currentRunId !== null &&
        entry.currentRunId !== expectedRunId &&
        (entry.leaseHeld || entry.acquirePending || entry.active !== null);
      if (heldByOtherRun) {
        throw new Error(
          `session sandbox ${sandboxId} is held by run ${entry.currentRunId}, not ${expectedRunId}`,
        );
      }
      await this.destroyEntry(entry);
      return;
    }
    await this.provider.destroyById(sandboxId);
  }

  async closeIdle(conversationId: string, sandboxIds: readonly string[]): Promise<void> {
    const ids = [...new Set(sandboxIds)];
    const attempted = new Set<string>();
    const failures: unknown[] = [];
    const entry = this.entries.get(conversationId);

    if (entry !== undefined) {
      if (entry.active !== null || entry.acquirePending) {
        throw new Error(`session sandbox busy: ${conversationId}`);
      }
      if (entry.destroying !== null) {
        const inFlight = entry.destroying;
        const id = entry.sandbox?.id;
        if (id !== undefined) attempted.add(id);
        try {
          await inFlight;
        } catch (err) {
          failures.push(err);
        }
      } else if (entry.leaseHeld && entry.broken === null) {
        throw new Error(`session sandbox busy: ${conversationId}`);
      } else if (entry.sandbox !== null) {
        const sandbox = entry.sandbox;
        if (ids.length === 0 || ids.includes(sandbox.id)) {
          attempted.add(sandbox.id);
          try {
            await this.destroyEntry(entry);
          } catch (err) {
            failures.push(err);
          }
        }
      }
    }

    for (const id of ids) {
      if (attempted.has(id)) continue;
      attempted.add(id);
      try {
        await this.provider.destroyById(id);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `session sandbox close failed: ${conversationId}`);
    }
  }

  private async doAcquire(
    spec: SessionSandboxSpec,
    signal: AbortSignal,
    runId: string,
  ): Promise<SessionSandboxLease> {
    if (this.closed.signal.aborted || signal.aborted) throw abortError();
    const existing = this.entries.get(spec.conversationId);
    if (existing !== undefined) {
      if (existing.agentId !== spec.agentId) {
        throw new Error(
          `conversation ${spec.conversationId} belongs to agent ${existing.agentId}, not ${spec.agentId}`,
        );
      }
      if (existing.active !== null || existing.acquirePending) {
        throw new Error(`session sandbox busy: ${spec.conversationId}`);
      }
      if (existing.broken !== null) {
        existing.leaseHeld = true;
        existing.acquirePending = true;
        existing.currentRunId = runId;
        const sandboxId = existing.sandbox?.id;
        try {
          await this.destroyEntry(existing);
        } catch (err) {
          throw sandboxId === undefined ? err : cleanupFailure(sandboxId, 'broken retry', err);
        } finally {
          existing.acquirePending = false;
        }
        if (this.closed.signal.aborted || signal.aborted) {
          this.removeEntry(existing);
          throw abortError();
        }
        return this.createEntry(spec, signal, runId, existing);
      }
      if (existing.destroying !== null) {
        existing.acquirePending = true;
        existing.currentRunId = runId;
        const sandboxId = existing.sandbox?.id;
        try {
          await existing.destroying;
        } catch (err) {
          throw sandboxId === undefined ? err : cleanupFailure(sandboxId, 'in-flight destroy', err);
        } finally {
          existing.acquirePending = false;
        }
        if (this.closed.signal.aborted || signal.aborted) {
          this.removeEntry(existing);
          throw abortError();
        }
        return this.createEntry(spec, signal, runId, existing);
      }
      if (existing.leaseHeld) {
        throw new Error(`session sandbox busy: ${spec.conversationId}`);
      }

      this.clearIdle(existing);
      existing.leaseHeld = true;
      existing.acquirePending = true;
      existing.currentRunId = runId;
      try {
        if (existing.alive && specMatches(existing.spec, spec)) {
          if (this.closed.signal.aborted || signal.aborted) {
            existing.leaseHeld = false;
            existing.currentRunId = null;
            this.scheduleIdle(existing);
            throw abortError();
          }
          return this.leaseFor(existing);
        }

        if (existing.sandbox !== null) {
          const sandboxId = existing.sandbox.id;
          try {
            await this.destroyEntry(existing);
          } catch (err) {
            throw cleanupFailure(sandboxId, 'replacement', err);
          }
        } else this.removeEntry(existing);
        if (this.closed.signal.aborted || signal.aborted) {
          this.removeEntry(existing);
          throw abortError();
        }
      } finally {
        existing.acquirePending = false;
      }
      return this.createEntry(spec, signal, runId, existing);
    }
    return this.createEntry(spec, signal, runId);
  }

  private async createEntry(
    spec: SessionSandboxSpec,
    signal: AbortSignal,
    runId: string,
    replacing?: SessionEntry,
  ): Promise<SessionSandboxLease> {
    const current = this.entries.get(spec.conversationId);
    if (current !== undefined && current !== replacing) {
      throw new Error(`session sandbox busy: ${spec.conversationId}`);
    }
    const entry: SessionEntry = {
      conversationId: spec.conversationId,
      agentId: spec.agentId,
      spec,
      sandbox: null,
      runtimeEnvironment: null,
      currentRunId: runId,
      leaseHeld: true,
      acquirePending: false,
      alive: true,
      broken: null,
      destroying: null,
      idleTimer: null,
      active: null,
      ready: false,
      readyWaiter: null,
      lastUsedSeq: 0,
    };
    this.entries.set(spec.conversationId, entry);
    const createSignal = AbortSignal.any([signal, this.closed.signal]);

    let runtimeEnvironment: ResolvedRuntimeEnvironment;
    try {
      runtimeEnvironment = await this.resolveRuntimeEnvironment(
        spec.runtimeEnvironmentId,
        spec.runtimeEnvironmentVersionId,
      );
      if (createSignal.aborted) throw abortError();
    } catch (err) {
      this.removeEntry(entry);
      throw err;
    }
    entry.runtimeEnvironment = runtimeEnvironment;

    await this.reclaimForCreate(entry);
    if (createSignal.aborted) {
      this.removeEntry(entry);
      throw abortError();
    }

    let sandbox: Sandbox;
    try {
      sandbox = await this.provider.create({
        image: runtimeEnvironment.imageId,
        workspaceDir: spec.workspaceDir,
        env: {},
        name: `pace-session-${crypto.getRandomValues(new Uint8Array(6)).toHex()}`,
        entrypoint: 'bun',
        command: ['dist/session-supervisor.js'],
        init: true,
        extraMounts: mountsFor(spec),
        signal: createSignal,
      });
    } catch (err) {
      this.removeEntry(entry);
      throw err;
    }

    entry.sandbox = sandbox;
    this.attach(entry);

    if (createSignal.aborted) {
      try {
        await this.destroyEntry(entry);
      } catch (err) {
        throw cleanupFailure(sandbox.id, 'acquire abort', err);
      }
      throw abortError();
    }

    try {
      await this.waitReady(entry, createSignal);
    } catch (err) {
      try {
        await this.destroyEntry(entry);
      } catch (cleanupErr) {
        const reason = err instanceof RunFailure ? err.message : errorText(err);
        throw cleanupFailure(sandbox.id, `ready failure (${reason})`, cleanupErr);
      }
      throw err;
    }
    return this.leaseFor(entry);
  }

  private waitReady(entry: SessionEntry, signal: AbortSignal): Promise<void> {
    if (entry.ready) return Promise.resolve();
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        if (entry.readyWaiter === waiter) entry.readyWaiter = null;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.readyWaiter = waiter;
    });
  }

  private leaseFor(entry: SessionEntry): SessionSandboxLease {
    const state: LeaseState = { released: false, releasing: null };
    const sandboxId = entry.sandbox?.id ?? '';
    const runtimeEnvironment = entry.runtimeEnvironment;
    if (runtimeEnvironment === null) {
      throw new Error(`session sandbox has no runtime environment: ${entry.conversationId}`);
    }
    return {
      sandboxId,
      runtimeEnvironment,
      start: (input) => this.start(entry, state, input),
      release: (input) => {
        state.released = true;
        state.releasing ??= this.release(entry, input.reuse);
        return state.releasing;
      },
    };
  }

  private async start(
    entry: SessionEntry,
    leaseState: LeaseState,
    input: {
      runId: string;
      task: SandboxTaskInput;
      env: Record<string, string>;
      onEvent(event: ChatEvent): void;
      onStderr(text: string): void;
    },
  ): Promise<SandboxExecution> {
    if (leaseState.released) throw new Error('session sandbox lease already released');
    if (this.closed.signal.aborted) throw abortError();
    if (entry.active !== null) throw new Error(`session sandbox busy: ${entry.conversationId}`);
    if (!entry.alive) throw new Error(`session supervisor is not running: ${entry.conversationId}`);
    if (
      entry.sandbox === null ||
      entry.sandbox.child.exitCode !== null ||
      entry.sandbox.child.signalCode !== null
    ) {
      throw new Error(`session supervisor is not writable: ${entry.conversationId}`);
    }

    const execution: ActiveExecution = {
      runId: input.runId,
      started: deferred<void>(),
      startedAcked: false,
      done: deferred<ExecutionSettlement>(),
      settlement: null,
      cancelling: null,
      onEvent: input.onEvent,
      onStderr: input.onStderr,
    };
    entry.active = execution;
    this.write(entry, { type: 'start', runId: input.runId, task: input.task, env: input.env });
    await execution.started.promise;

    return {
      done: execution.done.promise,
      send: (command) => {
        if (entry.active !== execution) return false;
        return this.write(entry, { type: 'input', runId: execution.runId, command });
      },
      cancel: () => this.cancel(entry, execution),
    };
  }

  private cancel(entry: SessionEntry, execution: ActiveExecution): Promise<ExecutionSettlement> {
    if (execution.cancelling !== null) return execution.cancelling;
    execution.cancelling = this.doCancel(entry, execution);
    return execution.cancelling;
  }

  private async doCancel(
    entry: SessionEntry,
    execution: ActiveExecution,
  ): Promise<ExecutionSettlement> {
    if (execution.settlement !== null) return execution.settlement;
    if (entry.active !== execution) return execution.done.promise;

    this.write(entry, { type: 'cancel', runId: execution.runId });
    if (execution.settlement !== null) return execution.settlement;

    const timer = setTimeout(() => {
      this.settle(
        entry,
        execution,
        unconfirmed(`cancel was not confirmed within ${CANCEL_GRACE_MS}ms`),
      );
    }, CANCEL_GRACE_MS);
    timer.unref();
    const settlement = await execution.done.promise;
    clearTimeout(timer);
    return settlement;
  }

  private async release(entry: SessionEntry, reuse: boolean): Promise<void> {
    if (entry.destroying !== null) {
      await entry.destroying;
      return;
    }
    const active = entry.active;
    const hadActive = active !== null;
    if (active !== null) {
      this.settle(entry, active, unconfirmed('lease released before the run settled'));
    }
    if (this.entries.get(entry.conversationId) !== entry) return;

    if (
      !hadActive &&
      reuse &&
      !this.closed.signal.aborted &&
      entry.broken === null &&
      entry.alive &&
      entry.sandbox !== null
    ) {
      entry.leaseHeld = false;
      entry.currentRunId = null;
      this.scheduleIdle(entry);
      return;
    }
    await this.destroyEntry(entry);
  }

  private scheduleIdle(entry: SessionEntry): void {
    if (entry.idleTimer !== null || entry.leaseHeld || this.closed.signal.aborted) return;
    entry.lastUsedSeq = ++this.useSeq;
    const timer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.leaseHeld || this.closed.signal.aborted) return;
      void this.destroyEntry(entry).catch(() => this.scheduleDestroyRetry(entry));
    }, this.idleTimeoutMs);
    timer.unref();
    entry.idleTimer = timer;
  }

  private scheduleDestroyRetry(entry: SessionEntry): void {
    if (this.closed.signal.aborted) return;
    if (this.entries.get(entry.conversationId) !== entry || !entry.alive) return;
    const timer = setTimeout(() => {
      entry.idleTimer = null;
      if (this.closed.signal.aborted || this.entries.get(entry.conversationId) !== entry) return;
      void this.destroyEntry(entry).catch(() => this.scheduleDestroyRetry(entry));
    }, IDLE_DESTROY_RETRY_MS);
    timer.unref();
    entry.idleTimer = timer;
  }

  private async reclaimForCreate(entry: SessionEntry): Promise<void> {
    const live = [...this.entries.values()].filter(
      (item) => item !== entry && item.sandbox !== null,
    );
    if (live.length < this.maxActive) return;
    const victim = live
      .filter((item) => this.reclaimable(item))
      .sort((a, b) => a.lastUsedSeq - b.lastUsedSeq)[0];
    if (victim === undefined) {
      this.logger.warn(
        {
          conversationId: entry.conversationId,
          phase: sessionPhase(entry),
          active: live.length + 1,
          maxActive: this.maxActive,
        },
        'session sandbox active limit exceeded, creating anyway',
      );
      return;
    }
    try {
      await this.destroyEntry(victim);
    } catch {}
  }

  private reclaimable(entry: SessionEntry): boolean {
    return (
      entry.sandbox !== null &&
      entry.alive &&
      !entry.leaseHeld &&
      !entry.acquirePending &&
      entry.active === null &&
      entry.destroying === null &&
      entry.broken === null &&
      !this.closed.signal.aborted
    );
  }

  private clearIdle(entry: SessionEntry): void {
    if (entry.idleTimer === null) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private destroyEntry(entry: SessionEntry): Promise<void> {
    if (entry.destroying !== null) return entry.destroying;
    this.clearIdle(entry);
    entry.leaseHeld = true;
    const destroying = this.performDestroy(entry);
    entry.destroying = destroying;
    void destroying.then(
      () => {
        entry.destroying = null;
      },
      () => {
        entry.destroying = null;
      },
    );
    return destroying;
  }

  private async performDestroy(entry: SessionEntry): Promise<void> {
    if (entry.active !== null) {
      this.settle(
        entry,
        entry.active,
        unconfirmed('session sandbox was destroyed before the run settled'),
      );
    }
    const sandbox = entry.sandbox;
    if (sandbox !== null) {
      try {
        await this.provider.destroy(sandbox);
      } catch (err) {
        const error = toError(err);
        entry.broken = error;
        this.logger.error(
          {
            err,
            conversationId: entry.conversationId,
            phase: sessionPhase(entry),
            sandboxId: sandbox.id,
          },
          'session sandbox cleanup failed',
        );
        throw error;
      }
    }
    entry.alive = false;
    entry.sandbox = null;
    if (!entry.acquirePending) this.removeEntry(entry);
  }

  private removeEntry(entry: SessionEntry): void {
    if (this.entries.get(entry.conversationId) === entry) {
      this.entries.delete(entry.conversationId);
    }
  }

  private attach(entry: SessionEntry): void {
    const sandbox = entry.sandbox;
    if (sandbox === null) return;
    const { child } = sandbox;

    const reader = createNdjsonReader({
      maxBytes: SUPERVISOR_INPUT_MAX_BYTES,
      onLine: (line) => this.onLine(entry, line),
      onOversize: () => {
        this.logger.warn(
          { conversationId: entry.conversationId, phase: sessionPhase(entry) },
          'session supervisor line exceeded the 8MiB cap, dropped',
        );
      },
    });
    const decoder = new TextDecoder();
    const stdoutDone = (async () => {
      for await (const chunk of child.stdout) reader.push(decoder.decode(chunk, { stream: true }));
      const rest = decoder.decode();
      if (rest !== '') reader.push(rest);
    })().catch((err) => {
      this.handleExit(entry, `session supervisor error: ${errorText(err)}`);
    });

    const stderrDecoder = new TextDecoder();
    const stderrDone = (async () => {
      for await (const chunk of child.stderr) {
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text !== '') {
          const active = entry.active;
          if (active !== null) active.onStderr(text);
          else this.logger.debug({ conversationId: entry.conversationId }, redactSecrets(text));
        }
      }
      const rest = stderrDecoder.decode();
      if (rest !== '') {
        const active = entry.active;
        if (active !== null) active.onStderr(rest);
        else this.logger.debug({ conversationId: entry.conversationId }, redactSecrets(rest));
      }
    })().catch(() => undefined);
    void Promise.all([stdoutDone, stderrDone, child.exited]).then(([, , exitCode]) => {
      const code = child.signalCode === null ? exitCode : null;
      this.handleExit(
        entry,
        `session supervisor exited with code ${String(code)}${child.signalCode === null ? '' : ` (${child.signalCode})`}`,
        code,
      );
    });
  }

  private onLine(entry: SessionEntry, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.logger.warn(
        {
          conversationId: entry.conversationId,
          phase: sessionPhase(entry),
          line: redactSecrets(line.slice(0, 500)),
        },
        'session supervisor emitted non-JSON line',
      );
      return;
    }
    const parsed = supervisorOutputSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        {
          conversationId: entry.conversationId,
          phase: sessionPhase(entry),
          line: redactSecrets(line.slice(0, 500)),
        },
        'session supervisor emitted non-contract frame',
      );
      return;
    }
    this.dispatch(entry, parsed.data);
  }

  private dispatch(entry: SessionEntry, output: SupervisorOutput): void {
    switch (output.type) {
      case 'ready': {
        entry.ready = true;
        const waiter = entry.readyWaiter;
        entry.readyWaiter = null;
        waiter?.resolve();
        return;
      }
      case 'started': {
        const active = this.activeFor(entry, output.runId);
        if (active === null || active.startedAcked) return;
        active.startedAcked = true;
        active.started.resolve();
        return;
      }
      case 'event': {
        this.activeFor(entry, output.runId)?.onEvent(output.event);
        return;
      }
      case 'stderr': {
        const active = this.activeFor(entry, output.runId);
        if (active === null) {
          this.logger.debug(
            { conversationId: entry.conversationId, runId: output.runId },
            redactSecrets(output.text),
          );
          return;
        }
        active.onStderr(output.text);
        return;
      }
      case 'settled': {
        const active = this.activeFor(entry, output.runId);
        if (active === null) return;
        if (output.stopped) {
          if (output.error !== undefined) {
            this.logger.warn(
              {
                conversationId: entry.conversationId,
                phase: sessionPhase(entry),
                runId: output.runId,
                error: output.error,
              },
              'session supervisor stopped the run with an error',
            );
          }
          this.settle(entry, active, {
            state: 'stopped',
            code: output.code,
            signal: output.signal,
          });
          return;
        }
        this.settle(
          entry,
          active,
          unconfirmed(
            output.error ?? 'session supervisor could not confirm the run process stopped',
          ),
        );
        return;
      }
      case 'rejected': {
        const active = this.activeFor(entry, output.runId);
        if (active === null) return;
        if (active.startedAcked) {
          this.logger.warn(
            {
              conversationId: entry.conversationId,
              phase: sessionPhase(entry),
              runId: output.runId,
              code: output.code,
              message: output.message,
            },
            'session supervisor rejected a command',
          );
          return;
        }
        const error = Object.assign(new Error(output.message), { code: output.code });
        active.startedAcked = true;
        active.started.reject(error);
        this.settle(entry, active, unconfirmed(output.message));
        return;
      }
    }
  }

  private activeFor(entry: SessionEntry, runId: string): ActiveExecution | null {
    return entry.active?.runId === runId ? entry.active : null;
  }

  private settle(
    entry: SessionEntry,
    execution: ActiveExecution,
    settlement: ExecutionSettlement,
  ): void {
    if (execution.settlement !== null) return;
    execution.settlement = settlement;
    if (!execution.startedAcked) {
      execution.startedAcked = true;
      execution.started.reject(
        new Error(
          settlement.state === 'unconfirmed'
            ? settlement.error
            : 'session supervisor settled before acknowledging the start frame',
        ),
      );
    }
    if (entry.active === execution) entry.active = null;
    execution.done.resolve(settlement);
  }

  private handleExit(entry: SessionEntry, message: string, exitCode: number | null = null): void {
    if (entry.destroying !== null) return;
    entry.alive = false;
    const waiter = entry.readyWaiter;
    entry.readyWaiter = null;
    if (waiter !== null) {
      waiter.reject(
        exitCode === 127
          ? new RunFailure(
              'sandbox',
              `运行环境「${entry.runtimeEnvironment?.environmentName ?? '未知'}」的线上镜像已过期（缺少 bun 或与当前沙盒协议不兼容），平台正在自动重建或请在「运维 → 运行环境」中重建上线`,
            )
          : new Error(message),
      );
    }
    if (entry.active !== null) this.settle(entry, entry.active, unconfirmed(message));
    this.logger.warn({ conversationId: entry.conversationId, phase: sessionPhase(entry) }, message);
    if (!entry.leaseHeld) {
      void this.destroyEntry(entry).catch(() => {});
    }
  }

  private write(entry: SessionEntry, frame: SupervisorInputFrame): boolean {
    const child = entry.sandbox?.child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.logger.warn(
        { conversationId: entry.conversationId, phase: sessionPhase(entry) },
        'session supervisor stdin is not writable',
      );
      return false;
    }
    const written = child.stdin.write(`${JSON.stringify(frame)}\n`);
    if (!written) return false;
    if (written instanceof Promise) {
      void written.catch((err: unknown) => {
        this.logger.warn(
          { err, conversationId: entry.conversationId, phase: sessionPhase(entry) },
          'session supervisor stdin error',
        );
      });
    }
    return true;
  }

  private async finishClose(): Promise<void> {
    for (const entry of this.entries.values()) this.clearIdle(entry);
    await Promise.allSettled([...this.pending]);

    const entries = [...this.entries.values()];
    const ids = entries.map((entry) => entry.sandbox?.id ?? entry.conversationId);
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        if (entry.active !== null) {
          this.settle(entry, entry.active, unconfirmed('worker is shutting down'));
        }
        await this.destroyEntry(entry);
      }),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status !== 'rejected') return [];
      return [
        new Error(`session sandbox cleanup failed: ${ids[index] ?? 'unknown'}`, {
          cause: result.reason,
        }),
      ];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, `session sandbox cleanup failed: ${ids.join(', ')}`);
    }
  }
}
