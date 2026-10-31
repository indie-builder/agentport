import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import {
  type SessionCleanupChannel,
  startSessionCleanupChannel,
} from '../../worker/src/sandbox/session-cleanup.js';

/** 记录路由删除时真实发来的关闭目标；测试不需要 Docker 的 SessionSandboxes 实现。 */
export class FakeSessionCloser {
  readonly calls: Array<{ conversationId: string; sandboxIds: string[] }> = [];
  readonly failures = new Map<string, Error>();
  /** 非空时挂起 `closeIdle`，用来观察 ACK 之前的顺序与锁内准入。 */
  hold: Promise<void> | null = null;

  async closeIdle(conversationId: string, sandboxIds: readonly string[]): Promise<void> {
    this.calls.push({ conversationId, sandboxIds: [...sandboxIds] });
    await this.hold;
    const failure = this.failures.get(conversationId);
    if (failure !== undefined) throw failure;
  }
}

/**
 * 在测试进程内启动真实的 worker 关闭信道（与生产同一个 handler），
 * 让 HTTP 删除路由真实经过 Redis 请求/ACK，而不是 mock 路由回调。
 * 使用 app 自己的 REDIS_URL，便于故障用例切到独享库隔离并行套件。
 */
export function startSessionCleanupResponder(
  app: FastifyInstance,
  sessions: FakeSessionCloser,
): Promise<SessionCleanupChannel> {
  return startSessionCleanupChannel({
    redisUrl: app.config.REDIS_URL,
    logger: pino({ level: 'silent' }),
    sessions,
  });
}
