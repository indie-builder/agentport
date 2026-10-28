import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { ChatEvent, ExecutionSettlement } from '@agentport/shared';
import { runStreamKey } from '@agentport/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { persistRunMessages } from '../src/messages.js';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  runInSandbox,
} from '../src/runner-client.js';
import type { SessionSandboxLease } from '../src/sandbox/sessions.js';

async function probeRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return false;
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const redisUrl = process.env.REDIS_URL ?? '';
const ready = await probeRedis();
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const dbReady = await pool.query('select 1').then(
  () => true,
  () => false,
);
const agentIds: string[] = [];

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

/** 记录 warn：清理失败的可见性本身也要有回归。 */
function recordingLogger(): {
  logger: Logger;
  warnings: Array<{ fields: unknown; message: string }>;
} {
  const warnings: Array<{ fields: unknown; message: string }> = [];
  const logger = {
    info: () => undefined,
    warn: (fields: unknown, message: string) => {
      warnings.push({ fields, message });
    },
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  } as unknown as Logger;
  return { logger, warnings };
}

interface RunOptions {
  destroy?: () => Promise<void>;
  timeoutMs?: number;
  logger?: Logger;
  /** 覆盖默认 provider，用于观察 create 收到的 AbortSignal。 */
  provider?: SessionSandboxLease;
  /** 写出全部 NDJSON 后模拟容器结局；默认正常退出。 */
  finish?: (child: FakeChild) => void;
}

