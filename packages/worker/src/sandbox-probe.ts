import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptSecrets } from '@agentport/core';
import { createDb, repo } from '@agentport/db';
import {
  limitToolCatalog,
  SANDBOX_PROBE_STARTUP_TIMEOUT_MS,
  SANDBOX_PROBE_STDERR_MAX_BYTES,
  SANDBOX_PROBES_QUEUE,
  type SandboxProbeJob,
  type SandboxProbeOutput,
  type ServerTestResult,
  sandboxProbeJobSchema,
  sandboxProbeOutputSchema,
  sandboxProbeTaskSchema,
} from '@agentport/shared';
import { Worker } from 'bullmq';
import pino, { type Logger } from 'pino';
import type { Config } from './config.js';
import { redactSecrets } from './redact.js';
import { DockerSandboxProvider } from './sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions } from './sandbox/provider.js';

/**
 * 试连要多两个容器入口字段：覆盖镜像 ENTRYPOINT 并传 `dist/probe.js`。
 * SandboxCreateOptions/SandboxProvider 由 worker 运行线补齐这两个可选字段；
 * 运行线接入前，`registerSandboxProbe` 会先确认 provider 支持，再传给 `runSandboxProbe`。
 */
export interface ProbeSandboxOptions extends SandboxCreateOptions {
  /** 覆盖镜像 ENTRYPOINT。 */
  entrypoint: string;
  /** ENTRYPOINT 之后的参数。 */
  command: string[];
}

export type ProbeSandbox = Sandbox;

export interface ProbeProvider {
  create(options: ProbeSandboxOptions): Promise<ProbeSandbox>;
  destroy(sandbox: ProbeSandbox): Promise<void>;
  destroyAll?(): Promise<void>;
}

export interface SandboxProbeDeps {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  provider: ProbeProvider;
  image: string;
  /** 容器侧路径：试连不写工作区，只挂一个空目录满足 -v。 */
  workspacesDir: string;
  /** 宿主视角的同一目录；docker -v 的源路径由宿主 daemon 解析。 */
  hostWorkspacesDir: string;
  secretKey: string;
  /** close 时 abort：取消这次试连的镜像拉取/创建。 */
  closing?: AbortSignal;
}

/** 试连结果回给 API：stderr 只进审计与日志，`serverTestResultSchema` 会把它剥掉。 */
export interface ProbeOutcome extends ServerTestResult {
  stderr?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 只取容器 stdout 的第一条合法结果；其余行属于上游噪音。 */
function parseResultLine(line: string): SandboxProbeOutput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = sandboxProbeOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * 在沙盒镜像里连一次 stdio MCP server：容器入口 `dist/probe.js` 只拿 stdio 配置，
 * 不给模型凭证、不写记忆。超时与容器启动失败都变成可读结果，不抛给 BullMQ。
 *
 * 整体预算含拉镜像与 docker create/start；容器内部的 connect/listTools 另有 5s 上限。
 * 超时后迟到的容器仍由 provider 销毁（失败只告警），避免 worker 无界等待与容器泄漏。
 */
export async function runSandboxProbe(
  deps: SandboxProbeDeps,
  serverId: string,
  timeoutMs: number = SANDBOX_PROBE_STARTUP_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const elapsed = (): { durationMs: number } => ({ durationMs: Date.now() - startedAt });
  const failure = (error: string, stderr?: string): ProbeOutcome => ({
    ok: false,
    tools: [],
    error,
    ...(stderr ? { stderr } : {}),
    ...elapsed(),
  });

  const row = await repo.servers.getServer(deps.db, serverId);
  if (!row) return failure('MCP Server 不存在，可能已被删除；请刷新后重试');
  if (row.kind !== 'stdio') return failure('只支持 stdio 类型的连接测试');
  const secrets = row.secretsEncrypted ? decryptSecrets(row.secretsEncrypted, deps.secretKey) : {};
  const task = sandboxProbeTaskSchema.safeParse({
    kind: 'stdio',
    command: row.config.command,
    args: row.config.args,
    env: secrets,
  });
  if (!task.success) return failure('连接配置不完整，请检查命令后再测试');

  const workspaceDir = join(deps.hostWorkspacesDir, 'sandbox-probes');
  await mkdir(join(deps.workspacesDir, 'sandbox-probes'), { recursive: true, mode: 0o700 });

  // 每次试连独立的取消信号：超时或关停时停掉冷拉取，不能等它跑完再销毁容器。
  const createAbort = new AbortController();

  let sandbox: ProbeSandbox | undefined;
  let abandoned = false;
  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (!sandbox || destroyed) return;
    destroyed = true;
    // 停止语义统一由 provider 负责（stop --time 5 + rm -f 兜底）。
    await deps.provider.destroy(sandbox).catch((err: unknown) => {
      deps.logger.warn({ err, serverId }, 'sandbox probe cleanup failed');
    });
  };

