import { resolve } from 'node:path';
import { CONFIG_CONTAINER_DIR, WORKSPACE_CONTAINER_DIR } from '@agentport/shared';
import {
  type Sandbox,
  SandboxCleanupError,
  type SandboxCreateOptions,
  type SandboxProvider,
} from './provider.js';

export interface DockerSandboxOptions {
  memory: string;
  cpus: number;
  pids: number;
  egress: 'open' | 'none' | 'proxy';
  closing?: AbortSignal;
}

function network(egress: DockerSandboxOptions['egress']): string {
  return egress === 'none' ? 'none' : 'bridge';
}

const STOP_GRACE_SECONDS = '5';
const CLEANUP_TIMEOUT_MS = 10_000;
const REMOVAL_POLL_MS = 100;

function abortError(): Error {
  const error = new Error('sandbox create aborted');
  error.name = 'AbortError';
  return error;
}

function errorDetail(stderr: string): string {
  const line = stderr.trim().split('\n').at(-1);
  return line === undefined || line === '' ? '' : `: ${line}`;
}

/**
 * 镜像 ID（含可选的 sha256: 前缀）是不可变引用：本地缺失时不能隐式 pull，
 * 否则同一 run 可能悄悄换成一个内容不同的镜像。
 */
function isImageId(image: string): boolean {
  return /^(sha256:)?[a-f0-9]{64}$/i.test(image);
}

interface CommandResult {
  ok: boolean;
  missing: boolean;
  stdout: string;
  stderr: string;
}

const OUTPUT_TAIL = 4_000;

function readChunks(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  return (async () => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (text !== '') onChunk(text);
    }
    const rest = decoder.decode();
    if (rest !== '') onChunk(rest);
  })();
}

