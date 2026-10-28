import { isRetryableFailure, RunFailure } from '@agentport/core';
import {
  type ChatEvent,
  chatEventSchema,
  RUN_STREAM_MAXLEN,
  runCancelKey,
  runStreamKey,
  type SandboxTaskInput,
} from '@agentport/shared';
import { Deferred, Effect, Exit, type Scope } from 'effect';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { redactSecrets } from './redact.js';
import type { Sandbox, SandboxProvider } from './sandbox/provider.js';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface SandboxRunInput {
  runId: string;
  timeoutMs: number;
  /** 原样发给 runner 的任务对象；schema 由 shared 定义，runner 直接校验。 */
  task: SandboxTaskInput;
  workspaceDir: string;
  image: string;
  /** 注入容器的凭证等；不会落到工作区文件。 */
  env: Record<string, string>;
  /** 额外挂载（宿主绝对路径），用于把原生 auto-memory 放到持久卷。 */
  extraMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  provider: SandboxProvider;
  logger: Logger;
}

/** 可重试 = 基础设施瞬时故障；业务失败不重试。分类来自 RunFailure，不再匹配错误文本。 */
export function isRetryable(outcome: SandboxRunOutcome): boolean {
  return outcome.failure !== undefined && isRetryableFailure(outcome.failure);
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
  /** 容器清理失败：容器可能还在写文件，调用方不能发布产出快照。 */
  cleanupError?: string;
  /** 本次 run 产生的完整事件，供调用方落库。 */
  events: ChatEvent[];
}

/** 容器创建预算；超时按基础设施失败处理。 */
const CREATE_TIMEOUT_MS = 30_000;
/** 容器停止由 provider 负责（stop --time 5 + rm -f 兜底，每步 10s 上限），这里留出总预算。 */
const DESTROY_TIMEOUT_MS = 40_000;

/**
 * 单行 NDJSON 上限；超过即丢弃，避免一行把内存吃穿。
 * 必须能盛住 runner 的单块上限：1MiB 字段最坏被 JSON 转义成 6 倍，取 8MiB 才有余量；
 * 两个上限要一起改，否则整块 assistant_text 会被这里静默丢掉。
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** 单 run 展示上限：瞬时增量与块边界超出后只停止展示，不占用落库额度。 */
const MAX_TRANSIENT_EVENTS = 2_000;
const MAX_TRANSIENT_BYTES = 32 * 1024 * 1024;
/**
 * 单 run 落库上限：只统计需要持久化的完整消息与工具事件。
 * 与展示额度分开，避免 text_delta 把完整的 assistant_text 挤出持久化集合。
 */
const MAX_PERSISTED_EVENTS = 2_000;
const MAX_PERSISTED_BYTES = 32 * 1024 * 1024;
/** 落库被截断时不能回报成功：SDK 会话完整而历史只剩部分，刷新后会对不上。 */
const PERSIST_OVERFLOW_MESSAGE = '完整输出超过保存上限，已保存部分结果';
/** 失败时保留的 stderr 上限：2KB 常常只剩最后一行，16KB 才能看到启动错误。 */
const STDERR_KEEP_CHARS = 16 * 1024;

/** shared 事件类型加上本轮补发的字段；shared 定稿前先在这里收窄。 */
type StreamEvent = ChatEvent & { streamBlockId?: string };

/** 落库需要的完整事件；text_delta 与块边界只用于展示。 */
function isPersistable(event: ChatEvent): boolean {
  return (
    event.type === 'assistant_text' ||
    event.type === 'tool_start' ||
    event.type === 'tool_input' ||
    event.type === 'tool_result' ||
    event.type === 'session_forked'
  );
}

/**
 * run 内稳定的文本块身份。`blockIndex` 会被 SDK 的后续消息重用（每条 assistant 消息都从 0 起），
 * 每帧 `sdkUuid` 又各不相同，二者都不能当段身份；这里按块边界发号。
 * `assistant_text` 只有完整消息里的 `blockIndex`，用「最近开启且未关闭」的块对齐。
 */
