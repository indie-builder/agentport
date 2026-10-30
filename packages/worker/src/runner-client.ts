import { isRetryableFailure, RunFailure } from '@agentport/core';
import {
  type ChatEvent,
  type ExecutionSettlement,
  type NativeQuestion,
  type QuestionResponse,
  RUN_STREAM_MAXLEN,
  type RunQuestion,
  runCancelKey,
  runStreamKey,
  type SandboxInputCommand,
  type SandboxTaskInput,
  SUPERVISOR_INPUT_MAX_BYTES,
} from '@agentport/shared';
import { Deferred, Effect, Exit, type Scope } from 'effect';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { publicRunQuestion, redactChatEvent, redactSecrets } from './redact.js';
import { SandboxCleanupError } from './sandbox/provider.js';
import type {
  SandboxExecution,
  SessionSandboxes,
  SessionSandboxLease,
  SessionSandboxSpec,
} from './sandbox/sessions.js';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

/** 原生澄清提问的宿主存储；由 index 绑定到 DB repo。 */
export interface SandboxQuestionCallbacks {
  /**
   * `expiresAt` 由 runner 在容器实际开始执行时给出：创建耗时不能挤占问答期限。
   */
  request(
    event: {
      requestId: string;
      toolUseId: string;
      questions: NativeQuestion[];
    },
    expiresAt: Date,
  ): Promise<RunQuestion>;
  list(): Promise<RunQuestion[]>;
  close(reason: string, requestId?: string): Promise<RunQuestion[]>;
}

export interface SandboxRunInput {
  runId: string;
  timeoutMs: number;
  /** 原样发给 runner 的任务对象；schema 由 shared 定义，runner 直接校验。 */
  task: SandboxTaskInput;
  /** lease 覆盖目录刷新到消息与成果发布的整个独占期。 */
  lease: SessionSandboxLease;
  env: Record<string, string>;
  signal?: AbortSignal;
  logger: Logger;
  /** 缺省时不支持提问：runner 的提问会被本地拒绝，不会假装已落库。 */
  questions?: SandboxQuestionCallbacks;
}

/**
 * 可重试 = 停稳已确认 + 基础设施瞬时故障；业务失败不重试。
 * 停稳未确认时容器可能还在执行副作用，重跑会重复计费与写文件。
 */
export function isRetryable(outcome: SandboxRunOutcome): boolean {
  return (
    outcome.settlement.state === 'stopped' &&
    outcome.cleanupError === undefined &&
    outcome.failure !== undefined &&
    isRetryableFailure(outcome.failure)
  );
}

