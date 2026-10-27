import { createDb } from '@agentport/db';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import setup, {
  type IsolatedRedis,
  startRedisContainer,
  stopRedisContainer,
} from './global-setup.js';
import { type BackendInfra, createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.js';

const adminUrl = process.env.DATABASE_URL ?? '';
const originalUrl = process.env.DATABASE_URL;
const databases: IsolatedDatabase[] = [];
const containers: IsolatedRedis[] = [];

let first: IsolatedDatabase | null = null;
let second: IsolatedDatabase | null = null;
let redisFirst: IsolatedRedis | null = null;
let redisSecond: IsolatedRedis | null = null;

async function cleanup(): Promise<void> {
  const results = await Promise.allSettled([
    ...databases.map((database) => database.close()),
    ...containers.map((container) => stopRedisContainer(container)),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to clean up isolation test resources');
  }
}

// 先注册清理，再逐个持有资源；第二个创建失败时也能回收第一个。
afterAll(cleanup);

try {
  first = await createIsolatedDatabase('isolation_first', adminUrl);
  if (first) databases.push(first);
  second = await createIsolatedDatabase('isolation_second', adminUrl);
  if (second) databases.push(second);
  redisFirst = await startRedisContainer();
  if (redisFirst) containers.push(redisFirst);
  redisSecond = await startRedisContainer();
  if (redisSecond) containers.push(redisSecond);
} catch (error) {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'isolation test setup failed and cleanup also failed',
    );
  }
  throw error;
}

const ready = first !== null && second !== null;
const redisReady = redisFirst !== null && redisSecond !== null;

async function databaseExists(name: string): Promise<boolean> {
  const { pool } = createDb(adminUrl);
  try {
    const result = await pool.query('select 1 from pg_database where datname = $1', [name]);
    return result.rowCount === 1;
  } finally {
    await pool.end();
  }
}

function databaseName(url: string): string {
  return new URL(url).pathname.slice(1);
}

async function probeValues(handle: IsolatedDatabase): Promise<string[]> {
  const { pool } = createDb(handle.url);
  try {
    const result = await pool.query<{ value: string }>(
      'select value from isolation_probe order by value',
    );
    return result.rows.map((row) => row.value);
  } finally {
    await pool.end();
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

it('receives infrastructure through the setup file before imports', () => {
  expect(originalUrl).toBeTruthy();
});

describe.skipIf(!ready)('createIsolatedDatabase sessions', () => {
  it('injects the per-run isolated database into the test process', () => {
    expect(originalUrl).toMatch(/\/backend_test_[0-9a-f]{16}$/);
  });

  it('keeps databases separate and only removes the session that closes', async () => {
    const a = first as IsolatedDatabase;
    const b = second as IsolatedDatabase;
    expect(process.env.DATABASE_URL).toBe(originalUrl);
    expect(a.name).not.toBe(b.name);
    expect(a.url).not.toBe(b.url);

    const aDb = createDb(a.url);
    const bDb = createDb(b.url);
    try {
      await aDb.pool.query('create table isolation_probe (value text not null)');
      await bDb.pool.query('create table isolation_probe (value text not null)');
      await aDb.pool.query("insert into isolation_probe values ('a')");
      await bDb.pool.query("insert into isolation_probe values ('b')");
      expect(await probeValues(a)).toEqual(['a']);
      expect(await probeValues(b)).toEqual(['b']);

      await aDb.pool.end();
      await a.close();
      expect(await databaseExists(a.name)).toBe(false);
      expect(await probeValues(b)).toEqual(['b']);
      expect(await databaseExists(b.name)).toBe(true);

      await a.close();
      await bDb.pool.end();
      await b.close();
      expect(await databaseExists(b.name)).toBe(false);
    } finally {
      await aDb.pool.end().catch(() => undefined);
      await bDb.pool.end().catch(() => undefined);
    }
  });

  it('reads DATABASE_URL at call time instead of capturing it at import', async () => {
    process.env.DATABASE_URL = 'postgres://unreachable@127.0.0.1:1/backend_infra_unavailable';
    try {
      expect(await createIsolatedDatabase('isolation_dynamic')).toBeNull();
    } finally {
      process.env.DATABASE_URL = originalUrl;
    }
  });
});

describe.skipIf(!ready)('global setup lifecycle', () => {
  it('removes the database it created when teardown runs', async () => {
    let provided: BackendInfra | undefined;
    const teardown = await setup({
      provide: (_key: string, value: BackendInfra) => {
        provided = value;
      },
    } as unknown as Parameters<typeof setup>[0]);
    let name = '';
    try {
      name = databaseName(provided?.DATABASE_URL ?? '');
      expect(await databaseExists(name)).toBe(true);
    } finally {
      await teardown();
    }
    expect(await databaseExists(name)).toBe(false);
    // 清理幂等：成功后才标记关闭，重复 teardown 不再操作资源。
    await expect(teardown()).resolves.toBeUndefined();
  });
});

describe.skipIf(!redisReady)('isolated redis sessions', () => {
  it('gives every container a unique name so cleanup cannot touch another run', () => {
    expect(redisFirst?.name).toBeTruthy();
    expect(redisSecond?.name).toBeTruthy();
    expect(redisFirst?.name).not.toBe(redisSecond?.name);
  });

  it('keeps keys and pub/sub separate and only removes the session that closes', async () => {
    const a = redisFirst as IsolatedRedis;
    const b = redisSecond as IsolatedRedis;
    const aClient = new Redis(a.url);
    const bClient = new Redis(b.url);
    const aSub = new Redis(a.url);
    const bSub = new Redis(b.url);
    try {
      await expect(aClient.ping()).resolves.toBe('PONG');
      await expect(bClient.ping()).resolves.toBe('PONG');

      await aClient.set('isolation-key', 'a');
      expect(await bClient.get('isolation-key')).toBeNull();

      const aMessages: string[] = [];
      const bMessages: string[] = [];
      aSub.on('message', (_channel, message) => aMessages.push(message));
      bSub.on('message', (_channel, message) => bMessages.push(message));
      await aSub.subscribe('isolation-channel');
      await bSub.subscribe('isolation-channel');
      await aClient.publish('isolation-channel', 'hello');
      await waitFor(() => aMessages.length === 1);
      expect(aMessages).toEqual(['hello']);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bMessages).toEqual([]);

      await stopRedisContainer(a);
      await expect(bClient.ping()).resolves.toBe('PONG');
      await bClient.set('after-close', 'b');
      expect(await bClient.get('after-close')).toBe('b');
    } finally {
      aClient.disconnect();
      bClient.disconnect();
      aSub.disconnect();
      bSub.disconnect();
    }
  });
});

describe('redis container cleanup', () => {
  it('reports a failed removal and keeps the handle retryable', async () => {
    // 以非法名字让 docker rm 返回非零，不触碰任何真实容器。
    const missing: IsolatedRedis = {
      name: '--invalid-container',
      url: 'redis://127.0.0.1:1/9',
      stopped: false,
    };
    await expect(stopRedisContainer(missing)).rejects.toThrow(missing.name);
    expect(missing.stopped).toBe(false);
    await expect(stopRedisContainer(missing)).rejects.toThrow(missing.name);
  });
});