  // 容器退出/输出/超时竞争一个结果；谁先到谁赢。
  let resolveDone: (value: { result?: SandboxProbeOutput; exited?: string }) => void = () => {};
  const done = new Promise<{ result?: SandboxProbeOutput; exited?: string }>((resolve) => {
    resolveDone = resolve;
  });
  // 记录提前结束的原因，容器还没起来时也要给出准确文案。
  let exitReason: string | undefined;
  const finish = (outcome: { result?: SandboxProbeOutput; exited?: string }): void => {
    exitReason = outcome.exited;
    resolveDone(outcome);
  };
  // 关停必须同时结束 done 并取消创建：只 abort 会让已启动的试连继续等满预算。
  // create 也可能因 provider 的 closing 监听先 reject，catch 靠 exitReason 归类。
  const onClosing = (): void => {
    exitReason = '__closing__';
    createAbort.abort();
    finish({ exited: '__closing__' });
  };
  // listener 要在 finish 可用后注册，已 aborted 的输入也要按关停立即结束。
  if (deps.closing?.aborted) onClosing();
  deps.closing?.addEventListener('abort', onClosing, { once: true });
  let stderr = '';
  const collectStderr = (chunk: string): void => {
    if (stderr.length < SANDBOX_PROBE_STDERR_MAX_BYTES) {
      stderr = (stderr + chunk).slice(0, SANDBOX_PROBE_STDERR_MAX_BYTES);
    }
  };

  // 启动与结果各有一次预算：容器起不来和连不上要给出不同文案。
  let timer = setTimeout(() => finish({ exited: '__startup_timeout__' }), timeoutMs);
  try {
    const creating = deps.provider.create({
      image: deps.image,
      workspaceDir,
      // 试连不跑模型：不给任何模型凭证，只留一个可写 HOME。
      env: { HOME: '/tmp' },
      name: `agentport-probe-${randomBytes(4).toString('hex')}`,
      entrypoint: 'node',
      command: ['dist/probe.js'],
      signal: createAbort.signal,
    });
    // 超时先返回时容器可能随后才创建完成；不能再走 finally，就地销毁避免泄漏。
    void creating.then(
      (late) => {
        if (!abandoned) return;
        void deps.provider.destroy(late).catch((err: unknown) => {
          deps.logger.warn(
            { err, serverId, sandboxId: late.id },
            'sandbox probe cleanup failed after timeout',
          );
        });
      },
      () => undefined,
    );

    const created = await Promise.race([creating, done.then(() => undefined)]);
    if (!created) {
      abandoned = true;
      // 启动预算或关停先用完：取消仍在进行的拉取/创建，迟到的容器由迟到分支销毁。
      createAbort.abort();
      // 错误信息区分「worker 关停」「容器没起来」与「连上了但没结果」。
      if (exitReason === '__closing__') {
        return failure('worker 正在关停，连接测试已取消');
      }
      return failure(`沙盒启动超时（${timeoutMs}ms），请检查 Docker 服务与镜像后重试`);
    }
    sandbox = created;
    // 容器已启动：剩余预算留给容器内的 connect + listTools。
    clearTimeout(timer);
    timer = setTimeout(() => finish({ exited: '__timeout__' }), timeoutMs);

    const { child } = created;
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const result = parseResultLine(line);
        if (result) finish({ result });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', collectStderr);
    child.stdin.on('error', () => undefined);
    child.once('error', (err) => finish({ exited: errorText(err) }));
    child.once('close', (code, signal) => {
      finish({
        exited: `退出码 ${String(code)}${signal ? ` (${signal})` : ''}`,
      });
    });
    child.stdin.write(`${JSON.stringify(task.data)}\n`);

    const outcome = await done;
    if (outcome.exited === '__timeout__' || outcome.exited === '__closing__') createAbort.abort();
    const stderrTail = redactSecrets(stderr.trim()).split('\n').at(-1)?.slice(0, 300) ?? '';
    if (outcome.result) {
      const output = outcome.result;
      if (!output.ok) {
        deps.logger.warn(
          { serverId, durationMs: Date.now() - startedAt, stderr: redactSecrets(stderr) },
          'sandbox probe reported failure',
        );
        return failure(redactSecrets(output.error ?? 'connection failed'), stderrTail || undefined);
      }
      // 容器已按同一上限裁剪；宿主机是信任边界，再校验一次形状与目录上限。
      let tools: ProbeOutcome['tools'];
      try {
        tools = limitToolCatalog(output.tools);
      } catch (err) {
        return failure(redactSecrets(errorText(err)), stderrTail || undefined);
      }
      return {
        ok: true,
        ...(output.serverInfo ? { serverInfo: output.serverInfo } : {}),
        tools,
        ...elapsed(),
      };
    }

    const reason =
      outcome.exited === '__closing__'
        ? 'worker 正在关停，连接测试已取消'
        : outcome.exited === '__timeout__'
          ? `连接测试超时（${timeoutMs}ms），请检查 Server 是否能正常启动`
          : `沙盒没有返回结果（${outcome.exited ?? 'unknown'}）`;
    deps.logger.warn(
      { serverId, durationMs: Date.now() - startedAt, stderr: redactSecrets(stderr) },
      'sandbox probe failed',
    );
    return failure(stderrTail ? `${reason}: ${stderrTail}` : reason, stderrTail || undefined);
  } catch (err) {
    // create 也可能在关停竞速里先 reject；此时要给关停文案，不能报成启动失败。
    if (exitReason === '__closing__' || deps.closing?.aborted === true) {
      deps.logger.warn({ serverId }, 'sandbox probe cancelled by shutdown');
      return failure('worker 正在关停，连接测试已取消');
    }
    // 容器创建失败（docker 不可达、镜像缺失）也只回可读结果，不让 BullMQ 重试无限拉长请求。
    deps.logger.warn({ err, serverId }, 'sandbox probe crashed');
    return failure(`无法启动沙盒：${redactSecrets(errorText(err))}`);
  } finally {
    clearTimeout(timer);
    deps.closing?.removeEventListener('abort', onClosing);
    await destroy();
  }
}

