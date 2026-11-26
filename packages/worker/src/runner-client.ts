import { appendStreamEvent, isRetryableFailure, RunFailure } from '@agentport/core';
import {
  type ChannelEvent,
  type ChatEvent,
  channelStreamKey,
  type ExecutionSettlement,
  errorText,
  type NativeQuestion,
  publicRunQuestion,
  type QuestionResponse,
  RUN_CANCEL_PAYLOAD,
  RUN_PERSISTED_MAX_BYTES,
  RUN_PERSISTED_MAX_EVENTS,
  RUN_TRANSIENT_MAX_BYTES,
  RUN_TRANSIENT_MAX_EVENTS,
  type RunQuestion,
  redactChatEvent,
  redactSecrets,
  runCancelKey,
  runStreamKey,
  type SandboxInputCommand,
  type SandboxTaskInput,
  SUPERVISOR_INPUT_MAX_BYTES,
  type TerminalRunStatus,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import { Deferred, Effect, Exit, type Scope } from 'effect';
import type { Logger } from 'pino';
import { SandboxCleanupError } from './sandbox/provider.js';
import type {
  SandboxExecution,
  SessionSandboxes,
  SessionSandboxLease,
  SessionSandboxSpec,
} from './sandbox/sessions.js';

export interface SandboxQuestionCallbacks {
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
  expireStale?(): Promise<void>;
}

export interface SandboxInstructionCallbacks {
  list(): Promise<Array<{ id: string; body: string }>>;
  markDelivered(id: string): Promise<void>;
}

interface SandboxRunInput {
  runId: string;
  timeoutMs: number;
  task: SandboxTaskInput;
  lease: SessionSandboxLease;
  env: Record<string, string>;
  signal?: AbortSignal;
  logger: Logger;
  questions?: SandboxQuestionCallbacks;
  instructions?: SandboxInstructionCallbacks;
}

export function isRetryable(outcome: SandboxRunOutcome): boolean {
  return (
    outcome.settlement.state === 'stopped' &&
    outcome.cleanupError === undefined &&
    outcome.failure !== undefined &&
    isRetryableFailure(outcome.failure)
  );
}

export interface SandboxRunOutcome {
  status: TerminalRunStatus;
  sandboxId: string;
  settlement: ExecutionSettlement;
  leaseReleased?: true;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  failure?: RunFailure;
  cleanupError?: string;
  events: ChatEvent[];
}

const PERSIST_OVERFLOW_MESSAGE = '完整输出超过保存上限，已保存部分结果';
const STDERR_KEEP_CHARS = 16 * 1024;

function isPersistable(event: ChatEvent): boolean {
  return (
    event.type === 'assistant_text' ||
    event.type === 'tool_start' ||
    event.type === 'tool_input' ||
    event.type === 'tool_result' ||
    event.type === 'session_forked'
  );
}

export function createStreamBlockIds(): (event: ChatEvent) => ChatEvent {
  const open = new Map<string, string>();
  const lastOpen = new Map<string, string>();
  let issued = 0;
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
      const key = `legacy:${parentToolUseId ?? ''}`;
      const id = open.get(key) ?? next();
      if (event.type === 'assistant_text') open.delete(key);
      else open.set(key, id);
      return { ...event, streamBlockId: id };
    }
    const id =
      open.get(slot(parentToolUseId, event.blockIndex)) ??
      lastOpen.get(slot(parentToolUseId, event.blockIndex)) ??
      next();
    if (event.type === 'assistant_text') {
      lastOpen.delete(slot(parentToolUseId, event.blockIndex));
    } else {
      lastOpen.set(slot(parentToolUseId, event.blockIndex), id);
    }
    return { ...event, streamBlockId: id };
  };
}

interface StderrTap {
  text: string;
  dropped: number;
}

interface QuestionHandle {
  settle?: (reason: string) => Promise<void>;
  error?: () => string | undefined;
  persistOverflowed?: () => boolean;
}

const QUESTION_POLL_MS = 500;

