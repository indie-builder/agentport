import { CONFIG_CONTAINER_DIR } from '@agentport/shared';

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

export async function readChunks(
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

export interface DockerProcessResult {
  code: number | null;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

export function runDockerProcess(options: {
  args: string[];
  tailLimit: number;
  spawn?: SpawnFn;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onOutput?: ((chunk: string) => void) | undefined;
}): Promise<DockerProcessResult> {
  const { args, tailLimit, signal, timeoutMs, onOutput } = options;
  const spawn = options.spawn ?? spawnDocker;
  return new Promise<DockerProcessResult>((resolveCommand, reject) => {
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const child = spawn('docker', args);
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`docker ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    if (signal?.aborted) onAbort();
    Promise.all([
      readChunks(child.stdout, (chunk) => {
        stdout = (stdout + chunk).slice(-tailLimit);
        onOutput?.(chunk);
      }),
      readChunks(child.stderr, (chunk) => {
        stderr = (stderr + chunk).slice(-tailLimit);
        onOutput?.(chunk);
      }),
      child.exited,
    ]).then(
      ([, , exitCode]) => {
        cleanup();
        resolveCommand({
          code: child.signalCode === null ? exitCode : null,
          aborted,
          stdout,
          stderr,
        });
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

export function dockerHardeningArgs(options: { mountConfigTmpfs: boolean }): string[] {
  return [
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    ...(options.mountConfigTmpfs
      ? ['--tmpfs', `${CONFIG_CONTAINER_DIR}:rw,noexec,nosuid,size=64m,uid=1000,gid=1000`]
      : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '--workdir',
    '/app',
  ];
}
