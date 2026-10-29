import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/db';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeEnvironmentBuildHandler,
  executeRuntimeEnvironmentBuild,
  type RuntimeEnvironmentBuildClaim,
  type RuntimeEnvironmentBuildJob,
  type RuntimeEnvironmentBuildStore,
  type SpawnFn,
} from '../src/runtime-environments/build.js';

const SANDBOX_IMAGE = 'repo/sandbox:dev';
const DOCKERFILE = 'ARG RUNTIME_BASE_IMAGE\nFROM ${RUNTIME_BASE_IMAGE}\n';
const BASE_ID = `sha256:${'b'.repeat(64)}`;
const BUILT_ID = `sha256:${'a'.repeat(64)}`;

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Logger;

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** 不自动结束：用例靠 abort 触发 kill 后的 close。 */
  holdOpen?: boolean;
  onStart?: () => void;
}

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
};

/** 只替换子进程；命令参数、管道与关闭语义与真实 docker CLI 一致。 */
function fakeDocker(respond: (args: string[]) => Reply): {
  spawn: SpawnFn;
  commands: string[][];
  /** buildx 的回复（含 --iidfile 写入）就绪时 resolve；真实 fs 之后的 spawn 不能靠数事件循环轮次等。 */
  buildxStarted: Promise<FakeChild>;
} {
  const commands: string[][] = [];
  let resolveBuildx!: (child: FakeChild) => void;
  const buildxStarted = new Promise<FakeChild>((resolve) => {
    resolveBuildx = resolve;
  });
  const spawnFn: SpawnFn = (_command, args) => {
    commands.push([...args]);
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 137, null));
      return true;
    };
    queueMicrotask(() => {
      const reply = respond([...args]);
      reply.onStart?.();
      if (reply.stdout !== undefined) child.stdout.write(reply.stdout);
      if (reply.stderr !== undefined) child.stderr.write(reply.stderr);
      if (args[0] === 'buildx') resolveBuildx(child);
      if (reply.holdOpen === true) return;
      queueMicrotask(() => child.emit('close', reply.code ?? 0, null));
    });
    return child as unknown as ChildProcess;
  };
  return { spawn: spawnFn, commands, buildxStarted };
}

