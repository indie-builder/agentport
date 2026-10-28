import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { TestProject } from 'vitest/node';
import { type BackendInfra, createIsolatedDatabase } from './isolated-db.js';

// 与 docker-compose.yml 的 redis 使用同一 tag+digest；CI 预拉取的就是这个 tag。
const REDIS_IMAGE =
  'redis:8.10.3-alpine@sha256:896f241f438ab6a210cfb24f573b84bea721a4cbe67f1b4fd07eb638b3b02a7b';
/** 私有实例内部的分区；对外仍沿用测试约定的 db 9。 */
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

/** 只有 CLI/守护进程不可用时才算基础设施缺失；镜像缺失等配置错误继续抛出。 */
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

/** 清理失败时同时保留原始错误与清理错误，并让调用方拿回重试机会。 */
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

/**
 * 每轮测试独享一个临时 Redis 容器：复用已缓存镜像，Docker 分配 loopback 随机端口，
 * 关闭持久化，结束时只按本次返回的容器名删除。Docker 不可用返回 null，由调用方
 * 发布不可连地址让依赖 Redis 的套件跳过，绝不回落到共享 Redis。
 */
export async function startRedisContainer(): Promise<IsolatedRedis | null> {
  const name = `${CONTAINER_PREFIX}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
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
  }
  project.provide('backendInfra', {
    DATABASE_URL: database?.url ?? UNAVAILABLE.DATABASE_URL,
    REDIS_URL: redis?.url ?? UNAVAILABLE.REDIS_URL,
  });

  // watch 会话开始时 globalSetup 只跑一次；会话内复用本轮资源，退出时 teardown 清理。
  return async () => {
    const results = await Promise.allSettled([
      stopRedisContainer(redis),
      database ? database.close() : Promise.resolve(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'backend tests: teardown failed');
    }
  };
}
