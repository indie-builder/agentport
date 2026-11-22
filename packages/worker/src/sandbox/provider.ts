import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface SandboxCreateOptions {
  image: string;
  workspaceDir: string;
  env: Record<string, string>;
  name?: string;
  extraMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  entrypoint?: string;
  command?: string[];
  init?: boolean;
  signal?: AbortSignal;
}

export interface Sandbox {
  id: string;
  child: ChildProcessWithoutNullStreams;
}

export class SandboxCleanupError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string, message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SandboxCleanupError';
    this.sandboxId = sandboxId;
  }
}

export interface SandboxProvider {
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  destroy(sandbox: Sandbox): Promise<void>;
  destroyById(id: string): Promise<void>;
}
