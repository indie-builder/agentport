import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { DockerSandboxProvider } from '../../src/sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from '../../src/sandbox/provider.js';
import { SessionSandboxes, type SessionSandboxSpec } from '../../src/sandbox/sessions.js';

const BASE_IMAGE = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const FIXTURE = join(REPO_ROOT, 'packages/worker/test/fixtures/session-task.mjs');
const ORPHAN_META = '/tmp/session-fixture/orphan.json';
const ORPHAN_PROGRESS = '/tmp/session-fixture/orphan-progress';
const ORPHAN_STOP = '/tmp/session-fixture/orphan-stop.json';
const GROUP_PROGRESS = '/tmp/session-fixture/group-progress';
const GROUP_STOP = '/tmp/session-fixture/group-stop.json';
const BUSY_OUTPUT = 'session-busy-progress';

interface CleanupEvidence {
  test: string;
  settlement?: unknown;
  [key: string]: unknown;
}

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

  destroyById(id: string): Promise<void> {
    return this.inner.destroyById(id);
  }
}

class RejectFirstDestroyProvider implements SandboxProvider {
  private rejected = false;

  constructor(private readonly inner: SandboxProvider) {}

  create(options: SandboxCreateOptions): Promise<Sandbox> {
    return this.inner.create(options);
  }

  destroy(sandbox: Sandbox): Promise<void> {
    if (!this.rejected) {
      this.rejected = true;
      return Promise.reject(new Error(`injected destroy failure for ${sandbox.id}`));
    }
    return this.inner.destroy(sandbox);
  }

  destroyById(id: string): Promise<void> {
    return this.inner.destroyById(id);
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
    } catch {}
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

interface RecordedEvent {
  type?: string;
  status?: string;
  text?: string;
}

export interface Incident {
  root: string;
  spec: SessionSandboxSpec;
  sessions: SessionSandboxes;
  ids: string[];
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

async function startRun(lease: Lease, prompt: string, runId = `run-${randomUUID()}`) {
  const events: RecordedEvent[] = [];
  const stderr: string[] = [];
  const execution = await lease.start({
    runId,
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
  } catch {}
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

async function compileCurrentSources(context: string, sourceEvidenceFile: string): Promise<void> {
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
          paths: { '@agentport/shared': [join(outputs.shared, 'index.d.ts')] },
        },
        references: [{ path: sharedConfig }],
      },
      null,
      2,
    )}\n`,
  );

  const before = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  const command = ['run', 'tsc', '-b', sandboxConfig, '--force'];
  const compiled = spawnSync('bun', command, {
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
    sourceEvidenceFile,
    `${JSON.stringify(
      {
        suite: 'session-sandbox-docker',
        compiledAt: new Date().toISOString(),
        command: `bun ${command.join(' ')}`,
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

async function buildTestImage(
  context: string,
  imageTag: string,
  sourceEvidenceFile: string,
): Promise<void> {
  await compileCurrentSources(context, sourceEvidenceFile);
  const dist = join(context, 'dist');
  await cp(FIXTURE, join(dist, 'session-task.mjs'));
  await writeFile(join(dist, 'runner.js'), "import './session-task.mjs';\n");

  await writeFile(
    join(context, 'Dockerfile'),
    [
      `FROM ${BASE_IMAGE}`,
      'COPY --chown=node:node dist/ /app/dist/',
      'COPY --chown=node:node shared/ /app/packages/shared/dist/',
      '',
    ].join('\n'),
  );
  const build = docker(
    ['build', '--pull=false', '--network', 'none', '-t', imageTag, context],
    120_000,
  );
  if (build.status !== 0) {
    throw new Error(`docker build ${imageTag} failed: ${build.stderr.trim()}`);
  }
}

export function createSessionSandboxDockerSuite() {
  const dockerReady = docker(['info', '--format', '{{.ServerVersion}}']).status === 0;
  const suiteId = randomUUID().slice(0, 8);
  const imageTag = `session-sandbox-lifecycle-test-${suiteId}`;
  const evidenceFile = `/tmp/session-docker-process-cleanup-${suiteId}.json`;
  const sourceEvidenceFile = `/tmp/session-docker-current-source-${suiteId}.json`;
  const cleanupEvidence: CleanupEvidence[] = [];
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
      maxActive: 32,
      logger: pino({ level: 'silent' }),
      resolveRuntimeEnvironment: async () => ({
        environmentId: 'env_docker',
        environmentName: '默认环境',
        versionId: 'ver_docker',
        imageId: imageTag,
      }),
    });
    return {
      root,
      sessions,
      ids: [],
      spec: {
        agentId: `agent-${randomUUID()}`,
        conversationId: randomUUID(),
        runtimeEnvironmentId: null,
        memoryWritable: true,
        ...dirs,
      },
    };
  }

  async function setup() {
    if (!imagePresent()) {
      throw new Error(
        `offline test requires local image ${BASE_IMAGE}; it is missing and this suite never pulls. Build it first: bun run --filter @agentport/sandbox image`,
      );
    }
    buildContext = await mkdtemp(join(tmpdir(), 'session-docker-image-'));
    await buildTestImage(buildContext, imageTag, sourceEvidenceFile);
  }

  async function teardown() {
    if (dockerReady) {
      await writeFile(
        evidenceFile,
        `${JSON.stringify({ ranAt: new Date().toISOString(), evidence: cleanupEvidence }, null, 2)}\n`,
      );
    }
    docker(['image', 'rm', '-f', imageTag]);
    if (buildContext !== '') {
      await rm(buildContext, { recursive: true, force: true });
    }
  }

  return {
    BUSY_OUTPUT,
    GROUP_PROGRESS,
    GROUP_STOP,
    ORPHAN_META,
    ORPHAN_PROGRESS,
    ORPHAN_STOP,
    RecordingProvider,
    RejectFirstDestroyProvider,
    cleanupEvidence,
    containerExists,
    containerRunning,
    delay,
    dispose,
    dockerProvider,
    dockerReady,
    inContainer,
    incident,
    setup,
    startRun,
    succeeded,
    teardown,
    waitFor,
  };
}
