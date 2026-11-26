import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/shared';
import {
  type DockerProcess,
  type DockerProcessResult,
  runDockerProcess,
  type SpawnFn,
  spawnDocker,
} from '../sandbox/docker-cli.js';

export { type DockerProcess, type SpawnFn, spawnDocker };

export function keepTail(text: string): string {
  return text.length > RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT
    ? text.slice(text.length - RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT)
    : text;
}

export function runDocker(
  spawnFn: SpawnFn,
  args: string[],
  signal: AbortSignal | undefined,
  onOutput?: (chunk: string) => void,
): Promise<DockerProcessResult> {
  return runDockerProcess({
    args,
    spawn: spawnFn,
    tailLimit: RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT,
    signal,
    onOutput,
  });
}
