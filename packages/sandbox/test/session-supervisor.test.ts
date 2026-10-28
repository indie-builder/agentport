import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { SupervisorInput, SupervisorOutput } from '@agentport/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runSupervisor } from '../src/session-supervisor.js';

const fixture = fileURLToPath(new URL('./fixtures/session-child.mjs', import.meta.url));
const USER_UUID = '11111111-2222-4333-8444-555555555555';
const GRACE_MS = 100;

function start(runId: string, prompt: string, env: Record<string, string> = {}): SupervisorInput {
  return {
    type: 'start',
    runId,
    task: {
      prompt,
      model: 'test-model',
      maxTurns: 1,
      maxBudgetUsd: 1,
      userMessageUuid: USER_UUID,
    },
    env,
  };
}

function input(runId: string, requestId: string): SupervisorInput {
  return {
    type: 'input',
    runId,
    command: { type: 'question_response', requestId, response: { decline: true } },
  };
}

function cancel(runId: string): SupervisorInput {
  return { type: 'cancel', runId };
}

/** 合法的 start 行，但 JSON 序列化后明显超过 8MiB 单行上限。 */
function oversizedStart(runId: string): string {
  return JSON.stringify(start(runId, 'x'.repeat(9 * 1024 * 1024)));
}

/**
 * Collects supervisor NDJSON. Waits are ordered: consuming an output advances a
 * cursor so a later wait cannot match the same line again.
 */