export interface SandboxRunOutcome {
  status: RunStatus;
  sandboxId: string;
  settlement: ExecutionSettlement;
  /** release 已被调用（结果已缓存）；不代表销毁成功，是否停稳只看 settlement。 */
  leaseReleased?: true;
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

/** 收尾时 runner-client 需要把未决问题一起关闭；handle 在 effect 内注入。 */
interface QuestionHandle {
  settle?: (reason: string) => Promise<void>;
  error?: () => string | undefined;
}

/** 答案由 API 写入 DB；宿主每 500ms 看一次，只有自己这次 attempt 的 pending 才回写 stdin。 */
const QUESTION_POLL_MS = 500;

/**
 * 提问的宿主侧状态机：
 * - question_requested 先落库，再推 question_updated；
 * - 答案由 API 写库，轮询只负责把 answered/declined 写回当前沙盒的 stdin，一次且仅一次；
 * - 游走在两端的迟到/重复答案不会命中断言之外的 pending；
 * - 收尾必须等异步落库排空，然后关闭所有未决卡片。
 */
function createQuestionRuntime(input: {
  runId: string;
  callbacks: SandboxQuestionCallbacks | undefined;
  logger: Logger;
  record: (event: ChatEvent) => void;
  /** 轮询不可用时终止整个 run：不能让 SDK 等满整体超时。 */
  abort: (message: string) => void;
}): {
  handle(event: ChatEvent): boolean;
  attach(write: (command: SandboxInputCommand) => void, expiresAt: Date): void;
  settle(reason: string): Promise<void>;
  error(): string | undefined;
} {
  const pending = new Map<string, RunQuestion>();
  const sent = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let polling: Promise<void> | undefined;
  let stopped = false;
  let sawQuestions = false;
  let failure: string | undefined;
  let write: ((command: SandboxInputCommand) => void) | undefined;
  let expiresAt: Date | undefined;

  const record = (question: RunQuestion): void => {
    input.record({ type: 'question_updated', question: publicRunQuestion(question) });
  };
  const fail = (err: unknown, message: string): string => {
    const detail = err instanceof Error ? err.message : String(err);
    failure ??= detail;
    input.logger.error({ err, runId: input.runId }, message);
    return detail;
  };
  const respond = (question: RunQuestion): void => {
    if (sent.has(question.requestId)) return;
    sent.add(question.requestId);
    pending.delete(question.requestId);
    // 给模型的答案必须是库里的原值；展示用的脱敏只发生在 record()。
    const response: QuestionResponse =
      question.status === 'answered' && question.answers !== null
        ? { answers: question.answers }
        : { decline: true };
    write?.({ type: 'question_response', requestId: question.requestId, response });
  };
  /** 明确拒绝所有 pending 并清空，避免 SDK 一直等一个不会到来的回答。 */
  const denyAll = (): void => {
    for (const requestId of [...pending.keys()]) {
      if (sent.has(requestId)) continue;
      sent.add(requestId);
      write?.({ type: 'question_response', requestId, response: { decline: true } });
    }
    pending.clear();
  };
  const startPolling = (): void => {
    if (polling !== undefined || stopped) return;
    polling = (async () => {
      try {
        while (!stopped && pending.size > 0) {
          await new Promise((resolve) => setTimeout(resolve, QUESTION_POLL_MS));
          if (stopped || pending.size === 0) break;
          const callbacks = input.callbacks;
          if (callbacks === undefined) break;
          let items: RunQuestion[];
          try {
            items = await callbacks.list();
          } catch (err) {
            const detail = fail(err, 'failed to poll questions');
            // 明确拒绝所有 pending，再终止 run；否则 SDK 会空等到整体超时。
            stopped = true;
            denyAll();
            input.abort(detail);
            break;
          }
          for (const item of items) {
            if (!pending.has(item.requestId) || item.status === 'pending') continue;
            respond(item);
          }
        }
      } finally {
        polling = undefined;
      }
    })();
  };
  const enqueue = (operation: () => Promise<void>): void => {
    chain = chain.then(operation).catch((err: unknown) => {
      fail(err, 'question operation failed');
    });
  };

  return {
    handle(event) {
      if (event.type === 'question_requested') {
        // 收尾开始后不再接受新问题：否则会在 close 之后又落一行 pending。
        if (stopped) return true;
        sawQuestions = true;
        const { requestId, toolUseId, questions } = event;
        enqueue(async () => {
          const callbacks = input.callbacks;
          if (callbacks === undefined) {
            fail(new Error('question store is not configured'), 'question store unavailable');
            // fail closed：不让工具无限等一个无法持久化的回答。
            write?.({ type: 'question_response', requestId, response: { decline: true } });
            return;
          }
          try {
            if (expiresAt === undefined) throw new Error('question runtime is not attached');
            const question = await callbacks.request(
              { requestId, toolUseId, questions },
              expiresAt,
            );
            pending.set(question.requestId, question);
            record(question);
            startPolling();
          } catch (err) {
            fail(err, 'failed to persist a question');
            write?.({ type: 'question_response', requestId, response: { decline: true } });
          }
        });
        return true;
      }
      if (event.type === 'question_closed') {
        const { requestId } = event;
        enqueue(async () => {
          const callbacks = input.callbacks;
          if (callbacks === undefined) return;
          try {
            for (const question of await callbacks.close('closed', requestId)) record(question);
            pending.delete(requestId);
          } catch (err) {
            fail(err, 'failed to close a question');
          }
        });
        return true;
      }
      return false;
    },
    attach(writeCommand, deadline) {
      write = writeCommand;
      expiresAt = deadline;
    },
    async settle(reason) {
      if (!sawQuestions) return;
      stopped = true;
      // 先等所有异步写库完成，run_finished 不能越过它们。
      await chain;
      if (polling !== undefined) await polling;
      const callbacks = input.callbacks;
      if (callbacks === undefined) return;
      try {
        for (const question of await callbacks.close(reason)) record(question);
        // 回答可能发生在最后一次轮询与收尾之间：刷新最终快照再落历史。
        for (const question of await callbacks.list()) record(question);
      } catch (err) {
        fail(err, 'failed to settle pending questions');
      }
    },
    error() {
      return failure;
    },
  };
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

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** acquire 的总预算；超时后仍要等 provider 清理完，不能先返回留下未知容器。 */
const ACQUIRE_BUDGET_MS = 30_000;

/** 订阅先于 acquire，拉取镜像与 supervisor ready 同样可取消且有界。 */
export async function acquireSessionSandbox(input: {
  runId: string;
  manager: Pick<SessionSandboxes, 'acquire'>;
  spec: SessionSandboxSpec;
  signal: AbortSignal;
  logger: Logger;
}): Promise<SessionSandboxLease> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cancelled = yield* Deferred.make<void>();
        const aborter = new AbortController();
        const onCancel = (): void => {
          Deferred.doneUnsafe(cancelled, Exit.succeed(undefined));
          aborter.abort();
        };
        // 订阅与创建共用一个预算，避免准备阶段把 30s 翻倍。
        const deadline = Date.now() + ACQUIRE_BUDGET_MS;
        const prepared = yield* Effect.result(
          Effect.raceAllFirst([
            Effect.gen(function* () {
              yield* subscribeCancel(input.runId, input.logger, onCancel, input.signal);
              return Deferred.isDoneUnsafe(cancelled) || input.signal.aborted
                ? ({ kind: 'cancelled' } as const)
                : ({ kind: 'prepared' } as const);
            }),
            Deferred.await(cancelled).pipe(Effect.map(() => ({ kind: 'cancelled' }) as const)),
            Effect.sleep(ACQUIRE_BUDGET_MS).pipe(Effect.map(() => ({ kind: 'timeout' }) as const)),
          ]),
        );
        if (prepared._tag === 'Failure') return yield* Effect.fail(prepared.failure);
        if (prepared.success.kind === 'cancelled')
          return yield* Effect.fail(
            new RunFailure('cancelled', 'cancelled during sandbox acquire'),
          );
        if (prepared.success.kind === 'timeout')
          return yield* Effect.fail(
            new RunFailure('infra', `sandbox acquire timed out after ${ACQUIRE_BUDGET_MS}ms`),
          );
        return yield* Effect.tryPromise({
          try: () =>
            acquireLease({
              manager: input.manager,
              spec: input.spec,
              runId: input.runId,
              aborter,
              cancelled: () => Deferred.isDoneUnsafe(cancelled) || input.signal.aborted,
              remainingMs: Math.max(0, deadline - Date.now()),
            }),
          catch: (err) =>
            err instanceof RunFailure ? err : new RunFailure('infra', toError(err), err),
        });
      }),
    ),
  );
}