function createQuestionRuntime(input: {
  runId: string;
  callbacks: SandboxQuestionCallbacks | undefined;
  logger: Logger;
  record: (event: ChatEvent) => void;
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
    const detail = errorText(err);
    failure ??= detail;
    input.logger.error({ err, runId: input.runId }, message);
    return detail;
  };
  const respond = (question: RunQuestion): void => {
    if (sent.has(question.requestId)) return;
    sent.add(question.requestId);
    pending.delete(question.requestId);
    const response: QuestionResponse =
      question.status === 'answered' && question.answers !== null
        ? { answers: question.answers }
        : { decline: true };
    write?.({ type: 'question_response', requestId: question.requestId, response });
  };
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
          try {
            await callbacks.expireStale?.();
          } catch (err) {
            input.logger.warn({ err }, 'question expire sweep failed');
          }
          let items: RunQuestion[];
          try {
            items = await callbacks.list();
          } catch (err) {
            const detail = fail(err, 'failed to poll questions');
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
        if (stopped) return true;
        sawQuestions = true;
        const { requestId, toolUseId, questions } = event;
        enqueue(async () => {
          const callbacks = input.callbacks;
          if (callbacks === undefined) {
            fail(new Error('question store is not configured'), 'question store unavailable');
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
      await chain;
      if (polling !== undefined) await polling;
      const callbacks = input.callbacks;
      if (callbacks === undefined) return;
      try {
        for (const question of await callbacks.close(reason)) record(question);
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

const INSTRUCTION_POLL_MS = 500;

function createInstructionRuntime(input: {
  runId: string;
  callbacks: SandboxInstructionCallbacks | undefined;
  logger: Logger;
}): {
  attach(write: (command: SandboxInputCommand) => boolean): void;
  stop(): void;
} {
  const sent = new Set<string>();
  let stopped = false;
  let polling = false;
  let timer: NodeJS.Timeout | undefined;
  let write: ((command: SandboxInputCommand) => boolean) | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || polling) return;
    const callbacks = input.callbacks;
    if (callbacks === undefined) return;
    polling = true;
    try {
      let items: Array<{ id: string; body: string }>;
      try {
        items = await callbacks.list();
      } catch (err) {
        input.logger.warn({ err, runId: input.runId }, 'instruction poll failed');
        return;
      }
      for (const item of items) {
        if (stopped) break;
        if (sent.has(item.id)) continue;
        let delivered: boolean;
        try {
          delivered =
            write?.({ type: 'user_message', text: item.body, uuid: crypto.randomUUID() }) ?? false;
        } catch (err) {
          input.logger.warn(
            { err, runId: input.runId, instructionId: item.id },
            'instruction send failed',
          );
          continue;
        }
        if (!delivered) {
          input.logger.warn(
            { runId: input.runId, instructionId: item.id },
            'instruction not delivered: session is not accepting input',
          );
          continue;
        }
        sent.add(item.id);
        try {
          await callbacks.markDelivered(item.id);
        } catch (err) {
          input.logger.warn(
            { err, runId: input.runId, instructionId: item.id },
            'instruction delivery mark failed',
          );
        }
      }
    } finally {
      polling = false;
    }
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().finally(schedule);
    }, INSTRUCTION_POLL_MS);
    timer.unref();
  };

  return {
    attach(activeWrite) {
      if (input.callbacks === undefined) return;
      write = activeWrite;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
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

function stderrExcerpt(tap: StderrTap, max: number): string {
  const body = redactSecrets(tap.text.slice(-max).trim());
  if (!body) return '';
  return tap.dropped > 0 || tap.text.length > max ? `[…stderr truncated]\n${body}` : body;
}

let redisUrl = 'redis://localhost:6379';
let serviceLogger: Logger | undefined;

export function configureRunnerClient(url: string, logger?: Logger): void {
  redisUrl = url;
  if (logger !== undefined) serviceLogger = logger;
}

let publisher: RedisClient | undefined;
let cancelSubscriber: RedisClient | undefined;
const cancelHandlers = new Map<string, Set<(message: string, channel: string) => void>>();

function getPublisher(logger: Logger): RedisClient {
  if (!publisher) {
    publisher = new RedisClient(redisUrl);
    publisher.onclose = (err) => (serviceLogger ?? logger).warn({ err }, 'redis error');
  }
  return publisher;
}

function getCancelSubscriber(logger: Logger): RedisClient {
  if (!cancelSubscriber) {
    cancelSubscriber = new RedisClient(redisUrl);
    cancelSubscriber.onclose = (err) => (serviceLogger ?? logger).warn({ err }, 'redis error');
    let connected = false;
    cancelSubscriber.onconnect = () => {
      if (!connected) {
        connected = true;
        return;
      }
      const redis = cancelSubscriber;
      if (!redis) return;
      for (const [channel, handlers] of cancelHandlers) {
        for (const handler of handlers) {
          void redis
            .subscribe(channel, handler)
            .then(async () => {
              if (await getPublisher(logger).exists(channel)) handler(RUN_CANCEL_PAYLOAD, channel);
            })
            .catch((err: unknown) =>
              (serviceLogger ?? logger).warn({ err }, 'cancel resubscribe failed'),
            );
        }
      }
    };
  }
  return cancelSubscriber;
}

export async function publishRun(runId: string, event: ChatEvent, logger: Logger): Promise<void> {
  await appendStreamEvent(getPublisher(logger), runStreamKey(runId), event);
}

export async function clearRunCancel(runId: string, logger: Logger): Promise<void> {
  await getPublisher(logger).send('DEL', [runCancelKey(runId)]);
}

const CHANNEL_PUBLISH_TIMEOUT_MS = 2_000;

function withPublishTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('channel event publish timed out')), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function publishChannelEvent(
  channelId: string,
  event: ChannelEvent,
  logger: Logger,
): Promise<void> {
  await withPublishTimeout(
    appendStreamEvent(getPublisher(logger), channelStreamKey(channelId), event),
    CHANNEL_PUBLISH_TIMEOUT_MS,
  );
}

export async function publishChannelEventSafely(
  channelId: string,
  event: ChannelEvent,
  logger: Logger,
  context: Record<string, unknown> = {},
): Promise<void> {
  try {
    await publishChannelEvent(channelId, event, logger);
  } catch (err) {
    logger.warn({ err, channelId, ...context }, 'channel event publish failed');
  }
}

export async function closeRunnerClient(): Promise<void> {
  const closing = [publisher, cancelSubscriber] as const;
  publisher = undefined;
  cancelSubscriber = undefined;
  cancelHandlers.clear();
  if (closing[0]) closing[0].onclose = () => undefined;
  if (closing[1]) closing[1].onclose = () => undefined;
  closing[0]?.close();
  closing[1]?.close();
}

const ACQUIRE_BUDGET_MS = 30_000;

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
            err instanceof RunFailure ? err : new RunFailure('infra', errorText(err), err),
        });
      }),
    ),
  );
}

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
      if (err instanceof RunFailure && !timedOut && !cancelled) throw err;
      throw new RunFailure(
        !timedOut && cancelled ? 'cancelled' : 'infra',
        timedOut
          ? `sandbox acquire timed out after ${ACQUIRE_BUDGET_MS}ms`
          : cancelled
            ? 'cancelled during sandbox acquire'
            : errorText(err),
        err,
      );
    }
    if (!timedOut && !input.cancelled()) return lease;
    const reason = timedOut ? 'infra' : 'cancelled';
    const message = timedOut
      ? `sandbox acquire timed out after ${ACQUIRE_BUDGET_MS}ms`
      : 'cancelled during sandbox acquire';
    try {
      await lease.release({ reuse: false });
    } catch (cleanupError) {
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
  const questions: QuestionHandle = {};
  let outcome = await Effect.runPromise(
    Effect.scoped(runInSandboxEffect(input, questions)).pipe(
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
    await questions.settle(outcome.status === 'succeeded' ? 'finished' : outcome.status);
    if (outcome.status === 'succeeded' && questions.persistOverflowed?.() === true) {
      outcome = {
        ...outcome,
        status: 'failed',
        error: PERSIST_OVERFLOW_MESSAGE,
        failure: new RunFailure('agent', PERSIST_OVERFLOW_MESSAGE),
      };
    }
    const failure = questions.error?.();
    if (failure !== undefined) {
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
      const error = errorText(err);
      input.logger.warn(
        { err, runId: input.runId, sandbox: input.lease.sandboxId },
        'sandbox cleanup failed',
      );
      outcome = {
        ...outcome,
        leaseReleased: true,
        settlement: { state: 'unconfirmed', error },
        cleanupError: error,
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
    let reportedStatus: TerminalRunStatus | undefined;
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

    const publish = (event: ChatEvent): void => {
      void publishRun(runId, event, logger).catch((err: unknown) => {
        logger.warn({ err, runId }, 'publish failed');
      });
    };

    const acceptPersisted = (publicEvent: ChatEvent): void => {
      if (persistOverflowed) return;
      const eventBytes = Buffer.byteLength(JSON.stringify(publicEvent));
      if (
        events.length >= RUN_PERSISTED_MAX_EVENTS ||
        persistedBytes + eventBytes > RUN_PERSISTED_MAX_BYTES
      ) {
        persistOverflowed = true;
        logger.warn(
          { runId, events: events.length, persistedBytes },
          'sandbox persisted event stream overflowed',
        );
        events.push({ type: 'error', message: PERSIST_OVERFLOW_MESSAGE });
        publish({ type: 'replay_truncated', reason: 'budget' });
        return;
      }
      persistedBytes += eventBytes;
      events.push(publicEvent);
      publish(publicEvent);
    };

    const questionFailed = yield* Deferred.make<string>();
    const questionRuntime = createQuestionRuntime({
      runId,
      callbacks: input.questions,
      logger,
      record: acceptPersisted,
      abort: (message) => Deferred.doneUnsafe(questionFailed, Exit.succeed(message)),
    });
    questionHandle.settle = questionRuntime.settle;
    questionHandle.error = questionRuntime.error;
    questionHandle.persistOverflowed = () => persistOverflowed;

    const instructionRuntime = createInstructionRuntime({
      runId,
      callbacks: input.instructions,
      logger,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => instructionRuntime.stop()));

    const onEvent = (parsed: ChatEvent): void => {
      const line = JSON.stringify(parsed);
      const bytes = Buffer.byteLength(line);
      if (bytes > SUPERVISOR_INPUT_MAX_BYTES) {
        logger.warn({ runId }, 'sandbox event line exceeded the 8MiB cap, dropped');
        return;
      }
      const event = assignStreamBlockId(parsed);

      if (questionRuntime.handle(event)) return;

      const publicEvent = redactChatEvent(event);

      if (publicEvent.type === 'run_finished') {
        instructionRuntime.stop();
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
        acceptPersisted(publicEvent);
        return;
      }

      if (transientOverflowed) return;
      const eventBytes = Buffer.byteLength(JSON.stringify(publicEvent));
      if (
        transientEvents >= RUN_TRANSIENT_MAX_EVENTS ||
        transientBytes + eventBytes > RUN_TRANSIENT_MAX_BYTES
      ) {
        transientOverflowed = true;
        logger.warn(
          { runId, events: transientEvents, eventBytes: transientBytes },
          'sandbox event stream overflowed',
        );
        publish({ type: 'replay_truncated', reason: 'budget' });
        return;
      }
      transientEvents += 1;
      transientBytes += eventBytes;
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
            catch: (err) => new RunFailure('infra', errorText(err)),
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
    instructionRuntime.attach((command) => execution?.send(command) ?? false);
    const result = yield* Effect.raceAll([
      Effect.promise(() =>
        activeExecution.done.catch(
          (err: unknown): ExecutionSettlement => ({ state: 'unconfirmed', error: errorText(err) }),
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
      settlement = yield* Effect.promise(async () => {
        try {
          const cancelled = await activeExecution.cancel();
          if (cancelled.state !== 'stopped') return cancelled;
          return await activeExecution.done;
        } catch (err) {
          return { state: 'unconfirmed', error: errorText(err) } as const;
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
      const suffix = stderrExcerpt(stderrTap, STDERR_KEEP_CHARS);
      if (suffix) {
        logger.warn(
          { runId, sandbox: sandbox.id, status: reportedStatus, stderr: suffix },
          'sandbox stderr on failed run',
        );
      }
    }
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

function subscribeCancel(
  runId: string,
  logger: Logger,
  onCancel: () => void,
  signal?: AbortSignal,
): Effect.Effect<void, RunFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const redis = getCancelSubscriber(logger);
    const channel = runCancelKey(runId);
    const handler = (_message: string, received: string): void => {
      if (received === channel) onCancel();
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const handlers = cancelHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        cancelHandlers.set(channel, handlers);
        signal?.addEventListener('abort', onCancel, { once: true });
        if (signal?.aborted) onCancel();
      }),
      () =>
        Effect.sync(() => {
          const handlers = cancelHandlers.get(channel);
          handlers?.delete(handler);
          if (handlers?.size === 0) cancelHandlers.delete(channel);
          signal?.removeEventListener('abort', onCancel);
          void Promise.resolve()
            .then(() => redis.unsubscribe(channel, handler))
            .catch((err: unknown) => {
              logger.warn({ err, runId }, 'cancel unsubscribe failed');
            });
        }),
    );
    yield* Effect.tryPromise({
      try: () => redis.subscribe(channel, handler),
      catch: (err) => new RunFailure('infra', errorText(err)),
    });
    const exists = yield* Effect.tryPromise({
      try: () => getPublisher(logger).exists(channel),
      catch: (err) => new RunFailure('infra', errorText(err)),
    });
    if (exists) onCancel();
  });
}
