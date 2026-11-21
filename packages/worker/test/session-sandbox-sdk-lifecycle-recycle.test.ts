import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  containerExists,
  createSessionSdkSuite,
  delay,
  finishedEvent,
  HANG_MARKER,
  hasDocker,
  sessionsFor,
  waitUntil,
  withTimeout,
} from './fixtures/session-sandbox-sdk-harness.js';

describe.skipIf(!hasDocker)('session sandbox with the real SDK native CLI', () => {
  const suite = createSessionSdkSuite();
  const { createProvider, getSpec, startRun } = suite;

  beforeAll(() => suite.setup(['idle', 'cancel']));
  beforeEach(suite.reset);
  afterAll(suite.teardown);

  it('recycles an idle container and resumes from the persistent session on disk', async () => {
    const { fake } = suite;
    const provider = createProvider();
    // 短阈值让真实回收可被观察；生产默认值仍由 worker 配置控制。
    const sessions = sessionsFor(provider, 1_200);
    try {
      const firstLease = await sessions.acquire(
        getSpec('idle'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      const firstSandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '回收前：请记住暗号 BLUE-442');
      expect((await withTimeout(first.execution.done, 30_000, 'idle run 1')).state).toBe('stopped');
      const sessionId = finishedEvent(first.events)?.sessionId;
      if (sessionId === undefined) throw new Error('first run did not report a session id');
      await firstLease.release({ reuse: true });

      await waitUntil(
        async () => !(await containerExists(firstSandboxId)),
        20_000,
        `idle sandbox ${firstSandboxId} to be removed`,
      );

      const secondLease = await sessions.acquire(
        getSpec('idle'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      expect(secondLease.sandboxId).not.toBe(firstSandboxId);
      const second = await startRun(secondLease, '回收后：继续', sessionId);
      expect((await withTimeout(second.execution.done, 30_000, 'idle run 2')).state).toBe(
        'stopped',
      );
      const secondFinished = finishedEvent(second.events);
      expect(secondFinished?.status).toBe('succeeded');
      expect(secondFinished?.sessionId).toBe(sessionId);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages[1]?.body)).toContain('BLUE-442');
      expect(JSON.stringify(messages[1]?.body)).toContain('REPLY:回收前：请记住暗号 BLUE-442');

      await secondLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it('confirms a cancelled hung run, keeps the session id, and resumes on the same container', async () => {
    const { fake } = suite;
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const firstLease = await sessions.acquire(
        getSpec('cancel'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      const sandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '取消前：请记住暗号 GREEN-913');
      expect((await withTimeout(first.execution.done, 30_000, 'cancel run 1')).state).toBe(
        'stopped',
      );
      const sessionId = finishedEvent(first.events)?.sessionId;
      if (sessionId === undefined) throw new Error('first run did not report a session id');

      const second = await startRun(firstLease, `取消挂起 ${HANG_MARKER} GREEN-913`, sessionId);
      const hung = await fake.waitForRequest((request) => request.hung, 10_000);
      const requestCountAtCancel = fake.requests.length;
      const cancelSettlement = await withTimeout(second.execution.cancel(), 15_000, 'cancel');
      expect(cancelSettlement.state).toBe('stopped');
      expect(await withTimeout(second.execution.done, 5_000, 'cancelled done')).toEqual(
        cancelSettlement,
      );

      const cancelledFinished = finishedEvent(second.events);
      expect(cancelledFinished?.status).toBe('cancelled');
      // 取消分支也必须把本轮 session id 交给宿主，否则下一轮只能退回旧 id。
      expect(cancelledFinished?.sessionId).toBe(sessionId);

      // 取消后不应再向模型发迟到请求（等待窗口内请求数不增长）。
      await delay(750);
      expect(fake.requests.length).toBe(requestCountAtCancel);
      expect(hung.closed).toBe(true);

      await firstLease.release({ reuse: true });
      const resumedLease = await sessions.acquire(
        getSpec('cancel'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      expect(resumedLease.sandboxId).toBe(sandboxId);
      const resumed = await startRun(resumedLease, '取消后：继续 GREEN-913', sessionId);
      expect((await withTimeout(resumed.execution.done, 30_000, 'cancel run 3')).state).toBe(
        'stopped',
      );
      const resumedFinished = finishedEvent(resumed.events);
      expect(resumedFinished?.status).toBe('succeeded');
      expect(resumedFinished?.sessionId).toBe(sessionId);
      expect(JSON.stringify(fake.messageRequests().at(-1)?.body)).toContain('GREEN-913');
      expect(JSON.stringify(fake.messageRequests().at(-1)?.body)).toContain(
        'REPLY:取消前：请记住暗号 GREEN-913',
      );

      await resumedLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);
});