/**
 * 取消/超时只负责 abort；provider 契约要求它清理完容器再 reject。
 * 这里必须等到真正收尾：提前返回会让调用方以为没有遗留容器。
 */
async function acquireLease(input: {
  manager: Pick<SessionSandboxes, 'acquire'>;
  spec: SessionSandboxSpec;
  runId: string;
  aborter: AbortController;
  cancelled: () => boolean;
  remainingMs: number;
}): Promise<SessionSandboxLease> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    input.aborter.abort();
  }, input.remainingMs);
  try {
    let lease: SessionSandboxLease;
    try {
      lease = await input.manager.acquire(input.spec, input.aborter.signal, input.runId);
    } catch (err) {
      const cancelled = input.cancelled();
      // 原始错误（含 provider 的 SandboxCleanupError）保留在 cause 链里，index 才能按 id 继续清理。
      if (err instanceof RunFailure && !timedOut && !cancelled) throw err;
      throw new RunFailure(
        !timedOut && cancelled ? 'cancelled' : 'infra',
        timedOut
          ? `sandbox acquire timed out after ${ACQUIRE_BUDGET_MS}ms`
          : cancelled
            ? 'cancelled during sandbox acquire'
            : toError(err),
        err,
      );
    }
    if (!timedOut && !input.cancelled()) return lease;
    // provider 忽略了取消仍迟到返回：所有权已经在这里，必须释放（销毁）后再报告。
    const reason = timedOut ? 'infra' : 'cancelled';
    const message = timedOut
      ? `sandbox acquire timed out after ${ACQUIRE_BUDGET_MS}ms`
      : 'cancelled during sandbox acquire';
    try {
      await lease.release({ reuse: false });
    } catch (cleanupError) {
      // 释放失败必须带容器 id，index 才能按 id 继续清理；普通错误没有 id，用 lease 自身的补上。
      throw new RunFailure(
        reason,
        message,
        cleanupError instanceof SandboxCleanupError
          ? cleanupError
          : new SandboxCleanupError(lease.sandboxId, message, cleanupError),
      );
    }
    throw new RunFailure(reason, message);
  } finally {
    clearTimeout(timer);
  }
}

