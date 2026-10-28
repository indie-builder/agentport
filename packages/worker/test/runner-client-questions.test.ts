import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type NativeQuestion, type RunQuestion, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMessageRows } from '../src/messages.js';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  runInSandbox,
  type SandboxQuestionCallbacks,
} from '../src/runner-client.js';
import type { SessionSandboxLease } from '../src/sandbox/sessions.js';

// 取消订阅是每个 run 的前置：必须指向本轮测试的独享 Redis，而不是开发实例。
configureRunnerClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:1/9');

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

const redisReady = await probeRedis();

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  kill(): boolean {
    return true;
  }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
} as unknown as Logger;

const task = {
  prompt: 'hi',
  model: 'test',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

const questions: [NativeQuestion] = [
  {
    question: '用哪种语言？',
    header: '语言',
    options: [
      { label: 'TypeScript', description: '默认选择' },
      { label: 'Python', description: '数据脚本' },
    ],
    multiSelect: false,
  },
];
const answers = { '用哪种语言？': 'TypeScript' };

function now(): string {
  return new Date().toISOString();
}

interface Store {
  callbacks: SandboxQuestionCallbacks;
  requested: Array<{
    requestId: string;
    toolUseId: string;
    questions: NativeQuestion[];
    expiresAt: Date;
  }>;
  rows: Map<string, RunQuestion>;
  closeCalls: Array<{ reason: string; requestId?: string }>;
}

/** 与 repo.questions 同语义的内存桩；回答由用例显式写入，模拟 API 响应。 */
function questionStore(runId: string): Store {
  const rows = new Map<string, RunQuestion>();
  const requested: Store['requested'] = [];
  const closeCalls: Store['closeCalls'] = [];
  return {
    requested,
    rows,
    closeCalls,
    callbacks: {
      request: async (event, expiresAt) => {
        requested.push({ ...event, expiresAt });
        const question: RunQuestion = {
          ...event,
          runId,
          status: 'pending',
          answers: null,
          createdAt: now(),
          resolvedAt: null,
          expiresAt: expiresAt.toISOString(),
          closeReason: null,
        };
        rows.set(question.requestId, question);
        return question;
      },
      list: async () => [...rows.values()],
      close: async (reason, requestId) => {
        closeCalls.push({ reason, ...(requestId === undefined ? {} : { requestId }) });
        const closed: RunQuestion[] = [];
        for (const question of rows.values()) {
          if (question.status !== 'pending') continue;
          if (requestId !== undefined && question.requestId !== requestId) continue;
          const next: RunQuestion = {
            ...question,
            status: 'closed',
            resolvedAt: now(),
            closeReason: reason,
          };
          rows.set(question.requestId, next);
          closed.push(next);
        }
        return closed;
      },
    },
  };
}

interface RunOptions {
  store?: Store;
  timeoutMs?: number;
  /** 模拟创建容器耗时：期限只能在创建完成、容器实际开始时起算。 */
  createDelayMs?: number;
  /** 收到 stdin 命令时回调（任务行除外）。 */
  onCommand?: (command: Record<string, unknown>, child: FakeChild) => void;
}

async function run(
  runId: string,
  emit: (child: FakeChild) => void,
  options: RunOptions = {},
): Promise<{
  outcome: Awaited<ReturnType<typeof runInSandbox>>;
  child: FakeChild;
  createdAt: number;
}> {
  const child = new FakeChild();
  let createdAt = 0;
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((chunk: string) => {
    child.writes.push(chunk);
    const parsed = JSON.parse(chunk) as Record<string, unknown>;
    if (parsed.type !== undefined) options.onCommand?.(parsed, child);
    return originalWrite(chunk);
  }) as typeof child.stdin.write;

  const lease: SessionSandboxLease = {
    sandboxId: 'fake',
    start: async ({ onEvent, task }) => {
      await new Promise((resolve) => setTimeout(resolve, options.createDelayMs ?? 0));
      createdAt = Date.now();
      const done = new Promise<import('@agentport/shared').ExecutionSettlement>((resolve) => {
        child.once('close', () => resolve({ state: 'stopped', code: 0, signal: null }));
      });
      child.stdout.on('data', (chunk) => {
        for (const line of String(chunk).trim().split('\n')) if (line) onEvent(JSON.parse(line));
      });
      child.stdin.write(`${JSON.stringify(task)}\n`);
      setTimeout(() => emit(child), 5);
      return {
        done,
        send: (command) => {
          child.stdin.write(`${JSON.stringify(command)}\n`);
        },
        cancel: async () => {
          child.emit('close', 0, null);
          return done;
        },
      };
    },
    release: async () => undefined,
  };

  const outcome = await runInSandbox({
    runId,
    timeoutMs: options.timeoutMs ?? 5_000,
    task,
    env: {},
    lease,
    logger,
    ...(options.store === undefined ? {} : { questions: options.store.callbacks }),
  });
  return { outcome, child, createdAt };
}

function questionRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'question_requested',
    requestId,
    toolUseId: `tool-${requestId}`,
    questions,
  })}\n`;
}

afterAll(async () => {
  await closeRunnerClient();
});

interface NativeSecretsRun {
  runId: string;
  outcome: Awaited<ReturnType<typeof runInSandbox>>;
  child: FakeChild;
  store: Store;
  secret: string;
  originalQuestion: string;
}

/** 原生问题、工具入参、工具结果、助手文本和错误都带着同一个凭证。 */
async function runWithNativeSecrets(): Promise<NativeSecretsRun> {
  const runId = `run-native-${randomUUID()}`;
  const store = questionStore(runId);
  const secret = 'sk-abcdefghijklmnop';
  const originalQuestion = `用 ${secret} 还是 A？`;
  const nativeQuestions: [NativeQuestion] = [
    {
      question: originalQuestion,
      header: '选择',
      options: [
        { label: secret, description: '' },
        { label: 'A', description: '' },
      ],
      multiSelect: false,
    },
  ];
  const originalRequest = store.callbacks.request;
  store.callbacks.request = async (event, expiresAt) => {
    const question = await originalRequest(event, expiresAt);
    store.rows.set(event.requestId, {
      ...question,
      status: 'answered',
      answers: { [originalQuestion]: secret },
    });
    return question;
  };
  const { outcome, child } = await run(
    runId,
    (sandbox) => {
      sandbox.stdout.write(
        `${JSON.stringify({
          type: 'question_requested',
          requestId: 'native-secrets',
          toolUseId: 'tool-native',
          questions: nativeQuestions,
        })}\n`,
      );
    },
    {
      store,
      onCommand(command, sandbox) {
        if (command.type !== 'question_response') return;
        sandbox.stdout.write(
          `${JSON.stringify({ type: 'tool_start', toolUseId: 'tool-native', name: 'AskUserQuestion' })}\n`,
        );
        sandbox.stdout.write(
          `${JSON.stringify({
            type: 'tool_input',
            toolUseId: 'tool-native',
            json: JSON.stringify({ questions: nativeQuestions }),
          })}\n`,
        );
        sandbox.stdout.write(
          `${JSON.stringify({ type: 'tool_result', toolUseId: 'tool-native', content: `用户回答：${secret}` })}\n`,
        );
        sandbox.stdout.write(
          `${JSON.stringify({ type: 'assistant_text', text: `答案是 ${secret}` })}\n`,
        );
        sandbox.stdout.write(`${JSON.stringify({ type: 'text_delta', text: `答案 ${secret}` })}\n`);
        sandbox.stdout.write(
          `${JSON.stringify({ type: 'error', message: `调用失败 ${secret}` })}\n`,
        );
        sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
        sandbox.emit('close', 0, null);
      },
    },
  );
  return { runId, outcome, child, store, secret, originalQuestion };
}

describe('runInSandbox question flow', () => {
  it('persists the question, publishes its snapshot and writes the answer back once', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const requestId = 'req-1';
    let answered = false;

    const { outcome, child } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine(requestId));
        // API 在问题落库后写入答案；poll 在 500ms 内把它带回沙盒。
        const timer = setInterval(() => {
          const question = store.rows.get(requestId);
          if (question === undefined) return;
          clearInterval(timer);
          answered = true;
          store.rows.set(requestId, {
            ...question,
            status: 'answered',
            answers,
            resolvedAt: now(),
          });
        }, 10);
      },
      {
        store,
        onCommand: (command, sandbox) => {
          if (command.type !== 'question_response') return;
          sandbox.stdout.write(
            `${JSON.stringify({
              type: 'tool_result',
              toolUseId: `tool-${requestId}`,
              content: 'User has answered your questions',
            })}\n`,
          );
          sandbox.stdout.write(
            `${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`,
          );
          sandbox.emit('close', 0, null);
        },
      },
    );

    expect(outcome.status).toBe('succeeded');
    expect(answered).toBe(true);
    expect(store.requested).toMatchObject([
      { requestId, toolUseId: `tool-${requestId}`, questions },
    ]);
    // 第一条是任务；回答只回当前工具的一次 stdin 命令，答案保持原始值。
    const commands = child.writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((command) => command.type !== undefined);
    expect(commands).toEqual([{ type: 'question_response', requestId, response: { answers } }]);
    // pending 与 answered 两份快照都进持久化事件；历史取最新一份。
    const snapshots = outcome.events.filter((event) => event.type === 'question_updated');
    expect(snapshots.at(0)).toMatchObject({
      type: 'question_updated',
      question: { requestId, status: 'pending', answers: null },
    });
    expect(snapshots.at(-1)).toMatchObject({
      type: 'question_updated',
      question: { requestId, status: 'answered', answers: { '0': 'TypeScript' } },
    });
    const history = buildMessageRows(outcome.events);
    expect(history).toHaveLength(2);
    expect(
      history.every(
        (row) => (row.content as { question?: unknown }).question === snapshots.at(-1)?.question,
      ),
    ).toBe(true);
    expect(store.closeCalls.at(-1)).toEqual({ reason: 'finished' });
  });

  it('keeps secrets in SDK stdin while SSE and history share the indexed projection', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const secret = ['sk-', 'test', 'A1b2C3d4E5f6G7h8'].join('');
    const originalQuestion = `选择 ${secret}？`;
    const rawAnswers = { [originalQuestion]: secret };
    const originalRequest = store.callbacks.request;
    store.callbacks.request = async (event, expiresAt) => {
      const question = await originalRequest(event, expiresAt);
      store.rows.set(event.requestId, { ...question, status: 'answered', answers: rawAnswers });
      return question;
    };
    const { outcome, child } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(
          `${JSON.stringify({
            type: 'question_requested',
            requestId: 'secret',
            toolUseId: 'tool-secret',
            questions: [
              {
                ...questions[0],
                question: originalQuestion,
                options: [
                  { label: secret, description: '' },
                  { label: 'Other', description: '' },
                ],
              },
            ],
          })}\n`,
        );
      },
      {
        store,
        onCommand(command, sandbox) {
          if (command.type !== 'question_response') return;
          sandbox.stdout.write(
            `${JSON.stringify({ type: 'tool_result', toolUseId: 'tool-secret', content: 'answered' })}\n`,
          );
          sandbox.stdout.write(
            `${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`,
          );
          sandbox.emit('close', 0, null);
        },
      },
    );
    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId: 'secret',
      response: { answers: rawAnswers },
    });
    const snapshots = outcome.events.filter((event) => event.type === 'question_updated');
    expect(JSON.stringify(snapshots)).not.toContain(secret);
    expect(snapshots.at(-1)?.question.answers).toEqual({ '0': 'sk-t***' });
    const history = buildMessageRows(outcome.events);
    expect(history).toHaveLength(2);
    expect(history[0]?.content).toMatchObject({ question: snapshots.at(-1)?.question });
    expect(history[1]?.content).toMatchObject({ question: snapshots.at(-1)?.question });
  });

  it('redacts every native text field before persistence while keeping SDK stdin raw', async () => {
    const { outcome, child, store, secret, originalQuestion } = await runWithNativeSecrets();

    // 库里的原问题与原答案、发给 SDK 的回答都保持原文。
    expect(store.rows.get('native-secrets')?.answers).toEqual({ [originalQuestion]: secret });
    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId: 'native-secrets',
      response: { answers: { [originalQuestion]: secret } },
    });

    // 落库/发布共享同一个事件对象：这里覆盖持久化事件，发布流由下一条用例直接核对。
    expect(JSON.stringify(outcome.events)).not.toContain(secret);
    const input = outcome.events.find((event) => event.type === 'tool_input');
    expect(input?.type).toBe('tool_input');
    if (input?.type === 'tool_input') {
      // JSON 语法必须保持完整：脱敏不能吞掉字符串的结束引号。
      const parsed = JSON.parse(input.json) as {
        questions: Array<{ question: string; options: Array<{ label: string }> }>;
      };
      expect(parsed.questions[0]?.question).toBe(originalQuestion.replace(secret, 'sk-a***'));
      expect(parsed.questions[0]?.options[0]?.label).toBe('sk-a***');
    }
    const assistant = outcome.events.find((event) => event.type === 'assistant_text');
    expect(assistant?.type === 'assistant_text' ? assistant.text : undefined).toBe(
      '答案是 sk-a***',
    );
    const result = outcome.events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' ? result.content : undefined).toBe('用户回答：sk-a***');

    const history = buildMessageRows(outcome.events);
    expect(JSON.stringify(history)).not.toContain(secret);
    const toolUse = history.find((row) => (row.content as { type?: string }).type === 'tool_use')
      ?.content as { input?: { questions?: Array<{ question?: string }> } } | undefined;
    expect(toolUse?.input?.questions?.[0]?.question).toBe(
      originalQuestion.replace(secret, 'sk-a***'),
    );
  });

  it.skipIf(!redisReady)('publishes only redacted native fields to the run stream', async () => {
    const { runId, secret, originalQuestion } = await runWithNativeSecrets();
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl === undefined) throw new Error('REDIS_URL is required');
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const payloads = async (): Promise<string[]> => {
      const entries = (await redis.xrange(runStreamKey(runId), '-', '+')) as Array<
        [string, string[]]
      >;
      return entries.map(([, fields]) => {
        const at = fields.indexOf('payload');
        return at === -1 ? '' : (fields[at + 1] ?? '');
      });
    };
    try {
      // 发布是异步的：等到最后的瞬时事件 error 入流，再核对全部事件。
      await expect
        .poll(async () => (await payloads()).join('').includes('"type":"error"'), {
          timeout: 3_000,
        })
        .toBe(true);
      const published = (await payloads()).map(
        (payload) =>
          JSON.parse(payload) as {
            type: string;
            json?: string;
          },
      );
      expect(published.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'tool_input',
          'tool_result',
          'assistant_text',
          'text_delta',
          'error',
        ]),
      );
      expect((await payloads()).join('\n')).not.toContain(secret);
      const input = published.find((event) => event.type === 'tool_input');
      expect(input?.json).toBeDefined();
      if (input?.json !== undefined) {
        const parsed = JSON.parse(input.json) as {
          questions: Array<{ question: string; options: Array<{ label: string }> }>;
        };
        expect(parsed.questions[0]?.question).toBe(originalQuestion.replace(secret, 'sk-a***'));
      }
    } finally {
      await redis.del(runStreamKey(runId));
      redis.disconnect();
    }
  });

  it('anchors the question deadline at sandbox start, not before creation', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const timeoutMs = 600;

    const { outcome, createdAt } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine('req-1'));
        sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
        sandbox.emit('close', 0, null);
      },
      { store, timeoutMs, createDelayMs: 120 },
    );

    expect(outcome.status).toBe('succeeded');
    const [requested] = store.requested;
    expect(requested).toBeDefined();
    // 期限 = 容器实际开始 + 整体 timeout；创建耗时不能挤占问答时间。
    expect(requested?.expiresAt.getTime()).toBeGreaterThanOrEqual(createdAt + timeoutMs);
    expect(requested?.expiresAt.getTime()).toBeLessThan(createdAt + timeoutMs + 300);
  });

  it('denies every pending question and fails promptly when polling rejects', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    store.callbacks.list = async () => {
      throw new Error('db down');
    };
    const startedAt = Date.now();

    const { outcome, child } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine('req-1'));
        // 不结束：轮询失败必须自己终止，不能等整体 timeout。
      },
      { store, timeoutMs: 1_200 },
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/db down/);
    expect(outcome.failure?.reason).toBe('infra');
    expect(isRetryable(outcome)).toBe(true);
    expect(store.closeCalls.at(-1)).toEqual({ reason: 'failed' });
    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId: 'req-1',
      response: { decline: true },
    });
  });

  it('fails closed and surfaces the error when the question cannot be persisted', async () => {
    const runId = `run-question-${randomUUID()}`;
    const requestId = 'req-1';
    const store = questionStore(runId);
    store.callbacks.request = async () => {
      throw new Error('db down');
    };

    const { outcome, child } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine(requestId));
        sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
        sandbox.emit('close', 0, null);
      },
      { store },
    );

    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId,
      response: { decline: true },
    });
    expect(outcome.events.some((event) => event.type === 'question_updated')).toBe(false);
    // 落库错误不吞：成功终态也带上显式说明。
    expect(outcome.error).toMatch(/问题记录失败：db down/);
  });

  it('closes pending questions on timeout without replaying any answer', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const requestId = 'req-1';

    const { outcome, child } = await run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine(requestId));
        // 不结束：让整体 timeout 收尾。
      },
      { store, timeoutMs: 40 },
    );

    expect(outcome.status).toBe('timeout');
    expect(store.closeCalls.at(-1)).toEqual({ reason: 'timeout' });
    expect(
      child.writes.map((line) => JSON.parse(line)).filter((c) => c.type !== undefined),
    ).toEqual([]);
    const last = outcome.events.filter((event) => event.type === 'question_updated').at(-1);
    expect(last).toMatchObject({
      type: 'question_updated',
      question: { requestId, status: 'closed', closeReason: 'timeout' },
    });
  });

  it('does not let run_finished overtake an unfinished question write', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const requestId = 'req-1';
    const originalRequest = store.callbacks.request;
    let resolveRequest: (() => void) | undefined;
    store.callbacks.request = async (event, expiresAt) => {
      await new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
      return originalRequest(event, expiresAt);
    };

    const running = run(
      runId,
      (sandbox) => {
        sandbox.stdout.write(questionRequestLine(requestId));
        sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
        sandbox.emit('close', 0, null);
      },
      {
        store,
        onCommand: (command, sandbox) => {
          if (command.type !== 'question_response') return;
          sandbox.stdout.write(
            `${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`,
          );
          sandbox.emit('close', 0, null);
        },
      },
    );

    // 问题落库还没完成时 run_finished 已到：结果必须等写入排空后才能返回。
    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveRequest?.();
    const { outcome } = await running;

    expect(outcome.status).toBe('succeeded');
    expect(outcome.events.some((event) => event.type === 'question_updated')).toBe(true);
    // 未回答的 pending 在收尾时关闭，而不是留一张永远 pending 的卡片。
    expect(store.rows.get(requestId)?.status).toBe('closed');
  });

  it('refuses a question when the host has no store', async () => {
    const runId = `run-question-${randomUUID()}`;
    const requestId = 'req-1';

    const { outcome, child } = await run(runId, (sandbox) => {
      sandbox.stdout.write(questionRequestLine(requestId));
      sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
      sandbox.emit('close', 0, null);
    });

    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId,
      response: { decline: true },
    });
    expect(outcome.error).toMatch(/问题记录失败/);
  });
});
