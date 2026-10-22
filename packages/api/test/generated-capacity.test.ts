import { expect, it } from 'vitest';
import { runMcpExecution, tryApprovalWait } from '../src/plugins/concurrency.js';

/**
 * 进程内名额只做计数，不需要 MCP/DB：直接拿 deferred 任务验证边界，
 * 不触发任何 fetch 或模型调用。
 */
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
  await expect.poll(() => started).toEqual([0, 1, 2, 3]);

  // 第 5 个请求必须排队，不能提前打上游。
  const queued = run(4);
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);

  gates[0]?.resolve();
  await running[0];
  await expect.poll(() => started).toEqual([0, 1, 2, 3, 4]);

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
    await expect.poll(() => started.length).toBe(4);
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

it('parks at most four approval waits; the fifth is refused instead of queued, and a slot frees on cancel', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const accepted: number[] = [];
  const wait = (index: number): Promise<boolean> =>
    tryApprovalWait(async () => {
      accepted.push(index);
      await gates[index]?.promise;
    }).then((outcome) => outcome.accepted);

  const parked = [0, 1, 2, 3].map((index) => wait(index));
  await expect.poll(() => accepted).toEqual([0, 1, 2, 3]);

  // 名额已满：同步返回 accepted:false，调用方走立即拒绝，不追加任何排队。
  const fifth = await wait(4);
  expect(fifth).toBe(false);
  expect(accepted).toEqual([0, 1, 2, 3]);

  // 取消一个挂起（任务抛错/提前返回）后名额必须归还。
  gates[0]?.resolve();
  expect(await parked[0]).toBe(true);
  const afterCancel = wait(4);
  await expect.poll(() => accepted).toEqual([0, 1, 2, 3, 4]);

  for (const gate of gates.slice(1)) gate.resolve();
  expect(await afterCancel).toBe(true);
  expect(await Promise.all(parked.slice(1))).toEqual([true, true, true]);
});
