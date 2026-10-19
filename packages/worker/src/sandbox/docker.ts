import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from './provider.js';

/**
 * 网络取舍：契约里的 `--network none` 会让沙盒连不上模型 API 与平台 /mcp 端点
 * （HTTP MCP server 也全部失效），所以网络模式改为可配置。
 * 默认 bridge 而不是 host：macOS 上 host 是 Docker 的特殊值（不是普通桥接），
 * 而 bridge 两端都可用；容器内访问宿主用 host.docker.internal。
 * 需要真正断网时设 SANDBOX_NETWORK=none，同时必须放弃 HTTP MCP 与 /mcp 调用。
 */
function network(): string {
  return process.env.SANDBOX_NETWORK ?? 'bridge';
}

export class DockerSandboxProvider implements SandboxProvider {
  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const workspace = resolve(options.workspaceDir);
    const envArgs = Object.entries(options.env).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]);
    // -i 保持 stdin 打开供任务写入；--rm 保证异常退出也不留容器。
    const args = [
      'run',
      '--rm',
      '-i',
      '--network',
      network(),
      // macOS 的 Docker Desktop 自带 host.docker.internal；Linux 需要显式映射。
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${workspace}:/workspace:ro`,
      ...envArgs,
      ...(options.name ? ['--name', options.name] : []),
      options.image,
    ];

    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const id = options.name ?? child.pid?.toString() ?? 'unknown';
    await new Promise<void>((resolveReady, reject) => {
      child.once('spawn', resolveReady);
      child.once('error', reject);
    });
    return { id, child };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    // runner 结束后容器的 stdin 关闭会自行退出；没退出就按名字强杀。
    await new Promise<void>((resolveKill) => {
      const killer = spawn('docker', ['rm', '-f', sandbox.id], { stdio: 'ignore' });
      killer.once('error', () => resolveKill());
      killer.once('close', () => resolveKill());
    });
  }
}
