import { randomBytes } from 'node:crypto';
import {
  type ChatEvent,
  type ExecutionSettlement,
  type ResolvedRuntimeEnvironment,
  type SandboxInputCommand,
  type SandboxTaskInput,
  SUPERVISOR_INPUT_MAX_BYTES,
  type SupervisorInputFrame,
  type SupervisorOutput,
  supervisorOutputSchema,
} from '@agentport/shared';
import type { Logger } from 'pino';
import { redactSecrets } from '../redact.js';
import type { RuntimeEnvironmentResolver } from '../runtime-environments/resolve.js';
import type { Sandbox, SandboxProvider } from './provider.js';
import { SandboxCleanupError } from './provider.js';

/**
 * 会话沙盒：同一 platform conversation 复用同一个常驻 supervisor 容器。
 * 容器创建用旧的一次性 provider 接口，长驻 supervisor 再由 stdin 接收每轮任务；
 * 每轮凭证只走 start 帧，不进入容器创建环境。
 */
export interface SessionSandboxSpec {
  agentId: string;
  conversationId: string;
  /** null 表示平台默认环境；只在新建容器时解析线上版本。 */
  runtimeEnvironmentId: string | null;
  /** 以下目录都是宿主 daemon 视角的绝对路径。 */
  workspaceDir: string;
  outputsDir: string;
  inputsDir: string;
  memoryDir: string;
  sessionsDir: string;
  /** 个人记忆目录，只读挂载到 /mnt/user；未接入时省略。 */
  personalDir?: string;
  /**
   * 子智能体项目记忆宿主目录，按 slug 排序后逐个 rw 挂载到
   * `/workspace/.claude/agent-memory/<slug>`；缺省表示本次没有子智能体记忆。
   */
  subAgentMemoryDirs?: Array<{ slug: string; memoryDir: string }>;
}

export interface SandboxExecution {
  done: Promise<ExecutionSettlement>;
  send(command: SandboxInputCommand): void;
  cancel(): Promise<ExecutionSettlement>;
}

export interface SessionSandboxLease {
  sandboxId: string;
  /** 该容器实际创建时的环境身份；复用旧容器时仍是旧版本，不读当前线上。 */
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

export interface SessionSandboxesOptions {
  provider: SandboxProvider;
  idleTimeoutMs: number;
  logger: Logger;
  /** 只在真实创建容器时调用；复用存活容器不读线上版本。 */
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
}

const CONFIG_DIR = '/home/node/.claude';
const OUTPUTS_DIR = '/mnt/outputs';
const INPUTS_DIR = '/mnt/inputs';
const MEMORY_DIR = '/mnt/agent-memory';
const USER_DIR = '/mnt/user';
/** 子智能体 project 记忆的容器内根；每个 slug 是独立 rw bind mount。 */
const SUBAGENT_MEMORY_DIR = '/workspace/.claude/agent-memory';
/** 取消 ACK 等待上限；超时返回 unconfirmed，由调用方 release(false) 销毁容器。 */
const CANCEL_GRACE_MS = 5_000;

function abortError(): Error {
  const error = new Error('session sandbox acquire aborted');
  error.name = 'AbortError';
  return error;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  reject(error: Error): void;
}

interface LeaseState {
  released: boolean;
  /** 第一次 release 的结果；重复调用必须拿到同一个 Promise，不能冒充已停稳。 */
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
  /** 容器实际创建时解析出的环境身份；存活期间不随线上版本变化。 */
  runtimeEnvironment: ResolvedRuntimeEnvironment | null;
  /** 容器当前归属的 run；空闲或销毁中为 null。cleanup 据此拒绝别的 run 的清理。 */
  currentRunId: string | null;
  leaseHeld: boolean;
  /** 已有 acquire 占用这次 entry（销毁收口期间也保留占位），第二个请求按 busy 拒绝。 */
  acquirePending: boolean;
  alive: boolean;
  broken: Error | null;
  destroying: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  active: ActiveExecution | null;
  ready: boolean;
  readyWaiter: ReadyWaiter | null;
}

function specMatches(current: SessionSandboxSpec, next: SessionSandboxSpec): boolean {
  const currentSubAgents = current.subAgentMemoryDirs ?? [];
  const nextSubAgents = next.subAgentMemoryDirs ?? [];
  return (
    // 只比绑定身份，不比对线上解析结果：发布/回退不能替换存活容器。
    current.runtimeEnvironmentId === next.runtimeEnvironmentId &&
    current.workspaceDir === next.workspaceDir &&
    current.outputsDir === next.outputsDir &&
    current.inputsDir === next.inputsDir &&
    current.memoryDir === next.memoryDir &&
    current.sessionsDir === next.sessionsDir &&
    current.personalDir === next.personalDir &&
    // 绑定启停或宿主目录变化都要换容器：运行中的 bind mount 不能热替换。
    currentSubAgents.length === nextSubAgents.length &&
    currentSubAgents.every(
      (dir, index) =>
        dir.slug === nextSubAgents[index]?.slug &&
        dir.memoryDir === nextSubAgents[index]?.memoryDir,
    )
  );
}

export class SessionSandboxes {
  private readonly provider: SandboxProvider;
  private readonly idleTimeoutMs: number;
  private readonly logger: Logger;
  private readonly resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
  private readonly entries = new Map<string, SessionEntry>();
  /** 创建/重建中的 acquire；close 必须等它们按取消语义收尾。 */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closed = new AbortController();
  private closePromise: Promise<void> | null = null;

