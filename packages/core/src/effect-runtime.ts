import type { RunErrorKind } from '@agentport/shared';
import { Effect } from 'effect';

export class DbError {
  readonly _tag = 'DbError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class RunFailure {
  readonly _tag = 'RunFailure';
  constructor(
    readonly reason: RunErrorKind,
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export function isRetryableFailure(failure: RunFailure): boolean {
  return failure.reason === 'infra';
}

export function runProgram<A, E>(effect: Effect.Effect<A, E>, onError?: (e: E) => void) {
  return Effect.runPromise(effect.pipe(Effect.tapError((e) => Effect.sync(() => onError?.(e)))));
}
