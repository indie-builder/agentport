import { AppError } from '@agentport/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import type { Database, DatabaseClient } from '../client.js';
import { agents, schema } from '../schema.js';

type LockDb = Pick<Database, 'execute' | 'select'>;

/** 委派、准入、记忆与删除共用的绑定锁键；API 复用同一字符串，不另造键。 */
export const AGENT_BINDINGS_LOCK_KEY = 'agentport.subagent-bindings';

const CONTROL_QUERY_TIMEOUT = '5s';

const CONTROL_QUERY_TIMEOUT_MS = 5_000;

/**
 * 委派关系、运行准入与记忆写入共用的绑定锁。凡是会读「发起专家 + enabled 子级」
 * 或改变这层关系的写事务，都必须先拿它；拿锁顺序固定为 绑定锁 → 记忆锁 → 行锁。
 */
export async function lockAgentBindings(db: LockDb): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${AGENT_BINDINGS_LOCK_KEY}))`);
}

async function lockMemoryKey(db: LockDb, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * 一次运行占用的资源集合 = 发起专家 + 发布快照的子智能体（缺省为 live enabled 直接子智能体）。
 * 集合在运行期间固定：先拿绑定锁再读子级，然后按 agentId 排序取记忆锁。
 * 调用方必须在插入 queued 运行的同一事务里调用。
 */
export async function lockRunResources(
  db: LockDb,
  agentId: string,
  subAgentIds?: string[],
): Promise<void> {
  await lockAgentBindings(db);
  const children = (
    await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          subAgentIds === undefined
            ? eq(agents.parentId, agentId)
            : inArray(agents.id, subAgentIds),
          eq(agents.enabled, true),
        ),
      )
      .orderBy(asc(agents.id))
  ).map((row) => row.id);
  const ids = [...new Set([agentId, ...children])].sort();
  for (const id of ids) await lockMemoryKey(db, agentMemoryLockKey(id));
}

/**
 * 记忆写入的统一目标锁：个人记忆按用户，专家记忆与规则共用该专家一把锁。
 * 同一专家只取一个锁，避免多个写入口交叉持锁。
 */
export function memoryTargetLockKey(
  target: { kind: 'personal' } | { kind: 'agent_memory' | 'agent_rule'; agentId: string },
  userId: string,
): string {
  return target.kind === 'personal' ? `user:${userId}` : `agent:${target.agentId}`;
}

function agentMemoryLockKey(agentId: string): string {
  return `agent:${agentId}`;
}

function serviceError(message: string, cause?: unknown): AppError {
  return new AppError('SERVICE_UNAVAILABLE', message, { cause, retryable: true });
}

function connectionError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * 会话级 advisory lock 覆盖整个操作：DB 事务提交/回滚由 fn 自己完成，
 * 锁一直持有到 fn 返回，文件投影与数据库写入之间不再留空窗。
 *
 * helper 在同一 checked-out client 上创建 Drizzle 并交给 fn；绝不替回调换连接。
 * 所有控制查询（读设置、取锁、解锁、恢复）都有 5s 客户端截止，超时立即销毁连接，
 * 不再在失效连接上等 finally 清理。连接错误、解锁/恢复失败或取锁结果未知时同样销毁，
 * 保证锁不会随连接归池泄漏。
 * `holdTimeoutMs` 只给删除这类跨网络确认的操作使用，从确认拿锁时起计时，覆盖其后
 * 的设置恢复、tx A/B 与 unlock；超时即销毁原 client 并拒绝，迟到回调不能换连接继续写入。
 */
export async function withAdvisoryLock<T>(
  databaseClient: DatabaseClient,
  key: string,
  fn: (db: Database) => Promise<T>,
  holdTimeoutMs?: number,
): Promise<T> {
  const client = await databaseClient.reserve().catch((err: unknown) => {
    throw serviceError('无法取得数据库锁，操作未执行', err);
  });
  let released = false;
  let closing: Promise<void> | undefined;
  let broken: Error | undefined;
  let statementTimeout: string | undefined;
  let lockTimeout: string | undefined;
  let lockHeld = false;
  let callbackStarted = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let expireHold: ((err: Error) => void) | undefined;
  let holdDeadline: Promise<never> | undefined;

  const releaseOnce = (destroy: boolean): void => {
    if (released) return;
    released = true;
    if (destroy) {
      closing = client.close({ timeout: 0 });
      void closing.catch(() => undefined);
    } else {
      client.release();
    }
  };

  const destroyControl = (message: string, cause?: unknown): AppError => {
    broken ??= connectionError(cause);
    releaseOnce(true);
    return serviceError(message, cause);
  };

  const control = <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: string[],
  ): Promise<R[]> => {
    if (released) return Promise.reject(serviceError('数据库连接已销毁，操作未执行'));
    return new Promise<R[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          destroyControl(
            '数据库锁控制查询超过客户端 5s 截止，连接已销毁',
            new Error('control query client deadline exceeded'),
          ),
        );
      }, CONTROL_QUERY_TIMEOUT_MS);
      timer.unref?.();
      client.unsafe<R[]>(text, values).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(destroyControl('数据库锁控制查询失败，连接已销毁', err));
        },
      );
    });
  };

  const readSetting = async (name: string): Promise<string> => {
    const result = await control<{ value: string }>('select current_setting($1) as value', [name]);
    return result[0]?.value ?? '0';
  };
  const setSetting = (name: string, value: string): Promise<unknown> =>
    control('select set_config($1, $2, false)', [name, value]);

  const startHoldDeadline = (): void => {
    if (holdTimeoutMs === undefined) return;
    holdDeadline = new Promise<never>((_, reject) => {
      expireHold = reject;
    });
    holdTimer = setTimeout(() => {
      const error = destroyControl(
        '删除操作超过持锁时间上限，操作未完成',
        new Error('hold deadline exceeded'),
      );
      expireHold?.(error);
    }, holdTimeoutMs);
    holdTimer.unref?.();
  };
  const bounded = <V>(promise: Promise<V>): Promise<V> =>
    holdDeadline === undefined ? promise : Promise.race([promise, holdDeadline]);

  let result: T | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    statementTimeout = await readSetting('statement_timeout');
    lockTimeout = await readSetting('lock_timeout');
    await setSetting('statement_timeout', CONTROL_QUERY_TIMEOUT);
    await setSetting('lock_timeout', CONTROL_QUERY_TIMEOUT);
    await control('select pg_advisory_lock(hashtext($1))', [key]);
    lockHeld = true;
    startHoldDeadline();
    await bounded(setSetting('statement_timeout', statementTimeout));
    if (broken !== undefined) throw serviceError('数据库连接在取锁后断开，操作未执行', broken);

    callbackStarted = true;
    const callback = Promise.resolve(fn(drizzle(client, { schema })));
    void callback.catch(() => undefined);
    result = await bounded(callback);
    if (broken !== undefined) throw serviceError('数据库连接在操作期间断开，操作未完成', broken);
  } catch (err) {
    primaryError =
      !callbackStarted && !(err instanceof AppError)
        ? serviceError('无法取得数据库锁，操作未执行', err)
        : err;
  }

  if (!released) {
    try {
      if (broken !== undefined) {
        throw serviceError('数据库连接已失效，取消解锁并销毁连接', broken);
      }
      if (!lockHeld) throw serviceError('无法取得数据库锁，操作未执行');
      await bounded(setSetting('statement_timeout', CONTROL_QUERY_TIMEOUT));
      const unlock = await bounded(
        control<{ unlocked: boolean }>('select pg_advisory_unlock(hashtext($1)) as unlocked', [
          key,
        ]),
      );
      if (unlock[0]?.unlocked !== true) {
        throw serviceError('数据库会话锁未按预期释放');
      }
      await bounded(setSetting('statement_timeout', statementTimeout ?? '0'));
      await bounded(setSetting('lock_timeout', lockTimeout ?? '0'));
      if (broken !== undefined) {
        throw serviceError('数据库连接在解锁后失效，操作结果按服务失败处理', broken);
      }
    } catch (err) {
      cleanupError = err;
    }
  }

  if (holdTimer !== undefined) clearTimeout(holdTimer);
  releaseOnce(cleanupError !== undefined);
  if (closing !== undefined) {
    try {
      await closing;
    } catch (err) {
      cleanupError ??= err;
    }
  }

  if (primaryError !== undefined) {
    const thrown =
      broken !== undefined && !(primaryError instanceof AppError)
        ? serviceError('数据库连接在操作期间断开，操作未完成', primaryError)
        : primaryError;
    if (cleanupError !== undefined && thrown instanceof Error) {
      Object.defineProperty(thrown, 'cleanupError', {
        value: cleanupError,
        enumerable: false,
        configurable: true,
      });
    }
    throw thrown;
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof AppError
      ? cleanupError
      : serviceError('数据库连接清理失败，操作可能未完成', cleanupError);
  }
  return result as T;
}