  constructor(options: SessionSandboxesOptions) {
    this.provider = options.provider;
    this.idleTimeoutMs = options.idleTimeoutMs;
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

  /**
   * 重启/替换后的显式清理入口。release(false) 会缓存第一次失败的 Promise，不能用来重试；
   * 同 ID 的条目复用既有 destroy 收口（并发调用合并）。同一容器被别的 run 持有时直接拒绝，
   * 不能退化成按 ID 删除而误杀当前容器；没有条目或条目已换成新容器时才按 ID 删除旧容器。
   */
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
        // 上次清理失败时旧容器可能还在，宿主目录仍归它所有；下一次 acquire 独占重试一轮销毁，
        // 成功后才在同一批目录上重建。失败继续拒绝，broken 保留给 close 重试。
        existing.leaseHeld = true;
        existing.acquirePending = true;
        existing.currentRunId = runId;
        // 等待前记下 id：重试仍失败时必须带出可继续清理的容器。
        const sandboxId = existing.sandbox?.id;
        try {
          await this.destroyEntry(existing);
        } catch (err) {
          throw sandboxId === undefined ? err : cleanupFailure(sandboxId, 'broken retry', err);
        } finally {
          existing.acquirePending = false;
        }
        if (this.closed.signal.aborted || signal.aborted) {
          // 已确认删除但不重建：移除占位，别让后续 acquire 卡在空壳上。
          this.removeEntry(existing);
          throw abortError();
        }
        return this.createEntry(spec, signal, runId, existing);
      }
      if (existing.destroying !== null) {
        // 空闲回收已经结束到“容器被删除”时才允许重取；等 destroy 收口，
        // 不能把销毁中的短暂窗口报成 busy，也不能抢在删除前建新容器。
        existing.acquirePending = true;
        existing.currentRunId = runId;
        // 等待前记下 id：销毁失败时同样要带出容器，不能只报普通错误。
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

        // 镜像/挂载变了就必须换容器：运行中的 bind mount 不能热替换。
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
    // 旧条目让出后并发 acquire 可能已经先建成；不能覆盖，否则它的容器会失去跟踪。
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
    };
    this.entries.set(spec.conversationId, entry);
    const createSignal = AbortSignal.any([signal, this.closed.signal]);

    let runtimeEnvironment: ResolvedRuntimeEnvironment;
    try {
      // 只有真正新建容器才读线上版本；复用路径不经过这里。
      runtimeEnvironment = await this.resolveRuntimeEnvironment(spec.runtimeEnvironmentId);
      if (createSignal.aborted) throw abortError();
    } catch (err) {
      this.removeEntry(entry);
      throw err;
    }
    entry.runtimeEnvironment = runtimeEnvironment;

    let sandbox: Sandbox;
    try {
      sandbox = await this.provider.create({
        image: runtimeEnvironment.imageId,
        workspaceDir: spec.workspaceDir,
        // 创建环境不含任何 run 凭证；每轮凭证由 start 帧带入 supervisor。
        env: {},
        name: `pace-session-${randomBytes(6).toString('hex')}`,
        entrypoint: 'node',
        command: ['dist/session-supervisor.js'],
        init: true,
        extraMounts: [
          { hostPath: spec.outputsDir, containerPath: OUTPUTS_DIR },
          { hostPath: spec.inputsDir, containerPath: INPUTS_DIR, readonly: true },
          { hostPath: spec.memoryDir, containerPath: MEMORY_DIR },
          { hostPath: spec.sessionsDir, containerPath: CONFIG_DIR },
          ...(spec.personalDir === undefined
            ? []
            : [{ hostPath: spec.personalDir, containerPath: USER_DIR, readonly: true }]),
          // 子智能体 project 记忆：唯一宿主直接 rw 挂载，不回写、不经过 /workspace 只读根。
          ...(spec.subAgentMemoryDirs ?? []).map((dir) => ({
            hostPath: dir.memoryDir,
            containerPath: `${SUBAGENT_MEMORY_DIR}/${dir.slug}`,
          })),
        ],
        signal: createSignal,
      });
    } catch (err) {
      this.removeEntry(entry);
      throw err;
    }

