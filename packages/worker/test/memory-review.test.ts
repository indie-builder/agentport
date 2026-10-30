import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { RUNS_QUEUE, runCancelKey } from '@agentport/shared';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeMemoryReview, type MemoryReviewQueryFn } from '../src/memory-review.js';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  run: vi.fn(),
  query: vi.fn(),
  processors: new Map<string, (job: unknown) => Promise<void>>(),
  dbHandles: [] as Array<{ pool: { end(): Promise<void> } }>,
}));

vi.mock('@agentport/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/db')>();
  return {
    ...actual,
    createDb: (...args: Parameters<typeof actual.createDb>) => {
      const handle = actual.createDb(...args);
      mocks.dbHandles.push(handle);
      return handle;
    },
  };
});

// 进程级守卫会把测试里任何未处理异常变成 process.exit；这里只验证 worker 分流。
vi.mock('@agentport/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core')>();
  return { ...actual, installProcessGuards: () => undefined };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: mocks.query };
});

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class Worker {
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      mocks.processors.set(_name, processor);
    }
    on(): this {
      return this;
    }
    async close(): Promise<void> {}
  }
  return { ...actual, Worker };
});

vi.mock('../src/sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    async destroyAll(): Promise<void> {}
    async ensureImage(): Promise<void> {}
  },
  resolveLocalImageId: async () => `sha256:${'a'.repeat(64)}`,
}));

vi.mock('../src/sandbox/sessions.js', () => ({
  SessionSandboxes: class {
    async close(): Promise<void> {}
  },
}));

vi.mock('../src/runner-client.js', () => ({
  configureRunnerClient: vi.fn(),
  closeRunnerClient: vi.fn(),
  acquireSessionSandbox: mocks.acquire,
  runInSandbox: mocks.run,
  publishRun: vi.fn(async () => undefined),
  isRetryable: () => false,
}));

vi.mock('../src/runtime-environments/default.js', () => ({
  ensureDefaultEnvironment: async () => undefined,
  startDefaultEnvironmentRetry: () => async () => undefined,
}));

vi.mock('../src/runtime-environments/build.js', () => ({
  startRuntimeEnvironmentBuildWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/runtime-environments/reconcile.js', () => ({
  startRuntimeEnvironmentBuildReconciler: () => () => undefined,
}));

vi.mock('../src/reconcile.js', () => ({
  startReconciler: () => () => undefined,
}));

vi.mock('../src/knowledge/queue.js', () => ({
  startKnowledgeWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/knowledge/reconcile.js', () => ({
  startKnowledgeReconciler: () => () => undefined,
}));

