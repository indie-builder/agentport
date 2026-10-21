import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from './provider.js';

/** 与 worker config 对应的容器资源上限；默认值见 config.ts。 */
export interface DockerSandboxOptions {
  memory: string;
  cpus: number;
  pids: number;
  egress: 'open' | 'none' | 'proxy';
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

/**
 * 只读根文件系统 + tmpfs：Agent SDK 会写 ~/.claude（会话、缓存）。
 * 单独给 /home/node/.claude 挂 tmpfs（uid/gid 对齐镜像内的 node 用户，否则 tmpfs
 * 默认 root:root、非 root 进程写不进去），并把 CLAUDE_CONFIG_DIR 指过去（worker 注入），
 * 根文件系统保持只读。已实测：上述组合下 runner 能正常启动并输出 run_finished。
 */
const READ_ONLY_ARGS = [
  '--read-only',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=64m',
  '--tmpfs',
  '/home/node/.claude:rw,noexec,nosuid,size=64m,uid=1000,gid=1000',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
];

export class DockerSandboxProvider implements SandboxProvider {
  private readonly options: DockerSandboxOptions;
  /** 运行中的容器名，SIGTERM 兜底清理用。 */
  private readonly running = new Set<string>();

  constructor(options: DockerSandboxOptions) {
    this.options = options;
  }

  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const workspace = resolve(options.workspaceDir);
    const envArgs = Object.entries(options.env).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]);
    const name = options.name ?? `agentport-${process.pid}-${Date.now()}`;
    // -i 保持 stdin 打开供任务写入；--rm 保证异常退出也不留容器。
    const args = [
      'run',
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
      ...READ_ONLY_ARGS,
      '-v',
      `${workspace}:/workspace:ro`,
      ...envArgs,
      '--name',
      name,
      options.image,
    ];

    this.running.add(name);
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('docker create timed out after 30000ms'));
      }, 30_000);
      child.once('spawn', () => {
        clearTimeout(timer);
        resolveReady();
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        this.running.delete(name);
        reject(err);
      });
    });
    return { id: name, child };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    this.running.delete(sandbox.id);
    // runner 结束后容器的 stdin 关闭会自行退出；没退出就按名字强杀。
    sandbox.child.kill('SIGKILL');
    await this.remove([sandbox.id]);
  }

  /** 关闭兜底：把所有还在运行的沙盒容器强杀。 */
  async destroyAll(): Promise<void> {
    const ids = [...this.running];
    this.running.clear();
    if (ids.length === 0) return;
    await this.remove(ids);
  }

  private async remove(ids: string[]): Promise<void> {
    await new Promise<void>((resolveKill, reject) => {
      const killer = spawn('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        killer.kill('SIGKILL');
        reject(new Error('docker rm timed out after 10000ms'));
      }, 10_000);
      killer.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      killer.once('close', () => {
        clearTimeout(timer);
        // --rm may already have removed the container before this command.
        resolveKill();
      });
    });
  }
}
