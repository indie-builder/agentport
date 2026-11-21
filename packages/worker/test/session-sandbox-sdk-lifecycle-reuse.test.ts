import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createSessionSdkSuite,
  finishedEvent,
  hasDocker,
  sessionsFor,
  withTimeout,
} from './fixtures/session-sandbox-sdk-harness.js';

describe.skipIf(!hasDocker)('session sandbox with the real SDK native CLI', () => {
  const suite = createSessionSdkSuite();
  const { createProvider, getSpec, startRun } = suite;

  beforeAll(() => suite.setup(['single', 'reuse']));
  beforeEach(suite.reset);
  afterAll(suite.teardown);

  it('runs one real SDK turn through the local fake Anthropic API', async () => {
    const { fake } = suite;
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const lease = await sessions.acquire(
        getSpec('single'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      const run = await startRun(lease, '单轮：请回复 SPIKE-ONE');
      const settlement = await withTimeout(run.execution.done, 30_000, 'single run');
      expect(settlement.state).toBe('stopped');
      if (settlement.state === 'stopped') expect(settlement.code).toBe(0);

      const finished = finishedEvent(run.events);
      expect(finished?.status).toBe('succeeded');
      expect(finished?.sessionId).toEqual(expect.any(String));
      expect(
        run.events.some(
          (event) => event.type === 'assistant_text' && event.text.includes('REPLY:单轮'),
        ),
      ).toBe(true);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0]?.body)).toContain('SPIKE-ONE');
      expect(new Set(fake.requests.map((request) => request.path))).toEqual(
        new Set(['/v1/messages']),
      );

      await lease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it('reuses one container and resumes the same SDK session across runs', async () => {
    const { fake } = suite;
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const firstLease = await sessions.acquire(
        getSpec('reuse'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      const firstSandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '第一轮：请记住暗号 ORANGE-731');
      const firstSettlement = await withTimeout(first.execution.done, 30_000, 'reuse run 1');
      expect(firstSettlement.state).toBe('stopped');
      const firstFinished = finishedEvent(first.events);
      expect(firstFinished?.status).toBe('succeeded');
      const sessionId = firstFinished?.sessionId;
      expect(sessionId).toEqual(expect.any(String));
      if (sessionId === undefined) throw new Error('first run did not report a session id');
      await firstLease.release({ reuse: true });

      const secondLease = await sessions.acquire(
        getSpec('reuse'),
        new AbortController().signal,
        `run-${randomUUID()}`,
      );
      expect(secondLease.sandboxId).toBe(firstSandboxId);
      const second = await startRun(secondLease, '第二轮：暗号是什么？', sessionId);
      const secondSettlement = await withTimeout(second.execution.done, 30_000, 'reuse run 2');
      expect(secondSettlement.state).toBe('stopped');
      const secondFinished = finishedEvent(second.events);
      expect(secondFinished?.status).toBe('succeeded');
      expect(secondFinished?.sessionId).toBe(sessionId);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.body).toBeDefined();
      expect(JSON.stringify(messages[1]?.body)).toContain('ORANGE-731');
      expect(JSON.stringify(messages[1]?.body)).toContain('REPLY:第一轮：请记住暗号 ORANGE-731');
      expect(new Set(fake.requests.map((request) => request.path))).toEqual(
        new Set(['/v1/messages']),
      );

      await secondLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);
});
