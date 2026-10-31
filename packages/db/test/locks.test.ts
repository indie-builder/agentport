import { randomUUID } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { createDb, type DbPool } from '../src/client.js';
import { withAdvisoryLock } from '../src/repo/locks.js';

const { pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);
const observer = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 2 });
// 同轮其它 db 套件也使用生产绑定键；本文件用独立键验证 helper 本身的语义。
const testKey = `runtimeB-locks-${randomUUID()}`;

afterAll(async () => {
  await observer.end();
  await pool.end();
});

async function backendPid(db: Database): Promise<number> {
  const result = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return Number(result.rows[0]?.pid);
}

async function canTakeSameKey(target: Pool, key: string): Promise<boolean> {
  const result = await target.query<{ locked: boolean }>(
    'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
    [key],
  );
  return result.rows[0]?.locked === true;
}

/** 后端断开会异步释放 session lock；只轮询条件，不靠固定 sleep 猜时序。 */
async function lockReleased(key: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canTakeSameKey(observer, key)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return canTakeSameKey(observer, key);
}

interface BlockingProxy {
  readonly url: string;
  blocked(): boolean;
  close(): Promise<void>;
}

/**
 * 真实 TCP 代理：匹配到指定 SQL 后，要么丢掉服务端响应（query 已执行），
 * 要么丢掉请求本身（服务端未执行），用来验证客户端截止而不是依赖服务端 timeout。
 */