const task = {
  prompt: 'hi',
  model: 'test',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

function runInput(
  runId: string,
  lease: SessionSandboxLease,
  logger: Logger = quietLogger,
  timeoutMs = 5_000,
) {
  return {
    runId,
    timeoutMs,
    task,
    env: {},
    lease,
    logger,
  };
}

/** create 返回后由用例写出全部 NDJSON，再模拟容器退出。 */
function fakeProvider(
  child: FakeChild,
  emitLines: () => void,
  destroy: () => Promise<void> = async () => undefined,
): SessionSandboxLease {
  return {
    sandboxId: 'fake',
    start: async ({ onEvent, onStderr }) => {
      let finish: (value: ExecutionSettlement) => void = () => undefined;
      const done = new Promise<ExecutionSettlement>((resolve) => {
        finish = resolve;
      });
      child.stdout.on('data', (chunk) => {
        for (const line of String(chunk).trim().split('\n')) if (line) onEvent(JSON.parse(line));
      });
      child.stderr.on('data', (chunk) => onStderr(String(chunk)));
      child.once('close', (code, signal) => finish({ state: 'stopped', code, signal }));
      child.once('error', (error) => finish({ state: 'unconfirmed', error: error.message }));
      setTimeout(emitLines, 5);
      return {
        done,
        send() {},
        cancel: async () => {
          finish({ state: 'unconfirmed', error: 'cancel unconfirmed' });
          return done;
        },
      };
    },
    release: destroy,
  };
}

async function runWith(lines: ChatEvent[], runId: string, options: RunOptions = {}) {
  configureRunnerClient(redisUrl);
  const child = new FakeChild();
  const outcome = await runInSandbox(
    runInput(
      runId,
      options.provider ??
        fakeProvider(
          child,
          () => {
            for (const event of lines) child.stdout.write(`${JSON.stringify(event)}\n`);
            (options.finish ?? ((c: FakeChild) => c.emit('close', 0, null)))(child);
          },
          options.destroy,
        ),
      options.logger ?? quietLogger,
      options.timeoutMs ?? 5_000,
    ),
  );
  return { outcome, child };
}

/** 发布是 fire-and-forget：轮询到写端追上目标事件，而不是假设终态返回时 Redis 已有数据。 */
async function waitForLastEvent(
  runId: string,
  type: ChatEvent['type'],
): Promise<string | undefined> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [entry] = (await redis.xrevrange(runStreamKey(runId), '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >;
      const payload = entry?.[1]?.[1];
      if (payload !== undefined && JSON.parse(payload).type === type) return payload;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return undefined;
  } finally {
    redis.disconnect();
  }
}

afterAll(async () => {
  if (dbReady) {
    // 删 agent 级联清掉会话、run、消息。
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
  }
  await pool.end();
  await closeRunnerClient();
});

describe.skipIf(!ready)('runInSandbox event budgets', () => {
  it('keeps complete messages after transient deltas exhaust the display budget', async () => {
    const runId = `run-limits-${randomUUID()}`;
    const lines: ChatEvent[] = [];
    for (let index = 0; index < 2_050; index += 1) {
      lines.push({ type: 'text_delta', text: 'x', blockIndex: 0 });
    }
    lines.push({ type: 'assistant_text', text: '完整回答', blockIndex: 0, sdkUuid: 'msg-1' });
    lines.push({ type: 'run_finished', status: 'succeeded' });

    const { outcome } = await runWith(lines, runId);

    expect(outcome.status).toBe('succeeded');
    // 瞬时增量不落库，更不能用它们挤掉同一次运行里的完整消息。
    expect(outcome.events.map((event) => event.type)).toEqual(['assistant_text']);
    expect(outcome.events[0]).toMatchObject({ text: '完整回答', streamBlockId: 'b0' });

    // 展示端可以截断增量，但完整的 assistant_text 仍必须发出。
    const published = await waitForLastEvent(runId, 'assistant_text');
    expect(published).toBeDefined();
    expect(JSON.parse(published ?? '{}')).toMatchObject({
      type: 'assistant_text',
      text: '完整回答',
    });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      // 增量展示确实被截断：完整消息之前紧挨着一条截断标记。
      const entries = (await redis.xrevrange(runStreamKey(runId), '+', '-', 'COUNT', 2)) as Array<
        [string, string[]]
      >;
      const payloads = entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}'));
      expect(payloads[0]).toMatchObject({ type: 'assistant_text', text: '完整回答' });
      expect(payloads[1]).toEqual({ type: 'error', message: '输出超出上限' });
    } finally {
      await redis.del(runStreamKey(runId));
      redis.disconnect();
    }
  });

  it('fails a succeeded run when the persisted event count overflows', async () => {
    const runId = `run-limits-${randomUUID()}`;
    const lines: ChatEvent[] = [];
    for (let index = 0; index < 2_050; index += 1) {
      lines.push({ type: 'assistant_text', text: 'x', blockIndex: 0 });
    }
    lines.push({
      type: 'run_finished',
      status: 'succeeded',
      costUsd: 0.25,
      turns: 3,
      sessionId: 'sdk-session',
      inputTokens: 10,
      outputTokens: 20,
    });

    const { outcome } = await runWith(lines, runId);

    // 落库被截断时 SDK session 仍完整，报成功会让刷新后的历史与实时流不一致。
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/保存上限/);
    expect(outcome.failure).toMatchObject({ reason: 'agent' });
    expect(isRetryable(outcome)).toBe(false);
    // 预算与会话信息仍保留，供续聊与读数使用。
    expect(outcome).toMatchObject({
      costUsd: 0.25,
      turns: 3,
      sessionId: 'sdk-session',
      inputTokens: 10,
      outputTokens: 20,
    });
    // 保护仍然存在：2050 条完整消息不会全部留下，已收集的部分保留。
    expect(outcome.events.length).toBe(2_001);
    expect(outcome.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/保存上限/),
    });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });

  it('fails a succeeded run when the persisted bytes overflow below the event count limit', async () => {
    const runId = `run-limits-${randomUUID()}`;
    const chunk = 'x'.repeat(7_000_000);
    const lines: ChatEvent[] = [];
    // 单行仍在 8MiB 行上限内，累计字节跨过 32MiB 的落库上限。
    for (let index = 0; index < 5; index += 1) {
      lines.push({ type: 'assistant_text', text: chunk, blockIndex: index });
    }
    lines.push({ type: 'run_finished', status: 'succeeded', sessionId: 'sdk-bytes' });

    const { outcome } = await runWith(lines, runId);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/保存上限/);
    expect(outcome.failure).toMatchObject({ reason: 'agent' });
    expect(outcome.sessionId).toBe('sdk-bytes');
    expect(outcome.events.length).toBeLessThan(6);
    expect(outcome.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/保存上限/),
    });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });
});