function dockerResponder(
  options: {
    user?: string;
    baseImage?: string;
    volumes?: string;
    build?: Reply;
    verify?: Reply;
    context?: { dir: string; files: string[]; dockerfile: string }[];
  } = {},
): (args: string[]) => Reply {
  const baseImage = options.baseImage ?? SANDBOX_IMAGE;
  return (args) => {
    if (args[0] === 'image') {
      const format = args[args.indexOf('--format') + 1];
      if (args[2] === baseImage) return { stdout: BASE_ID };
      if (args[2] === BUILT_ID) {
        if (format === '{{json .Config.Volumes}}') return { stdout: options.volumes ?? 'null' };
        return { stdout: options.user ?? 'node' };
      }
      throw new Error(`unexpected inspect: ${args.join(' ')}`);
    }
    if (args[0] === 'buildx') {
      const iid = args[args.indexOf('--iidfile') + 1] ?? '';
      const dir = args.at(-1) ?? '';
      options.context?.push({
        dir,
        files: readdirSync(dir).sort(),
        dockerfile: readFileSync(join(dir, 'Dockerfile'), 'utf8'),
      });
      return {
        onStart: () => writeFileSync(iid, BUILT_ID),
        stdout: '#1 [1/2] FROM docker.io\n#2 exporting layers\n',
        ...options.build,
      };
    }
    if (args[0] === 'tag') return { code: 0 };
    if (args[0] === 'run') return options.verify ?? { code: 0, stdout: 'verify: ok\n' };
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeStore(
  claim: RuntimeEnvironmentBuildClaim | null = {
    versionId: 'ver_test',
    dockerfile: DOCKERFILE,
    baseImageId: SANDBOX_IMAGE,
  },
) {
  const calls = {
    complete: [] as Array<{ versionId: string; image: Record<string, unknown> }>,
    fail: [] as Array<{ versionId: string; error: string }>,
    logs: [] as Array<{ versionId: string; chunk: string }>,
    claimed: [] as string[],
  };
  const store: RuntimeEnvironmentBuildStore = {
    claimBuild: async (versionId) => {
      calls.claimed.push(versionId);
      return claim;
    },
    appendBuildLog: async (versionId, chunk) => {
      calls.logs.push({ versionId, chunk });
    },
    completeBuild: async (versionId, image) => {
      calls.complete.push({ versionId, image });
    },
    failBuild: async (versionId, error) => {
      calls.fail.push({ versionId, error });
    },
  };
  return { store, calls };
}

describe('executeRuntimeEnvironmentBuild', () => {
  it('只在空上下文发送冻结 Dockerfile，并用不可变基座 ID 构建', async () => {
    const contexts: Array<{ dir: string; files: string[]; dockerfile: string }> = [];
    const fake = fakeDocker(dockerResponder({ context: contexts }));

    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_test',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.imageId).toBe(BUILT_ID);
    expect(result.baseImageId).toBe(BASE_ID);
    expect(result.imageTag).toBe('repo/sandbox:runtime-env-ver_test');

    const build = fake.commands.find((args) => args[0] === 'buildx');
    expect(build).toBeDefined();
    expect(build).toContain('--load');
    expect(build).toContain('--progress');
    expect(build).toContain('plain');
    expect(build).not.toContain('--no-cache');
    expect(build?.[build.indexOf('--build-arg') + 1]).toBe(
      'RUNTIME_BASE_IMAGE=repo/sandbox:runtime-base-bbbbbbbbbbbb',
    );
    expect(build?.[build.indexOf('--tag') + 1]).toBe('repo/sandbox:runtime-env-ver_test');

    // 基座解析成 ID 后固定到不可变 tag，避免 tag 指针变化影响构建。
    const tag = fake.commands.find((args) => args[0] === 'tag');
    expect(tag).toEqual(['tag', BASE_ID, 'repo/sandbox:runtime-base-bbbbbbbbbbbb']);

    // 构建上下文里只有 Dockerfile，没有仓库、工作区或 env。
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.files).toEqual(['Dockerfile']);
    expect(contexts[0]?.dockerfile).toBe(DOCKERFILE);

    const verify = fake.commands.find((args) => args[0] === 'run');
    expect(verify).toContain('--read-only');
    expect(verify?.[verify.indexOf('--user') + 1]).toBe('1000:1000');
    expect(verify?.[verify.indexOf('--workdir') + 1]).toBe('/app');
    expect(verify?.[verify.indexOf('--network') + 1]).toBe('none');
  });

  it('运行校验拒绝镜像声明的容器卷时构建失败', async () => {
    const fake = fakeDocker(dockerResponder({ volumes: '{"/app/dist":{}}' }));
    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_volume',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('/app/dist');
    expect(result.error).toContain('容器卷');
    expect(fake.commands.some((args) => args[0] === 'run')).toBe(false);
  });

  it('运行校验失败原因作为构建失败原因', async () => {
    const fake = fakeDocker(
      dockerResponder({
        verify: { code: 1, stderr: 'verify: bash is not available on PATH\n' },
      }),
    );
    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_verify',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bash is not available on PATH');
    expect(result.aborted).toBe(false);
  });

  it('拒绝默认用户为 root 的镜像', async () => {
    const fake = fakeDocker(dockerResponder({ user: 'root' }));
    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_root',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('uid 1000');
    expect(fake.commands.some((args) => args[0] === 'run')).toBe(false);
  });

  it('失败时保留日志尾部并带上错误原因', async () => {
    const fake = fakeDocker(
      dockerResponder({ build: { code: 1, stderr: 'ERROR: failed to solve\n' } }),
    );
    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_fail',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ERROR: failed to solve');
    expect(result.buildLog).toContain('failed to solve');
    expect(result.aborted).toBe(false);
  });

  it('超大输出只保留限长尾部', async () => {
    const fake = fakeDocker(
      dockerResponder({
        build: { stdout: `HEAD-DROPPED${'a'.repeat(70 * 1024)}BUILD-TAIL` },
      }),
    );
    const result = await executeRuntimeEnvironmentBuild({
      versionId: 'ver_big_log',
      dockerfile: DOCKERFILE,
      baseImageId: SANDBOX_IMAGE,
      spawn: fake.spawn,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.buildLog).toHaveLength(RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT);
    expect(result.buildLog).not.toContain('HEAD-DROPPED');
    expect(result.buildLog).toContain('BUILD-TAIL');
    expect(result.logTruncated).toBe(true);
  });
});

