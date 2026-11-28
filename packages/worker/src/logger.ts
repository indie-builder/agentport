import { createServiceLogger } from '@agentport/core/logger';
import type { Config } from './config.js';

const { version }: { version: string } = await Bun.file(
  new URL('../../../package.json', import.meta.url),
).json();

export function createWorkerLogger(config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>) {
  return createServiceLogger({
    service: 'worker',
    env: config.NODE_ENV,
    version,
    level: config.LOG_LEVEL,
  });
}