describe.skipIf(!ready)('runInSandbox cleanup failures', () => {
  const failingDestroy = async (): Promise<void> => {
    throw new Error('docker rm -f fake failed');
  };

  it('keeps a succeeded run complete without releasing its lease', async () => {
    const { logger, warnings } = recordingLogger();
    const runId = `run-cleanup-${randomUUID()}`;
    const lines: ChatEvent[] = [
      { type: 'assistant_text', text: '完成', blockIndex: 0, sdkUuid: 'msg-1' },
      {
        type: 'run_finished',
        status: 'succeeded',
        costUsd: 0.25,
        turns: 3,
        sessionId: 'sdk-session',
        inputTokens: 10,
        outputTokens: 20,
      },
    ];

    const { outcome } = await runWith(lines, runId, { destroy: failingDestroy, logger });

    // 已完成任务的清理失败只影响容器，不改业务结果，也不能触发重跑。
    expect(outcome.status).toBe('succeeded');
    expect(outcome.failure).toBeUndefined();
    expect(outcome.error).toBeUndefined();
    expect(isRetryable(outcome)).toBe(false);
    expect(outcome).toMatchObject({
      sandboxId: 'fake',
      costUsd: 0.25,
      turns: 3,
      sessionId: 'sdk-session',
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(outcome.events).toEqual([
      expect.objectContaining({ type: 'assistant_text', text: '完成' }),
    ]);
    expect(warnings).toEqual([]);
    expect(outcome.cleanupError).toBeUndefined();
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });

  it('reports no cleanupError when the sandbox stopped cleanly', async () => {
    const runId = `run-cleanup-${randomUUID()}`;
    const { outcome } = await runWith([{ type: 'run_finished', status: 'succeeded' }], runId);

    expect(outcome.cleanupError).toBeUndefined();
    expect(outcome).not.toHaveProperty('cleanupError');

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });

  it('keeps an agent failure, its error and budget when cleanup fails', async () => {
    const runId = `run-cleanup-${randomUUID()}`;
    const lines: ChatEvent[] = [
      {
        type: 'run_finished',
        status: 'failed',
        failureKind: 'agent',
        error: '模型拒绝请求',
        costUsd: 0.5,
        turns: 2,
        sessionId: 'sdk-failed',
      },
    ];

    const { outcome } = await runWith(lines, runId, { destroy: failingDestroy });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('模型拒绝请求');
    expect(outcome.failure).toMatchObject({ reason: 'agent', message: '模型拒绝请求' });
    expect(isRetryable(outcome)).toBe(false);
    expect(outcome).toMatchObject({ costUsd: 0.5, turns: 2, sessionId: 'sdk-failed' });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });

  it('keeps a timeout and its error when cleanup fails', async () => {
    const runId = `run-cleanup-${randomUUID()}`;
    const { outcome } = await runWith([], runId, {
      destroy: failingDestroy,
      timeoutMs: 20,
      finish: () => undefined,
    });

    expect(outcome.status).toBe('timeout');
    expect(outcome.error).toMatch(/timed out/);
    expect(outcome.failure).toMatchObject({ reason: 'timeout' });
    expect(isRetryable(outcome)).toBe(false);

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });

  it('does not retry an uncertain execution when cleanup fails', async () => {
    const runId = `run-cleanup-${randomUUID()}`;
    const { outcome } = await runWith([], runId, {
      destroy: failingDestroy,
      finish: (child) => child.emit('error', new Error('docker run failed')),
    });

    // 执行状态不明且销毁失败时不能重跑副作用。
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('docker run failed');
    expect(outcome.failure).toMatchObject({ reason: 'sandbox', message: 'docker run failed' });
    expect(outcome.cleanupError).toBe('docker rm -f fake failed');
    expect(isRetryable(outcome)).toBe(false);

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });
});

describe.skipIf(!ready || !dbReady)('runInSandbox cleanup persistence', () => {
  it('persists the completed messages and session when cleanup fails', async () => {
    const agentId = newId('agent');
    const conversationId = newId('conversation');
    const runId = newId('run');
    agentIds.push(agentId);
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `cleanup-${agentId.slice(4)}`,
      name: 'cleanup',
      model: 'test',
    });
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'cleanup' });
    await repo.chat.createRun(db, { id: runId, conversationId, agentId });
    await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));

    const lines: ChatEvent[] = [
      { type: 'assistant_text', text: '完整回答', blockIndex: 0, sdkUuid: 'msg-1' },
      {
        type: 'run_finished',
        status: 'succeeded',
        costUsd: 0.5,
        turns: 2,
        sessionId: 'sdk-cleanup',
        inputTokens: 3,
        outputTokens: 4,
      },
    ];

    const { outcome } = await runWith(lines, runId, {
      destroy: async () => {
        throw new Error('docker rm -f fake failed');
      },
    });

    expect(outcome.status).toBe('succeeded');
    expect(isRetryable(outcome)).toBe(false);
    expect(outcome).toMatchObject({ costUsd: 0.5, turns: 2, sessionId: 'sdk-cleanup' });

    const persisted = await persistRunMessages(db, {
      agentId,
      conversationId,
      runId,
      events: outcome.events,
      ...(outcome.sessionId === undefined ? {} : { sdkSessionId: outcome.sessionId }),
    });
    expect(persisted.written).toBe(true);

    const rows = await db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(eq(schema.messages.runId, runId), eq(schema.messages.role, 'assistant')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toMatchObject({ text: '完整回答' });
    expect(await repo.chat.getConversationSdkState(db, conversationId)).toMatchObject({
      sdkSessionId: 'sdk-cleanup',
    });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });
});

