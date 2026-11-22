import { expect, test } from 'bun:test';
import { startSingleFlight } from '../src/scheduling/single-flight.js';

test('并发调用共享一次执行并一起完成', async () => {
  const pending = Promise.withResolvers<void>();
  let calls = 0;
  const task = startSingleFlight(() => {
    calls += 1;
    return pending.promise;
  });

  const first = task.run();
  const second = task.run();
  expect(second).toBe(first);
  expect(calls).toBe(1);

  pending.resolve();
  expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
});

test('成功结算后再次调用会重新执行', async () => {
  let calls = 0;
  const task = startSingleFlight(async () => {
    calls += 1;
  });

  await task.run();
  await task.run();
  expect(calls).toBe(2);
});

test('idle 等待在飞任务完成', async () => {
  const pending = Promise.withResolvers<void>();
  const task = startSingleFlight(() => pending.promise);
  const run = task.run();
  let idle = false;
  const waiting = task.idle().then(() => {
    idle = true;
  });

  await Bun.sleep(0);
  expect(idle).toBe(false);

  pending.resolve();
  await Promise.all([run, waiting]);
  expect(idle).toBe(true);
});

test('并发调用共享拒绝且下一次调用可执行', async () => {
  const pending = Promise.withResolvers<void>();
  const error = new Error('sync failed');
  let calls = 0;
  const task = startSingleFlight(() => {
    calls += 1;
    return calls === 1 ? pending.promise : Promise.resolve();
  });

  const settled = Promise.allSettled([task.run(), task.run()]);
  pending.reject(error);
  expect(await settled).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  expect(calls).toBe(1);

  await expect(task.run()).resolves.toBeUndefined();
  expect(calls).toBe(2);
});