describe('createRuntimeEnvironmentBuildHandler', () => {
  it('成功后只写版本，不发布线上', async () => {
    const fake = fakeDocker(dockerResponder());
    const { store, calls } = fakeStore();
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
    });

    await handler({ data: { versionId: 'ver_test' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(calls.claimed).toEqual(['ver_test']);
    expect(calls.complete).toHaveLength(1);
    expect(calls.complete[0]?.image).toEqual({
      imageTag: 'repo/sandbox:runtime-env-ver_test',
      imageId: BUILT_ID,
      baseImageId: BASE_ID,
    });
    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0]?.chunk).toContain('exporting layers');
    expect(calls.fail).toHaveLength(0);
  });

  it('日志落库失败时按失败收尾，不留下没有日志的 ready 版本', async () => {
    const fake = fakeDocker(dockerResponder());
    const { store, calls } = fakeStore();
    let attempts = 0;
    store.appendBuildLog = async () => {
      attempts += 1;
      throw new Error('db down');
    };
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
    });

    await handler({ data: { versionId: 'ver_test' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(attempts).toBeGreaterThan(0);
    expect(calls.complete).toHaveLength(0);
    expect(calls.fail).toEqual([{ versionId: 'ver_test', error: '构建日志写入失败' }]);
  });

  it('日志落库同步抛错后，后续输出仍会落库', async () => {
    // 修复前 flush 会停在已完成的 drain 上死循环：先断言迟到日志，再关闭进程收尾。
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const fake = fakeDocker(dockerResponder({ build: { holdOpen: true } }));
      const { store, calls } = fakeStore();
      let attempts = 0;
      store.appendBuildLog = (versionId, chunk) => {
        attempts += 1;
        // 真实 repo 失败是异步拒绝；这里模拟同步抛出，覆盖 finally 早于 draining 赋值的情况。
        if (attempts === 1) throw new Error('db down');
        calls.logs.push({ versionId, chunk });
        return Promise.resolve();
      };
      const handler = createRuntimeEnvironmentBuildHandler({
        store,
        logger: quiet,
        spawn: fake.spawn,
        timeoutMs: 60_000,
      });

      const running = handler({
        data: { versionId: 'ver_test' },
      } as Job<RuntimeEnvironmentBuildJob>);
      // spawn buildx 前有真实 fs（mkdtemp/writeFile），等 fake spawn 的信号而不是数事件循环轮次。
      const buildChild = await Promise.race([
        fake.buildxStarted,
        running.then(() => {
          throw new Error('handler finished before the buildx spawn');
        }),
      ]);

      buildChild.stdout.write('first-step\n');
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      buildChild.stdout.write('late-step\n');
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(attempts).toBe(2);
      expect(calls.logs.map((entry) => entry.chunk).join('')).toContain('late-step');

      buildChild.emit('close', 0, null);
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('认领不到 queued 版本时什么都不做', async () => {
    const fake = fakeDocker(dockerResponder());
    const { store, calls } = fakeStore(null);
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
    });

    await handler({ data: { versionId: 'ver_gone' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(fake.commands).toHaveLength(0);
    expect(calls.complete).toHaveLength(0);
    expect(calls.fail).toHaveLength(0);
  });

  it('构建中分批落库日志，终态前 UI 已能看到输出', async () => {
    const fake = fakeDocker(
      dockerResponder({ build: { stdout: 'building-step\n'.repeat(2_000), holdOpen: true } }),
    );
    const { store, calls } = fakeStore();
    const closing = new AbortController();
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
      signal: closing.signal,
    });

    const running = handler({
      data: { versionId: 'ver_test' },
    } as Job<RuntimeEnvironmentBuildJob>);
    await waitFor(() => calls.logs.length > 0);

    expect(calls.complete).toHaveLength(0);
    expect(calls.fail).toHaveLength(0);
    expect(calls.logs.map((entry) => entry.chunk).join('')).toContain('building-step');

    closing.abort();
    await running;
    expect(calls.fail).toEqual([{ versionId: 'ver_test', error: '构建已中断' }]);
  });

  it('空闲刷新窗口后到达的日志仍落库，收尾 flush 能结束', async () => {
    // 只假 timers：fake docker 的 queueMicrotask 与流回调保持真实，避免测试自己制造死循环。
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const fake = fakeDocker(dockerResponder({ build: { holdOpen: true } }));
      const { store, calls } = fakeStore();
      const handler = createRuntimeEnvironmentBuildHandler({
        store,
        logger: quiet,
        spawn: fake.spawn,
        timeoutMs: 60_000,
      });

      const running = handler({
        data: { versionId: 'ver_test' },
      } as Job<RuntimeEnvironmentBuildJob>);
      const buildChild = await Promise.race([
        fake.buildxStarted,
        running.then(() => {
          throw new Error('handler finished before the buildx spawn');
        }),
      ]);

      // 先排空已到达的输出，再让下一次刷新在 pending 为空时执行。
      await vi.advanceTimersByTimeAsync(1_000);
      // 空 pending 的定时刷新：这里曾留下已完成的 drain Promise，后续日志再也落不了库。
      await vi.advanceTimersByTimeAsync(1_000);
      buildChild.stdout.write('late-step\n');
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(calls.logs.map((entry) => entry.chunk).join('')).toContain('late-step');

      buildChild.emit('close', 0, null);
      await running;

      expect(calls.complete).toHaveLength(1);
      expect(calls.fail).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用认领时冻结的基座构建，不读 worker 当前镜像', async () => {
    const frozenBase = 'frozen/sandbox:old';
    const fake = fakeDocker(dockerResponder({ baseImage: frozenBase }));
    const { store, calls } = fakeStore({
      versionId: 'ver_test',
      dockerfile: DOCKERFILE,
      baseImageId: frozenBase,
    });
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
    });

    await handler({ data: { versionId: 'ver_test' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(fake.commands.some((args) => args[0] === 'image' && args[2] === frozenBase)).toBe(true);
    expect(fake.commands.some((args) => args[2] === SANDBOX_IMAGE)).toBe(false);
    expect(calls.complete[0]?.image).toMatchObject({ baseImageId: BASE_ID });
  });

  it('关闭中断时按失败收尾，不留下 building', async () => {
    const fake = fakeDocker(dockerResponder());
    const { store, calls } = fakeStore();
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
      signal: AbortSignal.abort(),
    });

    await handler({ data: { versionId: 'ver_test' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(calls.fail).toEqual([{ versionId: 'ver_test', error: '构建已中断' }]);
    expect(calls.complete).toHaveLength(0);
  });

  it('超时按失败收尾', async () => {
    const fake = fakeDocker(dockerResponder({ build: { holdOpen: true } }));
    const { store, calls } = fakeStore();
    const handler = createRuntimeEnvironmentBuildHandler({
      store,
      logger: quiet,
      spawn: fake.spawn,
      timeoutMs: 5,
    });

    await handler({ data: { versionId: 'ver_test' } } as Job<RuntimeEnvironmentBuildJob>);

    expect(calls.fail).toEqual([{ versionId: 'ver_test', error: '构建超时' }]);
  });
});
