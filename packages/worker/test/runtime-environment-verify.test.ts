import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SpawnFn } from '../src/runtime-environments/build.js';
import { verifyRuntimeEnvironmentImage } from '../src/runtime-environments/verify.js';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** 只替换子进程；命令参数、管道与关闭语义与真实 docker CLI 一致。 */
function fakeDocker(respond: (args: string[]) => Reply): {
  spawn: SpawnFn;
  commands: string[][];
} {
  const commands: string[][] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    commands.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      const reply = respond([...args]);
      if (reply.stdout !== undefined) child.stdout.write(reply.stdout);
      if (reply.stderr !== undefined) child.stderr.write(reply.stderr);
      child.emit('close', reply.code ?? 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn: spawnFn, commands };
}

function responder(volumes: string, run: Reply): (args: string[]) => Reply {
  return (args) => {
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: volumes };
    if (args[0] === 'run') return run;
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
}

describe('verifyRuntimeEnvironmentImage', () => {
  it('拒绝镜像声明的任何容器卷，不启动容器', async () => {
    const fake = fakeDocker(responder('{"/app/dist":{}}', { code: 0 }));

    const result = await verifyRuntimeEnvironmentImage({ imageId: IMAGE_ID, spawn: fake.spawn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('/app/dist');
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toEqual([
      'image',
      'inspect',
      IMAGE_ID,
      '--format',
      '{{json .Config.Volumes}}',
    ]);
  });

  it('在只读、非 root、无网络的容器里冒烟启动全部入口', async () => {
    const fake = fakeDocker(responder('null', { code: 0, stdout: 'verify: ok\n' }));

    const result = await verifyRuntimeEnvironmentImage({ imageId: IMAGE_ID, spawn: fake.spawn });

    expect(result.ok).toBe(true);
    const run = fake.commands.find((args) => args[0] === 'run');
    expect(run).toBeDefined();
    if (run === undefined) return;
    const flag = (name: string): string | undefined => run[run.indexOf(name) + 1];
    expect(flag('--network')).toBe('none');
    expect(flag('--user')).toBe('1000:1000');
    expect(flag('--workdir')).toBe('/app');
    expect(flag('--cap-drop')).toBe('ALL');
    expect(flag('--security-opt')).toBe('no-new-privileges');
    expect(flag('--entrypoint')).toBe('node');
    expect(run).toContain('--read-only');
    expect(run).toContain('--rm');
    expect(run).toContain('/home/node/.claude:rw,noexec,nosuid,size=64m,uid=1000,gid=1000');
    expect(run.at(-3)).toBe(IMAGE_ID);
    expect(run.at(-2)).toBe('-e');
    const script = run.at(-1) ?? '';
    expect(script).toContain("'--check'");
    expect(script).toContain('command -v bash');
    expect(script).toContain('session-supervisor.js');
    expect(script).toContain('stdin closed before the probe task arrived');
    expect(script).toContain('stdin closed before the native plugin task arrived');
    expect(script).toContain('stdin closed before task JSON arrived');
    expect(script).toContain("'--version'");
  });

  it('把容器内的启动失败原因作为失败返回', async () => {
    const fake = fakeDocker(
      responder('null', {
        code: 1,
        stderr:
          'verify: probe entry failed before reaching its protocol: Error: Cannot find module',
      }),
    );

    const result = await verifyRuntimeEnvironmentImage({ imageId: IMAGE_ID, spawn: fake.spawn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.aborted).toBe(false);
    expect(result.error).toBe(
      '产物验证失败: verify: probe entry failed before reaching its protocol: Error: Cannot find module',
    );
  });

  it('超长输出只保留尾部，错误摘要限长且保留原因', async () => {
    const tail = 'FINAL-CAUSE';
    const fake = fakeDocker(responder('null', { code: 1, stderr: 'x'.repeat(200_000) + tail }));

    const result = await verifyRuntimeEnvironmentImage({ imageId: IMAGE_ID, spawn: fake.spawn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 200k 单行输出不能整段进错误摘要；限长后仍保留最尾部的原因。
    expect(result.error.endsWith(tail)).toBe(true);
    expect(result.error.length).toBeLessThanOrEqual('产物验证失败: '.length + '…'.length + 1_000);
    expect(result.error).not.toContain('x'.repeat(2_000));
  });

  it('已中断时不启动任何 docker 命令', async () => {
    const fake = fakeDocker(responder('null', { code: 0 }));
    const controller = new AbortController();
    controller.abort();

    const result = await verifyRuntimeEnvironmentImage({
      imageId: IMAGE_ID,
      spawn: fake.spawn,
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, aborted: true, error: '校验已中断' });
    expect(fake.commands).toHaveLength(0);
  });
});