export function createStreamBlockIds(): (event: ChatEvent) => StreamEvent {
  const open = new Map<string, string>();
  const lastOpen = new Map<string, string>();
  let issued = 0;
  // 全局单调：主线程与子智能体可能同时用 blockIndex 0，身份必须在整个 run 内唯一。
  const next = (): string => `b${issued++}`;
  const slot = (parentToolUseId: string | undefined, blockIndex: number) =>
    `${parentToolUseId ?? ''}:${blockIndex}`;

  return (event) => {
    const parentToolUseId =
      'parentToolUseId' in event && typeof event.parentToolUseId === 'string'
        ? event.parentToolUseId
        : undefined;
    if (event.type === 'assistant_block_start') {
      const id = next();
      open.set(slot(parentToolUseId, event.blockIndex), id);
      lastOpen.set(slot(parentToolUseId, event.blockIndex), id);
      return { ...event, streamBlockId: id };
    }
    if (event.type === 'assistant_block_stop') {
      const id = open.get(slot(parentToolUseId, event.blockIndex));
      if (id !== undefined) open.delete(slot(parentToolUseId, event.blockIndex));
      return { ...event, ...(id === undefined ? {} : { streamBlockId: id }) };
    }
    if (event.type !== 'text_delta' && event.type !== 'assistant_text') return event;
    if (event.blockIndex === undefined) {
      // 旧 runner 不带块序号：整条消息一段。不能用 sdkUuid，text_delta 上的是每帧都变的 uuid。
      const key = `legacy:${parentToolUseId ?? ''}`;
      const id = open.get(key) ?? next();
      // 完整消息到达即封口，下一条消息重新起号。
      if (event.type === 'assistant_text') open.delete(key);
      else open.set(key, id);
      return { ...event, streamBlockId: id };
    }
    const id =
      open.get(slot(parentToolUseId, event.blockIndex)) ??
      lastOpen.get(slot(parentToolUseId, event.blockIndex)) ??
      next();
    if (event.type === 'assistant_text') {
      // 完整块即消费完这一段：没有块边界的子智能体下一条消息会重用同号，
      // 必须封口 lastOpen 另起身份；stop 稍后到达，仍从 open 里取同一个 id。
      lastOpen.delete(slot(parentToolUseId, event.blockIndex));
    } else {
      lastOpen.set(slot(parentToolUseId, event.blockIndex), id);
    }
    return { ...event, streamBlockId: id };
  };
}

interface StderrTap {
  text: string;
  /** 超出上限被丢弃的字符数；非 0 时取出的片段要带截断标记。 */
  dropped: number;
}

function appendStderr(tap: StderrTap, chunk: string): void {
  tap.text += chunk;
  const excess = tap.text.length - STDERR_KEEP_CHARS;
  if (excess > 0) {
    tap.dropped += excess;
    tap.text = tap.text.slice(excess);
  }
}

/** 脱敏后取尾部；截断时必须说明「前面还有」，否则读者会以为这就是全部。 */
function stderrExcerpt(tap: StderrTap, max: number): string {
  const body = redactSecrets(tap.text.slice(-max).trim());
  if (!body) return '';
  return tap.dropped > 0 || tap.text.length > max ? `[…stderr truncated]\n${body}` : body;
}

let redisUrl = 'redis://localhost:6379';

