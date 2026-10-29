import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyRuntimeEnvironmentImage } from '../src/runtime-environments/verify.js';

/**
 * 真实 Docker 冒烟：默认用补齐 Bash 的基座 tag；镜像不在本机时整组跳过。
 * 负例都在本机已有基座上派生一层，不联网、不覆盖基座。
 */
const IMAGE = process.env.RUNTIME_ENV_VERIFY_IMAGE ?? 'agentport/sandbox:runtime-env-bash-20261029';

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

async function imageId(image: string): Promise<string | null> {
  try {
    const result = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], 10_000);
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** 用派生镜像跑一次校验并清理；`from` 用本机 tag，避免 BuildKit 拒绝裸镜像 ID。 */
async function verifyDerived(
  from: string,
  dockerfile: string[],
): Promise<Awaited<ReturnType<typeof verifyRuntimeEnvironmentImage>>> {
  const tag = `agentport/sandbox:verify-${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const dir = await mkdtemp(join(tmpdir(), 'runtime-env-verify-'));
  try {
    await writeFile(
      join(dir, 'Dockerfile'),
      [`FROM ${from}`, ...dockerfile, ''].join('\n'),
      'utf8',
    );
    const built = await run('docker', ['build', '--network', 'none', '-t', tag, dir], 180_000);
    expect(built.code, built.stderr).toBe(0);
    const id = await imageId(tag);
    expect(id, built.stderr).not.toBeNull();
    if (id === null) throw new Error('derived image missing');
    return await verifyRuntimeEnvironmentImage({ imageId: id });
  } finally {
    await run('docker', ['rmi', '-f', tag], 60_000).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const dockerReady = await dockerAvailable();
const baseId = dockerReady ? await imageId(IMAGE) : null;

describe.skipIf(baseId === null)('真实 Docker 运行环境校验', () => {
  it('补齐 Bash 的基座通过全部入口冒烟', async () => {
    const result = await verifyRuntimeEnvironmentImage({ imageId: baseId ?? '' });
    expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  }, 120_000);

  it('拒绝声明 /app/dist 卷的镜像', async () => {
    const result = await verifyDerived(IMAGE, ['USER root', 'VOLUME ["/app/dist"]']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('/app/dist');
    expect(result.error).toContain('容器卷');
  }, 240_000);

  it('拒绝语法错误的入口', async () => {
    const result = await verifyDerived(IMAGE, [
      'USER root',
      "RUN printf 'function broken(' > /app/dist/probe.js",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('syntax error in /app/dist/probe.js');
  }, 240_000);

  it('拒绝缺少模块依赖的入口', async () => {
    const result = await verifyDerived(IMAGE, [
      'USER root',
      'RUN printf "import \'./missing.js\';\\n" > /app/dist/probe.js',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('probe entry failed before reaching its protocol');
  }, 240_000);
});
