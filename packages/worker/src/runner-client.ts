import { RunFailure } from '@agentport/core';
import { type ChatEvent, chatEventSchema } from '@agentport/shared';
import { Deferred, Effect, Exit, type Scope } from 'effect';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { redactSecrets } from './redact.js';
import type { Sandbox, SandboxProvider } from './sandbox/provider.js';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface SandboxRunInput {
  runId: string;
  timeoutMs: number;
  /** 原样发给 runner 的任务对象（prompt + 模型 + 限额）。 */
  task: {
    prompt: string;
    /** 已格式化的历史对话；runner 拼在 prompt 之前。 */
    history?: string;
    model: string;
    maxTurns: number;
    maxBudgetUsd: number;
    /** SDK 权限模式；缺省由 runner 回落到 dontAsk。 */
    permissionMode?: string;
    /** 绑定到工作区的 MCP server 名，runner 用它生成精确 allow 规则 */
    mcpServers: string[];
    extraAllowedTools?: string[];
    extraDisallowedTools?: string[];
    effort?: string;
    maxThinkingTokens?: number;
  };
  workspaceDir: string;
  image: string;
  /** 注入容器的凭证等；不会落到工作区文件。 */
  env: Record<string, string>;
  provider: SandboxProvider;
  logger: Logger;
}

/** 可重试 = 基础设施瞬时故障；业务失败不重试。分类来自 RunFailure，不再匹配错误文本。 */
export function isRetryable(outcome: SandboxRunOutcome): boolean {
  return outcome.failure?.reason === 'infra';
}

export interface SandboxRunOutcome {
  status: RunStatus;
  sandboxId: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** 失败分类；只有 infra 会交给 BullMQ 重试。 */
  failure?: RunFailure;
  /** 本次 run 产生的完整事件，供调用方落库。 */
  events: ChatEvent[];
}

/** SIGTERM 后留一点时间让 runner 收尾，否则强杀。 */
const KILL_GRACE_MS = 5_000;

interface Killable {
  kill(signal: NodeJS.Signals): unknown;
}

/** 先 SIGTERM，宽限期后仍活着就 SIGKILL；超时与取消共用。 */
export function escalateKill(child: Killable, delayMs: number = KILL_GRACE_MS): void {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), delayMs).unref();
}

/** 单行 NDJSON 上限；超过即丢弃，避免一行把内存吃穿。 */
const MAX_LINE_BYTES = 1024 * 1024;
/** 单 run 收集上限：超出后只保留终态，不再转发事件。 */
const MAX_EVENTS = 2_000;
const MAX_EVENT_BYTES = 32 * 1024 * 1024;

let redisUrl = 'redis://localhost:6379';

/** 由 worker 入口在启动时注入校验过的 REDIS_URL。 */
export function configureRunnerClient(url: string): void {
  redisUrl = url;
}

/** 事件流键；与 API 的 producer 保持一致。 */
function streamKey(runId: string): string {
  return `run:${runId}:events`;
}

/** 取消信号通道；与 API 的 producer 保持一致。 */
function channelFor(runId: string): string {
  return `run:${runId}:cancel`;
}

let publisher: Redis | undefined;
let cancelSubscriber: Redis | undefined;

function getPublisher(logger: Logger): Redis {
  if (!publisher) {
    publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
    publisher.on('error', (err) => logger.warn({ err }, 'redis error'));
  }
  return publisher;
}

/** 与 API 的订阅共用同一频道；这里只关心 cancel 消息。 */
function getCancelSubscriber(logger: Logger): Redis {
  if (!cancelSubscriber) {
    cancelSubscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
    cancelSubscriber.on('error', (err) => logger.warn({ err }, 'redis error'));
  }
  return cancelSubscriber;
}

/**
 * 事件写 Redis Stream（与 API 的订阅端一致），可从流头回放；
 * 写完后用 pub/sub 唤醒正在 XRANGE 等待的订阅者。
 */
