import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRunnerClient,
  configureRunnerClient,
  escalateKill,
  runInSandbox,
} from '../src/runner-client.js';
import type { Sandbox, SandboxProvider } from '../src/sandbox/provider.js';

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

/** 只回一条 run_finished 的假容器；stdin 上的任务 JSON 留作断言。 */
class FakeSandboxChild extends FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Parameters<typeof runInSandbox>[0]['logger'];

function fakeProvider(child: FakeSandboxChild): SandboxProvider {
  return {
    create: async () => ({ id: 'fake', child }) as unknown as Sandbox,
    destroy: async () => undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('escalateKill', () => {
  it('sends SIGTERM first and SIGKILL only after the grace period', () => {
    vi.useFakeTimers();
    const child = new FakeChild();

    escalateKill(child, 5_000);
    expect(child.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(4_999);
    expect(child.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('runInSandbox task payload', () => {
  it('serializes the shared sandbox task to the runner unchanged', async () => {
    configureRunnerClient(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const child = new FakeSandboxChild();

    // 宿主写任务只经过 stdin；截下原始文本，再回一条终态让 run 收尾。
    const written: string[] = [];
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string) => {
      written.push(chunk);
      child.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
      child.emit('close', 0, null);
      return originalWrite(chunk);
    }) as typeof child.stdin.write;

    const task = {
      prompt: 'hi',
      model: 'test',
      maxTurns: 1,
      maxBudgetUsd: 1,
      mcpServers: ['files'],
      skills: ['pdf-tools', 'release-notes'],
      userMessageUuid: '11111111-2222-4333-8444-555555555555',
    };
    await runInSandbox({
      runId: 'run-test',
      timeoutMs: 5_000,
      task,
      workspaceDir: '/tmp/fake',
      image: 'fake',
      env: {},
      provider: fakeProvider(child),
      logger: quietLogger,
    });

    expect(JSON.parse(written.join('').trim())).toEqual(task);
    await closeRunnerClient();
  });
});
