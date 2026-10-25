import { Effect } from 'effect';

/**
 * Effect 运行时契约。
 *
 * 原则：Effect 只负责「一个任务内部的副作用」，不接管框架的生命周期。
 * - Fastify 管 HTTP 请求
 * - BullMQ 管任务分发与重试
 * - Effect 管任务内部的资源、取消、超时、并发、错误分类
 *
 * 这里只保留跨进程共用的错误分类与 Promise 边界；资源释放直接使用 Effect 原生
 * `acquireRelease` / `scoped`，不再维护无消费者的服务层适配器。
 */

export class DbError {
  readonly _tag = 'DbError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** 运行错误分类：可重试与不可重试在类型上是两件事。 */
export class RunFailure {
  readonly _tag = 'RunFailure';
  constructor(
    readonly reason: 'cancelled' | 'timeout' | 'sandbox' | 'agent' | 'infra',
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

/** 判断一次失败是否值得重试：只由 reason 决定，不再靠正则匹配错误文本。 */
export function isRetryableFailure(failure: RunFailure): boolean {
  return failure.reason === 'infra';
}

/**
 * 边界：把一个 Effect program 变成 Promise。
 * 这是 Fastify/BullMQ 与 Effect 的唯一接触点。
 */
export function runProgram<A, E>(effect: Effect.Effect<A, E>, onError?: (e: E) => void) {
  return Effect.runPromise(effect.pipe(Effect.tapError((e) => Effect.sync(() => onError?.(e)))));
}