    entry.sandbox = sandbox;
    this.attach(entry);

    if (createSignal.aborted) {
      // provider 可能忽略了取消并迟到返回；所有权已在这里，必须销毁。
      try {
        await this.destroyEntry(entry);
      } catch (err) {
        // 清理失败保留 broken 跟踪；本次创建留下残留容器，必须带出 id 交给上层继续清理。
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
        // 同上：销毁失败不能吞，带出容器 id，close/reconcile 还能按 id 重试。
        throw cleanupFailure(sandbox.id, `ready failure (${errorText(err)})`, cleanupErr);
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
        // 第一次调用的 reuse 决定后续路径；重复调用只复用同一个结果。
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
    if (entry.sandbox === null || entry.sandbox.child.stdin.destroyed) {
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
        if (entry.active !== execution) return;
        this.write(entry, { type: 'input', runId: execution.runId, command });
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
    const timer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.leaseHeld || this.closed.signal.aborted) return;
      void this.destroyEntry(entry).catch(() => {
        // performDestroy 已记录并保留 broken 跟踪，close 会重试并聚合报告。
      });
    }, this.idleTimeoutMs);
    timer.unref();
    entry.idleTimer = timer;
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
          { err, conversationId: entry.conversationId, sandboxId: sandbox.id },
          'session sandbox cleanup failed',
        );
        throw error;
      }
    }
    entry.alive = false;
    entry.sandbox = null;
    // acquire 正持有该条目准备同步替换时保留占位，避免并发 acquire 在删除与重建之间看到空档。
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

    // 手写行切分：超长行丢弃而不是整行留在内存里。
    let pending = '';
    let discarding = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start);
        if (newline === -1) {
          if (!discarding) {
            pending += chunk.slice(start);
            if (Buffer.byteLength(pending) > SUPERVISOR_INPUT_MAX_BYTES) {
              discarding = true;
              pending = '';
              this.logger.warn(
                { conversationId: entry.conversationId },
                'session supervisor line exceeded the 8MiB cap, dropped',
              );
            }
          }
          return;
        }
        const piece = chunk.slice(start, newline);
        start = newline + 1;
        if (discarding) {
          discarding = false;
          pending = '';
          continue;
        }
        const line = pending + piece;
        pending = '';
        if (Buffer.byteLength(line) > SUPERVISOR_INPUT_MAX_BYTES) {
          this.logger.warn(
            { conversationId: entry.conversationId },
            'session supervisor line exceeded the 8MiB cap, dropped',
          );
          continue;
        }
        if (line.trim().length > 0) this.onLine(entry, line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const active = entry.active;
      if (active !== null) active.onStderr(chunk);
      else this.logger.debug({ conversationId: entry.conversationId }, redactSecrets(chunk));
    });
    child.stdin.on('error', (err) => {
      this.logger.warn(
        { err, conversationId: entry.conversationId },
        'session supervisor stdin error',
      );
    });
    child.once('error', (err) => {
      this.handleExit(entry, `session supervisor error: ${errorText(err)}`);
    });
    child.once('close', (code, signal) => {
      this.handleExit(
        entry,
        `session supervisor exited with code ${String(code)}${signal === null ? '' : ` (${signal})`}`,
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
        // 控制帧不进 SSE；event 也只交给当前 run 的回调。
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
              { conversationId: entry.conversationId, runId: output.runId, error: output.error },
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

  private handleExit(entry: SessionEntry, message: string): void {
    if (entry.destroying !== null) return;
    entry.alive = false;
    const waiter = entry.readyWaiter;
    entry.readyWaiter = null;
    waiter?.reject(new Error(message));
    if (entry.active !== null) this.settle(entry, entry.active, unconfirmed(message));
    this.logger.warn({ conversationId: entry.conversationId }, message);
    // 客户端进程退出不能证明 daemon 已删除容器；leash 仍被持有时由 owner 销毁，
    // 空闲时也必须走 destroyEntry。失败保留 broken，close 会重试并报告。
    if (!entry.leaseHeld) {
      void this.destroyEntry(entry).catch(() => {
        // performDestroy 已记录并设置 broken；这里只避免 unhandled rejection。
      });
    }
  }

  private write(entry: SessionEntry, frame: SupervisorInputFrame): void {
    const child = entry.sandbox?.child;
    if (child === undefined || child.stdin.destroyed) {
      this.logger.warn(
        { conversationId: entry.conversationId },
        'session supervisor stdin is not writable',
      );
      return;
    }
    child.stdin.write(`${JSON.stringify(frame)}\n`);
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
