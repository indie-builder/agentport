import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { isRetryableFailure, RunFailure, runProgram } from '../src/effect-runtime.js';

describe('RunFailure classification', () => {
  it('retries only infra failures', () => {
    expect(isRetryableFailure(new RunFailure('infra', 'docker down'))).toBe(true);
    for (const reason of ['sandbox', 'agent', 'timeout', 'cancelled'] as const) {
      expect(isRetryableFailure(new RunFailure(reason, 'x'))).toBe(false);
    }
  });
});

describe('runProgram boundary', () => {
  it('resolves the value and does not call onError', async () => {
    let called = 0;
    const value = await runProgram(Effect.succeed(7), () => {
      called += 1;
    });
    expect(value).toBe(7);
    expect(called).toBe(0);
  });

  it('calls onError and rejects on failure', async () => {
    const failure = new RunFailure('agent', 'nope');
    const seen: RunFailure[] = [];
    await expect(runProgram(Effect.fail(failure), (error) => seen.push(error))).rejects.toBe(
      failure,
    );
    expect(seen).toEqual([failure]);
  });
});
