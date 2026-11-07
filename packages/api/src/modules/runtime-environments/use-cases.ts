import { fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import { repo } from '@agentport/db';
import {
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  type RuntimeEnvironmentVersion,
  runtimeBuildEnqueueOptions,
} from '@agentport/shared';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import { getRuntimeEnvironmentBuildQueue } from '../../queue/producer.js';

export async function requestRuntimeEnvironmentBuild(
  db: Database,
  config: Pick<Config, 'SANDBOX_IMAGE'>,
  log: Logger,
  environmentId: string,
): Promise<RuntimeEnvironmentVersion | null> {
  const version = await repo.runtimeEnvironments.enqueueRuntimeEnvironmentBuild(
    db,
    environmentId,
    config.SANDBOX_IMAGE,
  );
  if (!version) return null;
  try {
    await getRuntimeEnvironmentBuildQueue().add(
      'build',
      { versionId: version.id },
      runtimeBuildEnqueueOptions(version.id),
    );
  } catch {
    await repo.runtimeEnvironments
      .failRuntimeEnvironmentBuild(db, version.id, '构建任务入队失败，请稍后重试')
      .catch(() => null);
    log.warn(
      { environmentId, versionId: version.id },
      `runtime environment build enqueue failed (queue ${RUNTIME_ENVIRONMENT_BUILDS_QUEUE})`,
    );
    fail('SERVICE_UNAVAILABLE', '构建任务入队失败，请稍后重试');
  }
  return version;
}
