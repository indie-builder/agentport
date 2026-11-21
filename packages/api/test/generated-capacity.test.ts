import { expect, it } from 'bun:test';
import { runMcpExecution } from '../src/plugins/concurrency.js';
import { waitForAssertion } from './native.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

it('holds four upstream executions and starts the fifth only after one finishes', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const started: number[] = [];
  const run = (index: number): Promise<void> =>
    runMcpExecution(async () => {
      started.push(index);
      await gates[index]?.promise;
    });

  const running = gates.slice(0, 4).map((_, index) => run(index));
  await waitForAssertion(() => expect(started).toEqual([0, 1, 2, 3]));

  const queued = run(4);
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);

  gates[0]?.resolve();
  await running[0];
  await waitForAssertion(() => expect(started).toEqual([0, 1, 2, 3, 4]));

  for (const gate of gates.slice(1)) gate.resolve();
  await Promise.all([running[1], running[2], running[3], queued]);
  expect(started).toEqual([0, 1, 2, 3, 4]);
});

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