export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunOutcome> {
  // 正常 lease 留给调用方发布后释放；异常执行必须先销毁再允许捕获文件。
  const questions: QuestionHandle = {};
  let outcome = await Effect.runPromise(
    Effect.scoped(runInSandboxEffect(input, questions)).pipe(
      // 订阅取消频道失败属于基础设施故障：交给 BullMQ 重试，而不是伪装成 agent 失败。
      Effect.catch((failure) =>
        Effect.succeed<SandboxRunOutcome>({
          status: 'failed',
          sandboxId: input.lease.sandboxId,
          settlement: { state: 'unconfirmed', error: failure.message },
          error: failure.message,
          failure,
          events: [],
        }),
      ),
    ),
  );
  if (questions.settle !== undefined) {
    // 先把未决问题按终态关闭并等落库排空，再让调用方发布 run_finished。
    await questions.settle(outcome.status === 'succeeded' ? 'finished' : outcome.status);
    const failure = questions.error?.();
    if (failure !== undefined) {
      // 落库失败不能吞：运行结果里必须能看见，但不改写已经确定的终态。
      outcome = {
        ...outcome,
        error: `${outcome.error ?? outcome.status}；问题记录失败：${failure}`,
      };
    }
  }
  if (
    outcome.status === 'failed' ||
    outcome.status === 'timeout' ||
    outcome.settlement.state !== 'stopped'
  ) {
    try {
      await input.lease.release({ reuse: false });
      outcome = {
        ...outcome,
        leaseReleased: true,
        settlement: { state: 'stopped', code: null, signal: null },
      };
    } catch (err) {
      const error = toError(err);
      input.logger.warn(
        { err, runId: input.runId, sandbox: input.lease.sandboxId },
        'sandbox cleanup failed',
      );
      outcome = {
        ...outcome,
        leaseReleased: true,
        settlement: { state: 'unconfirmed', error },
        cleanupError: error,
        // provider 的 SandboxCleanupError 带容器 id；保留在 cause 链里，index 才能按 id 继续清理。
        ...(outcome.failure === undefined
          ? {}
          : { failure: new RunFailure(outcome.failure.reason, outcome.failure.message, err) }),
      };
    }
  }
  return outcome;
}

