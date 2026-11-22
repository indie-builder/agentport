import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { type BackendInfra, createIsolatedDatabase } from './isolated-db.js';

const REDIS_IMAGE =
  'redis:8.10.3-alpine@sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537';
const REDIS_DB = 9;
const CONTAINER_PREFIX = 'backend_test_redis';
const UNAVAILABLE: BackendInfra = {
  DATABASE_URL: 'postgres://unreachable@127.0.0.1:1/backend_infra_unavailable',
  REDIS_URL: 'redis://127.0.0.1:1/9',
};

interface DockerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IsolatedRedis {
  readonly name: string;
  readonly url: string;
  stopped: boolean;
}

function docker(args: string[]): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function firstLine(output: string): string {
  return output.trim().split('\n')[0] ?? '';
}

function dockerError(result: DockerResult): string {
  return firstLine(result.stderr) || `exit ${result.code}`;
}

function dockerUnavailable(result: DockerResult): boolean {
  return (
    result.code === -1 ||
    /cannot connect to the docker daemon|is the docker daemon running|error during connect/i.test(
      result.stderr,
    )
  );
}

async function removeContainer(name: string): Promise<void> {
  const removed = await docker(['rm', '-f', name]);
  if (removed.code !== 0) {
    throw new Error(
      `backend tests: failed to remove Redis container ${name}: ${dockerError(removed)}`,
    );
  }
}

async function discardContainer(name: string, original: Error): Promise<never> {
  try {
    await removeContainer(name);
  } catch (cleanupError) {
    throw new AggregateError([original, cleanupError], original.message);
  }
  throw original;
}

function waitForPort(port: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

export async function startRedisContainer(): Promise<IsolatedRedis | null> {
  const name = `${CONTAINER_PREFIX}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  // create 与 start 分开：run 非零退出时容器可能已创建，唯一名字保证失败也只清本轮容器。
  const created = await docker([
    'create',
    '--name',
    name,
    '--pull=never',
    '-p',
    '127.0.0.1::6379',
    REDIS_IMAGE,
    'redis-server',
    '--save',
    '',
    '--appendonly',
    'no',
  ]);
  if (created.code !== 0) {
    if (dockerUnavailable(created)) {
      console.warn(
        `backend tests: Docker/Redis unavailable, Redis-backed suites will skip: ${dockerError(created)}`,
      );
      return null;
    }
    throw new Error(`backend tests: cannot create Redis container: ${dockerError(created)}`);
  }

  const started = await docker(['start', name]);
  if (started.code !== 0) {
    return discardContainer(
      name,
      new Error(`backend tests: Redis container ${name} failed to start: ${dockerError(started)}`),
    );
  }

  const portResult = await docker(['port', name, '6379/tcp']);
  const portLine = firstLine(portResult.stdout);
  const port = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
  if (portResult.code !== 0 || !Number.isInteger(port) || port <= 0) {
    const detail =
      portResult.code === 0 ? `unexpected port output "${portLine}"` : dockerError(portResult);
    return discardContainer(
      name,
      new Error(`backend tests: cannot resolve the Redis port for container ${name}: ${detail}`),
    );
  }
  if (!(await waitForPort(port))) {
    return discardContainer(
      name,
      new Error(`backend tests: Redis container ${name} did not accept connections on ${port}`),
    );
  }

  return { name, url: `redis://127.0.0.1:${port}/${REDIS_DB}`, stopped: false };
}

export async function stopRedisContainer(redis: IsolatedRedis | null): Promise<void> {
  if (!redis || redis.stopped) return;
  await removeContainer(redis.name);
  redis.stopped = true;
}

export default async function setup(): Promise<{
  env: BackendInfra;
  close(): Promise<void>;
}> {
  const database = await createIsolatedDatabase('backend_test');
  let redis: IsolatedRedis | null = null;
  try {
    redis = await startRedisContainer();
  } catch (error) {
    try {
      await database?.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'backend tests: setup failed and database cleanup also failed',
      );
    }
    throw error;
  }

  if (!database) {
    console.warn('backend tests: PostgreSQL unavailable, database-backed suites will skip');
  } else {
    console.info(`backend tests: PostgreSQL database ${database.name}`);
  }
  if (redis) console.info(`backend tests: Redis container ${redis.name}`);
  const env = {
    DATABASE_URL: database?.url ?? UNAVAILABLE.DATABASE_URL,
    REDIS_URL: redis?.url ?? UNAVAILABLE.REDIS_URL,
  };

  const missing = [...(database ? [] : ['PostgreSQL']), ...(redis ? [] : ['Redis'])];

  return {
    env,
    async close() {
      const results = await Promise.allSettled([
        stopRedisContainer(redis),
        database ? database.close() : Promise.resolve(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (missing.length > 0) {
        const missingError = new Error(
          `backend tests: missing infrastructure (${missing.join(', ')}); dependent suites were skipped, not passed`,
        );
        if (failures.length > 0) {
          throw new AggregateError([...failures, missingError], missingError.message);
        }
        throw missingError;
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'backend tests: teardown failed');
      }
    },
  };
}
