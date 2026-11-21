import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type NativeQuestion, type RunQuestion, runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import { buildMessageRows } from '../src/messages.js';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  runInSandbox,
  type SandboxQuestionCallbacks,
} from '../src/runner-client.js';
import type { SessionSandboxLease } from '../src/sandbox/sessions.js';
import { probeBunRedis } from './fixtures/bun-redis.js';
import { waitFor } from './fixtures/native-test.js';

configureRunnerClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:1/9');

async function probeRedis(): Promise<boolean> {
  return probeBunRedis(process.env.REDIS_URL);
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
  createDelayMs?: number;
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
          return true;
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
    const commands = child.writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((command) => command.type !== undefined);
    expect(commands).toEqual([{ type: 'question_response', requestId, response: { answers } }]);
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

    expect(store.rows.get('native-secrets')?.answers).toEqual({ [originalQuestion]: secret });
    expect(child.writes.map((line) => JSON.parse(line))).toContainEqual({
      type: 'question_response',
      requestId: 'native-secrets',
      response: { answers: { [originalQuestion]: secret } },
    });

    expect(JSON.stringify(outcome.events)).not.toContain(secret);
    const input = outcome.events.find((event) => event.type === 'tool_input');
    expect(input?.type).toBe('tool_input');
    if (input?.type === 'tool_input') {
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
    const redis = new RedisClient(redisUrl);
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
      await waitFor(
        async () => expect((await payloads()).join('').includes('"type":"error"')).toBe(true),
        { timeout: 3_000 },
      );
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
      redis.close();
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

    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveRequest?.();
    const { outcome } = await running;

    expect(outcome.status).toBe('succeeded');
    expect(outcome.events.some((event) => event.type === 'question_updated')).toBe(true);
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

  it('counts question snapshots toward the persisted budget and fails after settle overflow', async () => {
    const runId = `run-question-${randomUUID()}`;
    const store = questionStore(runId);
    const requestId = 'req-budget';

    const { outcome } = await run(
      runId,
      (sandbox) => {
        for (let index = 0; index < 1_999; index += 1) {
          sandbox.stdout.write(
            `${JSON.stringify({ type: 'assistant_text', text: 'x', blockIndex: 0 })}\n`,
          );
        }
        sandbox.stdout.write(questionRequestLine(requestId));
        sandbox.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
        sandbox.emit('close', 0, null);
      },
      { store },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/保存上限/);
    expect(outcome.failure).toMatchObject({ reason: 'agent' });
    expect(isRetryable(outcome)).toBe(false);
    expect(outcome.events).toHaveLength(2_001);
    expect(outcome.events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/保存上限/),
    });
    expect(outcome.events.filter((event) => event.type === 'question_updated')).toHaveLength(1);
  });
});