/** 由 worker 入口在启动时注入校验过的 REDIS_URL。 */
export function configureRunnerClient(url: string): void {
  redisUrl = url;
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

/** 事件写 Redis Stream（与 API 的订阅端一致），可从流头回放；BLOCK 订阅者由 XADD 直接唤醒。 */
export async function publishRun(runId: string, event: ChatEvent, logger: Logger): Promise<void> {
  const key = runStreamKey(runId);
  // XADD 与 TTL 合并为一次 pipeline；逐命令检查，避免任一失败被静默吞掉。
  const replies = await getPublisher(logger)
    .pipeline()
    .xadd(key, 'MAXLEN', '~', RUN_STREAM_MAXLEN, '*', 'payload', JSON.stringify(event))
    .expire(key, 3600)
    .exec();
  // 无 WATCH 时不应返回 null；真出现说明命令没执行，不能当作发布成功。
  if (replies === null) throw new Error('redis pipeline aborted');
  for (const reply of replies) {
    if (reply[0]) throw reply[0];
  }
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

interface ExitSignal {
  kind: 'closed' | 'error';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/**
 * 按退出信号分类，不匹配错误文本：
 * - spawn 'error'（docker 进程都没起来）= 基础设施问题
 * - docker run 自身的失败码 125（daemon 不可达、镜像拉取失败）= 基础设施问题
 * - 其余非零退出（OOM、容器内命令崩溃）= 沙盒失败
 * shortcut: 容器进程自己以 125 退出会与 docker 失败混淆，等 runner 上报带分类的退出码时再区分。
 */
function reasonFor(signal: ExitSignal): RunFailure['reason'] {
  if (signal.kind === 'error') return 'infra';
  return signal.code === 125 ? 'infra' : 'sandbox';
}

/**
 * 启动一次沙盒 run：转发事件、处理超时与取消，返回用于落库的终态。
 * 终态 run_finished 由调用方统一发布一次，避免与 runner 输出重复。
 *
 * 取消、超时、进程退出三者用 race 表达，谁先到谁赢；容器销毁由 Scope 保证。
 */
export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunOutcome> {
  // 容器销毁由 scope 在返回值确定后执行；清理结果只能在这个外层合并回 outcome。
  const cleanup: { error?: string } = {};
  const outcome = await Effect.runPromise(
    Effect.scoped(runInSandboxEffect(input, cleanup)).pipe(
      // 订阅取消频道失败属于基础设施故障：交给 BullMQ 重试，而不是伪装成 agent 失败。
      Effect.catch((failure) =>
        Effect.succeed<SandboxRunOutcome>({
          status: 'failed',
          sandboxId: '',
          error: failure.message,
          failure,
          events: [],
        }),
      ),
    ),
  );
  return cleanup.error === undefined ? outcome : { ...outcome, cleanupError: cleanup.error };
}

function runInSandboxEffect(
  input: SandboxRunInput,
  cleanup: { error?: string },
): Effect.Effect<SandboxRunOutcome, RunFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const { logger, runId } = input;
    const events: ChatEvent[] = [];
    let reportedStatus: RunStatus | undefined;
    let reportedCost: number | undefined;
    let reportedTurns: number | undefined;
    let reportedError: string | undefined;
    let reportedFailure: RunFailure['reason'] | undefined;
    let reportedSessionId: string | undefined;
    let reportedInput: number | undefined;
    let reportedOutput: number | undefined;
    const stderrTap: StderrTap = { text: '', dropped: 0 };
    let transientEvents = 0;
    let transientBytes = 0;
    let transientOverflowed = false;
    let persistedBytes = 0;
    let persistOverflowed = false;
    let abandoning = false;
    let runnerStarted = false;
    const assignStreamBlockId = createStreamBlockIds();

    // 同一连接上的命令按序排队；不 await 也能保证事件顺序。
    const publish = (event: ChatEvent): void => {
      void publishRun(runId, event, logger).catch((err: unknown) => {
        logger.warn({ err, runId }, 'publish failed');
      });
    };

    const onEvent = (line: string): void => {
      const parsed = parseLine(line, logger);
      if (!parsed) return;
      // 流式增量先补运行内稳定块身份，再分发给页面与落库。
      const event = assignStreamBlockId(parsed);
      runnerStarted = true;

      if (event.type === 'run_finished') {
        // 只记下终态，由调用方统一发布，保证每个 run 恰好一条。
        reportedStatus = event.status;
        reportedCost = event.costUsd;
        reportedTurns = event.turns;
        reportedError = event.error === undefined ? undefined : redactSecrets(event.error);
        reportedFailure = event.failureKind;
        reportedSessionId = event.sessionId;
        reportedInput = event.inputTokens;
        reportedOutput = event.outputTokens;
        return;
      }

      const bytes = Buffer.byteLength(line);
      if (isPersistable(event)) {
        if (persistOverflowed) return;
        if (events.length >= MAX_PERSISTED_EVENTS || persistedBytes + bytes > MAX_PERSISTED_BYTES) {
          persistOverflowed = true;
          logger.warn(
            { runId, events: events.length, persistedBytes },
            'sandbox persisted event stream overflowed',
          );
          events.push({ type: 'error', message: PERSIST_OVERFLOW_MESSAGE });
          publish({ type: 'error', message: PERSIST_OVERFLOW_MESSAGE });
          return;
        }
        persistedBytes += bytes;
        events.push(event);
        publish(event);
        return;
      }

      // 瞬时展示有独立额度：截断增量不能影响上面的完整消息落库。
      if (transientOverflowed) return;
      if (transientEvents >= MAX_TRANSIENT_EVENTS || transientBytes + bytes > MAX_TRANSIENT_BYTES) {
        transientOverflowed = true;
        logger.warn(
          { runId, events: transientEvents, eventBytes: transientBytes },
          'sandbox event stream overflowed',
        );
        publish({ type: 'error', message: '输出超出上限' });
        return;
      }
      transientEvents += 1;
      transientBytes += bytes;
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

    const destroy = async (sandbox: Sandbox): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          input.provider.destroy(sandbox),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              sandbox.child.kill('SIGKILL');
              reject(new Error(`sandbox cleanup timed out after ${DESTROY_TIMEOUT_MS}ms`));
            }, DESTROY_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        sandbox.child.kill('SIGKILL');
        // 清理失败只影响容器回收，不能改写已完成的业务结果；容器仍由 provider tracking 兜底。
        // 但容器没停稳时文件可能还在变：把失败显式带出去，调用方据此不发布产出快照。
        cleanup.error = toError(err);
        logger.warn({ err, runId, sandbox: sandbox.id }, 'sandbox cleanup failed');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const attach = (sandbox: Sandbox): void => {
      if (abandoning) {
        // 取消先到，容器才创建完成：交给 provider 的停止语义清理，不让它泄漏。
        void destroy(sandbox);
        return;
      }
      const proc = sandbox.child;

      proc.stderr.setEncoding('utf8');
      let startupLog = '';
      proc.stderr.on('data', (chunk: string) => {
        startupLog = (startupLog + chunk).slice(-256);
        if (startupLog.includes('[runner] starting query')) runnerStarted = true;
        appendStderr(stderrTap, chunk);
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
                logger.warn({ runId }, 'sandbox event line exceeded the 8MiB cap, dropped');
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
            logger.warn({ runId }, 'sandbox event line exceeded the 8MiB cap, dropped');
            continue;
          }
          if (line.trim().length > 0) onEvent(line);
        }
      });

      proc.stdin.write(`${JSON.stringify(input.task)}\n`);
    };

    // 创建失败也必须结束竞争；raceAll 只在成功时结束，会吞掉创建错误。
    const created = yield* Effect.result(
      Effect.raceAllFirst([
        Effect.tryPromise({
          // 声明参数才会拿到 Effect 的 AbortSignal：取消/创建超时/中断打断 create 分支时 abort，
          // 让 provider 能中断 docker pull；create 正常完成不会 abort（已核对 effect 4.0.6 语义）。
          try: (signal) =>
            input.provider
              .create({
                image: input.image,
                workspaceDir: input.workspaceDir,
                env: input.env,
                name: `agentport-${runId.toLowerCase()}`,
                ...(input.extraMounts ? { extraMounts: input.extraMounts } : {}),
                signal,
              })
              .then((sandbox) => {
                if (abandoning) void destroy(sandbox);
                return sandbox;
              }),
          catch: (err) => err,
        }).pipe(Effect.map((sandbox) => ({ sandbox }))),
        Effect.sleep(CREATE_TIMEOUT_MS).pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error(`sandbox create timed out after ${CREATE_TIMEOUT_MS}ms`)),
          ),
        ),
        Deferred.await(cancelled).pipe(
          Effect.map(() => {
            abandoning = true;
            return {};
          }),
        ),
      ]),
    );

    if (created._tag === 'Failure') {
      abandoning = true;
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
    yield* Effect.acquireRelease(Effect.succeed(sandbox), (s) => Effect.promise(() => destroy(s)));
    attach(sandbox);

    // 谁先到谁赢：正常退出 / 用户取消 / 超时。
    const stopped = yield* Effect.raceAll([
      Deferred.await(exitSignal).pipe(Effect.map((s) => ({ kind: s.kind, signal: s }))),
      Deferred.await(cancelled).pipe(Effect.map(() => ({ kind: 'cancelled' as const }))),
      Effect.sleep(input.timeoutMs).pipe(Effect.map(() => ({ kind: 'timeout' as const }))),
      Effect.sleep(CREATE_TIMEOUT_MS).pipe(
        Effect.flatMap(() =>
          runnerStarted ? Effect.never : Effect.succeed({ kind: 'infra' as const }),
        ),
      ),
    ]);

    if (stopped.kind === 'infra') {
      const error = `sandbox startup timed out after ${CREATE_TIMEOUT_MS}ms`;
      return {
        status: 'failed',
        sandboxId: sandbox.id,
        error,
        failure: new RunFailure('infra', error),
        events,
      };
    }
    if (stopped.kind === 'cancelled') {
      logger.info({ runId }, 'sandbox run cancelled');
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
        failure: new RunFailure(reasonFor(stopped.signal), error),
        events,
      };
    }

    if (reportedStatus === undefined) {
      // 日志留 16KB 供排查；agent_runs.error 只取尾部 2KB，避免把整段 stderr 带进页面。
      const suffix = stderrExcerpt(stderrTap, STDERR_KEEP_CHARS);
      const persisted = stderrExcerpt(stderrTap, 2_000);
      if (suffix) {
        // 默认 info 级下 debug 不可见，而失败现场只有 stderr 能说明原因。
        logger.warn(
          { runId, sandbox: sandbox.id, exitCode: stopped.signal.code, stderr: suffix },
          'sandbox stderr on abnormal exit',
        );
      }
      const detail =
        stopped.signal.code === 0
          ? 'sandbox exited without run_finished'
          : `sandbox exited with code ${String(stopped.signal.code)}${stopped.signal.signal ? ` (${stopped.signal.signal})` : ''}`;
      const error = persisted ? `${detail}: ${persisted}` : detail;
      return {
        status: 'failed',
        sandboxId: sandbox.id,
        error,
        failure: new RunFailure(reasonFor(stopped.signal), error),
        events,
      };
    }
    if (reportedStatus !== 'succeeded') {
      // runner 自己报了失败：SDK 的 stderr 往往有更具体的那一行。
      const suffix = stderrExcerpt(stderrTap, STDERR_KEEP_CHARS);
      if (suffix) {
        logger.warn(
          { runId, sandbox: sandbox.id, status: reportedStatus, stderr: suffix },
          'sandbox stderr on failed run',
        );
      }
    }
    // 落库被截断时把成功改判为失败；已有的非成功终态（取消/超时/失败）优先，不覆盖。
    const persistFailure =
      persistOverflowed && reportedStatus === 'succeeded'
        ? new RunFailure('agent', PERSIST_OVERFLOW_MESSAGE)
        : undefined;
    const failure =
      persistFailure ??
      (reportedStatus !== 'succeeded'
        ? new RunFailure(reportedFailure ?? 'agent', reportedError ?? 'agent failed')
        : undefined);
    return {
      status: persistFailure === undefined ? reportedStatus : 'failed',
      sandboxId: sandbox.id,
      events,
      ...budget,
      ...(persistFailure === undefined
        ? reportedError === undefined
          ? {}
          : { error: reportedError }
        : { error: persistFailure.message }),
      ...(failure === undefined ? {} : { failure }),
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
): Effect.Effect<() => Promise<void>, RunFailure> {
  return Effect.callback((resume, signal) => {
    const redis = getCancelSubscriber(logger);
    const channel = runCancelKey(runId);
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
        redis.on('message', handler);
        await redis.subscribe(channel);
        // 订阅连接不能执行 EXISTS；通过普通连接补查订阅之前的取消。
        if ((await getPublisher(logger).exists(channel)) === 1) onCancel();
      } catch (err) {
        // 订阅不上就无法保证取消：宁可让这次 run 失败并由 BullMQ 重试，
        // 也不要启动一个用户停不掉的容器。
        logger.warn({ err, runId }, 'cancel subscription failed');
        const message = err instanceof Error ? err.message : String(err);
        if (!signal.aborted) resume(Effect.fail(new RunFailure('infra', message)));
        return;
      }
      if (!signal.aborted) resume(Effect.succeed(release));
    })();
  });
}
