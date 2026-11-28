import { describe, expect, it } from 'bun:test';
import type { DockerProcess, SpawnFn } from '../src/runtime-environments/command.js';
import { verifyRuntimeEnvironmentImage } from '../src/runtime-environments/verify.js';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
  holdOpen?: boolean;
  onStart?: () => void;
}

interface FakeProcess extends DockerProcess {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  finish(code: number): void;
}

function fakeProcess(): FakeProcess {
  const encoder = new TextEncoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  let done = false;
  let signalCode: NodeJS.Signals | number | null = null;
  const finish = (code: number): void => {
    if (done) return;
    done = true;
    stdoutController.close();
    stderrController.close();
    settle(code);
  };
  return {
    stdout,
    stderr,
    exited,
    get signalCode() {
      return signalCode;
    },
    kill: (signal) => {
      signalCode = signal ?? 'SIGKILL';
      finish(signal === 'SIGKILL' ? 137 : 143);
    },
    writeStdout: (chunk) => {
      stdoutController.enqueue(encoder.encode(chunk));
    },
    writeStderr: (chunk) => {
      stderrController.enqueue(encoder.encode(chunk));
    },
    finish,
  };
}

function fakeDocker(respond: (args: string[]) => Reply): {
  spawn: SpawnFn;
  commands: string[][];
} {
  const commands: string[][] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    commands.push([...args]);
    const child = fakeProcess();
    queueMicrotask(() => {
      const reply = respond([...args]);
      reply.onStart?.();
      if (reply.stdout !== undefined) child.writeStdout(reply.stdout);
      if (reply.stderr !== undefined) child.writeStderr(reply.stderr);
      if (!reply.holdOpen) child.finish(reply.code ?? 0);
    });
    return child;
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
    expect(flag('--entrypoint')).toBe('bun');
    expect(run).toContain('--read-only');
    expect(run).toContain('--rm');
    expect(run).toContain('/home/node/.claude:rw,noexec,nosuid,size=64m,uid=1000,gid=1000');
    expect(run.at(-3)).toBe(IMAGE_ID);
    expect(run.at(-2)).toBe('-e');
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
    expect(result.error.endsWith(tail)).toBe(true);
    expect(result.error.length).toBeLessThanOrEqual('产物验证失败: '.length + '…'.length + 1_000);
    expect(result.error).not.toContain('x'.repeat(2_000));
  });

  it('中断运行中的校验命令并返回取消结果', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = fakeDocker(responder('null', { holdOpen: true, onStart: () => started() }));
    const verifying = verifyRuntimeEnvironmentImage({
      imageId: IMAGE_ID,
      spawn: fake.spawn,
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    await expect(verifying).resolves.toEqual({ ok: false, aborted: true, error: '校验已中断' });
    expect(fake.commands.filter((command) => command[0] === 'run')).toHaveLength(1);
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
