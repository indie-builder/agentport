import { BUILD_ENQUEUE_FAILED_MESSAGE } from '@agentport/core';
import type { repo } from '@agentport/db';
import { type RuntimeEnvironmentBuildJob, runtimeBuildEnqueueOptions } from '@agentport/shared';
import type { Logger } from 'pino';
import { RUNTIME_ENVIRONMENT_BUILD_JOB } from './build.js';

interface RuntimeEnvironmentSyncQueueLike {
  add: (
    name: string,
    data: RuntimeEnvironmentBuildJob,
    opts: ReturnType<typeof runtimeBuildEnqueueOptions>,
  ) => Promise<unknown>;
}

interface SyncStaleRuntimeEnvironmentsDeps {
  sandboxImage: string;
  resolveImageId: (image: string) => Promise<string | null>;
  listStale: (
    currentBaseImageId: string,
    sandboxImage: string,
  ) => Promise<repo.runtimeEnvironments.StaleOnlineRuntimeEnvironment[]>;
  enqueueBuild: (environmentId: string, baseImageId: string) => Promise<{ id: string } | null>;
  failBuild: (versionId: string, error: string) => Promise<unknown>;
  queue: RuntimeEnvironmentSyncQueueLike;
  logger: Logger;
  signal?: AbortSignal | undefined;
}

export async function syncStaleRuntimeEnvironments(
  deps: SyncStaleRuntimeEnvironmentsDeps,
): Promise<{ queued: number }> {
  if (deps.signal?.aborted) return { queued: 0 };
  const currentBaseImageId = await deps.resolveImageId(deps.sandboxImage);
  if (deps.signal?.aborted) return { queued: 0 };
  if (currentBaseImageId === null) {
    deps.logger.warn(
      { sandboxImage: deps.sandboxImage },
      'sandbox image not found locally; skipping runtime environment base sync',
    );
    return { queued: 0 };
  }

  const stale = await deps.listStale(currentBaseImageId, deps.sandboxImage);
  let queued = 0;
  for (const env of stale) {
    if (deps.signal?.aborted) break;
    const version = await deps.enqueueBuild(env.environmentId, currentBaseImageId);
    if (version === null) continue;
    try {
      await deps.queue.add(
        RUNTIME_ENVIRONMENT_BUILD_JOB,
        {
          versionId: version.id,
          autoPublishIfOnlineVersionId: env.onlineVersionId,
        },
        runtimeBuildEnqueueOptions(version.id),
      );
      queued += 1;
      deps.logger.info(
        {
          environmentId: env.environmentId,
          environmentName: env.environmentName,
          versionId: version.id,
          previousOnlineVersionId: env.onlineVersionId,
          previousBaseImageId: env.onlineBaseImageId,
          currentBaseImageId,
        },
        'queued stale runtime environment rebuild',
      );
    } catch (err) {
      await deps.failBuild(version.id, BUILD_ENQUEUE_FAILED_MESSAGE).catch(() => undefined);
      deps.logger.warn(
        { err, environmentId: env.environmentId, versionId: version.id },
        'failed to enqueue stale runtime environment rebuild',
      );
    }
  }
  return { queued };
}