export async function publishRun(runId: string, event: ChatEvent, logger: Logger): Promise<void> {
  const redis = getPublisher(logger);
  const key = streamKey(runId);
  await redis.xadd(key, 'MAXLEN', '~', 1000, '*', 'payload', JSON.stringify(event));
  await redis.expire(key, 3600);
  await redis.publish(`${key}:wake`, '1');
}

export async function closeRunnerClient(): Promise<void> {
  const closing = [publisher, cancelSubscriber] as const;
  publisher = undefined;
  cancelSubscriber = undefined;
  await Promise.allSettled([closing[0]?.quit(), closing[1]?.quit()]);
}

/** 容器 stdout 每行一个 ChatEvent；非法行只记日志，不中断 run。 */
function parseLine(line: string, logger: Logger): ChatEvent | null {
  const excerpt = redactSecrets(line.slice(0, 500));
  try {
    const parsed = chatEventSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      logger.warn({ line: excerpt }, 'sandbox emitted non-contract event');
      return null;
    }
    return parsed.data;
  } catch {
    logger.warn({ line: excerpt }, 'sandbox emitted non-JSON line');
    return null;
  }
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 子进程错误里只有这些是基础设施问题；其余算沙盒自身失败。 */
const INFRA_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Cannot connect to the Docker daemon|no such image|pull access denied/i;

function reasonFor(error: string): RunFailure['reason'] {
  return INFRA_RE.test(error) ? 'infra' : 'sandbox';
}

interface ExitSignal {
  kind: 'closed' | 'error';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/**
 * 启动一次沙盒 run：转发事件、处理超时与取消，返回用于落库的终态。
 * 终态 run_finished 由调用方统一发布一次，避免与 runner 输出重复。
 *
 * 取消、超时、进程退出三者用 race 表达，谁先到谁赢；容器销毁由 Scope 保证。
 */
export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunOutcome> {
  return Effect.runPromise(Effect.scoped(runInSandboxEffect(input)));
}

function runInSandboxEffect(
  input: SandboxRunInput,
): Effect.Effect<SandboxRunOutcome, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { logger, runId } = input;
    const events: ChatEvent[] = [];
    let reportedStatus: RunStatus | undefined;
    let reportedCost: number | undefined;
    let reportedTurns: number | undefined;
    let reportedError: string | undefined;
    let reportedSessionId: string | undefined;
    let reportedInput: number | undefined;
    let reportedOutput: number | undefined;
    let stderrTail = '';
    let eventBytes = 0;
    let overflowed = false;
    let child: Sandbox['child'] | undefined;
    let abandoning = false;

    // 同一连接上的命令按序排队；不 await 也能保证事件顺序。
    const publish = (event: ChatEvent): void => {
      void publishRun(runId, event, logger).catch((err: unknown) => {
        logger.warn({ err, runId }, 'publish failed');
      });
    };

    const onEvent = (line: string): void => {
      const event = parseLine(line, logger);
      if (!event) return;

      if (event.type === 'run_finished') {
        // 只记下终态，由调用方统一发布，保证每个 run 恰好一条。
        reportedStatus = event.status;
        reportedCost = event.costUsd;
        reportedTurns = event.turns;
        reportedError = event.error === undefined ? undefined : redactSecrets(event.error);
        reportedSessionId = event.sessionId;
        reportedInput = event.inputTokens;
        reportedOutput = event.outputTokens;
        return;
      }
      if (overflowed) return;

      eventBytes += Buffer.byteLength(line);
      if (events.length >= MAX_EVENTS || eventBytes > MAX_EVENT_BYTES) {
        overflowed = true;
        logger.warn(
          { runId, events: events.length, eventBytes },
          'sandbox event stream overflowed',
        );
        events.push({ type: 'error', message: '输出超出上限' });
        publish({ type: 'error', message: '输出超出上限' });
        return;
      }
      events.push(event);
      publish(event);
    };

