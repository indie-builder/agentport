import { dataDomainConnectionTestResultSchema } from '@agentport/contract/data-domains';
import { fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import { repo } from '@agentport/db';
import { DATA_DOMAIN_BUILDS_QUEUE, dataDomainBuildEnqueueOptions } from '@agentport/shared';
import { Effect } from 'effect';
import type { Logger } from 'pino';
import { getDataDomainBuildQueue } from '../../queue/producer.js';

export async function enqueueDataDomainBuild(
  db: Database,
  log: Logger,
  dataDomainId: string,
  versionId: string,
): Promise<void> {
  try {
    await getDataDomainBuildQueue().add(
      'build',
      { dataDomainId, versionId },
      dataDomainBuildEnqueueOptions(versionId),
    );
  } catch {
    try {
      await repo.dataDomains.failDataDomainVersionBuild(db, versionId, 'queued');
    } catch {
      log.warn({ dataDomainId, versionId }, 'data domain version failed-state compensation failed');
    }
    log.warn(
      { dataDomainId, versionId },
      `data domain build enqueue failed (queue ${DATA_DOMAIN_BUILDS_QUEUE})`,
    );
    fail('SERVICE_UNAVAILABLE', '构建任务入队失败，请稍后重试');
  }
}

const CONNECTION_TEST_TIMEOUT_MS = 15_000;

const probeWrenRuntime = (
  url: string,
  datasource: string,
  connection: Record<string, string>,
): Effect.Effect<unknown, Error> =>
  Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (active) => Effect.sync(() => active.abort()),
    );
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ datasource, connection }),
          signal: controller.signal,
        });
        return (await response.json()) as unknown;
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.timeout(CONNECTION_TEST_TIMEOUT_MS));
  }).pipe(Effect.scoped);

export async function testDataDomainConnection(
  wrenRuntimeUrl: string,
  datasource: string,
  connection: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  if (wrenRuntimeUrl === '') {
    fail('SERVICE_UNAVAILABLE', '连接测试服务未配置（WREN_RUNTIME_URL）');
  }
  const url = `${wrenRuntimeUrl.replace(/\/+$/, '')}/test-connection`;
  const exit = await Effect.runPromiseExit(probeWrenRuntime(url, datasource, connection));
  if (exit._tag !== 'Success') {
    return { ok: false, error: '连接测试服务不可用，请稍后重试' };
  }
  const parsed = dataDomainConnectionTestResultSchema.safeParse(exit.value);
  if (!parsed.success) return { ok: false, error: '连接测试服务响应异常' };
  const { ok, error } = parsed.data;
  return error === undefined ? { ok } : { ok, error };
}
