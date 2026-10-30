import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface SandboxCreateOptions {
  image: string;
  /** 宿主机绝对路径，只读挂载到容器 /workspace。 */
  workspaceDir: string;
  /** 只在宿主侧传入的凭证等，不落盘到工作区。 */
  env: Record<string, string>;
  /** docker 容器名；取消时按名字强制清理。 */
  name?: string;
  /**
   * 额外挂载（宿主绝对路径 → 容器路径）。用于让 Claude Code 原生 auto-memory
   * 落在跨 run 持久的宿主目录，而不是沙盒内被回收的 tmpfs。
   */
  extraMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  /** 覆盖镜像 ENTRYPOINT；试连用它换成 `node dist/probe.js`。 */
  entrypoint?: string;
  /** ENTRYPOINT 之后的参数。 */
  command?: string[];
  /** 给容器 PID 1 加 init 进程，长驻 supervisor 需要回收每轮子进程。 */
  init?: boolean;
  /** 取消创建：拉取结束前取消则不创建；create 已发出则等它结束、rm 且不 start。 */
  signal?: AbortSignal;
}

export interface Sandbox {
  /** 容器名，同时作为 agent_runs.sandbox_id 落库。 */
  id: string;
  child: ChildProcessWithoutNullStreams;
}

/**
 * 创建路径失败且容器可能残留时抛出：调用方按 sandboxId 继续清理，不能把它当成普通失败。
 * 普通错误（含 busy）保证本次创建没有待清理容器。
 */
export class SandboxCleanupError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SandboxCleanupError';
    this.sandboxId = sandboxId;
  }
}

/**
 * 业务代码只依赖这个接口；换 microsandbox 时只新增实现。
 * create 返回时容器已 start 并附着；进程错误通过 child 的 error/close 事件暴露。
 */
export interface SandboxProvider {
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
  /** 按容器名删除没有句柄的沙盒（worker 重启后由 cleanup 调用）。 */
  destroyById(id: string): Promise<void>;
}