    const exitSignal = yield* Deferred.make<ExitSignal>();
    const cancelled = yield* Deferred.make<void>();

    // 先订阅再建容器：服务启动期间的取消不能漏。
    const unsubscribe = yield* Effect.acquireRelease(
      subscribeCancel(runId, logger, () => {
        logger.info({ runId }, 'cancel requested');
        Deferred.doneUnsafe(cancelled, Exit.succeed(undefined));
      }),
      (release) => Effect.promise(release),
    );

    const attach = (sandbox: Sandbox): void => {
      if (abandoning) {
        // 取消先到，容器才创建完成：直接扔掉，不让它泄漏。
        void input.provider.destroy(sandbox).catch(() => undefined);
        return;
      }
      const proc = sandbox.child;
      child = proc;

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
        for (const line of chunk.split('\n')) {
          if (line.trim().length > 0) {
            logger.debug({ runId, sandbox: sandbox.id }, redactSecrets(line));
          }
        }
      });
      proc.stdin.on('error', (err) => logger.warn({ err, runId }, 'sandbox stdin closed'));

      const done = (signal: ExitSignal): void => {
        Deferred.doneUnsafe(exitSignal, Exit.succeed(signal));
      };
      proc.once('close', (code, signal) => done({ kind: 'closed', code, signal }));
      proc.once('error', (err) =>
        done({ kind: 'error', code: null, signal: null, error: toError(err) }),
      );

      // 手写行切分而不是 readline：超长行直接丢弃，不把它整行留在内存里。
      let pending = '';
      let discarding = false;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf('\n', start);
          if (newline === -1) {
            if (!discarding) {
              pending += chunk.slice(start);
              if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
                discarding = true;
                pending = '';
                logger.warn({ runId }, 'sandbox event line exceeded 1MiB, dropped');
              }
            }
            return;
          }
          const piece = chunk.slice(start, newline);
          start = newline + 1;
          if (discarding) {
            // 丢弃行的结尾；后续行恢复正常处理。
            discarding = false;
            pending = '';
            continue;
          }
          const line = pending + piece;
          pending = '';
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            logger.warn({ runId }, 'sandbox event line exceeded 1MiB, dropped');
            continue;
          }
          if (line.trim().length > 0) onEvent(line);
        }
      });

      proc.stdin.write(`${JSON.stringify(input.task)}\n`);
    };

    // 容器创建与取消竞争；创建期间收到取消也要立刻放弃。
    const created = yield* Effect.result(
      Effect.raceAll([
        Effect.tryPromise({
          try: () =>
            input.provider.create({
              image: input.image,
              workspaceDir: input.workspaceDir,
              env: input.env,
              name: `agentport-${runId.toLowerCase()}`,
            }),
          catch: (err) => err,
        }).pipe(Effect.map((sandbox) => ({ sandbox }))),
        Deferred.await(cancelled).pipe(
          Effect.map(() => {
            abandoning = true;
            return {};
          }),
        ),
      ]),
    );

    if (created._tag === 'Failure') {
      const error = `sandbox create failed: ${toError(created.failure)}`;
      logger.error({ err: created.failure, runId }, error);
      return {
        status: 'failed',
        sandboxId: '',
        error,
        failure: new RunFailure('infra', error),
        events,
      };
    }
    if (!('sandbox' in created.success)) {
      return { status: 'cancelled', sandboxId: '', events };
    }

    const sandbox = created.success.sandbox;
    yield* Effect.acquireRelease(Effect.succeed(sandbox), (s) =>
      Effect.promise(() =>
        input.provider.destroy(s).catch((err: unknown) => {
          logger.warn({ err, runId }, 'sandbox cleanup failed');
        }),
      ),
    );
    attach(sandbox);

    // 谁先到谁赢：正常退出 / 用户取消 / 超时。
    const stopped = yield* Effect.raceAll([
      Deferred.await(exitSignal).pipe(Effect.map((s) => ({ kind: s.kind, signal: s }))),
      Deferred.await(cancelled).pipe(Effect.map(() => ({ kind: 'cancelled' as const }))),
      Effect.sleep(input.timeoutMs).pipe(Effect.map(() => ({ kind: 'timeout' as const }))),
    ]);

    if (stopped.kind === 'cancelled') {
      logger.info({ runId }, 'sandbox run cancelled');
      if (child) escalateKill(child);
      yield* Effect.promise(() => unsubscribe());
      return {
        status: 'cancelled',
        sandboxId: sandbox.id,
        events,
        failure: new RunFailure('cancelled', 'cancelled'),
      };
    }
    if (stopped.kind === 'timeout') {
      logger.warn({ runId, timeoutMs: input.timeoutMs }, 'sandbox timed out');
      if (child) escalateKill(child);
      yield* Effect.promise(() => unsubscribe());
      const error = `sandbox timed out after ${input.timeoutMs}ms`;
      return {
        status: 'timeout',
        sandboxId: sandbox.id,
        error,
        failure: new RunFailure('timeout', error),
        events,
      };
    }

    yield* Effect.promise(() => unsubscribe());

    const budget = {
      ...(reportedCost === undefined ? {} : { costUsd: reportedCost }),
      ...(reportedTurns === undefined ? {} : { turns: reportedTurns }),
      ...(reportedSessionId === undefined ? {} : { sessionId: reportedSessionId }),
      ...(reportedInput === undefined ? {} : { inputTokens: reportedInput }),
      ...(reportedOutput === undefined ? {} : { outputTokens: reportedOutput }),
    };

    if (stopped.signal.kind === 'error') {
      const error = stopped.signal.error ?? 'sandbox process error';
      logger.error({ runId, error }, 'sandbox process error');
      return {
        status: 'failed',
        sandboxId: sandbox.id,
        error,
        failure: new RunFailure(reasonFor(error), error),
        events,
      };
    }

    if (reportedStatus === undefined) {
      const suffix = redactSecrets(stderrTail.trim());
      const detail =
        stopped.signal.code === 0
          ? 'sandbox exited without run_finished'
          : `sandbox exited with code ${String(stopped.signal.code)}${stopped.signal.signal ? ` (${stopped.signal.signal})` : ''}`;
      const error = suffix ? `${detail}: ${suffix}` : detail;
      return {
        status: 'failed',
        sandboxId: sandbox.id,
        error,
        failure: new RunFailure(reasonFor(error), error),
        events,
      };
    }
    return {
      status: reportedStatus,
      sandboxId: sandbox.id,
      events,
      ...budget,
      ...(reportedError === undefined ? {} : { error: reportedError }),
    };
  });
}

/**
 * 订阅取消频道。Effect.callback 的 AbortSignal 保证：即使 subscribe 还没返回就被中断，
 * 监听器也会解绑，不会有残留的 redis 订阅。
 */
function subscribeCancel(
  runId: string,
  logger: Logger,
  onCancel: () => void,
): Effect.Effect<() => Promise<void>> {
  return Effect.callback((resume, signal) => {
    const redis = getCancelSubscriber(logger);
    const channel = channelFor(runId);
    // API 在 cancel 频道上只发 '1'；订阅成立后先查一次键，避免漏掉早到的取消。
    const handler = (received: string): void => {
      if (received === channel) onCancel();
    };
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      redis.off('message', handler);
      await redis.unsubscribe(channel).catch((err: unknown) => {
        logger.warn({ err, runId }, 'cancel unsubscribe failed');
      });
    };
    signal.addEventListener('abort', () => void release());

    void (async () => {
      try {
        if ((await redis.exists(channel)) === 1) onCancel();
        redis.on('message', handler);
        await redis.subscribe(channel);
      } catch (err) {
        logger.warn({ err, runId }, 'cancel subscription failed');
      }
      if (!signal.aborted) resume(Effect.succeed(release));
    })();
  });
}