function runInSandboxEffect(
  input: SandboxRunInput,
  questionHandle: QuestionHandle,
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
    const assignStreamBlockId = createStreamBlockIds();

    // 同一连接上的命令按序排队；不 await 也能保证事件顺序。
    const publish = (event: ChatEvent): void => {
      void publishRun(runId, event, logger).catch((err: unknown) => {
        logger.warn({ err, runId }, 'publish failed');
      });
    };

    const questionFailed = yield* Deferred.make<string>();
    const questionRuntime = createQuestionRuntime({
      runId,
      callbacks: input.questions,
      logger,
      record: (event) => {
        events.push(event);
        publish(event);
      },
      abort: (message) => Deferred.doneUnsafe(questionFailed, Exit.succeed(message)),
    });
    questionHandle.settle = questionRuntime.settle;
    questionHandle.error = questionRuntime.error;

    const onEvent = (parsed: ChatEvent): void => {
      const line = JSON.stringify(parsed);
      const bytes = Buffer.byteLength(line);
      // 行上限复用 supervisor 的 8MiB：runner 单块 1MiB 最坏被转义成 6 倍，两个上限要一起改。
      if (bytes > SUPERVISOR_INPUT_MAX_BYTES) {
        logger.warn({ runId }, 'sandbox event line exceeded the 8MiB cap, dropped');
        return;
      }
      // 流式增量先补运行内稳定块身份，再分发给页面与落库。
      const event = assignStreamBlockId(parsed);

      // runner 的提问事件只用于落库/回写，不直接进 SSE（对外只发 question_updated）。
      if (questionRuntime.handle(event)) return;

      // 对外只公开脱敏后的事件；问题投影已在 record() 完成，不能二次处理。
      const publicEvent = redactChatEvent(event);

      if (publicEvent.type === 'run_finished') {
        // 只记下终态，由调用方统一发布，保证每个 run 恰好一条。
        reportedStatus = publicEvent.status;
        reportedCost = publicEvent.costUsd;
        reportedTurns = publicEvent.turns;
        reportedError = publicEvent.error;
        reportedFailure = publicEvent.failureKind;
        reportedSessionId = publicEvent.sessionId;
        reportedInput = publicEvent.inputTokens;
        reportedOutput = publicEvent.outputTokens;
        return;
      }

      if (isPersistable(publicEvent)) {
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
        events.push(publicEvent);
        publish(publicEvent);
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
      publish(publicEvent);
    };

    const metadata = () => ({
      ...(reportedCost === undefined ? {} : { costUsd: reportedCost }),
      ...(reportedTurns === undefined ? {} : { turns: reportedTurns }),
      ...(reportedSessionId === undefined ? {} : { sessionId: reportedSessionId }),
      ...(reportedInput === undefined ? {} : { inputTokens: reportedInput }),
      ...(reportedOutput === undefined ? {} : { outputTokens: reportedOutput }),
    });
    const cancelled = yield* Deferred.make<void>();
    let execution: SandboxExecution | undefined;
    let startRequested = false;
    questionRuntime.attach(
      (command) => execution?.send(command),
      new Date(Date.now() + input.timeoutMs),
    );
    const starting = yield* Effect.result(
      Effect.raceAllFirst([
        Effect.gen(function* () {
          yield* subscribeCancel(
            runId,
            logger,
            () => Deferred.doneUnsafe(cancelled, Exit.succeed(undefined)),
            input.signal,
          );
          if (Deferred.isDoneUnsafe(cancelled) || input.signal?.aborted)
            return { kind: 'cancelled' as const };
          return yield* Effect.tryPromise({
            try: () => {
              startRequested = true;
              return input.lease.start({
                runId,
                task: input.task,
                env: input.env,
                onEvent,
                onStderr: (text: string) => {
                  appendStderr(stderrTap, text);
                  logger.debug({ runId, sandbox: input.lease.sandboxId }, redactSecrets(text));
                },
              });
            },
            catch: (err) => new RunFailure('infra', toError(err)),
          }).pipe(Effect.map((execution) => ({ kind: 'started' as const, execution })));
        }),
        Deferred.await(cancelled).pipe(Effect.map(() => ({ kind: 'cancelled' as const }))),
        Effect.sleep(30_000).pipe(Effect.map(() => ({ kind: 'startup_timeout' as const }))),
      ]),
    );
    if (starting._tag === 'Failure')
      return {
        ...metadata(),
        status: 'failed',
        sandboxId: input.lease.sandboxId,
        settlement: { state: 'unconfirmed', error: starting.failure.message },
        error: starting.failure.message,
        failure: starting.failure,
        events,
      };
    if (starting.success.kind !== 'started') {
      const cancelled = starting.success.kind === 'cancelled';
      const error = cancelled ? 'cancelled before runner start ACK' : 'runner start ACK timed out';
      return {
        ...metadata(),
        status: cancelled ? 'cancelled' : 'failed',
        sandboxId: input.lease.sandboxId,
        settlement: startRequested
          ? { state: 'unconfirmed', error }
          : { state: 'stopped', code: 0, signal: null },
        events,
        failure: new RunFailure(cancelled ? 'cancelled' : 'infra', error),
        ...(cancelled ? {} : { error }),
      };
    }
    const activeExecution: SandboxExecution = starting.success.execution;
    execution = activeExecution;
    questionRuntime.attach(
      (command) => execution?.send(command),
      new Date(Date.now() + input.timeoutMs),
    );
    const result = yield* Effect.raceAll([
      Effect.promise(() =>
        activeExecution.done.catch(
          (err: unknown): ExecutionSettlement => ({ state: 'unconfirmed', error: toError(err) }),
        ),
      ).pipe(Effect.map((settlement) => ({ kind: 'done' as const, settlement }))),
      Deferred.await(cancelled).pipe(Effect.map(() => ({ kind: 'cancelled' as const }))),
      Effect.sleep(input.timeoutMs).pipe(Effect.map(() => ({ kind: 'timeout' as const }))),
      Deferred.await(questionFailed).pipe(
        Effect.map((message) => ({ kind: 'question_failed' as const, message })),
      ),
    ]);
    let settlement: ExecutionSettlement;
    if (result.kind === 'done') settlement = result.settlement;
    else {
      // 取消期间仍接收 init/result，停稳 ACK 后再读取 session 与费用。
      settlement = yield* Effect.promise(async () => {
        try {
          const cancelled = await activeExecution.cancel();
          if (cancelled.state !== 'stopped') return cancelled;
          return await activeExecution.done;
        } catch (err) {
          return { state: 'unconfirmed', error: toError(err) } as const;
        }
      });
    }
    const sandbox = { id: input.lease.sandboxId };
    const base = { sandboxId: sandbox.id, settlement, events };
    const budget = metadata();

    if (result.kind === 'cancelled')
      return {
        ...base,
        ...budget,
        status: 'cancelled',
        failure: new RunFailure('cancelled', 'cancelled'),
      };
    if (result.kind === 'timeout') {
      const error = `sandbox timed out after ${input.timeoutMs}ms`;
      return {
        ...base,
        ...budget,
        status: 'timeout',
        error,
        failure: new RunFailure('timeout', error),
      };
    }
    if (result.kind === 'question_failed') {
      const error = `问题状态读取失败：${result.message}`;
      return {
        ...base,
        ...budget,
        status: 'failed',
        error,
        failure: new RunFailure('infra', error),
      };
    }
    if (
      result.kind === 'done' &&
      settlement.state === 'stopped' &&
      (settlement.code !== 0 || settlement.signal !== null)
    ) {
      const error = `sandbox runner exited abnormally (code ${settlement.code}, signal ${settlement.signal})`;
      return {
        ...base,
        ...budget,
        status: 'failed',
        error,
        failure: new RunFailure('sandbox', error),
      };
    }
    if (reportedStatus === undefined) {
      const detail =
        settlement.state === 'unconfirmed'
          ? settlement.error
          : `sandbox exited without run_finished (code ${settlement.code})`;
      const stderr = stderrExcerpt(stderrTap, 2_000);
      const error = stderr ? `${detail}: ${stderr}` : detail;
      return {
        ...base,
        ...budget,
        status: 'failed',
        error,
        failure: new RunFailure('sandbox', error),
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
      ...base,
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

/** 先注册清理再等待 Redis；未完成的命令由 Effect 中断，释放不等待断连的连接。 */
function subscribeCancel(
  runId: string,
  logger: Logger,
  onCancel: () => void,
  signal?: AbortSignal,
): Effect.Effect<void, RunFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const redis = getCancelSubscriber(logger);
    const channel = runCancelKey(runId);
    const handler = (received: string): void => {
      if (received === channel) onCancel();
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        redis.on('message', handler);
        signal?.addEventListener('abort', onCancel, { once: true });
        if (signal?.aborted) onCancel();
      }),
      () =>
        Effect.sync(() => {
          redis.off('message', handler);
          signal?.removeEventListener('abort', onCancel);
          // 同一连接按序发送 UNSUBSCRIBE，不能等它的 ACK 把 shutdown 再次挂住。
          void redis.unsubscribe(channel).catch((err: unknown) => {
            logger.warn({ err, runId }, 'cancel unsubscribe failed');
          });
        }),
    );
    yield* Effect.tryPromise({
      try: () => redis.subscribe(channel),
      catch: (err) => new RunFailure('infra', toError(err)),
    });
    // 订阅连接不能执行 EXISTS；独立 effect 保证中断后不再发补查。
    const exists = yield* Effect.tryPromise({
      try: () => getPublisher(logger).exists(channel),
      catch: (err) => new RunFailure('infra', toError(err)),
    });
    if (exists === 1) onCancel();
  });
}
