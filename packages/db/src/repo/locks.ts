import { AppError } from '@agentport/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, DbPool } from '../client.js';
import { agents, schema } from '../schema.js';

/** 事务或连接都可用的最小查询面，避免调用方为了加锁反复 cast。 */
type LockDb = Pick<Database, 'execute' | 'select'>;

/** 委派、准入、记忆与删除共用的绑定锁键；API 复用同一字符串，不另造键。 */
export const AGENT_BINDINGS_LOCK_KEY = 'agentport.subagent-bindings';

/** 取锁、解锁与恢复连接设置的服务端上限；不允许为了等锁关闭 statement_timeout。 */
const CONTROL_QUERY_TIMEOUT = '5s';

/**
 * 控制查询的客户端截止。服务端 statement_timeout 只约束执行，无法覆盖请求/响应
 * 在网络中被黑洞的情形；超时立即销毁连接，避免在失效连接上继续 unlock/恢复。
 */
const CONTROL_QUERY_TIMEOUT_MS = 5_000;

/**
 * 委派关系、运行准入与记忆写入共用的绑定锁。凡是会读「发起专家 + enabled 子级」
 * 或改变这层关系的写事务，都必须先拿它；拿锁顺序固定为 绑定锁 → 记忆锁 → 行锁。
 */
export async function lockAgentBindings(db: LockDb): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${AGENT_BINDINGS_LOCK_KEY}))`);
}

/** 事务级 advisory lock，事务结束自动释放；调用方必须在事务里使用。 */
export async function lockMemoryKey(db: LockDb, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * 一次运行占用的资源集合 = 发起专家 + 其 enabled 直接子智能体。
 * 集合在运行期间固定：先拿绑定锁再读子级，然后按 agentId 排序取记忆锁。
 * 调用方必须在插入 queued 运行的同一事务里调用。
 */
export async function lockRunResources(db: LockDb, agentId: string): Promise<void> {
  await lockAgentBindings(db);
  const children = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.parentId, agentId), eq(agents.enabled, true)))
    .orderBy(asc(agents.id));
  const ids = [...new Set([agentId, ...children.map((row) => row.id)])].sort();
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

export function agentMemoryLockKey(agentId: string): string {
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
  pool: DbPool,
  key: string,
  fn: (db: Database) => Promise<T>,
  holdTimeoutMs?: number,
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  let broken: Error | undefined;
  let statementTimeout: string | undefined;
  let lockTimeout: string | undefined;
  let lockHeld = false;
  let callbackStarted = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let expireHold: ((err: Error) => void) | undefined;
  let holdDeadline: Promise<never> | undefined;

  const onError = (err: unknown): void => {
    broken ??= connectionError(err);
  };
  const onEnd = (): void => {
    broken ??= new Error('database connection ended');
  };
  client.on('error', onError);
  client.on('end', onEnd);

  const releaseOnce = (destroy: boolean): void => {
    if (released) return;
    released = true;
    client.removeListener('error', onError);
    client.removeListener('end', onEnd);
    client.release(destroy);
  };

  /** 控制查询超时/失效：先销毁一次连接，再把失败交给调用方。 */
  const destroyControl = (message: string, cause?: unknown): AppError => {
    broken ??= connectionError(cause);
    releaseOnce(true);
    return serviceError(message, cause);
  };

  const control = <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: string[],
  ): Promise<QueryResult<R>> => {
    if (released) return Promise.reject(serviceError('数据库连接已销毁，操作未执行'));
    return new Promise<QueryResult<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          destroyControl(
            '数据库锁控制查询超过客户端 5s 截止，连接已销毁',
            new Error('control query client deadline exceeded'),
          ),
        );
      }, CONTROL_QUERY_TIMEOUT_MS);
      timer.unref?.();
      client.query<R>(text, values).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  };

  const readSetting = async (name: string): Promise<string> => {
    const result = await control<{ value: string }>('select current_setting($1) as value', [name]);
    return result.rows[0]?.value ?? '0';
  };
  const setSetting = (name: string, value: string): Promise<unknown> =>
    control('select set_config($1, $2, false)', [name, value]);

  /** 从确认拿锁开始计时；timer 触发时立即销毁连接，并用同一错误打断当前 await。 */
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
    // 与 pg_advisory_xact_lock 共用 hashtext 的单 bigint 键空间。
    await control('select pg_advisory_lock(hashtext($1))', [key]);
    lockHeld = true;
    // timer 必须从确认拿锁就启动，才能覆盖其后的设置恢复、A/B 与 unlock。
    startHoldDeadline();
    // 业务查询沿用连接原有的 statement budget；lock_timeout 在退出时恢复。
    await bounded(setSetting('statement_timeout', statementTimeout));
    if (broken !== undefined) throw serviceError('数据库连接在取锁后断开，操作未执行', broken);

    callbackStarted = true;
    const callback = Promise.resolve(fn(drizzle(client, { schema })));
    // 超时竞速离开后回调仍可能在 ACK 等待；销毁连接会让它后续 SQL 失败。
    void callback.catch(() => undefined);
    result = await bounded(callback);
    if (broken !== undefined) throw serviceError('数据库连接在操作期间断开，操作未完成', broken);
  } catch (err) {
    primaryError =
      !callbackStarted && !(err instanceof AppError)
        ? serviceError('无法取得数据库锁，操作未执行', err)
        : err;
  }

  // 清理只执行一次；已知连接失效或已因超时销毁时不再 unlock，避免在死连接上等待。
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
      if (unlock.rows[0]?.unlocked !== true) {
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

  if (primaryError !== undefined) {
    const thrown =
      broken !== undefined && !(primaryError instanceof AppError)
        ? serviceError('数据库连接在操作期间断开，操作未完成', primaryError)
        : primaryError;
    if (cleanupError !== undefined && thrown instanceof Error) {
      // 关联清理失败但不覆盖原业务异常；调用方仍能看到真正失败原因。
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
