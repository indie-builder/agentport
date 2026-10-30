import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Reply {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** 不自动结束：用例自己 close，模拟慢 pull/create。 */
  holdOpen?: boolean;
}

// 只验证 docker CLI 参数与生命周期；容器真跑由 sandbox 镜像测试覆盖。
const state = vi.hoisted(() => ({
  commands: [] as string[][],
  kills: [] as string[][],
  startError: false,
  children: {} as Record<
    string,
    Array<
      EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill(signal?: NodeJS.Signals): boolean;
      }
    >
  >,
  reply: (_args: string[]): Reply => ({ exitCode: 0 }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      state.commands.push([command, ...args]);
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: (signal?: NodeJS.Signals) => boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        state.kills.push([command, ...args]);
        child.signalCode = signal ?? 'SIGKILL';
        queueMicrotask(() => child.emit('close', 137, signal ?? 'SIGKILL'));
        return true;
      };
      // 真实 ChildProcess 在退出前 exitCode/signalCode 都是 null。
      child.exitCode = null;
      child.signalCode = null;
      const key = args[0] === 'image' ? 'image inspect' : String(args[0]);
      const children = state.children[key] ?? [];
      children.push(child);
      state.children[key] = children;
      queueMicrotask(() => {
        if (args[0] === 'start' && state.startError) {
          child.emit('error', new Error('spawn docker failed'));
          return;
        }
        child.emit('spawn');
      });
      // start -ai 是前台附着进程；其余命令按 reply 结束。
      if (args[0] === 'start') return child;
      const reply = state.reply(args);
      if (reply.holdOpen === true) return child;
      queueMicrotask(() => {
        if (reply.stdout !== undefined) child.stdout.write(reply.stdout);
        if (reply.stderr !== undefined) child.stderr.write(reply.stderr);
        child.emit('close', reply.exitCode, null);
      });
      return child;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  state.commands = [];
  state.kills = [];
  state.children = {};
  state.reply = () => ({ exitCode: 0 });
  state.startError = false;
});

interface CreateOptions {
  extraMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  entrypoint?: string;
  name?: string;
  signal?: AbortSignal;
  init?: boolean;
}

async function makeProvider() {
  const { DockerSandboxProvider } = await import('../src/sandbox/docker.js');
  return new DockerSandboxProvider({
    memory: '1g',
    cpus: 1,
    pids: 128,
    egress: 'open',
  });
}

function createOptions(options: CreateOptions = {}) {
  return {
    image: 'sandbox:test',
    workspaceDir: '/tmp/workspace',
    env: {},
    name: options.name ?? 'pace-test',
    ...(options.extraMounts === undefined ? {} : { extraMounts: options.extraMounts }),
    ...(options.entrypoint === undefined
      ? {}
      : { entrypoint: options.entrypoint, command: ['dist/probe.js'] }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.init === undefined ? {} : { init: options.init }),
  };
}

async function create(options: CreateOptions = {}) {
  const provider = await makeProvider();
  const sandbox = await provider.create(createOptions(options));
  const args = state.commands.findLast((command) => command[1] === 'create') ?? [];
  return { provider, sandbox, args };
}