/**
 * 独立队列消费者。固定契约：`registerSandboxProbe(config)`，由 worker/index.ts
 * 启动时调用、关停时 `close()`；本模块自持 db 连接与 provider。
 */
export async function registerSandboxProbe(config: Config): Promise<{ close(): Promise<void> }> {
  const handle = createDb(config.DATABASE_URL);
  const closing = new AbortController();
  const provider: ProbeProvider = new DockerSandboxProvider({
    memory: config.SANDBOX_MEMORY,
    cpus: config.SANDBOX_CPUS,
    pids: config.SANDBOX_PIDS,
    egress: config.SANDBOX_EGRESS,
    closing: closing.signal,
  });
  const deps: SandboxProbeDeps = {
    db: handle.db,
    logger: pino({ level: config.LOG_LEVEL }),
    provider,
    image: config.SANDBOX_IMAGE,
    workspacesDir: config.WORKSPACES_DIR,
    hostWorkspacesDir: config.HOST_WORKSPACES_DIR ?? config.WORKSPACES_DIR,
    secretKey: config.APP_SECRET_KEY,
    closing: closing.signal,
  };

  const worker = new Worker<SandboxProbeJob>(
    SANDBOX_PROBES_QUEUE,
    async (job) => {
      const parsed = sandboxProbeJobSchema.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid sandbox probe payload');
      // 结果作为 job returnvalue 回给 API；失败也走正常返回，避免 waitUntilFinished 拿到原始错误。
      return runSandboxProbe(deps, parsed.data.serverId);
    },
    { connection: { url: config.REDIS_URL }, concurrency: config.AGENT_MAX_CONCURRENT },
  );

  return {
    close: async () => {
      // 先停新任务并取消进行中的拉取/创建，再并行等消费者与容器清理收尾。
      closing.abort();
      const closed = worker.close();
      const results = await Promise.allSettled([closed, provider.destroyAll?.()]);
      await handle.pool.end();
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'sandbox probe shutdown failed');
      }
    },
  };
}
