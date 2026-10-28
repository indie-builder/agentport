import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxProvider } from '../src/sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from '../src/sandbox/provider.js';
import { SessionSandboxes } from '../src/sandbox/sessions.js';

/**
 * 真实 Docker 的会话沙盒生命周期验收：不 mock docker、不拉镜像、不调模型。
 * runner 由 fixture/session-task.mjs 顶替，只验证进程停止与容器/挂载保留行为。
 * 每次运行都从当前 shared/sandbox 源码编译到本次独占的临时构建目录（绝不复用
 * packages/<pkg>/dist），再基于本机 sandbox:dev 构建一次性派生镜像并在结束时删除。
 * 镜像缺失时明确失败，不联网 pull；派生 tag 随机且测试结束删除，不覆盖共享镜像。
 */
const BASE_IMAGE = 'agentport/sandbox:dev';
const IMAGE_TAG = `session-sandbox-lifecycle-test-${randomUUID().slice(0, 8)}`;
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'packages/worker/test/fixtures/session-task.mjs');
/** 容器内观测点；busy 的进展写到宿主 outputs 挂载，容器消失后仍可读取。 */
const ORPHAN_META = '/tmp/session-fixture/orphan.json';
const ORPHAN_PROGRESS = '/tmp/session-fixture/orphan-progress';
const ORPHAN_STOP = '/tmp/session-fixture/orphan-stop.json';
const GROUP_PROGRESS = '/tmp/session-fixture/group-progress';
const GROUP_STOP = '/tmp/session-fixture/group-stop.json';
const BUSY_OUTPUT = 'session-busy-progress';
const EVIDENCE_FILE = '/tmp/session-docker-process-cleanup.json';
const SOURCE_EVIDENCE_FILE = '/tmp/session-docker-current-source.json';

interface CleanupEvidence {
  test: string;
  settlement?: unknown;
  [key: string]: unknown;
}

const cleanupEvidence: CleanupEvidence[] = [];

/** 只记录真实 provider 创建的 Sandbox.child，destroy 仍走真实实现。 */
class RecordingProvider implements SandboxProvider {
  readonly children: Sandbox['child'][] = [];

  constructor(private readonly inner: SandboxProvider) {}

  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const sandbox = await this.inner.create(options);
    this.children.push(sandbox.child);
    return sandbox;
  }

  destroy(sandbox: Sandbox): Promise<void> {
    return this.inner.destroy(sandbox);
  }
}

function dockerProvider(): DockerSandboxProvider {
  return new DockerSandboxProvider({
    memory: '512m',
    cpus: 1,
    pids: 128,
    egress: 'none',
  });
}

function docker(args: string[], timeout = 20_000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout });
}

const dockerReady = docker(['info', '--format', '{{.ServerVersion}}']).status === 0;

function imagePresent(): boolean {
  return docker(['image', 'inspect', BASE_IMAGE]).status === 0;
}

function containerRunning(id: string): boolean {
  const result = docker(['inspect', '--format', '{{.State.Running}}', id]);
  return result.status === 0 && result.stdout.trim() === 'true';
}

function containerExists(id: string): boolean {
  return docker(['inspect', id]).status === 0;
}

