import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/shared';

export interface DockerProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode: NodeJS.Signals | number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

export type SpawnFn = (command: string, args: readonly string[]) => DockerProcess;

export function spawnDocker(command: string, args: readonly string[]): DockerProcess {
  return Bun.spawn([command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

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

async function readChunks(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text !== '') onChunk(text);
  }
  const rest = decoder.decode();
  if (rest !== '') onChunk(rest);
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
    const child = spawnFn('docker', args);
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
    Promise.all([
      readChunks(child.stdout, (chunk) => {
        stdout = keepTail(stdout + chunk);
        onOutput?.(chunk);
      }),
      readChunks(child.stderr, (chunk) => {
        stderr = keepTail(stderr + chunk);
        onOutput?.(chunk);
      }),
      child.exited,
    ]).then(
      ([, , exitCode]) => {
        finish();
        resolveCommand({
          code: child.signalCode === null ? exitCode : null,
          aborted,
          stdout,
          stderr,
        });
      },
      (err) => {
        finish();
        reject(err);
      },
    );
  });
}
