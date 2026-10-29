import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from './provider.js';

/** 与 worker config 对应的容器资源上限；默认值见 config.ts。 */
export interface DockerSandboxOptions {
  memory: string;
  cpus: number;
  pids: number;
  egress: 'open' | 'none' | 'proxy';
  /** 关停信号：abort 后拒绝新建容器，并取消进行中的镜像拉取。 */
  closing?: AbortSignal;
}

/**
 * 网络取舍：契约里的 `--network none` 会让沙盒连不上模型 API 与平台 /mcp 端点
 * （HTTP MCP server 也全部失效），所以网络模式改为可配置：
 * - open/proxy：bridge + host.docker.internal（容器内访问宿主 API / 模型代理）
 * - none：真正断网，启动时 worker 会显式警告
 * 默认 bridge 而不是 host：macOS 上 host 是 Docker 的特殊值，bridge 两端都可用。
 * proxy 模式同样是 bridge，出口由沙盒内 HTTPS_PROXY 指向宿主代理（单机妥协，
 * 代理不强制时容器仍可直连；需要硬隔离时用 none 或上出站网关）。
 */
function network(egress: DockerSandboxOptions['egress']): string {
  return egress === 'none' ? 'none' : 'bridge';
}

const CONFIG_DIR = '/home/node/.claude';
/** 给容器留 5s 自行退出；容器内 runner 已收到 SIGTERM。 */
const STOP_GRACE_SECONDS = '5';
const CLEANUP_TIMEOUT_MS = 10_000;
/** 等待 --rm 自动删除完成时的 inspect 轮询间隔。 */
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

function runDockerCommand(args: string[], timeoutMs?: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-4_000);
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
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
    proc.once('error', (err) => {
      clear();
      reject(err);
    });
    proc.once('close', (code) => {
      clear();
      const ok = code === 0;
      // Docker CLI 对不存在的容器/对象/镜像固定报 "No such ..."；其他非 0 不能当成已清理。
      resolveCommand({
        ok,
        missing: !ok && /no such (container|object|image)/i.test(stderr),
        stdout,
        stderr,
      });
    });
  });
}

/**
 * `docker rm -f` 与容器自身 `--rm` 自动删除并发时，daemon 返回
 * "removal ... is already in progress"；它不是成功也不是失败，要另行确认结果。
 */
function removalInProgress(stderr: string): boolean {
  return /removal of container .* is already in progress/i.test(stderr);
}

/** 读取本地镜像的实际 ID；镜像不存在返回 null，daemon 错误照常抛出。 */
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
    (mount) => resolve(mount.containerPath) === CONFIG_DIR,
  );
  return [
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    ...(configDirMounted
      ? []
      : ['--tmpfs', `${CONFIG_DIR}:rw,noexec,nosuid,size=64m,uid=1000,gid=1000`]),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
  ];
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly options: DockerSandboxOptions;
  /** 运行中的容器名，SIGTERM 兜底清理用。 */
  private readonly running = new Set<string>();
  /** 进行中的创建；shutdown 必须等它们按取消语义收尾，不能直接抛下。 */
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
    // 拉取结束前取消：不创建容器。
    if (signal.aborted) throw abortError();

    // 拆成 create + start -ai：create 完成即拿到容器，取消时才能 rm 而不启动。
    // --rm 仍负责正常退出的清理；--pull=never 保证这里不会再隐式拉镜像。
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
      // 自定义运行环境镜像也必须以非 root 运行，并从固定工作目录启动。
      '--user',
      '1000:1000',
      '--workdir',
      '/app',
      ...readOnlyArgs(options.extraMounts),
      ...(options.init === true ? ['--init'] : []),
      '-v',
      `${workspace}:/workspace:ro`,
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
    // create 已交给 daemon，不能再按客户端超时杀掉 CLI：那样 daemon 晚到的
    // 创建会无人跟踪。创建预算由上层 signal 决定，这里只等真实结果。
    const created = await runDockerCommand(args);
    if (!created.ok) throw new Error(`docker create ${name} failed${errorDetail(created.stderr)}`);
    this.running.add(name);

    if (signal.aborted) {
      // 请求已交给 daemon：等它创建完成后直接删，绝不 start；不杀客户端冒充清理。
      try {
        await this.removeContainer(name);
      } catch (err) {
        // 清理失败时保留跟踪，交给 shutdown 重试；不能假装已经取消干净。
        throw new Error(`docker rm -f ${name} failed after create abort`, { cause: err });
      }
      this.running.delete(name);
      throw abortError();
    }

    const child = spawn('docker', ['start', '-ai', name], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolveReady, reject) => {
      child.once('spawn', resolveReady);
      child.once('error', reject);
    });
    return { id: name, child };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      // --rm 负责正常退出的清理；还在运行的容器先给 5s 优雅停止，失败再强删。
      await this.stopAndRemove(sandbox.id);
      // 确认停止/删除后才移出跟踪；失败项留给 destroyAll 重试。
      this.running.delete(sandbox.id);
    } finally {
      // 容器已停，start -ai 客户端若仍未退出则直接结束，避免 worker 等它。
      sandbox.child.kill('SIGKILL');
    }
  }

  /**
   * 关闭兜底：先禁止新建并取消拉取，等进行中的创建收尾，再清理所有沙盒容器。
   * 单项失败继续清理其余项，最后用含容器 id 的 AggregateError 抛出。
   */
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
        // 失败项留在 running 里，下一次清理还能再试。
        failures.push(new Error(`sandbox ${String(id)} cleanup failed`, { cause: result.reason }));
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, `docker sandbox cleanup failed: ${ids.join(', ')}`);
    }
  }

  /**
   * 确保镜像本地存在；缺失且不是不可变 ID 时拉取。
   * 创建容器前与首次启动登记默认环境共用这一条路径，不另造拉取逻辑。
   */
  async ensureImage(image: string, signal: AbortSignal): Promise<void> {
    const inspected = await runDockerCommand(['image', 'inspect', image], CLEANUP_TIMEOUT_MS);
    if (inspected.ok) return;
    // 明确不存在才拉；daemon 不可达等其他错误直接抛出，不伪装成拉取失败。
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

  /** 可取消的拉取：abort 时结束 CLI；拉取未完成就取消则不进入 create。 */
  private pullImage(image: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePull, reject) => {
      const proc = spawn('docker', ['pull', image], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_000);
      });
      const onAbort = (): void => {
        proc.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = (error?: Error): void => {
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) resolvePull();
        else reject(error);
      };
      proc.once('error', (err) => finish(signal.aborted ? abortError() : err));
      proc.once('close', (code) => {
        if (signal.aborted) return finish(abortError());
        if (code === 0) return finish();
        finish(new Error(`docker pull ${image} failed${errorDetail(stderr)}`));
      });
      if (signal.aborted) onAbort();
    });
  }

  /**
   * 删除容器并确认真实结果：`--rm` 自动删除与 `rm -f` 并发时，daemon 会拒绝
   * "removal ... already in progress"；此时用 inspect 有界轮询等它删完，
   * 既不当成成功吞掉，也不提前当成 missing 或失败。
   */
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
