import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSessionSandboxDockerSuite,
  type Incident,
} from './fixtures/session-sandbox-docker-harness.js';

const {
  BUSY_OUTPUT,
  GROUP_PROGRESS,
  GROUP_STOP,
  ORPHAN_META,
  ORPHAN_PROGRESS,
  ORPHAN_STOP,
  RecordingProvider,
  RejectFirstDestroyProvider,
  cleanupEvidence,
  dockerProvider,
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

  it('does not recycle a container while a run is in flight', { timeout: 60_000 }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident(120);
      const signal = new AbortController().signal;
      const longPrompt = `fixture:long-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, longPrompt);
      let settled = false;
      void run.execution.done.then(() => {
        settled = true;
      });

      await waitFor(
        () => inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']),
        'long task progress file',
      );
      await delay(500);
      expect(settled).toBe(false);
      expect(containerRunning(lease.sandboxId)).toBe(true);

      run.execution.cancel();
      expect(await run.execution.done).toMatchObject({ state: 'stopped' });
      await lease.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('close removes every managed container', { timeout: 60_000 }, async () => {
    const left = await incident();
    const right = await incident();
    try {
      const signal = new AbortController().signal;
      const leftLease = await left.sessions.acquire(left.spec, signal, `run-${randomUUID()}`);
      const rightLease = await right.sessions.acquire(right.spec, signal, `run-${randomUUID()}`);
      left.ids.push(leftLease.sandboxId);
      right.ids.push(rightLease.sandboxId);
      const [leftRun, rightRun] = await Promise.all([
        startRun(leftLease, `close-left-${randomUUID()}`),
        startRun(rightLease, `close-right-${randomUUID()}`),
      ]);
      await leftRun.execution.done;
      await rightRun.execution.done;
      await leftLease.release({ reuse: true });
      await rightLease.release({ reuse: true });

      await left.sessions.close();
      await right.sessions.close();
      await waitFor(
        () => !containerRunning(leftLease.sandboxId) && !containerRunning(rightLease.sandboxId),
        'managed containers to be removed',
        20_000,
      );
    } finally {
      await dispose(left);
      await dispose(right);
    }
  });

  it('stops detached and same-group children holding inherited stdout before reporting stopped', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const prompt = `fixture:orphan-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, prompt);

      const settlement = await run.execution.done;
      expect(settlement).toMatchObject({ state: 'stopped' });

      const meta = JSON.parse(inContainer(lease.sandboxId, ['cat', ORPHAN_META]) ?? '{}');
      expect(meta.ready).toBe(true);
      expect(typeof meta.detachedPid).toBe('number');
      expect(typeof meta.groupPid).toBe('number');
      expect(meta.detachedPid).not.toBe(meta.rootPid);

      const stopRecords: Record<string, unknown> = {};
      for (const [label, stopFile, pid] of [
        ['detached', ORPHAN_STOP, meta.detachedPid],
        ['same-group', GROUP_STOP, meta.groupPid],
      ] as const) {
        const stopped = JSON.parse(inContainer(lease.sandboxId, ['cat', stopFile]) ?? '{}');
        stopRecords[label] = stopped;
        expect({ label, ...stopped }).toMatchObject({ label, pid, ppid: 1 });
      }

      const orphanAtSettle = inContainer(lease.sandboxId, ['cat', ORPHAN_PROGRESS]);
      const groupAtSettle = inContainer(lease.sandboxId, ['cat', GROUP_PROGRESS]);
      expect(orphanAtSettle).not.toBeNull();
      expect(groupAtSettle).not.toBeNull();
      await delay(500);
      expect(inContainer(lease.sandboxId, ['cat', ORPHAN_PROGRESS])).toBe(orphanAtSettle);
      expect(inContainer(lease.sandboxId, ['cat', GROUP_PROGRESS])).toBe(groupAtSettle);

      await lease.release({ reuse: true });
      const again = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(again.sandboxId);
      expect(again.sandboxId).toBe(lease.sandboxId);
      const nextPrompt = `after-orphan-${randomUUID()}`;
      const next = await startRun(again, nextPrompt);
      expect(await next.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(next.events, nextPrompt)).toBe(true);
      await again.release({ reuse: false });

      cleanupEvidence.push({
        test: 'orphan-stop',
        settlement,
        rootPid: meta.rootPid,
        detachedPid: meta.detachedPid,
        groupPid: meta.groupPid,
        orphanAtSettle,
        groupAtSettle,
        stopRecords,
        orphanFrozen: true,
        groupFrozen: true,
        reusedSandboxId: again.sandboxId,
      });
    } finally {
      await dispose(current);
    }
  });

  it('removes a busy container after worker stdin EOF, without an explicit close', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      const recording = new RecordingProvider(dockerProvider());
      current = await incident(60_000, recording);
      const signal = new AbortController().signal;
      const busyFile = join(current.spec.outputsDir, BUSY_OUTPUT);
      const prompt = `fixture:busy-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal, `run-${randomUUID()}`);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, prompt);

      const firstTick = await waitFor(async () => {
        if (!existsSync(busyFile)) return null;
        const tick = Number(JSON.parse(await readFile(busyFile, 'utf8')).tick);
        return tick >= 2 ? tick : null;
      }, 'busy output to advance');

      expect(recording.children).toHaveLength(1);
      const child = recording.children[0];
      if (child === undefined) throw new Error('provider did not record the sandbox child');
      expect(child.exitCode).toBeNull();
      void child.stdin.end();

      await waitFor(
        () => !containerExists(lease.sandboxId),
        'container to disappear after stdin EOF',
        20_000,
      );
      const settlement = await run.execution.done;
      expect(settlement).toMatchObject({ state: 'stopped' });

      const afterRemoval = await readFile(busyFile, 'utf8');
      await delay(300);
      const stillStopped = await readFile(busyFile, 'utf8');
      expect(stillStopped).toBe(afterRemoval);
      expect(JSON.parse(stillStopped).tick).toBeGreaterThanOrEqual(firstTick);

      cleanupEvidence.push({
        test: 'stdin-eof-cleanup',
        settlement,
        firstTick,
        lastTick: JSON.parse(stillStopped).tick,
        stdinEofPropagated: true,
        containerRemovedWithoutClose: true,
        explicitRelease: false,
      });
    } finally {
      await dispose(current);
      for (const id of current?.ids ?? []) {
        expect(containerExists(id)).toBe(false);
      }
    }
  });

  it('retries a failed destroy from cleanup and confirms the container and host writes stop', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    const recording = new RejectFirstDestroyProvider(dockerProvider());
    try {
      current = await incident(60_000, recording);
      const signal = new AbortController().signal;
      const busyFile = join(current.spec.outputsDir, BUSY_OUTPUT);
      const prompt = `fixture:busy-cleanup-${randomUUID()}`;

      const runId = `run-${randomUUID()}`;
      const lease = await current.sessions.acquire(current.spec, signal, runId);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, prompt, runId);

      const readTick = async (): Promise<number | null> => {
        if (!existsSync(busyFile)) return null;
        return Number(JSON.parse(await readFile(busyFile, 'utf8')).tick);
      };
      await waitFor(async () => {
        const tick = await readTick();
        return tick !== null && tick >= 2 ? tick : null;
      }, 'busy output to advance');

      await expect(lease.release({ reuse: false })).rejects.toThrow(/injected destroy failure/);
      expect(containerRunning(lease.sandboxId)).toBe(true);
      const tickAfterFailure = await readTick();
      expect(tickAfterFailure).not.toBeNull();
      await delay(200);
      const tickStillWriting = await readTick();
      expect(tickStillWriting).toBeGreaterThan(tickAfterFailure ?? 0);

      await current.sessions.cleanup(current.spec.conversationId, lease.sandboxId, runId);
      await waitFor(
        () => !containerExists(lease.sandboxId),
        'failed container to be removed after cleanup',
        20_000,
      );
      const settlement = await run.execution.done;
      const frozen = await readFile(busyFile, 'utf8');
      await delay(300);
      expect(await readFile(busyFile, 'utf8')).toBe(frozen);

      cleanupEvidence.push({
        test: 'failed-destroy-cleanup-retry',
        settlement,
        sandboxId: lease.sandboxId,
        firstDestroyRejected: true,
        cleanupResolved: true,
        containerRemoved: true,
        outputFrozen: true,
        tickAfterFailure,
        tickStillWriting,
        tickAfterCleanup: JSON.parse(frozen).tick,
      });
    } finally {
      await dispose(current);
    }
  });
});
