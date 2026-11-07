import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { schema } from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];
export type DatabaseClient = SQL;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbHandle = Database | Transaction;

const POOL_WAIT_TIMEOUT_MS = 5_000;

type QueryValues = unknown[] | Record<string, unknown> | undefined;

function isoDateParams(values: QueryValues): QueryValues {
  if (!Array.isArray(values)) return values;
  return values.map((value) => (value instanceof Date ? value.toISOString() : value));
}

function withIsoDateParams<T extends SQL>(client: T): T {
  const unsafe = client.unsafe.bind(client);
  client.unsafe = (text, values) => unsafe(text, isoDateParams(values));
  const begin = client.begin.bind(client);
  client.begin = ((
    first: string | ((tx: Bun.TransactionSQL) => unknown),
    second?: (tx: Bun.TransactionSQL) => unknown,
  ) => {
    if (typeof first === 'string') {
      return begin(first, (tx) => second?.(withIsoDateParams(tx)));
    }
    return begin((tx) => first(withIsoDateParams(tx)));
  }) as typeof client.begin;
  return client;
}

export function createDb(connectionString: string) {
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const client = new SQL(connectionString, {
    max: Number.isFinite(max) && max > 0 ? max : 10,
    connectionTimeout: 5,
    prepare: false,
    connection: { statement_timeout: '15s', client_connection_check_interval: '1s' },
  });
  const acquire = client.reserve.bind(client);
  client.reserve = (options) => {
    const timeout = AbortSignal.timeout(POOL_WAIT_TIMEOUT_MS);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return acquire({ signal }).then(
      (reserved) => withIsoDateParams(reserved),
      (err: unknown) => {
        if (timeout.aborted && !options?.signal?.aborted) {
          throw new DOMException(
            `数据库连接池等待超时 (timeout): ${POOL_WAIT_TIMEOUT_MS}ms`,
            'TimeoutError',
          );
        }
        throw err;
      },
    );
  };
  withIsoDateParams(client);
  const db = drizzle(client, { schema });
  return { db, client };
}