function runDockerCommand(args: string[], timeoutMs?: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand, reject) => {
    const proc = Bun.spawn(['docker', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`docker ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };
    Promise.all([
      readChunks(proc.stdout, (chunk) => {
        stdout = (stdout + chunk).slice(-OUTPUT_TAIL);
      }),
      readChunks(proc.stderr, (chunk) => {
        stderr = (stderr + chunk).slice(-OUTPUT_TAIL);
      }),
      proc.exited,
    ]).then(
      ([, , exitCode]) => {
        clear();
        const code = proc.signalCode === null ? exitCode : null;
        const ok = code === 0;
        // Docker CLI 对不存在的容器/对象/镜像固定报 "No such ..."；其他非 0 不能当成已清理。
        resolveCommand({
          ok,
          missing: !ok && /no such (container|object|image)/i.test(stderr),
          stdout,
          stderr,
        });
      },
      (err) => {
        clear();
        reject(err);
      },
    );
  });
}

/**
 * `docker rm -f` 与容器自身 `--rm` 自动删除并发时，daemon 返回
 * "removal ... is already in progress"；它不是成功也不是失败，要另行确认结果。
 */
function removalInProgress(stderr: string): boolean {
  return /removal of container .* is already in progress/i.test(stderr);
}

export async function resolveLocalImageId(image: string): Promise<string | null> {
  const inspected = await runDockerCommand(
    ['image', 'inspect', '--format', '{{.Id}}', image],
    CLEANUP_TIMEOUT_MS,
  );
  if (inspected.ok) {
    const id = inspected.stdout.trim();
    return id === '' ? null : id;
  }
  if (inspected.missing) return null;
  throw new Error(`docker image inspect ${image} failed${errorDetail(inspected.stderr)}`);
}

/**
 * 只读根文件系统 + tmpfs：Agent SDK 会写 /tmp 与 ~/.claude 的缓存。
 * `/home/node/.claude` 只有在调用方没有挂持久目录时才用 tmpfs：
 * Docker 不允许同一容器路径同时挂 tmpfs 与 bind mount（Duplicate mount point）。
 */
function readOnlyArgs(extraMounts: SandboxCreateOptions['extraMounts']): string[] {
  const configDirMounted = (extraMounts ?? []).some(
    (mount) => resolve(mount.containerPath) === CONFIG_CONTAINER_DIR,
  );
  return [
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    ...(configDirMounted
      ? []
      : ['--tmpfs', `${CONFIG_CONTAINER_DIR}:rw,noexec,nosuid,size=64m,uid=1000,gid=1000`]),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
  ];
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly options: DockerSandboxOptions;
  private readonly running = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closed = new AbortController();

  constructor(options: DockerSandboxOptions) {
    this.options = options;
  }

  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const signal = AbortSignal.any(
      [options.signal, this.options.closing, this.closed.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    if (signal.aborted) throw abortError();
    const creating = this.createSandbox(options, signal);
    this.pending.add(creating);
    try {
      return await creating;
    } finally {
      this.pending.delete(creating);
    }
  }

  private async createSandbox(
    options: SandboxCreateOptions,
    signal: AbortSignal,
  ): Promise<Sandbox> {
    const workspace = resolve(options.workspaceDir);
    const envArgs = Object.entries(options.env).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]);
    const name = options.name ?? `agentport-${process.pid}-${Date.now()}`;

    await this.ensureImage(options.image, signal);
    if (signal.aborted) throw abortError();

    const args = [
      'create',
      '--pull=never',
      '--rm',
      '-i',
      '--network',
      network(this.options.egress),
      // macOS 的 Docker Desktop 自带 host.docker.internal；Linux 需要显式映射。
      '--add-host',
      'host.docker.internal:host-gateway',
      '--memory',
      this.options.memory,
      '--cpus',
      String(this.options.cpus),
      '--pids-limit',
      String(this.options.pids),
      '--user',
      '1000:1000',
      '--workdir',
      '/app',
      ...readOnlyArgs(options.extraMounts),
      ...(options.init === true ? ['--init'] : []),
      '-v',
      `${workspace}:${WORKSPACE_CONTAINER_DIR}:ro`,
      ...(options.extraMounts ?? []).flatMap((mount) => [
        '-v',
        `${resolve(mount.hostPath)}:${mount.containerPath}:${mount.readonly ? 'ro' : 'rw'}`,
      ]),
      ...envArgs,
      '--name',
      name,
      ...(options.entrypoint === undefined ? [] : ['--entrypoint', options.entrypoint]),
      options.image,
      ...(options.command ?? []),
    ];
    const created = await runDockerCommand(args);
    if (!created.ok) throw new Error(`docker create ${name} failed${errorDetail(created.stderr)}`);
    this.running.add(name);

    if (signal.aborted) {
      try {
        await this.removeContainer(name);
      } catch (err) {
        throw new SandboxCleanupError(name, `docker rm -f ${name} failed after create abort`, err);
      }
      this.running.delete(name);
      throw abortError();
    }

    let child: Sandbox['child'];
    try {
      child = Bun.spawn(['docker', 'start', '-ai', name], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      try {
        await this.removeContainer(name);
      } catch (cleanupErr) {
        throw new SandboxCleanupError(
          name,
          `docker rm -f ${name} failed after start spawn failure`,
          cleanupErr,
        );
      }
      this.running.delete(name);
      throw err;
    }
    return { id: name, child };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      await this.destroyById(sandbox.id);
    } finally {
      sandbox.child.kill('SIGKILL');
    }
  }

  async destroyById(id: string): Promise<void> {
    await this.stopAndRemove(id);
    this.running.delete(id);
  }

  async destroyAll(): Promise<void> {
    this.closed.abort();
    await Promise.allSettled([...this.pending]);
    const ids = [...this.running];
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => this.stopAndRemove(id)));
    const failures: Error[] = [];
    results.forEach((result, index) => {
      const id = ids[index];
      if (result.status === 'fulfilled') {
        if (id !== undefined) this.running.delete(id);
      } else {
        failures.push(new Error(`sandbox ${String(id)} cleanup failed`, { cause: result.reason }));
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, `docker sandbox cleanup failed: ${ids.join(', ')}`);
    }
  }

  async ensureImage(image: string, signal: AbortSignal): Promise<void> {
    const inspected = await runDockerCommand(['image', 'inspect', image], CLEANUP_TIMEOUT_MS);
    if (inspected.ok) return;
    if (!inspected.missing) {
      throw new Error(`docker image inspect ${image} failed${errorDetail(inspected.stderr)}`);
    }
    if (isImageId(image)) {
      throw new Error(
        `sandbox image ${image} is not present locally; refusing to pull an immutable image id`,
      );
    }
    await this.pullImage(image, signal);
  }

  private pullImage(image: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePull, reject) => {
      let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
      try {
        proc = Bun.spawn(['docker', 'pull', image], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        reject(signal.aborted ? abortError() : err);
        return;
      }
      let stderr = '';
      const onAbort = (): void => {
        proc.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = (error?: Error): void => {
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) resolvePull();
        else reject(error);
      };
      Promise.all([
        readChunks(proc.stderr, (chunk) => {
          stderr = (stderr + chunk).slice(-OUTPUT_TAIL);
        }),
        proc.exited,
      ]).then(
        ([, code]) => {
          if (signal.aborted) return finish(abortError());
          if (code === 0) return finish();
          finish(new Error(`docker pull ${image} failed${errorDetail(stderr)}`));
        },
        (err) => finish(signal.aborted ? abortError() : err),
      );
      if (signal.aborted) onAbort();
    });
  }

  private async removeContainer(id: string): Promise<void> {
    const removed = await runDockerCommand(['rm', '-f', id], CLEANUP_TIMEOUT_MS);
    if (removed.ok || removed.missing) return;
    if (!removalInProgress(removed.stderr)) {
      throw new Error(`docker rm -f ${id} failed${errorDetail(removed.stderr)}`);
    }
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inspected = await runDockerCommand(
        ['container', 'inspect', '--format', '{{.Id}}', id],
        CLEANUP_TIMEOUT_MS,
      );
      if (inspected.missing) return;
      if (!inspected.ok) {
        throw new Error(`docker inspect ${id} failed${errorDetail(inspected.stderr)}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, REMOVAL_POLL_MS));
    }
    throw new Error(
      `docker rm -f ${id} still in progress after ${CLEANUP_TIMEOUT_MS}ms${errorDetail(removed.stderr)}`,
    );
  }

  private async stopAndRemove(id: string): Promise<void> {
    // stop 只做优雅尝试；它退出 0 也不代表 created 容器被 --rm 删除，清理以 rm 为准。
    await runDockerCommand(['stop', '--time', STOP_GRACE_SECONDS, id], CLEANUP_TIMEOUT_MS).catch(
      () => {},
    );
    await this.removeContainer(id);
  }
}