async function startBlockingProxy(
  connectionString: string,
  marker: string,
  mode: 'request' | 'response',
  occurrence = 1,
): Promise<BlockingProxy> {
  const target = new URL(connectionString);
  const sockets = new Set<Socket>();
  let matches = 0;
  let triggered = false;
  const server = createServer((downstream) => {
    const upstream = connect({
      host: target.hostname,
      port: Number(target.port === '' ? 5432 : target.port),
    });
    sockets.add(downstream);
    sockets.add(upstream);
    const cleanup = (): void => {
      downstream.destroy();
      upstream.destroy();
      sockets.delete(downstream);
      sockets.delete(upstream);
    };
    downstream.on('error', cleanup);
    upstream.on('error', cleanup);
    downstream.on('close', cleanup);
    upstream.on('close', cleanup);
    downstream.on('data', (chunk: Buffer) => {
      if (!triggered && chunk.includes(marker)) {
        matches += 1;
        if (matches >= occurrence) {
          triggered = true;
          if (mode === 'request') return;
        }
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      // 触发后不再把服务端响应交给客户端；连接保持打开，模拟网络黑洞。
      if (!triggered) downstream.write(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no port');
  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    blocked: () => triggered,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function proxiedPool(url: string): { pool: DbPool; real: Pool; releases: boolean[] } {
  const real = new Pool({ connectionString: url, max: 1 });
  const releases: boolean[] = [];
  return { pool: faultyPool(real, () => undefined, releases), real, releases };
}

interface Fault {
  reject?: unknown;
  result?: unknown;
}

/** 真实 PG 上只替换一条语句的结果，用来触发难自然出现的 unlock/reset/acquire 分支。 */
function faultyPool(
  real: Pool,
  fault: (text: string, values: unknown[] | undefined) => Fault | undefined,
  releases: boolean[],
): DbPool {
  return {
    connect: async () => {
      const client = await real.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (text: string, values?: unknown[]) => {
              const injected = fault(text, values);
              if (injected?.reject !== undefined) return Promise.reject(injected.reject);
              if (injected?.result !== undefined) return Promise.resolve(injected.result);
              return target.query(text, values);
            };
          }
          if (property === 'release') {
            return (destroy?: boolean | Error) => {
              releases.push(destroy === true);
              return target.release(destroy as boolean | undefined);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  } as unknown as DbPool;
}

describe.skipIf(!ready)('withAdvisoryLock', () => {
  it('runs A/B on the same pooled client and releases the session lock', async () => {
    const pids: number[] = [];
    const value = await withAdvisoryLock(pool, testKey, async (db) => {
      pids.push(await backendPid(db));
      pids.push(await db.transaction((tx) => backendPid(tx as unknown as Database)));
      pids.push(await db.transaction((tx) => backendPid(tx as unknown as Database)));
      return 'done';
    });
    expect(value).toBe('done');
    expect(new Set(pids).size).toBe(1);
    expect(await canTakeSameKey(observer, testKey)).toBe(true);
  });

  it('completes two transactions with a single-connection pool without self-locking', async () => {
    const single = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
    try {
      await expect(
        withAdvisoryLock(single, testKey, async (db) => {
          await db.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
          });
          await db.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
          });
        }),
      ).resolves.toBeUndefined();
    } finally {
      await single.end();
    }
  });

  it('excludes the same key from another session while held', async () => {
    let allowed: boolean | undefined;
    await withAdvisoryLock(pool, testKey, async () => {
      allowed = await canTakeSameKey(observer, testKey);
    });
    expect(allowed).toBe(false);
    expect(await canTakeSameKey(observer, testKey)).toBe(true);
  });

  it('destroys the client when unlock reports false and does not leak the lock', async () => {
    const releases: boolean[] = [];
    const faulty = faultyPool(
      pool,
      (text) =>
        text.includes('pg_advisory_unlock')
          ? { result: { rows: [{ unlocked: false }] } }
          : undefined,
      releases,
    );
    await expect(withAdvisoryLock(faulty, testKey, async () => 'ignored')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(releases).toEqual([true]);
    expect(await lockReleased(testKey)).toBe(true);
  });

  it('destroys the client when unlock throws', async () => {
    const releases: boolean[] = [];
    const faulty = faultyPool(
      pool,
      (text) =>
        text.includes('pg_advisory_unlock') ? { reject: new Error('unlock failed') } : undefined,
      releases,
    );
    await expect(withAdvisoryLock(faulty, testKey, async () => 'ignored')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(releases).toEqual([true]);
    expect(await lockReleased(testKey)).toBe(true);
  });

  it('destroys the client when restoring connection settings fails', async () => {
    const releases: boolean[] = [];
    let lockTimeoutSets = 0;
    const faulty = faultyPool(
      pool,
      (text, values) => {
        if (text.includes('set_config') && values?.[0] === 'lock_timeout') {
          lockTimeoutSets += 1;
          if (lockTimeoutSets === 2) return { reject: new Error('reset failed') };
        }
        return undefined;
      },
      releases,
    );
    await expect(withAdvisoryLock(faulty, testKey, async () => 'ignored')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(releases).toEqual([true]);
    expect(await lockReleased(testKey)).toBe(true);
  });

  it('destroys the client when lock acquisition has an unknown result', async () => {
    const releases: boolean[] = [];
    const faulty = faultyPool(
      pool,
      (text) =>
        text.includes('pg_advisory_lock')
          ? { reject: Object.assign(new Error('lock timeout'), { code: '55P03' }) }
          : undefined,
      releases,
    );
    await expect(withAdvisoryLock(faulty, testKey, async () => 'ignored')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(releases).toEqual([true]);
    expect(await lockReleased(testKey)).toBe(true);
  });

  it('expires the hold budget, destroys the client, and stops a late callback from deleting', async () => {
    const releases: boolean[] = [];
    let continued = false;
    const faulty = faultyPool(pool, () => undefined, releases);
    await expect(
      withAdvisoryLock(
        faulty,
        testKey,
        async (db) => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await db.execute(sql`select 1`);
          continued = true;
          return 'late';
        },
        50,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(releases).toEqual([true]);
    expect(continued).toBe(false);
    expect(await lockReleased(testKey)).toBe(true);
  });

  it('still supports memory callbacks that ignore the delivered connection', async () => {
    const memoryKey = `user:runtimeB-${randomUUID()}`;
    const value = await withAdvisoryLock(pool, memoryKey, async () => {
      const result = await pool.query('select 1 as value');
      return result.rows[0]?.value;
    });
    expect(value).toBe(1);
    expect(await canTakeSameKey(observer, memoryKey)).toBe(true);
  });

  it('aborts a blocked settings read by the client deadline and releases the connection once', async () => {
    const proxy = await startBlockingProxy(
      process.env.DATABASE_URL ?? '',
      'current_setting',
      'response',
    );
    const { pool: proxied, real, releases } = proxiedPool(proxy.url);
    const key = `${testKey}-${randomUUID()}`;
    let ran = false;
    try {
      const started = Date.now();
      await expect(
        withAdvisoryLock(proxied, key, async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const elapsed = Date.now() - started;
      expect(proxy.blocked()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(releases).toEqual([true]);
      expect(ran).toBe(false);
      expect(await canTakeSameKey(observer, key)).toBe(true);
    } finally {
      await real.end();
      await proxy.close();
    }
  }, 12_000);

  it('aborts a blocked lock acquisition by the client deadline and leaks no lock', async () => {
    const proxy = await startBlockingProxy(
      process.env.DATABASE_URL ?? '',
      'pg_advisory_lock',
      'response',
    );
    const { pool: proxied, real, releases } = proxiedPool(proxy.url);
    const key = `${testKey}-${randomUUID()}`;
    let ran = false;
    try {
      const started = Date.now();
      await expect(
        withAdvisoryLock(proxied, key, async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const elapsed = Date.now() - started;
      expect(proxy.blocked()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(releases).toEqual([true]);
      expect(ran).toBe(false);
      // 服务端已执行取锁；销毁 TCP 连接必须让后端退出并释放 session lock。
      expect(await lockReleased(key)).toBe(true);
    } finally {
      await real.end();
      await proxy.close();
    }
  }, 12_000);

  it('aborts a blocked settings restore by the client deadline before the callback starts', async () => {
    const proxy = await startBlockingProxy(
      process.env.DATABASE_URL ?? '',
      'set_config',
      'response',
      3,
    );
    const { pool: proxied, real, releases } = proxiedPool(proxy.url);
    const key = `${testKey}-${randomUUID()}`;
    let ran = false;
    try {
      const started = Date.now();
      await expect(
        withAdvisoryLock(proxied, key, async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const elapsed = Date.now() - started;
      expect(proxy.blocked()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(releases).toEqual([true]);
      expect(ran).toBe(false);
      expect(await lockReleased(key)).toBe(true);
    } finally {
      await real.end();
      await proxy.close();
    }
  }, 12_000);

  it('aborts a blocked unlock request by the client deadline and leaks no lock', async () => {
    const proxy = await startBlockingProxy(
      process.env.DATABASE_URL ?? '',
      'pg_advisory_unlock',
      'request',
    );
    const { pool: proxied, real, releases } = proxiedPool(proxy.url);
    const key = `${testKey}-${randomUUID()}`;
    let ran = false;
    try {
      const started = Date.now();
      await expect(
        withAdvisoryLock(proxied, key, async () => {
          ran = true;
          return 'done';
        }),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const elapsed = Date.now() - started;
      expect(proxy.blocked()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(releases).toEqual([true]);
      expect(ran).toBe(true);
      // 服务端没收到 unlock，仍持有 session lock；销毁连接后必须可再次取得。
      expect(await lockReleased(key)).toBe(true);
    } finally {
      await real.end();
      await proxy.close();
    }
  }, 12_000);

  it('starts the hold deadline when the lock is confirmed, so it also covers settings restore', async () => {
    const proxy = await startBlockingProxy(
      process.env.DATABASE_URL ?? '',
      'set_config',
      'response',
      3,
    );
    const { pool: proxied, real, releases } = proxiedPool(proxy.url);
    const key = `${testKey}-${randomUUID()}`;
    let ran = false;
    try {
      const started = Date.now();
      await expect(
        withAdvisoryLock(
          proxied,
          key,
          async () => {
            ran = true;
          },
          100,
        ),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const elapsed = Date.now() - started;
      expect(proxy.blocked()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(1_000);
      expect(releases).toEqual([true]);
      expect(ran).toBe(false);
      expect(await lockReleased(key)).toBe(true);
    } finally {
      await real.end();
      await proxy.close();
    }
  }, 12_000);
});