class OutputSink extends Writable {
  readonly outputs: SupervisorOutput[] = [];
  private cursor = 0;
  private readonly waiters: Array<{
    predicate: (output: SupervisorOutput) => boolean;
    resolve: (output: SupervisorOutput) => void;
    timer: NodeJS.Timeout;
  }> = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const output = JSON.parse(line) as SupervisorOutput;
      this.outputs.push(output);
      this.consume(output);
    }
    callback();
  }

  private consume(output: SupervisorOutput): void {
    for (const [index, waiter] of this.waiters.entries()) {
      if (!waiter.predicate(output)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      // Outputs are ordered, so everything up to this line is now consumed.
      this.cursor = this.outputs.length;
      waiter.resolve(output);
      return;
    }
  }

  waitFor<T extends SupervisorOutput['type']>(
    type: T,
    predicate: (output: Extract<SupervisorOutput, { type: T }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<SupervisorOutput, { type: T }>> {
    for (let index = this.cursor; index < this.outputs.length; index += 1) {
      const output = this.outputs[index];
      if (output?.type !== type) continue;
      const typed = output as Extract<SupervisorOutput, { type: T }>;
      if (!predicate(typed)) continue;
      this.cursor = index + 1;
      return Promise.resolve(typed);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((waiter) => waiter.timer === timer),
          1,
        );
        reject(
          new Error(
            `timed out waiting for ${type}; saw ${this.outputs.map((output) => output.type).join(', ')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate: (output) => {
          if (output.type !== type) return false;
          return predicate(output as Extract<SupervisorOutput, { type: T }>);
        },
        resolve: (output) => resolve(output as Extract<SupervisorOutput, { type: T }>),
        timer,
      });
    });
  }
}

interface Harness {
  stdin: PassThrough;
  sink: OutputSink;
  done: Promise<void>;
}

const open: Harness[] = [];

function harness(): Harness {
  const stdin = new PassThrough();
  const sink = new OutputSink();
  const done = runSupervisor({ stdin, stdout: sink, runnerPath: fixture, graceMs: GRACE_MS });
  const entry = { stdin, sink, done };
  open.push(entry);
  return entry;
}

function send(stdin: PassThrough, message: SupervisorInput): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

function withTimeout<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`operation did not finish within ${ms}ms`)), ms),
    ),
  ]);
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    entry.stdin.end();
    await withTimeout(entry.done).catch(() => undefined);
  }
});

describe('session supervisor', () => {
  it('keeps two runs separate and gives each run its own env', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-a', 'plain-a', { RUN_MARKER: 'A' }));
    await sink.waitFor('started', (output) => output.runId === 'run-a');
    const first = await sink.waitFor(
      'event',
      (output) => output.runId === 'run-a' && output.event.type === 'text_delta',
    );
    expect(first.event).toMatchObject({ type: 'text_delta', text: 'run:plain-a:A' });
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-a')).toMatchObject({
      stopped: true,
      code: 0,
      signal: null,
    });

    // The second start inherits process.env but must add its own run env on top.
    send(stdin, start('run-b', 'plain-b', { RUN_MARKER: 'B' }));
    await sink.waitFor('started', (output) => output.runId === 'run-b');
    const second = await sink.waitFor(
      'event',
      (output) => output.runId === 'run-b' && output.event.type === 'text_delta',
    );
    expect(second.event).toMatchObject({ type: 'text_delta', text: 'run:plain-b:B' });
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-b')).toMatchObject({
      stopped: true,
    });
  });

  it('rejects a second start while busy and commands for unknown runs', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-a', 'hang-a'));
    await sink.waitFor('started', (output) => output.runId === 'run-a');

    send(stdin, start('run-b', 'plain-b'));
    expect(await sink.waitFor('rejected', (output) => output.runId === 'run-b')).toMatchObject({
      code: 'BUSY',
    });

    send(stdin, input('run-x', 'req-x'));
    expect(await sink.waitFor('rejected', (output) => output.runId === 'run-x')).toMatchObject({
      code: 'NOT_ACTIVE',
    });

    send(stdin, cancel('run-x'));
    expect(await sink.waitFor('rejected', (output) => output.runId === 'run-x')).toMatchObject({
      code: 'NOT_ACTIVE',
    });

    send(stdin, cancel('run-a'));
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-a')).toMatchObject({
      stopped: true,
    });
  });

  it('cancel is idempotent and late input from the old run never reaches the next one', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-a', 'hang-a', { RUN_MARKER: 'A' }));
    await sink.waitFor('started', (output) => output.runId === 'run-a');
    await sink.waitFor('event', (output) => output.runId === 'run-a');

    send(stdin, cancel('run-a'));
    send(stdin, cancel('run-a'));
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-a')).toMatchObject({
      stopped: true,
    });
    // The runner itself reported the cancelled terminal event before settling.
    expect(
      sink.outputs.some(
        (output) =>
          output.type === 'event' &&
          output.runId === 'run-a' &&
          output.event.type === 'run_finished' &&
          output.event.status === 'cancelled',
      ),
    ).toBe(true);

    send(stdin, start('run-b', 'hang-b', { RUN_MARKER: 'B' }));
    await sink.waitFor('started', (output) => output.runId === 'run-b');
    await sink.waitFor('event', (output) => output.runId === 'run-b');

    // A late answer for the previous run must be rejected, not forwarded to B.
    send(stdin, input('run-a', 'req-a'));
    expect(await sink.waitFor('rejected', (output) => output.runId === 'run-a')).toMatchObject({
      code: 'NOT_ACTIVE',
    });

    // B still receives its own command, and only that one.
    send(stdin, input('run-b', 'req-b'));
    const echo = await sink.waitFor(
      'event',
      (output) =>
        output.runId === 'run-b' &&
        output.event.type === 'text_delta' &&
        output.event.text.includes('req-b'),
    );
    expect(echo.event).toMatchObject({ text: expect.not.stringContaining('req-a') });

    // A's delayed write would land after its settle if the process were still alive.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      sink.outputs.some(
        (output) =>
          output.type === 'event' &&
          output.runId === 'run-a' &&
          output.event.type === 'text_delta' &&
          output.event.text === 'late',
      ),
    ).toBe(false);
    const settledIndex = sink.outputs.findIndex(
      (output) => output.type === 'settled' && output.runId === 'run-a',
    );
    expect(
      sink.outputs
        .slice(settledIndex + 1)
        .filter((output) => output.type === 'event' && output.runId === 'run-a'),
    ).toEqual([]);

    send(stdin, cancel('run-b'));
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-b')).toMatchObject({
      stopped: true,
    });
  });

  it('stops lingering descendants before reporting the run settled', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-l', 'linger-l'));
    await sink.waitFor('started', (output) => output.runId === 'run-l');
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-l')).toMatchObject({
      stopped: true,
    });
  });

  it('reports unconfirmed instead of faking a stop when cleanup cannot confirm', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-s', 'stubborn-s'));
    await sink.waitFor('started', (output) => output.runId === 'run-s');
    const stderr = await sink.waitFor(
      'stderr',
      (output) => output.runId === 'run-s' && output.text.includes('grandchild-pid:'),
    );
    const pid = Number(/grandchild-pid:(\d+)/.exec(stderr.text)?.[1]);
    expect(Number.isFinite(pid)).toBe(true);

    const settled = await sink.waitFor('settled', (output) => output.runId === 'run-s');
    expect(settled.stopped).toBe(false);
    expect(settled.error).toContain('still running');

    // The fixture reports the stubborn pid so the test can clean it up.
    process.kill(pid, 'SIGKILL');
  });

  it('cleans up the active run on stdin EOF', async () => {
    const { stdin, sink, done } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-a', 'hang-a'));
    await sink.waitFor('started', (output) => output.runId === 'run-a');
    stdin.end();

    await withTimeout(done);
    expect(
      sink.outputs.find((output) => output.type === 'settled' && output.runId === 'run-a'),
    ).toMatchObject({ stopped: true });
  });

  it('settles after stopping a descendant that inherited stdio, with every event before settled', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-i', 'inherit-stdio'));
    // 后代继承 stdout/stderr 后 root 退出：close 不会来，收尾仍必须有界完成。
    await sink.waitFor('stderr', (output) => output.text.includes('desc-pid:'));
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-i')).toMatchObject({
      stopped: true,
    });

    const settledIndex = sink.outputs.findIndex(
      (output) => output.type === 'settled' && output.runId === 'run-i',
    );
    const eventIndexes = sink.outputs.flatMap((output, index) =>
      output.type === 'event' && output.runId === 'run-i' ? [index] : [],
    );
    const lastEvent = sink.outputs[eventIndexes.at(-1) ?? -1];
    expect(lastEvent).toMatchObject({ event: { type: 'run_finished', status: 'succeeded' } });
    expect(eventIndexes.at(-1) ?? -1).toBeLessThan(settledIndex);
  });

  it('does not fake a stop for an untracked detached descendant holding stdio open', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-d', 'detach-stdio'));
    const stderr = await sink.waitFor(
      'stderr',
      (output) => output.runId === 'run-d' && output.text.includes('desc-pid:'),
    );
    const pid = Number(/desc-pid:(\d+)/.exec(stderr.text)?.[1]);
    expect(Number.isFinite(pid)).toBe(true);

    const settled = await sink.waitFor('settled', (output) => output.runId === 'run-d');
    try {
      if (settled.stopped) {
        // 只有能追踪并停掉 detached 后代的平台（Linux 专用容器）才允许报 stopped。
        expect(() => process.kill(pid, 0)).toThrow();
      } else {
        expect(settled.error).toMatch(/stdio|still/i);
      }
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已停稳。
      }
    }
  });

  it('finishes cleanup of inherited stdio descendants on stdin EOF before resolving', async () => {
    const { stdin, sink, done } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-e', 'hang-inherit-stdio'));
    await sink.waitFor('stderr', (output) => output.text.includes('desc-pid:'));
    stdin.end();

    await withTimeout(done);
    expect(
      sink.outputs.find((output) => output.type === 'settled' && output.runId === 'run-e'),
    ).toMatchObject({ stopped: true });
  });

  it('rejects an over-limit input line and still accepts the next one', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    stdin.write(`${oversizedStart('run-big')}\n`);
    expect(await sink.waitFor('rejected')).toMatchObject({
      runId: '',
      code: 'INVALID_COMMAND',
    });

    send(stdin, start('run-ok', 'plain-ok'));
    await sink.waitFor('started', (output) => output.runId === 'run-ok');
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-ok')).toMatchObject({
      stopped: true,
    });
  });

  it('recovers after an over-limit line split across chunks without killing the active run', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-a', 'hang-a'));
    await sink.waitFor('started', (output) => output.runId === 'run-a');

    const line = oversizedStart('run-big');
    const half = Math.floor(line.length / 2);
    stdin.write(line.slice(0, half));
    stdin.write(`${line.slice(half)}\n`);
    expect(await sink.waitFor('rejected')).toMatchObject({
      runId: '',
      code: 'INVALID_COMMAND',
    });

    send(stdin, cancel('run-a'));
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-a')).toMatchObject({
      stopped: true,
    });
  });

  it('fails the run on over-limit runner output instead of accepting a later success', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    send(stdin, start('run-out', 'bloat'));
    await sink.waitFor('started', (output) => output.runId === 'run-out');
    const settled = await sink.waitFor('settled', (output) => output.runId === 'run-out');
    expect(settled).toMatchObject({ stopped: false });
    expect(settled.error).toMatch(/exceed|limit/i);
    expect(
      sink.outputs.some(
        (output) =>
          output.type === 'event' &&
          output.runId === 'run-out' &&
          output.event.type === 'run_finished',
      ),
    ).toBe(false);

    // 收尾有界，active 已清空，下一轮可以正常启动。
    send(stdin, start('run-next', 'plain-ok'));
    await sink.waitFor('started', (output) => output.runId === 'run-next');
    expect(await sink.waitFor('settled', (output) => output.runId === 'run-next')).toMatchObject({
      stopped: true,
    });
  });

  it('rejects malformed input without starting a run', async () => {
    const { stdin, sink } = harness();
    await sink.waitFor('ready');

    stdin.write('not json\n');
    expect(await sink.waitFor('rejected')).toMatchObject({
      runId: '',
      code: 'INVALID_COMMAND',
    });
  });
});
