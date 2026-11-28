import { expect, it } from 'bun:test';
import { runMcpExecution } from '../src/modules/servers/concurrency.js';
import { waitForAssertion } from './native.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

it('refuses execution overflow without scheduling the extra task', async () => {
  const gate = deferred();
  const started: number[] = [];
  const admitted = Array.from({ length: 12 }, (_, index) =>
    runMcpExecution(async () => {
      started.push(index);
      await gate.promise;
    }),
  );
  try {
    await waitForAssertion(() => expect(started.length).toBe(4));
    await expect(
      runMcpExecution(async () => {
        started.push(99);
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(started).not.toContain(99);
  } finally {
    gate.resolve();
    await Promise.all(admitted);
  }
});
