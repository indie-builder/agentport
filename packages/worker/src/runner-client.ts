import { createInterface } from 'node:readline';
import { type ChatEvent, chatEventSchema } from '@agentport/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { SandboxProvider } from './sandbox/provider.js';

export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface SandboxRunInput {
  runId: string;
  timeoutMs: number;
  /** 原样发给 runner 的任务对象（prompt + 模型 + 限额）。 */
  task: {
    prompt: string;
    model: string;
    maxTurns: number;
    maxBudgetUsd: number;
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

/** 可重试 = 基础设施瞬时故障；业务失败不重试。 */
export function isRetryable(outcome: SandboxRunOutcome): boolean {
  if (outcome.status !== 'failed') return false;
  const error = outcome.error ?? '';
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|docker: |Cannot connect to the Docker daemon|pull access denied|no such image/i.test(
    error,
  );
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
  /** 本次 run 产生的完整事件，供调用方落库。 */
  events: ChatEvent[];
}

/** SIGTERM 后留一点时间让 runner 收尾，否则强杀。 */
const KILL_GRACE_MS = 5_000;

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
  try {
    const parsed = chatEventSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      logger.warn({ line }, 'sandbox emitted non-contract event');
      return null;
    }
    return parsed.data;
  } catch {
    logger.warn({ line }, 'sandbox emitted non-JSON line');
    return null;
  }
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 启动一次沙盒 run：转发事件、处理超时与取消，返回用于落库的终态。
 * 终态 run_finished 由调用方统一发布一次，避免与 runner 输出重复。
 */
export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunOutcome> {
  const { logger, runId } = input;
  // 每次 run 都有 job，取消时按这个容器名清理。
  const containerName = `agentport-${runId.toLowerCase()}`;
  let sandbox: Awaited<ReturnType<SandboxProvider['create']>>;
  try {
    sandbox = await input.provider.create({
      image: input.image,
      workspaceDir: input.workspaceDir,
      env: input.env,
      name: containerName,
    });
  } catch (err) {
    const error = `sandbox create failed: ${toError(err)}`;
    logger.error({ err, runId }, error);
    return { status: 'failed', sandboxId: '', error, events: [] };
  }
  const child = sandbox.child;

  const events: ChatEvent[] = [];
  let reportedStatus: RunStatus | undefined;
  let reportedCost: number | undefined;
  let reportedTurns: number | undefined;
  let reportedError: string | undefined;
  let reportedSessionId: string | undefined;
  let reportedInput: number | undefined;
  let reportedOutput: number | undefined;
  let cancelled = false;
  let timedOut = false;
  let stderrTail = '';

  // 同一连接上的命令按序排队；不 await 也能保证事件顺序。
  const publish = (event: ChatEvent): void => {
    void publishRun(runId, event, logger).catch((err: unknown) => {
      logger.warn({ err, runId }, 'publish failed');
    });
  };

  const unsubscribe = await subscribeCancel(runId, logger, () => {
    cancelled = true;
    logger.info({ runId }, 'cancel requested');
    child.kill('SIGTERM');
  }).catch((err: unknown) => {
    logger.warn({ err, runId }, 'cancel subscription failed');
    return async (): Promise<void> => {};
  });

  const killTimer = setTimeout(() => {
    timedOut = true;
    logger.warn({ runId, timeoutMs: input.timeoutMs }, 'sandbox timed out');
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }, input.timeoutMs);

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
    for (const line of chunk.split('\n')) {
      if (line.trim().length > 0) logger.info({ runId, sandbox: sandbox.id }, line);
    }
  });
  child.stdin.on('error', (err) => logger.warn({ err, runId }, 'sandbox stdin closed'));

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim().length === 0) return;
    const event = parseLine(line, logger);
    if (!event) return;

    if (event.type === 'run_finished') {
      // 只记下终态，由调用方统一发布，保证每个 run 恰好一条。
      reportedStatus = event.status;
      reportedCost = event.costUsd;
      reportedTurns = event.turns;
      reportedError = event.error;
      reportedSessionId = event.sessionId;
      reportedInput = event.inputTokens;
      reportedOutput = event.outputTokens;
      return;
    }
    events.push(event);
    publish(event);
  });

  child.stdin.write(`${JSON.stringify(input.task)}\n`);

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await closed;
  } finally {
    clearTimeout(killTimer);
    lines.close();
    await unsubscribe();
    await input.provider.destroy(sandbox).catch((err: unknown) => {
      logger.warn({ err, runId }, 'sandbox cleanup failed');
    });
  }

  const budget = {
    ...(reportedCost === undefined ? {} : { costUsd: reportedCost }),
    ...(reportedTurns === undefined ? {} : { turns: reportedTurns }),
    ...(reportedSessionId === undefined ? {} : { sessionId: reportedSessionId }),
    ...(reportedInput === undefined ? {} : { inputTokens: reportedInput }),
    ...(reportedOutput === undefined ? {} : { outputTokens: reportedOutput }),
  };

  if (cancelled) {
    return { status: 'cancelled', sandboxId: sandbox.id, events, ...budget };
  }
  if (timedOut) {
    return {
      status: 'timeout',
      sandboxId: sandbox.id,
      error: `sandbox timed out after ${input.timeoutMs}ms`,
      events,
      ...budget,
    };
  }
  if (reportedStatus === undefined) {
    const suffix = stderrTail.trim();
    const detail =
      exit.code === 0
        ? 'sandbox exited without run_finished'
        : `sandbox exited with code ${String(exit.code)}${exit.signal ? ` (${exit.signal})` : ''}`;
    return {
      status: 'failed',
      sandboxId: sandbox.id,
      error: suffix ? `${detail}: ${suffix}` : detail,
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
}

async function subscribeCancel(
  runId: string,
  logger: Logger,
  onCancel: () => void,
): Promise<() => Promise<void>> {
  const redis = getCancelSubscriber(logger);
  const channel = channelFor(runId);
  // API 的 publishRun 在 cancel 频道上只发 '1'；订阅成立后先查一次键，
  // 避免 worker 在 API 发布之后才订阅而漏掉取消。
  const handler = (received: string): void => {
    if (received === channel) onCancel();
  };
  if ((await redis.exists(channel)) === 1) onCancel();
  redis.on('message', handler);
  await redis.subscribe(channel);
  return async () => {
    redis.off('message', handler);
    await redis.unsubscribe(channel).catch((err: unknown) => {
      logger.warn({ err, runId }, 'cancel unsubscribe failed');
    });
  };
}
