import { Cause, Effect, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import {
  Clock,
  ClockLive,
  isRetryableFailure,
  RunFailure,
  runProgram,
  withTimeout,
} from '../src/effect-runtime.js';

describe('withTimeout', () => {
  it('returns the value when it finishes in time', async () => {
    const value = await Effect.runPromise(withTimeout(Effect.succeed(42), 1_000));
    expect(value).toBe(42);
  });

  it('fails with RunFailure(timeout) instead of leaking TimeoutError', async () => {
    const result = await Effect.runPromiseExit(
      withTimeout(Effect.sleep('10 seconds').pipe(Effect.as(1)), 50),
    );
    expect(result._tag).toBe('Failure');
    const error = result._tag === 'Failure' ? Cause.squash(result.cause) : undefined;
    expect(error).toBeInstanceOf(RunFailure);
    expect((error as RunFailure).reason).toBe('timeout');
  });

  it('does not affect a failing effect that is not a timeout', async () => {
    const result = await Effect.runPromiseExit(withTimeout(Effect.fail(new Error('boom')), 1_000));
    expect(result._tag).toBe('Failure');
  });
});

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

describe('Clock service', () => {
  it('can be replaced with a fake clock so logic does not depend on wall time', async () => {
    const sleeps: number[] = [];
    const fakeClock = {
      sleep: (ms: number) =>
        Effect.sync(() => {
          sleeps.push(ms);
        }),
      now: () => Effect.succeed(1_000),
    };

    const program = Effect.gen(function* () {
      const clock = yield* Clock;
      yield* clock.sleep(250);
      yield* clock.sleep(500);
      return yield* clock.now();
    });

    const now = await Effect.runPromise(program.pipe(Effect.provideService(Clock, fakeClock)));
    expect(now).toBe(1_000);
    expect(sleeps).toEqual([250, 500]);
  });

  it('ClockLive delegates to the Effect clock', async () => {
    const program = Effect.gen(function* () {
      const clock = yield* Clock;
      const before = yield* clock.now();
      return before > 0;
    });
    const ok = await Effect.runPromise(program.pipe(Effect.provide(ClockLive)));
    expect(ok).toBe(true);
  });
});

describe('TestClock', () => {
  // fork 与 adjust 必须在同一个 TestClock.layer() 里，否则是两个互不相干的假时钟。
  const withTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

  it('drives a sleep to completion without real waiting', async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        withTimeout(Effect.sleep('10 seconds').pipe(Effect.as('late')), 60_000),
      );
      yield* TestClock.adjust('11 seconds');
      return yield* Fiber.join(fiber);
    });
    expect(await withTestClock(program)).toBe('late');
  });

  it('fires the timeout when virtual time passes the deadline', async () => {
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        withTimeout(Effect.sleep('10 seconds').pipe(Effect.as('late')), 5_000).pipe(Effect.result),
      );
      yield* TestClock.adjust('6 seconds');
      return yield* Fiber.join(fiber);
    });
    const result = await withTestClock(program);
    expect(result._tag).toBe('Failure');
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
