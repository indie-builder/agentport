import { Context, Effect, Layer, type Scope } from 'effect';

/**
 * Effect 运行时契约。
 *
 * 原则：Effect 只负责「一个任务内部的副作用」，不接管框架的生命周期。
 * - Fastify 管 HTTP 请求
 * - BullMQ 管任务分发与重试
 * - Effect 管任务内部的资源、取消、超时、并发、错误分类
 *
 * 所有适配器都是薄薄一层：把 Promise/事件 API 包成 Effect，不重新实现它们。
 */

/** 可取消的等待。测试里用 TestClock 替换，逻辑不变。 */
export class Clock extends Context.Service<
  Clock,
  {
    readonly sleep: (ms: number) => Effect.Effect<void>;
    readonly now: () => Effect.Effect<number>;
  }
>()('agentport/Clock') {}

export const ClockLive = Layer.succeed(Clock, {
  sleep: (ms) => Effect.sleep(ms),
  now: () => Effect.sync(() => Date.now()),
});

/** 数据库：只暴露调用方需要的最小能力，避免把 Drizzle 类型泄漏到 program 里。 */
export interface DbAdapter {
  readonly query: <A>(run: () => Promise<A>) => Effect.Effect<A, DbError>;
}

export class DbError {
  readonly _tag = 'DbError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class Db extends Context.Service<Db, DbAdapter>()('agentport/Db') {}

/** Redis：发布/订阅/普通命令，统一成一个错误类型。 */
export interface RedisAdapter {
  readonly publish: (channel: string, payload: string) => Effect.Effect<void, RedisError>;
  readonly xadd: (key: string, field: string, value: string) => Effect.Effect<void, RedisError>;
  readonly expire: (key: string, seconds: number) => Effect.Effect<void, RedisError>;
  readonly get: (key: string) => Effect.Effect<string | null, RedisError>;
  readonly del: (key: string) => Effect.Effect<void, RedisError>;
}

export class RedisError {
  readonly _tag = 'RedisError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class Redis extends Context.Service<Redis, RedisAdapter>()('agentport/Redis') {}

/** 沙盒：创建/执行/销毁；销毁必须由 Scope 保证。 */
export interface SandboxHandle {
  readonly id: string;
}

export interface SandboxAdapter<H extends SandboxHandle = SandboxHandle> {
  /**
   * 用 acquireRelease 语义创建：返回的 Effect 在 Scope 结束时自动销毁。
   * 这是整个迁移的核心收益——释放不由调用方记得。
   */
  readonly acquire: (options: {
    image: string;
    workspaceDir: string;
    env: Record<string, string>;
    name?: string;
  }) => Effect.Effect<H, SandboxError, Scope.Scope>;
  readonly destroy: (handle: H) => Effect.Effect<void>;
}

export class SandboxError {
  readonly _tag = 'SandboxError';
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

export class Sandbox extends Context.Service<Sandbox, SandboxAdapter>()('agentport/Sandbox') {}

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

/** 带超时的执行：超时与取消在 Effect 里是同一套中断机制。 */
export function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ms: number,
): Effect.Effect<A, E | RunFailure, R> {
  return effect.pipe(
    Effect.timeout(ms),
    // v4 的 timeout 成功时原样返回值，超时失败为 TimeoutError；统一成 RunFailure。
    Effect.catchTag('TimeoutError', () =>
      Effect.fail(new RunFailure('timeout', `timed out after ${ms}ms`)),
    ),
  );
}