/** 容器内命令的输出；容器已删除或命令失败返回 null，供 waitFor 轮询。 */
function inContainer(id: string, command: string[]): string | null {
  const result = docker(['exec', id, ...command]);
  return result.status === 0 ? result.stdout : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  check: () => T | null | false | Promise<T | null | false>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value !== null && value !== false) return value;
    } catch {
      // 容器/文件尚未就绪，继续等。
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

interface RecordedEvent {
  type?: string;
  status?: string;
  text?: string;
}

interface Incident {
  root: string;
  spec: {
    agentId: string;
    conversationId: string;
    image: string;
    workspaceDir: string;
    outputsDir: string;
    inputsDir: string;
    memoryDir: string;
    sessionsDir: string;
  };
  sessions: SessionSandboxes;
  ids: string[];
}

let buildContext = '';

async function incident(
  idleTimeoutMs = 60_000,
  provider: SandboxProvider = dockerProvider(),
): Promise<Incident> {
  const root = await mkdtemp(join(tmpdir(), 'session-docker-run-'));
  const dirs = {
    workspaceDir: join(root, 'workspace'),
    outputsDir: join(root, 'outputs'),
    inputsDir: join(root, 'inputs'),
    memoryDir: join(root, 'memory'),
    sessionsDir: join(root, 'sessions'),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  const sessions = new SessionSandboxes({
    provider,
    idleTimeoutMs,
    logger: pino({ level: 'silent' }),
  });
  return {
    root,
    sessions,
    ids: [],
    spec: {
      agentId: `agent-${randomUUID()}`,
      conversationId: randomUUID(),
      image: IMAGE_TAG,
      ...dirs,
    },
  };
}

function taskInput(prompt: string) {
  return {
    prompt,
    model: 'fixture',
    maxTurns: 1,
    maxBudgetUsd: 0.01,
    userMessageUuid: randomUUID(),
  };
}

type Lease = Awaited<ReturnType<SessionSandboxes['acquire']>>;

async function startRun(lease: Lease, prompt: string) {
  const events: RecordedEvent[] = [];
  const stderr: string[] = [];
  const execution = await lease.start({
    runId: `run-${randomUUID()}`,
    task: taskInput(prompt),
    env: {},
    onEvent: (event: RecordedEvent) => {
      events.push(event);
    },
    onStderr: (chunk: string) => {
      stderr.push(chunk);
    },
  });
  return { execution, events, stderr };
}

function succeeded(events: RecordedEvent[], prompt: string): boolean {
  return (
    events.some((event) => event.type === 'assistant_text' && event.text === `fixture:${prompt}`) &&
    events.some((event) => event.type === 'run_finished' && event.status === 'succeeded')
  );
}

async function dispose(current: Incident | null): Promise<void> {
  if (current === null) return;
  try {
    await current.sessions.close();
  } catch {
    // 用例失败时 close 可能已经报过；下面仍按 id 兜底清理本用例容器。
  }
  for (const id of current.ids) docker(['rm', '-f', id]);
  await rm(current.root, { recursive: true, force: true });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

function sourceDigest(dir: string): string {
  const hash = createHash('sha256');
  for (const name of filesUnder(dir)) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0');
  }
  return hash.digest('hex');
}

function newestSourceMtime(dir: string): number {
  return filesUnder(dir).reduce((max, name) => Math.max(max, statSync(join(dir, name)).mtimeMs), 0);
}

function artifact(path: string) {
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    builtAt: new Date(statSync(path).mtimeMs).toISOString(),
  };
}

/**
 * 每次运行都从当前 shared/sandbox 源码在独占临时目录编译，绝不复用 packages/<pkg>/dist。
 * 临时 tsconfig 只覆盖 outDir/tsBuildInfoFile，并把 @agentport/shared 指向本次构建的
 * 声明文件；项目引用与 tsc -b 仍由工作区工具链负责，产物不会写进共享 dist。
 */
async function compileCurrentSources(context: string): Promise<void> {
  const sources = {
    shared: join(REPO_ROOT, 'packages/shared/src'),
    sandbox: join(REPO_ROOT, 'packages/sandbox/src'),
  };
  const outputs = {
    shared: join(context, 'shared'),
    sandbox: join(context, 'dist'),
  };
  const sharedConfig = join(context, 'tsconfig.shared.json');
  const sandboxConfig = join(context, 'tsconfig.sandbox.json');
  await writeFile(
    sharedConfig,
    `${JSON.stringify(
      {
        extends: join(REPO_ROOT, 'packages/shared/tsconfig.json'),
        compilerOptions: {
          outDir: outputs.shared,
          tsBuildInfoFile: join(context, 'shared.tsbuildinfo'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    sandboxConfig,
    `${JSON.stringify(
      {
        extends: join(REPO_ROOT, 'packages/sandbox/tsconfig.json'),
        compilerOptions: {
          outDir: outputs.sandbox,
          tsBuildInfoFile: join(context, 'sandbox.tsbuildinfo'),
          // sandbox 源码里的 bare import 在容器运行时解析；编译期用本次 shared 产物。
          paths: { '@agentport/shared': [join(outputs.shared, 'index.d.ts')] },
        },
        references: [{ path: sharedConfig }],
      },
      null,
      2,
    )}\n`,
  );

  const before = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  const command = ['exec', 'tsc', '-b', sandboxConfig, '--force'];
  const compiled = spawnSync('pnpm', command, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (compiled.status !== 0) {
    const output = `${compiled.stdout}${compiled.stderr}`.trim();
    throw new Error(`compiling current shared/sandbox sources failed: ${output}`);
  }
  const after = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  if (before.shared !== after.shared || before.sandbox !== after.sandbox) {
    throw new Error('shared/sandbox sources changed during compilation; rerun this suite');
  }

  const artifacts = {
    'shared/sandbox-session.js': join(outputs.shared, 'sandbox-session.js'),
    'sandbox/session-supervisor.js': join(outputs.sandbox, 'session-supervisor.js'),
  };
  const newestSource = Math.max(
    newestSourceMtime(sources.shared),
    newestSourceMtime(sources.sandbox),
  );
  for (const [label, path] of Object.entries(artifacts)) {
    if (!existsSync(path)) {
      throw new Error(`${label} is missing after compiling current shared/sandbox sources`);
    }
    if (statSync(path).mtimeMs < newestSource) {
      throw new Error(`${label} predates the current sources; refusing stale artifacts`);
    }
  }

  await writeFile(
    SOURCE_EVIDENCE_FILE,
    `${JSON.stringify(
      {
        suite: 'session-sandbox-docker',
        compiledAt: new Date().toISOString(),
        command: `pnpm ${command.join(' ')}`,
        repoRoot: REPO_ROOT,
        sourceDigest: after,
        artifacts: Object.fromEntries(
          Object.entries(artifacts).map(([label, path]) => [label, artifact(path)]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function buildTestImage(context: string): Promise<void> {
  await compileCurrentSources(context);
  const dist = join(context, 'dist');
  await cp(FIXTURE, join(dist, 'session-task.mjs'));
  await writeFile(join(dist, 'runner.js'), "import './session-task.mjs';\n");

  await writeFile(
    join(context, 'Dockerfile'),
    [
      `FROM ${BASE_IMAGE}`,
      'COPY --chown=node:node dist/ /app/dist/',
      'COPY --chown=node:node shared/ /app/node_modules/@agentport/shared/dist/',
      '',
    ].join('\n'),
  );
  // --pull=false + --network none：只用本机 base 与 COPY，离线构建，绝不联网取镜像。
  const build = docker(
    ['build', '--pull=false', '--network', 'none', '-t', IMAGE_TAG, context],
    120_000,
  );
  if (build.status !== 0) {
    throw new Error(`docker build ${IMAGE_TAG} failed: ${build.stderr.trim()}`);
  }
}

describe.skipIf(!dockerReady)('session sandbox real docker lifecycle', () => {
  beforeAll(async () => {
    if (!imagePresent()) {
      throw new Error(
        `offline test requires local image ${BASE_IMAGE}; it is missing and this suite never pulls. Build it first: pnpm --filter @agentport/sandbox image`,
      );
    }
    buildContext = await mkdtemp(join(tmpdir(), 'session-docker-image-'));
    await buildTestImage(buildContext);
  });

  afterAll(async () => {
    if (dockerReady) {
      await writeFile(
        EVIDENCE_FILE,
        `${JSON.stringify({ ranAt: new Date().toISOString(), evidence: cleanupEvidence }, null, 2)}\n`,
      );
    }
    docker(['image', 'rm', '-f', IMAGE_TAG]);
    if (buildContext !== '') {
      await rm(buildContext, { recursive: true, force: true });
    }
  });

  it('reuses one container across runs in the same session and keeps /tmp state', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const firstPrompt = `first-${randomUUID()}`;
      const secondPrompt = `second-${randomUUID()}`;

      const firstLease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(firstLease.sandboxId);
      const first = await startRun(firstLease, firstPrompt);
      expect(await first.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(first.events, firstPrompt)).toBe(true);
      await firstLease.release({ reuse: true });

      const secondLease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(secondLease.sandboxId);
      expect(secondLease.sandboxId).toBe(firstLease.sandboxId);
      const second = await startRun(secondLease, secondPrompt);
      expect(await second.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(second.events, secondPrompt)).toBe(true);

      // /tmp 是容器 tmpfs：计数从 1 走到 2，且第一轮文件仍在，才证明复用了同一容器。
      expect(inContainer(firstLease.sandboxId, ['cat', '/tmp/session-fixture/count'])?.trim()).toBe(
        '2',
      );
      expect(
        inContainer(firstLease.sandboxId, ['cat', `/tmp/session-fixture/run-${firstPrompt}.json`]),
      ).toContain(firstPrompt);
      expect(containerRunning(firstLease.sandboxId)).toBe(true);
      await secondLease.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('gives different sessions different containers and isolated session mounts', {
    timeout: 60_000,
  }, async () => {
    const left = await incident();
    const right = await incident();
    try {
      const signal = new AbortController().signal;
      const leftPrompt = `left-${randomUUID()}`;
      const rightPrompt = `right-${randomUUID()}`;
      const leftLease = await left.sessions.acquire(left.spec, signal);
      const rightLease = await right.sessions.acquire(right.spec, signal);
      left.ids.push(leftLease.sandboxId);
      right.ids.push(rightLease.sandboxId);
      expect(leftLease.sandboxId).not.toBe(rightLease.sandboxId);

      const [leftRun, rightRun] = await Promise.all([
        startRun(leftLease, leftPrompt),
        startRun(rightLease, rightPrompt),
      ]);
      expect(await leftRun.execution.done).toMatchObject({ state: 'stopped' });
      expect(await rightRun.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(leftRun.events, leftPrompt)).toBe(true);
      expect(succeeded(rightRun.events, rightPrompt)).toBe(true);

      // sessionsDir 按会话挂到 /home/node/.claude：各自的宿主目录只能看到自己的 run。
      const leftState = await readFile(join(left.spec.sessionsDir, 'session-fixture.json'), 'utf8');
      const rightState = await readFile(
        join(right.spec.sessionsDir, 'session-fixture.json'),
        'utf8',
      );
      expect(leftState).toContain(leftPrompt);
      expect(leftState).not.toContain(rightPrompt);
      expect(rightState).toContain(rightPrompt);
      expect(rightState).not.toContain(leftPrompt);

      await leftLease.release({ reuse: false });
      await rightLease.release({ reuse: false });
    } finally {
      await dispose(left);
      await dispose(right);
    }
  });

  it('cancel stops the runner file writes while the container stays usable', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const longPrompt = `fixture:long-${randomUUID()}`;
      const thirdPrompt = `third-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, longPrompt);

      await waitFor(
        () => inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']),
        'long task progress file',
      );
      run.execution.cancel();
      expect(await run.execution.done).toMatchObject({ state: 'stopped' });

      // 有界静默窗口只证明取消后没有继续写，不用等待某个固定时长来猜。
      const afterCancel = inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']);
      expect(afterCancel).not.toBeNull();
      await delay(500);
      expect(inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress'])).toBe(
        afterCancel,
      );
      expect(inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/cancelled'])).toContain(
        'SIGTERM',
      );
      expect(containerRunning(lease.sandboxId)).toBe(true);
      await lease.release({ reuse: true });

      const again = await current.sessions.acquire(current.spec, signal);
      current.ids.push(again.sandboxId);
      expect(again.sandboxId).toBe(lease.sandboxId);
      const third = await startRun(again, thirdPrompt);
      expect(await third.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(third.events, thirdPrompt)).toBe(true);
      expect(
        inContainer(again.sandboxId, ['cat', `/tmp/session-fixture/run-${thirdPrompt}.json`]),
      ).toContain(thirdPrompt);
      await again.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('recycles an idle container, then gives the next run a new container with persistent state', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident(150);
      const signal = new AbortController().signal;
      const firstPrompt = `persist-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(lease.sandboxId);
      const first = await startRun(lease, firstPrompt);
      expect(await first.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(first.events, firstPrompt)).toBe(true);
      const persistentFile = join(current.spec.sessionsDir, 'session-fixture.json');
      expect(await readFile(persistentFile, 'utf8')).toContain(firstPrompt);
      await lease.release({ reuse: true });

      await waitFor(
        () => !containerExists(lease.sandboxId),
        'idle container to be reclaimed',
        20_000,
      );

      // 容器删除完成即视为回收完成：下一轮必须能直接 acquire，不能靠重试掩盖
      // destroy 尚未收口时抛 busy 的竞态。
      const fresh = await current.sessions.acquire(current.spec, signal);
      current.ids.push(fresh.sandboxId);
      expect(fresh.sandboxId).not.toBe(lease.sandboxId);
      // 新容器仍挂到同一会话目录：上一轮的持久文件还在，runner 无需重建状态。
      expect(
        inContainer(fresh.sandboxId, ['cat', '/home/node/.claude/session-fixture.json']),
      ).toContain(firstPrompt);
      const nextPrompt = `after-${randomUUID()}`;
      const next = await startRun(fresh, nextPrompt);
      expect(await next.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(next.events, nextPrompt)).toBe(true);
      expect(await readFile(persistentFile, 'utf8')).toContain(nextPrompt);
      await fresh.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('does not recycle a container while a run is in flight', { timeout: 60_000 }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident(120);
      const signal = new AbortController().signal;
      const longPrompt = `fixture:long-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, longPrompt);
      let settled = false;
      void run.execution.done.then(() => {
        settled = true;
      });

      await waitFor(
        () => inContainer(lease.sandboxId, ['cat', '/tmp/session-fixture/progress']),
        'long task progress file',
      );
      // 明显长于 idleTimeoutMs：忙碌中的执行不能触发空闲回收。
      await delay(500);
      expect(settled).toBe(false);
      expect(containerRunning(lease.sandboxId)).toBe(true);

      run.execution.cancel();
      expect(await run.execution.done).toMatchObject({ state: 'stopped' });
      await lease.release({ reuse: false });
    } finally {
      await dispose(current);
    }
  });

  it('close removes every managed container', { timeout: 60_000 }, async () => {
    const left = await incident();
    const right = await incident();
    try {
      const signal = new AbortController().signal;
      const leftLease = await left.sessions.acquire(left.spec, signal);
      const rightLease = await right.sessions.acquire(right.spec, signal);
      left.ids.push(leftLease.sandboxId);
      right.ids.push(rightLease.sandboxId);
      const [leftRun, rightRun] = await Promise.all([
        startRun(leftLease, `close-left-${randomUUID()}`),
        startRun(rightLease, `close-right-${randomUUID()}`),
      ]);
      await leftRun.execution.done;
      await rightRun.execution.done;
      await leftLease.release({ reuse: true });
      await rightLease.release({ reuse: true });

      await left.sessions.close();
      await right.sessions.close();
      await waitFor(
        () => !containerRunning(leftLease.sandboxId) && !containerRunning(rightLease.sandboxId),
        'managed containers to be removed',
        20_000,
      );
    } finally {
      await dispose(left);
      await dispose(right);
    }
  });

  it('stops detached and same-group children holding inherited stdout before reporting stopped', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      current = await incident();
      const signal = new AbortController().signal;
      const prompt = `fixture:orphan-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, prompt);

      const settlement = await run.execution.done;
      expect(settlement).toMatchObject({ state: 'stopped' });

      const meta = JSON.parse(inContainer(lease.sandboxId, ['cat', ORPHAN_META]) ?? '{}');
      expect(meta.ready).toBe(true);
      expect(typeof meta.detachedPid).toBe('number');
      expect(typeof meta.groupPid).toBe('number');
      expect(meta.detachedPid).not.toBe(meta.rootPid);

      const stopRecords: Record<string, unknown> = {};
      for (const [label, stopFile, pid] of [
        ['detached', ORPHAN_STOP, meta.detachedPid],
        ['same-group', GROUP_STOP, meta.groupPid],
      ] as const) {
        const stopped = JSON.parse(inContainer(lease.sandboxId, ['cat', stopFile]) ?? '{}');
        stopRecords[label] = stopped;
        // SIGTERM 只在 runner 退出后发出；/proc 里的 ppid=1 证明子进程已回挂容器 PID1。
        expect({ label, ...stopped }).toMatchObject({ label, pid, ppid: 1 });
      }

      // 两个子进程都持续写各自的进度文件；settled stopped 之后必须完全静默。
      const orphanAtSettle = inContainer(lease.sandboxId, ['cat', ORPHAN_PROGRESS]);
      const groupAtSettle = inContainer(lease.sandboxId, ['cat', GROUP_PROGRESS]);
      expect(orphanAtSettle).not.toBeNull();
      expect(groupAtSettle).not.toBeNull();
      await delay(500);
      expect(inContainer(lease.sandboxId, ['cat', ORPHAN_PROGRESS])).toBe(orphanAtSettle);
      expect(inContainer(lease.sandboxId, ['cat', GROUP_PROGRESS])).toBe(groupAtSettle);

      await lease.release({ reuse: true });
      const again = await current.sessions.acquire(current.spec, signal);
      current.ids.push(again.sandboxId);
      expect(again.sandboxId).toBe(lease.sandboxId);
      const nextPrompt = `after-orphan-${randomUUID()}`;
      const next = await startRun(again, nextPrompt);
      expect(await next.execution.done).toMatchObject({ state: 'stopped' });
      expect(succeeded(next.events, nextPrompt)).toBe(true);
      await again.release({ reuse: false });

      cleanupEvidence.push({
        test: 'orphan-stop',
        settlement,
        rootPid: meta.rootPid,
        detachedPid: meta.detachedPid,
        groupPid: meta.groupPid,
        orphanAtSettle,
        groupAtSettle,
        stopRecords,
        orphanFrozen: true,
        groupFrozen: true,
        reusedSandboxId: again.sandboxId,
      });
    } finally {
      await dispose(current);
    }
  });

  it('removes a busy container after worker stdin EOF, without an explicit close', {
    timeout: 60_000,
  }, async () => {
    let current: Incident | null = null;
    try {
      const recording = new RecordingProvider(dockerProvider());
      current = await incident(60_000, recording);
      const signal = new AbortController().signal;
      const busyFile = join(current.spec.outputsDir, BUSY_OUTPUT);
      const prompt = `fixture:busy-${randomUUID()}`;

      const lease = await current.sessions.acquire(current.spec, signal);
      current.ids.push(lease.sandboxId);
      const run = await startRun(lease, prompt);

      const firstTick = await waitFor(async () => {
        if (!existsSync(busyFile)) return null;
        const tick = Number(JSON.parse(await readFile(busyFile, 'utf8')).tick);
        return tick >= 2 ? tick : null;
      }, 'busy output to advance');

      expect(recording.children).toHaveLength(1);
      const child = recording.children[0];
      if (child === undefined) throw new Error('provider did not record the sandbox child');
      expect(child.stdin.destroyed).toBe(false);
      // 只断开 worker 侧连接；不 release/close，容器清理必须由 EOF 触发的自身退出完成。
      child.stdin.end();

      await waitFor(
        () => !containerExists(lease.sandboxId),
        'container to disappear after stdin EOF',
        20_000,
      );
      const settlement = await run.execution.done;
      expect(settlement).toMatchObject({ state: 'stopped' });

      const afterRemoval = await readFile(busyFile, 'utf8');
      await delay(300);
      const stillStopped = await readFile(busyFile, 'utf8');
      expect(stillStopped).toBe(afterRemoval);
      expect(JSON.parse(stillStopped).tick).toBeGreaterThanOrEqual(firstTick);

      cleanupEvidence.push({
        test: 'stdin-eof-cleanup',
        settlement,
        firstTick,
        lastTick: JSON.parse(stillStopped).tick,
        stdinEofPropagated: true,
        containerRemovedWithoutClose: true,
        explicitRelease: false,
      });
    } finally {
      // 仅兜底：正常路径已由 EOF 自清；失败时 close 仍必须把本轮容器清干净。
      await dispose(current);
      for (const id of current?.ids ?? []) {
        expect(containerExists(id)).toBe(false);
      }
    }
  });
});
