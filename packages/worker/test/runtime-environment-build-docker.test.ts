import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { executeRuntimeEnvironmentBuild } from '../src/runtime-environments/build.js';

/**
 * 真实 Docker 证据：仅在本机已有基座镜像、且基座含当前产物与 Bash 时运行。
 * 基座默认用补齐 Bash 的固定 tag（SANDBOX_IMAGE 可能仍是缺产物的开发镜像）。
 * 构建产物用本次独占 tag，不覆盖基座。
 */
const IMAGE = process.env.RUNTIME_ENV_BUILD_IMAGE ?? 'agentport/sandbox:runtime-env-bash-20261029';
const REQUIRED_ARTIFACTS = [
  '/app/dist/runner.js',
  '/app/dist/session-supervisor.js',
  '/app/dist/probe.js',
  '/app/dist/native-plugins.js',
];

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function baseHasArtifacts(image: string): Promise<boolean> {
  const script = `const fs=require('node:fs');process.exit(${JSON.stringify(REQUIRED_ARTIFACTS)}.every((p)=>fs.existsSync(p))?0:1)`;
  try {
    const result = await run(
      'docker',
      ['run', '--rm', '--entrypoint', 'node', image, '-e', script],
      30_000,
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

const dockerReady = await dockerAvailable();
const baseReady = dockerReady ? await baseHasArtifacts(IMAGE) : false;

describe.skipIf(!dockerReady || !baseReady)('真实 Docker 构建', () => {
  it('相同 Dockerfile 重复构建复用层缓存', async () => {
    const nonce = `cache${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const dockerfile = [
      'ARG RUNTIME_BASE_IMAGE',
      'FROM ${RUNTIME_BASE_IMAGE}',
      `RUN echo ${nonce} > /tmp/runtime-env-cache`,
      '',
    ].join('\n');
    const input = {
      versionId: nonce,
      dockerfile,
      baseImageId: IMAGE,
    };
    let imageTag: string | undefined;
    const imageIds = new Set<string>();

    try {
      const first = await executeRuntimeEnvironmentBuild(input);
      expect(first.ok, first.ok ? undefined : first.buildLog).toBe(true);
      if (!first.ok) return;
      imageIds.add(first.imageId);
      imageTag = first.imageTag;

      const second = await executeRuntimeEnvironmentBuild(input);
      expect(second.ok, second.ok ? undefined : second.buildLog).toBe(true);
      if (!second.ok) return;
      imageIds.add(second.imageId);

      // 镜像配置里的创建时间会让两次构建的 image ID 不同；缓存证据看层是否 CACHED。
      expect(second.imageTag).toBe(first.imageTag);
      expect(second.buildLog).toMatch(/CACHED/);
    } finally {
      if (imageTag !== undefined) await run('docker', ['rmi', '-f', imageTag]).catch(() => {});
      for (const imageId of imageIds) {
        await run('docker', ['rmi', '-f', imageId]).catch(() => {});
      }
    }
  }, 240_000);
});
