import { Effect, Fiber, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { isRetryableFailure, RunFailure, runProgram } from '../src/effect-runtime.js';

describe('acquireRelease semantics', () => {
  const makeResource = () => {
    let released = 0;
    const resource = Effect.acquireRelease(
      Effect.sync(() => 'handle'),
      () =>
        Effect.sync(() => {
          released += 1;
        }),
    );
    return { resource, released: () => released };
  };

  it('releases exactly once after success', async () => {
    const { resource, released } = makeResource();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* resource;
        }),
      ),
    );
    expect(released()).toBe(1);
  });

  it('releases exactly once after failure', async () => {
    const { resource, released } = makeResource();
    await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* resource;
          return yield* Effect.fail(new Error('boom'));
        }),
      ),
    );
    expect(released()).toBe(1);
  });

  it('releases exactly once after timeout', async () => {
    const { resource, released } = makeResource();
    await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* resource;
          yield* Effect.sleep('10 seconds');
        }),
      ).pipe(Effect.timeout(30)),
    );
    expect(released()).toBe(1);
  });

  it('releases exactly once after fiber interruption', async () => {
    const { resource, released } = makeResource();
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* resource;
          yield* Effect.sleep('10 seconds');
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(released()).toBe(1);
  });
});

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
    let called = 0;
    await expect(
      runProgram(Effect.fail(new RunFailure('agent', 'nope')), () => {
        called += 1;
      }),
    ).rejects.toBeInstanceOf(RunFailure);
    expect(called).toBe(1);
  });
});

describe('Effect primitives used by the worker', () => {
  it('Effect.result isolates per-item failures', async () => {
    const results = await Effect.runPromise(
      Effect.forEach(
        [1, 2, 3],
        (n) => Effect.result(n === 2 ? Effect.fail(new Error('bad')) : Effect.succeed(n)),
        { concurrency: 1 },
      ),
    );
    expect(results.map((r) => r._tag)).toEqual(['Success', 'Failure', 'Success']);
  });

  it('Option is returned by timeout+option', async () => {
    const slow = await Effect.runPromise(
      Effect.timeout(Effect.sleep('10 seconds').pipe(Effect.as(1)), 10).pipe(Effect.option),
    );
    expect(Option.isNone(slow)).toBe(true);
  });
});
