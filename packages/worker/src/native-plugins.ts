import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NATIVE_PLUGIN_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type NativePluginOutput,
  nativePluginActionSchema,
  nativePluginOutputSchema,
} from '@agentport/shared';
import { Worker } from 'bullmq';
import pino, { type Logger } from 'pino';
import type { Config } from './config.js';
import { redactSecrets } from './redact.js';
import { DockerSandboxProvider } from './sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from './sandbox/provider.js';

/** 结果行上限：快照本身另有 4MiB 业务限制，这里兜住异常输出。 */
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 2 * 1024;
const WORKSPACE_DIR_MODE = 0o700;

/** 安装动作不写工作区：固定挂载一个空的只读目录即可。 */
const ACTION_WORKSPACE = 'native-plugin-actions';
const CACHE_DIR = 'plugin-cache';
const CONTAINER_CACHE_DIR = '/mnt/plugin-cache';

export interface NativePluginsDeps {
  provider: SandboxProvider;
  image: string;
  /** 容器侧路径；与 hostWorkspacesDir 指向同一目录。 */
  workspacesDir: string;
  /** 宿主视角目录：docker -v 的源路径由宿主 daemon 解析。 */
  hostWorkspacesDir: string;
  logger: Logger;
  timeoutMs?: number;
  /** close 时 abort：丢弃正在创建/安装的容器，让任务尽快结束。 */
  closing?: AbortSignal;
}

/**
 * 持久安装缓存：worker（容器内 uid 1000）与沙盒都以同一用户运行，0700 足够；
 * 沿用 agent-memory 的目录规范，不递归 chown 未核对的宿主目录。
 */
