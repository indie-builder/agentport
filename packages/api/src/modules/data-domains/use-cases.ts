import { fail } from '@agentport/core';
import type { Database } from '@agentport/db';
import { repo } from '@agentport/db';
import { DATA_DOMAIN_BUILDS_QUEUE, dataDomainBuildEnqueueOptions } from '@agentport/shared';
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