vi.mock('../src/knowledge/scheduler.js', () => ({
  startKnowledgeScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

vi.mock('../src/scheduler.js', () => ({
  startScheduleScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

vi.mock('../src/maintenance.js', () => ({
  startMaintenanceWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/sandbox-probe.js', () => ({
  registerSandboxProbe: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/native-plugins.js', () => ({
  registerNativePlugins: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/eval-runner.js', () => ({
  executeEvalRun: async () => undefined,
  closeEvalRunQueue: async () => undefined,
}));

vi.mock('../src/model-proxy.js', () => ({
  startModelProxy: async () => null,
}));

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

async function probeDatabase(): Promise<boolean> {
  try {
    await dbHandle.pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

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

const dbReady = await probeDatabase();
const redisReady = await probeRedis();
const ready = dbReady && redisReady;
const redisUrl = process.env.REDIS_URL ?? '';

const userId = newId('user');
const agentId = newId('agent');
const agentSlug = `review-${agentId.slice(4, 12)}`;

interface Seeded {
  conversationId: string;
  runId: string;
  messageIds: string[];
}

async function seed(
  input: {
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
    target?: unknown;
    instruction?: string;
    before?: { content: string | null; globs: string | null };
  },
  options: { status?: 'queued' | 'running' } = {},
): Promise<Seeded> {
  const conversationId = newId('conversation');
  const runId = newId('run');
  await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'review source' });
  const messageIds: string[] = [];
  for (const message of input.messages) {
    const id = newId('message');
    messageIds.push(id);
    await repo.chat.appendMessage(db, {
      id,
      conversationId,
      role: message.role,
      content: { type: 'text', text: message.text },
    });
  }
  // repo.chat.createRun 的 trigger 类型暂未包含 review，这里按真实行形状落库。
  await db.insert(schema.agentRuns).values({
    id: runId,
    conversationId,
    agentId,
    trigger: 'review',
    status: options.status ?? 'running',
    ...(options.status === 'queued' ? {} : { startedAt: new Date() }),
  });
  await repo.memoryReviews.insert(db, {
    runId,
    userId,
    modelAgentId: agentId,
    requestKey: runId,
    requestHash: `hash-${runId}`,
    target: (input.target ?? { kind: 'personal' }) as never,
    sources: [{ conversationId }],
    instruction: input.instruction ?? '',
    before: input.before ?? { content: null, globs: null },
  });
  return { conversationId, runId, messageIds };
}

interface Captured {
  prompt: string;
  options: Options;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  } as unknown as SDKMessage;
}

function reply(messages: SDKMessage[], captured: Captured[]): MemoryReviewQueryFn {
  return ({ prompt, options }) => {
    captured.push({ prompt, options });
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

async function runOf(runId: string) {
  const [row] = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  return row;
}

async function messagesOf(runId: string) {
  return db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.runId, runId));
}

beforeAll(async () => {
  if (!ready) return;
  await db.insert(schema.authUsers).values({
    id: userId,
    name: 'memory review',
    email: `memory-review-${userId.slice(4)}@test.local`,
  });
  await db.insert(schema.agents).values({
    id: agentId,
    slug: agentSlug,
    name: 'review',
    model: 'review-model',
    maxTurns: 3,
    maxBudgetUsd: '0.5',
  });
});

afterAll(async () => {
  if (ready) {
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
  }
  for (const handle of mocks.dbHandles) await handle.pool.end();
});

describe.skipIf(!ready)('executeMemoryReview', () => {
  it('writes a complete proposal with valid evidence and only real SDK spend', async () => {
    const seeded = await seed({
      messages: [
        { role: 'user', text: '以后请始终用中文回答，并且先给结论。' },
        { role: 'assistant', text: '好的，我会记住。' },
      ],
    });
    const captured: Captured[] = [];
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              structured_output: {
                summary: '记录语言与结论优先偏好',
                proposedContent: '始终用中文回答，并且先给结论。',
                evidence: [{ messageId: seeded.messageIds[0], quote: '始终用中文' }],
              },
              total_cost_usd: 0.0123,
              num_turns: 2,
              usage: { input_tokens: 100, output_tokens: 20 },
            }),
          ],
          captured,
        ),
      },
    );

    const options = captured[0]?.options;
    expect(options).toMatchObject({
      model: 'review-model',
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      permissionMode: 'dontAsk',
      persistSession: false,
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      outputFormat: { type: 'json_schema' },
    });
    expect(options?.env).toMatchObject({
      HOME: options?.cwd,
      CLAUDE_CONFIG_DIR: options?.cwd,
    });
    expect(options?.env).not.toHaveProperty('DATABASE_URL');
    expect(captured[0]?.prompt).toContain('## 历史资料');
    expect(captured[0]?.prompt).toContain('## 本次要求');
    expect(captured[0]?.prompt).toContain('当前内容：');
    expect(captured[0]?.prompt).not.toContain('MEMORY.md 是索引');

    const review = await repo.memoryReviews.find(db, seeded.runId);
    expect(review?.proposal).toEqual({
      summary: '记录语言与结论优先偏好',
      proposedContent: '始终用中文回答，并且先给结论。',
      evidence: [{ messageId: seeded.messageIds[0], quote: '始终用中文' }],
    });
    expect(await runOf(seeded.runId)).toMatchObject({
      status: 'succeeded',
      costUsd: '0.0123',
      turns: 2,
      inputTokens: 100,
      outputTokens: 20,
      error: null,
      sandboxId: null,
      sessionId: null,
    });
    expect(await messagesOf(seeded.runId)).toHaveLength(0);
    expect(existsSync(options?.cwd ?? '')).toBe(false);
  });

  it('keeps the MEMORY.md index contract in the agent memory prompt', async () => {
    const seeded = await seed({
      target: { kind: 'agent_memory', agentId },
      messages: [{ role: 'user', text: '记得保留主题链接。' }],
    });
    const captured: Captured[] = [];
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              structured_output: {
                summary: '更新索引项',
                proposedContent: '- [主题](topic.md)',
                evidence: [{ messageId: seeded.messageIds[0], quote: '主题链接' }],
              },
            }),
          ],
          captured,
        ),
      },
    );

    const prompt = captured[0]?.prompt ?? '';
    expect(prompt).toContain('MEMORY.md 是索引：保留已有主题链接与结构');
    expect(prompt).toContain('不要创建新文件');
    expect(prompt).toContain('最多 200 行 / 25KB');
  });

  it('fails when evidence is not found in the saved snapshot', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              structured_output: {
                summary: '提案',
                proposedContent: '回答要短。',
                evidence: [{ messageId: seeded.messageIds[0], quote: '这句话不在原文里' }],
              },
            }),
          ],
          [],
        ),
      },
    );

    expect(await runOf(seeded.runId)).toMatchObject({ status: 'failed' });
    expect((await runOf(seeded.runId))?.error).toContain('不是消息原文');
    expect((await repo.memoryReviews.find(db, seeded.runId))?.proposal).toBeNull();
  });

  it('fails when the model returns no structured output', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      { queryFn: reply([resultMessage()], []) },
    );

    expect(await runOf(seeded.runId)).toMatchObject({ status: 'failed' });
    expect((await runOf(seeded.runId))?.error).toContain('没有返回结构化结果');
  });

  it('succeeds with a null proposedContent when the material is insufficient', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '今天先这样吧。' }] });
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              structured_output: {
                summary: '没有可复用内容',
                proposedContent: null,
                evidence: [],
              },
            }),
          ],
          [],
        ),
      },
    );

    expect(await runOf(seeded.runId)).toMatchObject({ status: 'succeeded' });
    expect((await repo.memoryReviews.find(db, seeded.runId))?.proposal).toEqual({
      summary: '没有可复用内容',
      proposedContent: null,
      evidence: [],
    });
  });

  it('cancels through the run cancel channel and cleans up the SDK directory', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const captured: Captured[] = [];
    const queryFn: MemoryReviewQueryFn = ({ prompt, options }) => {
      captured.push({ prompt, options });
      return (async function* () {
        started();
        await new Promise<void>((resolve) => {
          const signal = options.abortController?.signal;
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      })();
    };

    const execution = executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      { queryFn },
    );
    await startedPromise;
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await redis.publish(runCancelKey(seeded.runId), '1');
    } finally {
      redis.disconnect();
    }
    await execution;

    expect(await runOf(seeded.runId)).toMatchObject({ status: 'cancelled', error: 'cancelled' });
    expect(existsSync(captured[0]?.options.cwd ?? '')).toBe(false);
  });

  it('records a real failure and spend when the SDK hits the budget', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              subtype: 'error_max_budget_usd',
              is_error: true,
              errors: ['budget exhausted'],
              total_cost_usd: 0.2,
              num_turns: 1,
              usage: { input_tokens: 50, output_tokens: 10 },
            }),
          ],
          [],
        ),
      },
    );

    expect(await runOf(seeded.runId)).toMatchObject({
      status: 'failed',
      costUsd: '0.2000',
      turns: 1,
      inputTokens: 50,
      outputTokens: 10,
    });
    expect((await runOf(seeded.runId))?.error).toContain('error_max_budget_usd');
    expect((await runOf(seeded.runId))?.error).toContain('budget exhausted');
  });

  it('times out a hanging SDK query and cleans up the temporary directory', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    await db.update(schema.agents).set({ timeoutMs: 50 }).where(eq(schema.agents.id, agentId));
    let aborted = false;
    const captured: Captured[] = [];
    const queryFn: MemoryReviewQueryFn = ({ options }) => {
      captured.push({ prompt: '', options });
      return (async function* () {
        await new Promise<void>((resolve) => {
          const signal = options.abortController?.signal;
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
        });
      })();
    };
    try {
      await executeMemoryReview(
        db,
        { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
        { queryFn },
      );
    } finally {
      await db
        .update(schema.agents)
        .set({ timeoutMs: 600_000 })
        .where(eq(schema.agents.id, agentId));
    }

    expect(aborted).toBe(true);
    expect(await runOf(seeded.runId)).toMatchObject({
      status: 'failed',
      error: '历史回顾超时',
    });
    expect(existsSync(captured[0]?.options.cwd ?? '')).toBe(false);
  });

  it('keeps shutdown as the first termination reason when the deadline passes', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    await db.update(schema.agents).set({ timeoutMs: 50 }).where(eq(schema.agents.id, agentId));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const queryFn: MemoryReviewQueryFn = ({ options }) => {
      return (async function* () {
        started();
        await new Promise<void>((resolve) => {
          const signal = options.abortController?.signal;
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      })();
    };
    const shutdown = new AbortController();
    try {
      const execution = executeMemoryReview(
        db,
        { runId: seeded.runId, redisUrl, signal: shutdown.signal },
        { queryFn },
      );
      await startedPromise;
      shutdown.abort();
      // 关停已发生，再跨过 timeoutMs；首个原因不能被随后的 deadline 覆盖。
      await new Promise((resolve) => setTimeout(resolve, 120));
      await execution;
    } finally {
      await db
        .update(schema.agents)
        .set({ timeoutMs: 600_000 })
        .where(eq(schema.agents.id, agentId));
    }

    expect(await runOf(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error: 'worker 关停',
    });
  });

  it('redacts credentials from the stored failure message', async () => {
    const seeded = await seed({ messages: [{ role: 'user', text: '请把回答写短一点。' }] });
    const token = `sk-${'a'.repeat(32)}`;
    await executeMemoryReview(
      db,
      { runId: seeded.runId, redisUrl, signal: new AbortController().signal },
      {
        queryFn: reply(
          [
            resultMessage({
              subtype: 'error_max_turns',
              is_error: true,
              errors: [`upstream rejected ${token}`],
            }),
          ],
          [],
        ),
      },
    );

    const run = await runOf(seeded.runId);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run?.error).not.toContain(token);
    expect(run?.error).toContain('sk-a***');
  });

  it('refuses a run that is not a memory review', async () => {
    const conversationId = newId('conversation');
    const runId = newId('run');
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'chat' });
    await repo.chat.createRun(db, { id: runId, conversationId, agentId });
    const queryFn = vi.fn<MemoryReviewQueryFn>();

    await expect(
      executeMemoryReview(
        db,
        { runId, redisUrl, signal: new AbortController().signal },
        { queryFn },
      ),
    ).rejects.toThrow('不是记忆审核');
    expect(queryFn).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ready)('worker trigger routing', () => {
  let workdir = '';

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'worker-memory-review-'));
    process.env.WORKSPACES_DIR = workdir;
    process.env.HOST_WORKSPACES_DIR = workdir;
    const sigterm = new Set(process.listeners('SIGTERM'));
    const sigint = new Set(process.listeners('SIGINT'));
    await import('../src/index.js');
    // 测试进程不接管真实关停信号。
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigterm.has(listener)) process.off('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!sigint.has(listener)) process.off('SIGINT', listener);
    }
  });

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('routes a review run straight to executeMemoryReview without touching the sandbox', async () => {
    mocks.acquire.mockReset();
    mocks.run.mockReset();
    mocks.query.mockReset();
    const seeded = await seed(
      { messages: [{ role: 'user', text: '以后请始终用中文回答。' }] },
      { status: 'queued' },
    );
    mocks.query.mockImplementation(() =>
      (async function* () {
        yield resultMessage({
          structured_output: {
            summary: '记录中文偏好',
            proposedContent: '始终用中文回答。',
            evidence: [{ messageId: seeded.messageIds[0], quote: '始终用中文' }],
          },
        });
      })(),
    );

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({
      data: {
        runId: seeded.runId,
        agentId,
        conversationId: seeded.conversationId,
        prompt: '队列里的 prompt 不能被当作审核内容',
      },
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    expect(await runOf(seeded.runId)).toMatchObject({ status: 'succeeded' });
    expect((await repo.memoryReviews.find(db, seeded.runId))?.proposal).not.toBeNull();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await messagesOf(seeded.runId)).toHaveLength(0);
    expect(existsSync(join(workdir, agentSlug, seeded.runId))).toBe(false);
  });

  it('leaves ordinary chat runs on the sandbox path', async () => {
    mocks.acquire.mockReset();
    mocks.run.mockReset();
    mocks.query.mockReset();
    const conversationId = newId('conversation');
    const runId = newId('run');
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'chat' });
    await repo.chat.createRun(db, { id: runId, conversationId, agentId });
    mocks.acquire.mockRejectedValue(new Error('stop after routing'));

    const processor = mocks.processors.get(RUNS_QUEUE);
    await processor?.({
      data: { runId, agentId, conversationId, prompt: 'hello' },
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
