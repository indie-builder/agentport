import { Deferred, Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import { RunFailure, runProgram } from '../../core/src/effect-runtime.js';

describe('runProgram', () => {
  it('invokes onError and rejects when the program fails', async () => {
    const failure = new RunFailure('agent', 'program failed');
    const seen: RunFailure[] = [];

    const result = runProgram(Effect.fail(failure), (error) => seen.push(error));

    await expect(result).rejects.toBe(failure);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(failure);
  });
});

describe('fiber cancellation', () => {
  it('propagates interruption to forked children and reports an interrupted Exit', async () => {
    const program = Effect.gen(function* () {
      const childStarted = yield* Deferred.make<void>();
      let childCleanedUp = false;

      const parent = Effect.gen(function* () {
        yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Deferred.succeed(childStarted, undefined);
            yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                childCleanedUp = true;
              }),
            ),
          ),
        );
        yield* Effect.never;
      });

      const parentFiber = yield* Effect.forkChild(parent);
      // Handshake: interrupt only after the child fiber is actually running.
      yield* Deferred.await(childStarted);
      yield* Fiber.interrupt(parentFiber);

      return { exit: yield* Fiber.await(parentFiber), childCleanedUp };
    });

    const { exit, childCleanedUp } = await Effect.runPromise(program);

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(childCleanedUp).toBe(true);
  });
});
