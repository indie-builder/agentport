import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE } from '@agentport/core';
import {
  errorText,
  NATIVE_PLUGIN_TIMEOUT_MS,
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type NativePluginOutput,
  nativePluginActionSchema,
  nativePluginOutputSchema,
  PLUGIN_CACHE_CONTAINER_DIR,
  parseJsonAs,
  redactSecrets,
} from '@agentport/shared';
import { createBunRedisClient, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { createWorkerLogger } from './logger.js';
import type { RuntimeEnvironmentResolver } from './runtime-environments/resolve.js';
import { DockerSandboxProvider } from './sandbox/docker.js';
import { runSandboxTask, SANDBOX_TASK_OUTPUT_MAX_BYTES } from './sandbox/one-shot.js';
import type { SandboxCreateOptions, SandboxProvider } from './sandbox/provider.js';

const STDERR_TAIL_BYTES = 2 * 1024;

const ACTION_WORKSPACE = 'native-plugin-actions';
const CACHE_DIR = 'plugin-cache';

export interface NativePluginsDeps {
  provider: SandboxProvider;
  /** 插件市场动作固定用平台默认环境（null）；只在真实创建容器时解析线上版本。 */
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver;
  /** 容器侧路径；与 hostWorkspacesDir 指向同一目录。 */
  workspacesDir: string;
  /** 宿主视角目录：docker -v 的源路径由宿主 daemon 解析。 */
  hostWorkspacesDir: string;
  logger: Logger;
  timeoutMs?: number;
  /** close 时 abort：丢弃正在创建/安装的容器，让任务尽快结束。 */
  closing?: AbortSignal;
}

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

function parseResultLine(line: string): NativePluginOutput | null {
  return parseJsonAs(line, nativePluginOutputSchema);
}

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

  let runtimeEnvironmentImageId: string;
  try {
    runtimeEnvironmentImageId = (await deps.resolveRuntimeEnvironment(null)).imageId;
  } catch (err) {
    deps.logger.warn({ err, action: action.action }, 'native plugin environment failed');
    return { ok: false, error: `无法解析运行环境：${redactSecrets(errorText(err))}` };
  }

  const workspaceDir = join(deps.hostWorkspacesDir, ACTION_WORKSPACE);
  const createOptions: SandboxCreateOptions = {
    image: runtimeEnvironmentImageId,
    workspaceDir,
    env: { HOME: '/tmp', TMPDIR: '/tmp' },
    name: `agentport-native-plugin-${randomBytes(4).toString('hex')}`,
    entrypoint: 'bun',
    command: ['dist/native-plugins.js'],
    extraMounts: [
      {
        hostPath: join(deps.hostWorkspacesDir, CACHE_DIR),
        containerPath: PLUGIN_CACHE_CONTAINER_DIR,
      },
    ],
  };

  return runSandboxTask<NativePluginOutput, NativePluginOutput>(
    {
      provider: deps.provider,
      logger: deps.logger,
      closing: deps.closing,
      create: createOptions,
      payload: action,
      parseLine: parseResultLine,
      totalMs: timeoutMs,
      stderrMaxBytes: STDERR_TAIL_BYTES,
      stderrKeep: 'tail',
      killChildOnDestroy: true,
      logContext: { action: action.action },
      cleanupLog: 'native plugin sandbox cleanup failed',
      lateCleanupLog: 'native plugin sandbox cleanup failed after timeout',
    },
    {
      complete: (outcome) => {
        if (!outcome.started) {
          return {
            ok: false,
            error:
              outcome.exited === '__closing__'
                ? 'worker 正在关停，安装已取消'
                : `沙盒启动超时（${timeoutMs}ms），请检查 Docker 服务与镜像后重试`,
          };
        }
        const tail = redactSecrets(outcome.stderr.trim()).split('\n').at(-1)?.slice(0, 300) ?? '';
        if (outcome.result) {
          if (!outcome.result.ok) {
            deps.logger.warn(
              {
                action: action.action,
                duration: elapsed(),
                stderr: redactSecrets(outcome.stderr),
              },
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
                ? `沙盒输出超过 ${SANDBOX_TASK_OUTPUT_MAX_BYTES} 字节上限`
                : `沙盒没有返回结果（${outcome.exited ?? 'unknown'}）`;
        deps.logger.warn(
          {
            action: action.action,
            duration: elapsed(),
            stderr: redactSecrets(outcome.stderr),
          },
          'native plugin sandbox failed',
        );
        return { ok: false, error: tail ? `${reason}: ${tail}` : reason };
      },
      fail: (err, closing) => {
        if (closing) {
          deps.logger.warn({ action: action.action }, 'native plugin action cancelled by shutdown');
          return { ok: false, error: 'worker 正在关停，安装已取消' };
        }
        deps.logger.warn({ err, action: action.action }, 'native plugin sandbox crashed');
        return { ok: false, error: `无法启动沙盒：${redactSecrets(errorText(err))}` };
      },
    },
  );
}

export async function registerNativePlugins(
  config: Config,
  resolveRuntimeEnvironment: RuntimeEnvironmentResolver,
): Promise<{ close(): Promise<void> }> {
  const closing = new AbortController();
  const provider = new DockerSandboxProvider({
    memory: config.SANDBOX_MEMORY,
    cpus: config.SANDBOX_CPUS,
    pids: config.SANDBOX_PIDS,
    egress: config.SANDBOX_EGRESS,
    closing: closing.signal,
  });
  const deps: NativePluginsDeps = {
    provider,
    resolveRuntimeEnvironment,
    workspacesDir: config.WORKSPACES_DIR,
    hostWorkspacesDir: config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR,
    logger: createWorkerLogger(config),
    closing: closing.signal,
  };

  const connection = createBunRedisClient(new RedisClient(config.REDIS_URL));
  const worker = new Worker<NativePluginAction>(
    NATIVE_PLUGINS_QUEUE,
    async (job) => {
      const parsed = nativePluginActionSchema.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid native plugin payload');
      return runNativePluginAction(deps, parsed.data);
    },
    { connection, concurrency: 1 },
  );

  return {
    close: async () => {
      closing.abort();
      const closed = worker.close().finally(() => connection.quit());
      const results = await Promise.allSettled([closed, provider.destroyAll()]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'native plugin shutdown failed');
      }
    },
  };
}
