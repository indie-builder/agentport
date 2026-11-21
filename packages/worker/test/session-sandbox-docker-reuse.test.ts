import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSessionSandboxDockerSuite,
  type Incident,
} from './fixtures/session-sandbox-docker-harness.js';

const {
  containerExists,
  containerRunning,
  delay,
  dispose,
  dockerReady,
  inContainer,
  incident,
  setup,
  startRun,
  succeeded,
  teardown,
  waitFor,
} = createSessionSandboxDockerSuite();

describe.skipIf(!dockerReady)('session sandbox real docker lifecycle', () => {
  beforeAll(setup);
  afterAll(teardown);

  it('reuses one container across runs in the same session and keeps /tmp state', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const firstPrompt = `first-${randomUUID()}`;
      const secondPrompt = `second-${randomUUID()}`;

      const firstLease = await current.sessions.acquire(
        current.spec,
        signal,
        `run-${randomUUID()}`,
      );
      current.ids.push(firstLease.sandboxId);
      const first = await startRun(firstLease, firstPrompt);
      expect(await first.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(first.events, firstPrompt)).toBe(true);
      await firstLease.release({ reuse: true });

      const secondLease = await current.sessions.acquire(
        current.spec,
        signal,
        `run-${randomUUID()}`,
      );
      current.ids.push(secondLease.sandboxId);
      expect(secondLease.sandboxId).toBe(firstLease.sandboxId);
      const second = await startRun(secondLease, secondPrompt);
      expect(await second.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(second.events, secondPrompt)).toBe(true);

      // /tmp 是容器 tmpfs：计数从 1 走到 2，且第一轮文件仍在，才证明复用了同一容器。
      expect(inContainer(firstLease.sandboxId, ['cat', '/tmp/session-fixture/count'])?.trim()).toBe(
        '2',
      );
      expect(
        inContainer(firstLease.sandboxId, ['cat', `/tmp/session-fixture/run-${firstPrompt}.json`]),
      ).toContain(firstPrompt);
      expect(containerRunning(firstLease.sandboxId)).toBe(true);
      await secondLease.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('gives different sessions different containers and isolated session mounts', {
    timeout: 60_000,
  }, async () => {
    const left = await incident();
    const right = await incident();
    try {
      const signal = new AbortController().signal;
      const leftPrompt = `left-${randomUUID()}`;
      const rightPrompt = `right-${randomUUID()}`;
      const leftLease = await left.sessions.acquire(left.spec, signal, `run-${randomUUID()}`);
      const rightLease = await right.sessions.acquire(right.spec, signal, `run-${randomUUID()}`);
      left.ids.push(leftLease.sandboxId);
      right.ids.push(rightLease.sandboxId);
      expect(leftLease.sandboxId).not.toBe(rightLease.sandboxId);

      const [leftRun, rightRun] = await Promise.all([
        startRun(leftLease, leftPrompt),
        startRun(rightLease, rightPrompt),
      ]);
      expect(await leftRun.execution.done).toMatchObject({ state: 'stopped' });
      expect(await rightRun.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(leftRun.events, leftPrompt)).toBe(true);
      expect(succeeded(rightRun.events, rightPrompt)).toBe(true);

      // sessionsDir 按会话挂到 /home/node/.claude：各自的宿主目录只能看到自己的 run。
      const leftState = await readFile(join(left.spec.sessionsDir, 'session-fixture.json'), 'utf8');
      const rightState = await readFile(
        join(right.spec.sessionsDir, 'session-fixture.json'),
        'utf8',
      );
      expect(leftState).toContain(leftPrompt);
      expect(leftState).not.toContain(rightPrompt);
      expect(rightState).toContain(rightPrompt);
      expect(rightState).not.toContain(leftPrompt);

      await leftLease.release({ reuse: false });
      await rightLease.release({ reuse: false });
    } finally {
      await dispose(left);
      await dispose(right);
    }
  });

  it('cancel stops the runner file writes while the container stays usable', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const longPrompt = `fixture:long-${randomUUID()}`;
      const thirdPrompt = `third-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, longPrompt);

      await waitFor(
        () => inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']),
        'long task progress file',
      );
      run.execution.cancel();
      expect(await run.execution.done).toMatchObject({ state: 'stopped' });

      // 有界静默窗口只证明取消后没有继续写，不用等待某个固定时长来猜。
      const afterCancel = inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']);
      expect(afterCancel).not.toBeNull();
      await delay(500);
      expect(inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress'])).toBe(
        afterCancel,
      );
      expect(inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/cancelled'])).toContain(
        'SIGTERM',
      );
      expect(containerRunning(lease.sandboxId)).toBe(true);
      await lease.release({ reuse: true });

      const again = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(again.sandboxId);
      expect(again.sandboxId).toBe(lease.sandboxId);
      const third = await startRun(again, thirdPrompt);
      expect(await third.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(third.events, thirdPrompt)).toBe(true);
      expect(
        inContainer(again.sandboxId, ['cat', `/tmp/session-fixture/run-${thirdPrompt}.json`]),
      ).toContain(thirdPrompt);
      await again.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('recycles an idle container, then gives the next run a new container with persistent state', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident(150);
      const signal = new AbortController().signal;
      const firstPrompt = `persist-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(lease.sandboxId);
      const first = await startRun(lease, firstPrompt);
      expect(await first.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(first.events, firstPrompt)).toBe(true);
      const persistentFile = join(current.spec.sessionsDir, 'session-fixture.json');
      expect(await readFile(persistentFile, 'utf8')).toContain(firstPrompt);
      await lease.release({ reuse: true });

      await waitFor(
        () => !containerExists(lease.sandboxId),
        'idle container to be reclaimed',
        20_000,
      );

      // 容器删除完成即视为回收完成：下一轮必须能直接 acquire，不能靠重试掩盖
      // destroy 尚未收口时抛 busy 的竞态。
      const fresh = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(fresh.sandboxId);
      expect(fresh.sandboxId).not.toBe(lease.sandboxId);
      // 新容器仍挂到同一会话目录：上一轮的持久文件还在，runner 无需重建状态。
      expect(
        inContainer(fresh.sandboxId, ['cat', '/home/node/.claude/session-fixture.json']),
      ).toContain(firstPrompt);
      const nextPrompt = `after-${randomUUID()}`;
      const next = await startRun(fresh, nextPrompt);
      expect(await next.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(next.events, nextPrompt)).toBe(true);
      expect(await readFile(persistentFile, 'utf8')).toContain(nextPrompt);
      await fresh.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });
});
