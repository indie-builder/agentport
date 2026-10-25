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
}

export interface Sandbox {
  /** 容器名，同时作为 agent_runs.sandbox_id 落库。 */
  id: string;
  child: ChildProcessWithoutNullStreams;
}

/**
 * 业务代码只依赖这个接口；换 microsandbox 时只新增实现。
 * create 返回时容器可能尚未就绪，进程错误通过 child 的 error/close 事件暴露。
 */
export interface SandboxProvider {
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
}