describe.skipIf(!ready || !dbReady)('runInSandbox byte overflow persistence', () => {
  it('persists the retained events and keeps the session after the overflow', async () => {
    const agentId = newId('agent');
    const conversationId = newId('conversation');
    const runId = newId('run');
    agentIds.push(agentId);
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `limits-${agentId.slice(4)}`,
      name: 'limits',
      model: 'test',
    });
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'limits' });
    await repo.chat.createRun(db, { id: runId, conversationId, agentId });
    await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));

    const chunk = 'x'.repeat(7_000_000);
    const lines: ChatEvent[] = [];
    for (let index = 0; index < 5; index += 1) {
      lines.push({ type: 'assistant_text', text: chunk, blockIndex: index });
    }
    lines.push({ type: 'run_finished', status: 'succeeded', sessionId: 'sdk-bytes' });

    const { outcome } = await runWith(lines, runId);

    // 落库被截断后不能回报成功，也不能因为字节超限交给 BullMQ 重试。
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/保存上限/);
    expect(isRetryable(outcome)).toBe(false);
    expect(outcome.sessionId).toBe('sdk-bytes');

    // 落库消费的正是 runner 返回的 outcome.events，而不是另造一份事件。
    const persisted = await persistRunMessages(db, {
      agentId,
      conversationId,
      runId,
      events: outcome.events,
      ...(outcome.sessionId === undefined ? {} : { sdkSessionId: outcome.sessionId }),
    });
    expect(persisted.written).toBe(true);

    const rows = await db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(eq(schema.messages.runId, runId), eq(schema.messages.role, 'assistant')));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => (row.content as { text?: string }).text?.length === 7_000_000)).toBe(
      true,
    );
    expect(await repo.chat.getConversationSdkState(db, conversationId)).toMatchObject({
      sdkSessionId: 'sdk-bytes',
    });

    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.del(runStreamKey(runId));
    redis.disconnect();
  });
});