describe('docker sandbox provider', () => {
  it('creates with --pull=never, then starts the container attached', async () => {
    const { args, sandbox } = await create({ name: 'pace-run' });

    expect(args.slice(0, 3)).toEqual(['docker', 'create', '--pull=never']);
    expect(args).toContain('--rm');
    expect(args).toContain('-i');
    expect(args).toContain('pace-run');
    expect(state.commands).toContainEqual(['docker', 'start', '-ai', 'pace-run']);
    // create 阶段不启动容器：只有 start 负责前台附着。
    expect(state.commands.some((command) => command[1] === 'run')).toBe(false);
    expect(sandbox.id).toBe('pace-run');
  });

  it('mounts the session directory over the config tmpfs instead of duplicating it', async () => {
    const { args } = await create({
      extraMounts: [{ hostPath: '/tmp/sessions', containerPath: '/home/node/.claude' }],
    });
    // Docker 不允许同一路径既 tmpfs 又 bind mount；两者同时出现会直接失败。
    expect(args.join(' ')).not.toContain('--tmpfs /home/node/.claude');
    expect(args.join(' ')).toContain('-v /tmp/sessions:/home/node/.claude:rw');
    expect(args.join(' ')).toContain('--tmpfs /tmp:');
  });

  it('keeps the config tmpfs for runs without a session mount', async () => {
    const { args } = await create();
    expect(args.join(' ')).toContain('--tmpfs /home/node/.claude:');
  });

  it('mounts the definition workspace read-only and the outputs draft read-write', async () => {
    const { args } = await create({
      extraMounts: [{ hostPath: '/host/runs/run_1', containerPath: '/mnt/outputs' }],
    });
    const command = args.join(' ');
    expect(command).toContain('-v /tmp/workspace:/workspace:ro');
    expect(command).toContain('-v /host/runs/run_1:/mnt/outputs:rw');
    // 显式只读挂载才会加 :ro；交付目录不能被当成定义目录。
    expect(command).not.toContain('/mnt/outputs:ro');
  });

  it('overrides the entrypoint only when asked', async () => {
    const probe = await create({ entrypoint: 'node' });
    expect(probe.args.join(' ')).toContain('--entrypoint node sandbox:test dist/probe.js');
    const run = await create();
    expect(run.args.join(' ')).not.toContain('--entrypoint');
  });

  it('adds an init process only when requested, keeping the old path unchanged', async () => {
    const supervised = await create({ init: true });
    expect(supervised.args).toContain('--init');
    const oneShot = await create();
    expect(oneShot.args).not.toContain('--init');
  });

  it('does not pull when the image already exists locally', async () => {
    await create();
    expect(state.commands.some((command) => command[1] === 'pull')).toBe(false);
  });

  it('pulls a missing image before creating the container', async () => {
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'image'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such image: sandbox:test' }
        : { exitCode: 0 };

    await provider.create(createOptions({ name: 'pace-run' }));

    expect(state.commands.map((command) => command[1])).toEqual([
      'image',
      'pull',
      'create',
      'start',
    ]);
  });

  it('refuses to pull a missing immutable image id instead of silently switching images', async () => {
    const provider = await makeProvider();
    const id = `sha256:${'a'.repeat(64)}`;
    state.reply = (args) =>
      args[0] === 'image'
        ? { exitCode: 1, stderr: `Error response from daemon: No such image: ${id}` }
        : { exitCode: 0 };

    await expect(
      provider.create({ ...createOptions({ name: 'pace-run' }), image: id }),
    ).rejects.toThrow(/immutable image id/);
    expect(state.commands.some((command) => command[1] === 'pull')).toBe(false);
    expect(state.commands.some((command) => command[1] === 'create')).toBe(false);
  });

  it('always runs as uid 1000 from /app', async () => {
    const { args } = await create({ name: 'pace-run' });
    expect(args.join(' ')).toContain('--user 1000:1000');
    expect(args.join(' ')).toContain('--workdir /app');
  });

  it('reads the actual local image id for default environment registration', async () => {
    const { resolveLocalImageId } = await import('../src/sandbox/docker.js');
    const id = `sha256:${'b'.repeat(64)}`;
    state.reply = (args) =>
      args[0] === 'image' ? { exitCode: 0, stdout: `${id}\n` } : { exitCode: 0 };

    await expect(resolveLocalImageId('sandbox:test')).resolves.toBe(id);
    expect(state.commands).toContainEqual([
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      'sandbox:test',
    ]);

    state.reply = () => ({ exitCode: 1, stderr: 'Error response from daemon: No such image' });
    await expect(resolveLocalImageId('sandbox:test')).resolves.toBeNull();
  });

  it('cancels a pull that is still running after the old one-second window and never creates', async () => {
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'image'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such image: sandbox:test' }
        : args[0] === 'pull'
          ? { exitCode: 0, holdOpen: true }
          : { exitCode: 0 };
    const controller = new AbortController();
    const creating = provider.create(createOptions({ signal: controller.signal }));
    await vi.waitFor(() => expect(state.children.pull?.length).toBe(1));
    // 旧实现按 1s 猜测容器何时出现；取消必须与这个猜测无关。
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const rejected = expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    expect(state.kills).toContainEqual(['docker', 'pull', 'sandbox:test']);
    expect(state.commands.some((command) => command[1] === 'create')).toBe(false);
  });

  it('waits for an in-flight create, removes it and never starts it', async () => {
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'create' ? { exitCode: 0, holdOpen: true } : { exitCode: 0 };
    const controller = new AbortController();
    const creating = provider.create(
      createOptions({ name: 'pace-cancel', signal: controller.signal }),
    );
    await vi.waitFor(() => expect(state.children.create?.length).toBe(1));

    const rejected = expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    // create 请求已交给 daemon：不能杀掉客户端冒充清理。
    expect(state.kills.some((command) => command[1] === 'create')).toBe(false);
    state.children.create?.[0]?.emit('close', 0, null);
    await rejected;

    expect(state.commands.some((command) => command[1] === 'start')).toBe(false);
    expect(state.commands).toContainEqual(['docker', 'rm', '-f', 'pace-cancel']);
  });

  it('waits for an in-flight create without killing it after the old 30s budget', async () => {
    vi.useFakeTimers();
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'create' ? { exitCode: 0, holdOpen: true } : { exitCode: 0 };
    const controller = new AbortController();
    let settled: { status: 'fulfilled' | 'rejected'; reason?: unknown } | undefined;
    const creating = provider
      .create(createOptions({ name: 'pace-slow', signal: controller.signal }))
      .then(
        () => {
          settled = { status: 'fulfilled' };
        },
        (reason: unknown) => {
          settled = { status: 'rejected', reason };
        },
      );
    await vi.waitFor(() => expect(state.children.create?.length).toBe(1));

    await vi.advanceTimersByTimeAsync(30_000);
    // create 已交给 daemon：不能杀 CLI，也不能假装创建已结束。
    expect(state.kills.some((command) => command[1] === 'create')).toBe(false);
    expect(settled).toBeUndefined();

    controller.abort();
    state.children.create?.[0]?.emit('close', 0, null);
    await creating;

    expect(settled?.status).toBe('rejected');
    const reason = settled?.status === 'rejected' ? (settled.reason as Error) : undefined;
    expect(reason?.name).toBe('AbortError');
    expect(state.commands.some((command) => command[1] === 'start')).toBe(false);
    expect(state.commands).toContainEqual(['docker', 'rm', '-f', 'pace-slow']);

    // rm 成功即已不再跟踪。
    state.commands = [];
    await provider.destroyAll();
    expect(state.commands).toEqual([]);
  });

  it('waits for an in-flight --rm auto removal instead of failing or faking success', async () => {
    const { provider, sandbox } = await create({ name: 'pace-race' });
    state.commands = [];
    let inspections = 0;
    state.reply = (args) => {
      if (args[0] === 'stop') return { exitCode: 1, stderr: 'daemon busy' };
      if (args[0] === 'rm') {
        return {
          exitCode: 1,
          stderr:
            'Error response from daemon: removal of container pace-race is already in progress',
        };
      }
      if (args[0] === 'container') {
        inspections += 1;
        // 自动删除还在进行：inspect 仍能看到容器，必须继续等，不能提前当成已删除。
        return inspections < 3
          ? { exitCode: 0, stdout: 'pace-race\n' }
          : { exitCode: 1, stderr: 'Error response from daemon: No such container: pace-race' };
      }
      return { exitCode: 0 };
    };

    await expect(provider.destroy(sandbox)).resolves.toBeUndefined();
    expect(inspections).toBe(3);

    // 确认删除完成才移出跟踪。
    state.commands = [];
    await provider.destroyAll();
    expect(state.commands).toEqual([]);
  });

  it('keeps the container tracked when an in-progress removal never completes', async () => {
    const { provider, sandbox } = await create({ name: 'pace-stuck' });
    state.commands = [];
    state.reply = (args) => {
      if (args[0] === 'stop') return { exitCode: 1, stderr: 'daemon busy' };
      if (args[0] === 'rm') {
        return {
          exitCode: 1,
          stderr:
            'Error response from daemon: removal of container pace-stuck is already in progress',
        };
      }
      if (args[0] === 'container') return { exitCode: 0, stdout: 'pace-stuck\n' };
      return { exitCode: 0 };
    };
    // 有限超时：第一次取 deadline，第二次进入轮询，之后时间越界退出。
    const start = Date.now();
    let clockCalls = 0;
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => (clockCalls++ < 2 ? start : start + 20_000));

    try {
      await expect(provider.destroy(sandbox)).rejects.toThrow(/still in progress/);
    } finally {
      clock.mockRestore();
    }

    // 删除未确认：保留跟踪，shutdown 还能再试。
    state.reply = () => ({ exitCode: 0 });
    state.commands = [];
    await provider.destroyAll();
    expect(state.commands.map(([, command]) => command)).toEqual(['stop', 'rm']);
  });

  it('stops the container with a five second grace period, then removes it', async () => {
    const { provider, sandbox } = await create({ name: 'pace-run' });
    state.commands = [];

    await provider.destroy(sandbox);

    // stop 退出 0 只表示停止成功；created 容器仍要靠 rm 才消失。
    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-run'],
      ['docker', 'rm', '-f', 'pace-run'],
    ]);
  });

  it('falls back to rm -f when docker stop fails', async () => {
    const { provider, sandbox } = await create({ name: 'pace-run' });
    state.commands = [];
    state.reply = (args) => (args[0] === 'stop' ? { exitCode: 1 } : { exitCode: 0 });

    await provider.destroy(sandbox);

    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-run'],
      ['docker', 'rm', '-f', 'pace-run'],
    ]);
  });

  it('treats a container already removed by --rm as cleaned up', async () => {
    const { provider, sandbox } = await create({ name: 'pace-run' });
    state.commands = [];
    state.reply = (args) =>
      args[0] === 'stop'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such container: pace-run' }
        : { exitCode: 1, stderr: 'Error: No such object: pace-run' };

    await expect(provider.destroy(sandbox)).resolves.toBeUndefined();
    // stop 报不存在后仍要 rm：missing 才是“已删除”的证据。
    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-run'],
      ['docker', 'rm', '-f', 'pace-run'],
    ]);

    // 已确认清理的容器不再跟踪。
    state.commands = [];
    await provider.destroyAll();
    expect(state.commands).toEqual([]);
  });

  it('throws and keeps the container tracked when rm -f fails', async () => {
    const { provider, sandbox } = await create({ name: 'pace-run' });
    state.commands = [];
    state.reply = (args) => {
      if (args[0] === 'stop') return { exitCode: 1, stderr: 'daemon busy' };
      if (args[0] === 'rm') return { exitCode: 1, stderr: 'cannot remove container' };
      return { exitCode: 0 };
    };

    await expect(provider.destroy(sandbox)).rejects.toThrow(/rm/);
    expect(state.commands.map(([, command]) => command)).toEqual(['stop', 'rm']);

    // 失败项留在 running 里，shutdown 时还能再试一次；再次失败仍要报出来。
    state.commands = [];
    await expect(provider.destroyAll()).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('pace-run'),
    });
    expect(state.commands.map(([, command]) => command)).toEqual(['stop', 'rm']);
  });

  it('removes a created container when start fails to spawn and rethrows the spawn error', async () => {
    state.startError = true;
    const provider = await makeProvider();
    await expect(provider.create(createOptions({ name: 'pace-start-fail' }))).rejects.toThrow(
      'spawn docker failed',
    );

    // 创建成功后的失败由 create 自己收尾：普通错误不携带待清理容器。
    expect(state.commands).toContainEqual(['docker', 'rm', '-f', 'pace-start-fail']);
    state.commands = [];
    state.reply = () => ({ exitCode: 0 });
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    expect(state.commands).toEqual([]);
  });

  it('reports the container id when start failure cleanup fails, keeping it tracked', async () => {
    state.startError = true;
    state.reply = (args) =>
      args[0] === 'rm' ? { exitCode: 1, stderr: 'cannot remove container' } : { exitCode: 0 };
    const provider = await makeProvider();

    await expect(provider.create(createOptions({ name: 'pace-start-fail' }))).rejects.toMatchObject(
      {
        name: 'SandboxCleanupError',
        sandboxId: 'pace-start-fail',
      },
    );

    // 清理失败仍保留跟踪：shutdown 再试 stop 0 + rm。
    state.commands = [];
    state.reply = () => ({ exitCode: 0 });
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-start-fail'],
      ['docker', 'rm', '-f', 'pace-start-fail'],
    ]);
  });

  it('does not report a cleanup error when docker create itself fails', async () => {
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'create' ? { exitCode: 1, stderr: 'name is already in use' } : { exitCode: 0 };

    await expect(provider.create(createOptions({ name: 'pace-create-fail' }))).rejects.toThrow(
      /docker create pace-create-fail failed/,
    );

    // 没有容器被创建：不留下任何待清理项。
    state.commands = [];
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    expect(state.commands).toEqual([]);
  });

  it('keeps tracking when rm after an aborted create fails, then removes on shutdown', async () => {
    const provider = await makeProvider();
    state.reply = (args) => {
      if (args[0] === 'create') return { exitCode: 0, holdOpen: true };
      if (args[0] === 'rm') return { exitCode: 1, stderr: 'cannot remove container' };
      return { exitCode: 0 };
    };
    const controller = new AbortController();
    const creating = provider.create(
      createOptions({ name: 'pace-abort-rm', signal: controller.signal }),
    );
    await vi.waitFor(() => expect(state.children.create?.length).toBe(1));

    const rejected = expect(creating).rejects.toMatchObject({
      name: 'SandboxCleanupError',
      sandboxId: 'pace-abort-rm',
    });
    controller.abort();
    state.children.create?.[0]?.emit('close', 0, null);
    await rejected;

    // 清理失败不能丢弃跟踪；shutdown 用 stop 0 + rm 再试。
    state.commands = [];
    state.reply = () => ({ exitCode: 0 });
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-abort-rm'],
      ['docker', 'rm', '-f', 'pace-abort-rm'],
    ]);
  });

  it('cancels and awaits pending creation during destroyAll', async () => {
    const provider = await makeProvider();
    state.reply = (args) =>
      args[0] === 'image'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such image: sandbox:test' }
        : args[0] === 'pull'
          ? { exitCode: 0, holdOpen: true }
          : { exitCode: 0 };
    const creating = provider.create(createOptions({ name: 'pace-pending' }));
    await vi.waitFor(() => expect(state.children.pull?.length).toBe(1));

    const rejected = expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    await rejected;

    expect(state.commands.some((command) => command[1] === 'create')).toBe(false);
  });

  it('cancels pending creation and rejects new ones when the shutdown signal aborts', async () => {
    const { DockerSandboxProvider } = await import('../src/sandbox/docker.js');
    const closing = new AbortController();
    const provider = new DockerSandboxProvider({
      memory: '1g',
      cpus: 1,
      pids: 128,
      egress: 'open',
      closing: closing.signal,
    });
    state.reply = (args) =>
      args[0] === 'image'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such image: sandbox:test' }
        : args[0] === 'pull'
          ? { exitCode: 0, holdOpen: true }
          : { exitCode: 0 };
    const creating = provider.create(createOptions({ name: 'pace-closing' }));
    await vi.waitFor(() => expect(state.children.pull?.length).toBe(1));

    const rejected = expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    closing.abort();
    await rejected;

    expect(state.commands.some((command) => command[1] === 'create')).toBe(false);
    await expect(provider.create(createOptions({ name: 'pace-late' }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports failed cleanup as an AggregateError with the container id and retries later', async () => {
    const { provider } = await create({ name: 'pace-run' });
    state.commands = [];
    state.reply = (args) => {
      if (args[0] === 'stop') return { exitCode: 1, stderr: 'daemon busy' };
      if (args[0] === 'rm') return { exitCode: 1, stderr: 'cannot remove container' };
      return { exitCode: 0 };
    };

    await expect(provider.destroyAll()).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('pace-run'),
    });

    // 失败项保留跟踪：下一次清理重试成功。
    state.commands = [];
    state.reply = () => ({ exitCode: 0 });
    await expect(provider.destroyAll()).resolves.toBeUndefined();
    expect(state.commands).toContainEqual(['docker', 'stop', '--time', '5', 'pace-run']);
  });

  it('stops every tracked container on shutdown', async () => {
    const { provider, sandbox } = await create({ name: 'pace-run' });
    state.commands = [];

    await provider.destroyAll();

    expect(sandbox.id).toBe('pace-run');
    expect(state.commands).toEqual([
      ['docker', 'stop', '--time', '5', 'pace-run'],
      ['docker', 'rm', '-f', 'pace-run'],
    ]);
  });
});
