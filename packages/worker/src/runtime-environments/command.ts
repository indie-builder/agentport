import type { ChildProcess } from 'node:child_process';
import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/db';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

interface CommandResult {
  code: number | null;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

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
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const child = spawnFn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = keepTail(stdout + chunk);
      onOutput?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk);
      onOutput?.(chunk);
    });
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => signal?.removeEventListener('abort', onAbort);
    child.once('error', (err) => {
      finish();
      reject(err);
    });
    child.once('close', (code) => {
      finish();
      resolveCommand({ code, aborted, stdout, stderr });
    });
    if (signal?.aborted) onAbort();
  });
}