async function ensureCacheDir(deps: NativePluginsDeps): Promise<string> {
  const dir = join(deps.workspacesDir, CACHE_DIR);
  await mkdir(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  await mkdir(join(deps.workspacesDir, ACTION_WORKSPACE), {
    recursive: true,
    mode: WORKSPACE_DIR_MODE,
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Native plugin cache path must be a real directory: ${dir}`);
  }
  await chmod(dir, WORKSPACE_DIR_MODE);
  return dir;
}

/** 只取容器 stdout 的第一条合法结果；其余行属于 CLI 噪音。 */
function parseResultLine(line: string): NativePluginOutput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = nativePluginOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 在一次性沙盒里执行一次原生插件动作：容器入口 `dist/native-plugins.js` 只拿
 * 动作 JSON，没有模型或业务凭据；安装缓存以 rw 挂到 /mnt/plugin-cache。
 * 启动与整体动作共用 NATIVE_PLUGIN_TIMEOUT_MS，超时立即销毁容器。
 */
export async function runNativePluginAction(
  deps: NativePluginsDeps,
  action: NativePluginAction,
): Promise<NativePluginOutput> {
  const timeoutMs = deps.timeoutMs ?? NATIVE_PLUGIN_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsed = (): string => `${Date.now() - startedAt}ms`;

  try {
    await ensureCacheDir(deps);
  } catch (err) {
    deps.logger.error({ err }, 'native plugin cache unavailable');
    return { ok: false, error: `安装缓存不可用：${redactSecrets(errorText(err))}` };
  }

  const workspaceDir = join(deps.hostWorkspacesDir, ACTION_WORKSPACE);
  const createOptions: SandboxCreateOptions = {
    image: deps.image,
    workspaceDir,
    // 安装不调用模型：环境里只有 HOME/TMPDIR，任何平台密钥都不进容器。
    env: { HOME: '/tmp', TMPDIR: '/tmp' },
    name: `agentport-native-plugin-${randomBytes(4).toString('hex')}`,
    entrypoint: 'node',
    command: ['dist/native-plugins.js'],
    extraMounts: [
      { hostPath: join(deps.hostWorkspacesDir, CACHE_DIR), containerPath: CONTAINER_CACHE_DIR },
    ],
  };

  let sandbox: Sandbox | undefined;
  let abandoned = false;
  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (!sandbox || destroyed) return;
    destroyed = true;
    sandbox.child.kill('SIGKILL');
    await deps.provider.destroy(sandbox).catch((err: unknown) => {
      deps.logger.warn({ err, action: action.action }, 'native plugin sandbox cleanup failed');
    });
  };

  let resolveDone: (value: { result?: NativePluginOutput; exited?: string }) => void = () => {};
  const done = new Promise<{ result?: NativePluginOutput; exited?: string }>((resolve) => {
    resolveDone = resolve;
  });
  let stdout = '';
  let stderr = '';
  // 记录提前结束的原因，容器还没起来时也要给出准确文案。
  let exitReason: string | undefined;
  const finish = (outcome: { result?: NativePluginOutput; exited?: string }): void => {
    exitReason = outcome.exited;
    resolveDone(outcome);
  };

  // close 期间不再等安装跑完；已创建的容器走 finally 销毁，创建还没完成的交给迟到分支。
  const onClosing = (): void => finish({ exited: '__closing__' });
  if (deps.closing?.aborted) onClosing();
  deps.closing?.addEventListener('abort', onClosing, { once: true });

  // 启动与动作共用一个总预算：超时即销毁容器，不让安装任务无界占用队列。
  const timer = setTimeout(() => finish({ exited: '__timeout__' }), timeoutMs);
  try {
    const creating = deps.provider.create(createOptions);
    // 超时先返回时容器可能随后才创建完成；就地销毁，避免遗留。
    void creating.then(
      (late) => {
        if (!abandoned) return;
        late.child.kill('SIGKILL');
        void deps.provider.destroy(late).catch(() => undefined);
      },
      () => undefined,
    );

    const created = await Promise.race([creating, done.then(() => undefined)]);
    if (!created) {
      abandoned = true;
      return {
        ok: false,
        error:
          exitReason === '__closing__'
            ? 'worker 正在关停，安装已取消'
            : `沙盒启动超时（${timeoutMs}ms），请检查 Docker 服务与镜像后重试`,
      };
    }
    sandbox = created;

    const { child } = created;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > OUTPUT_MAX_BYTES) {
        resolveDone({ exited: '__output_too_large__' });
        return;
      }
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline === -1) return;
        const result = parseResultLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        if (result) resolveDone({ result });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (err) => resolveDone({ exited: errorText(err) }));
    child.once('close', (code, signal) => {
      resolveDone({ exited: `退出码 ${String(code)}${signal ? ` (${signal})` : ''}` });
    });
    child.stdin.write(`${JSON.stringify(action)}\n`);

    const outcome = await done;
    const tail = redactSecrets(stderr.trim()).split('\n').at(-1)?.slice(0, 300) ?? '';
    if (outcome.result) {
      if (!outcome.result.ok) {
        deps.logger.warn(
          { action: action.action, duration: elapsed(), stderr: redactSecrets(stderr) },
          'native plugin action reported failure',
        );
        return { ok: false, error: redactSecrets(outcome.result.error) };
      }
      return outcome.result;
    }

    const reason =
      outcome.exited === '__closing__'
        ? 'worker 正在关停，安装已取消'
        : outcome.exited === '__timeout__'
          ? `沙盒动作超时（${timeoutMs}ms）`
          : outcome.exited === '__output_too_large__'
            ? `沙盒输出超过 ${OUTPUT_MAX_BYTES} 字节上限`
            : `沙盒没有返回结果（${outcome.exited ?? 'unknown'}）`;
    deps.logger.warn(
      { action: action.action, duration: elapsed(), stderr: redactSecrets(stderr) },
      'native plugin sandbox failed',
    );
    return { ok: false, error: tail ? `${reason}: ${tail}` : reason };
  } catch (err) {
    deps.logger.warn({ err, action: action.action }, 'native plugin sandbox crashed');
    return { ok: false, error: `无法启动沙盒：${redactSecrets(errorText(err))}` };
  } finally {
    clearTimeout(timer);
    deps.closing?.removeEventListener('abort', onClosing);
    await destroy();
  }
}

/**
 * 独立队列消费者。契约：`registerNativePlugins(config)`，由 worker/index.ts 启动时
 * 调用、关停时 `close()`；安装缓存与官方目录写入串行，并发固定 1。
 */
export async function registerNativePlugins(config: Config): Promise<{ close(): Promise<void> }> {
  const provider = new DockerSandboxProvider({
    memory: config.SANDBOX_MEMORY,
    cpus: config.SANDBOX_CPUS,
    pids: config.SANDBOX_PIDS,
    egress: config.SANDBOX_EGRESS,
  });
  const closing = new AbortController();
  const deps: NativePluginsDeps = {
    provider,
    image: config.SANDBOX_IMAGE,
    workspacesDir: config.WORKSPACES_DIR,
    hostWorkspacesDir: config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR,
    logger: pino({ level: config.LOG_LEVEL }),
    closing: closing.signal,
  };

  const worker = new Worker<NativePluginAction>(
    NATIVE_PLUGINS_QUEUE,
    async (job) => {
      const parsed = nativePluginActionSchema.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid native plugin payload');
      // 失败也走正常返回，API 的 waitUntilFinished 拿到的是结果而不是异常。
      return runNativePluginAction(deps, parsed.data);
    },
    { connection: { url: config.REDIS_URL }, concurrency: 1 },
  );

  return {
    close: async () => {
      // 先停新任务并取消活动安装，再销毁容器，最后才等 close 收尾：
      // 反过来先 await 会等满 120s 安装预算，超过 compose 的 30s 宽限，Docker 来不及清理。
      closing.abort();
      const closed = worker.close();
      await provider.destroyAll();
      await closed;
    },
  };
}
