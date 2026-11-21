import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, newId, repo, schema } from '@agentport/db';
import {
  SESSION_CLEANUP_REQUEST_CHANNEL,
  type SessionCleanupAck,
  type SessionCleanupTarget,
  sessionCleanupAckChannel,
  sessionCleanupAckSchema,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { deleteConversationWithSandboxes } from '../../api/src/modules/runtime/runtime-deletion.js';
import { DockerSandboxProvider } from '../src/sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from '../src/sandbox/provider.js';
import { startSessionCleanupChannel } from '../src/sandbox/session-cleanup.js';
import { SessionSandboxes } from '../src/sandbox/sessions.js';
import { type IsolatedRedis, startRedisContainer, stopRedisContainer } from './global-setup.js';
import { createIsolatedDatabase } from './isolated-db.js';

const BASE_IMAGE = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
const IMAGE_TAG = `session-cleanup-lifecycle-test-${randomUUID().slice(0, 8)}`;
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
let REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:1/9';
let isolatedRedis: IsolatedRedis | null = null;
const REQUEST_CHANNEL = SESSION_CLEANUP_REQUEST_CHANNEL;
const isolatedDb = await createIsolatedDatabase(
  'worker_session_cleanup_docker',
  process.env.DATABASE_URL ?? '',
);
const { db, client } = createDb(
  isolatedDb?.url ?? 'postgres://unreachable@127.0.0.1:1/unavailable',
);
const dbReady = await client.unsafe('select 1').then(
  () => true,
  () => false,
);

function docker(args: string[], timeout = 20_000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout });
}

const dockerReady = docker(['info', '--format', '{{.ServerVersion}}']).status === 0;
const imageReady = docker(['image', 'inspect', BASE_IMAGE]).status === 0;

function containerExists(id: string): boolean {
  return docker(['inspect', id]).status === 0;
}

class FlakyProvider implements SandboxProvider {
  failDestroy = false;

  constructor(private readonly inner: SandboxProvider) {}

  create(options: SandboxCreateOptions): Promise<Sandbox> {
    return this.inner.create(options);
  }

  destroy(sandbox: Sandbox): Promise<void> {
    if (this.failDestroy) return Promise.reject(new Error('injected destroy failure'));
    return this.inner.destroy(sandbox);
  }

  destroyById(id: string): Promise<void> {
    if (this.failDestroy) return Promise.reject(new Error('injected destroy failure'));
    return this.inner.destroyById(id);
  }
}

async function requestClose(targets: SessionCleanupTarget[]): Promise<void> {
  const requestId = randomUUID();
  const channel = sessionCleanupAckChannel(requestId);
  const subscriber = new RedisClient(REDIS_URL);
  const publisher = new RedisClient(REDIS_URL);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let resolveAck!: (ack: SessionCleanupAck) => void;
    let rejectAck!: (error: Error) => void;
    const ack = new Promise<SessionCleanupAck>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    await subscriber.subscribe(channel, (payload, received) => {
      if (received !== channel) return;
      if (timer !== undefined) clearTimeout(timer);
      const parsed = sessionCleanupAckSchema.safeParse(JSON.parse(payload));
      if (parsed.success) resolveAck(parsed.data);
    });
    timer = setTimeout(() => rejectAck(new Error('close ack timeout')), 15_000);
    timer.unref();
    await publisher.publish(
      REQUEST_CHANNEL,
      JSON.stringify({ requestId, deadline: Date.now() + 15_000, targets }),
    );
    const result = await ack;
    if (!result.ok) throw new Error(result.error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscriber.close();
    publisher.close();
  }
}

let buildContext = '';

async function buildTestImage(): Promise<void> {
  const compiled = spawnSync(
    'bun',
    ['run', 'tsc', '-b', 'packages/sandbox/tsconfig.json', '--force'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  if (compiled.status !== 0) {
    throw new Error(`compiling current shared/sandbox sources failed: ${compiled.stderr}`);
  }
  buildContext = await mkdtemp(join(tmpdir(), 'session-cleanup-image-'));
  await cp(join(REPO_ROOT, 'packages/sandbox/dist'), join(buildContext, 'dist'), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, 'packages/shared/dist'), join(buildContext, 'shared'), {
    recursive: true,
  });
  await writeFile(
    join(buildContext, 'Dockerfile'),
    [
      `FROM ${BASE_IMAGE}`,
      'COPY --chown=node:node dist/ /app/dist/',
      'COPY --chown=node:node shared/ /app/packages/shared/dist/',
      '',
    ].join('\n'),
  );
  const build = docker(
    ['build', '--pull=false', '--network', 'none', '-t', IMAGE_TAG, buildContext],
    180_000,
  );
  if (build.status !== 0) {
    throw new Error(`docker build ${IMAGE_TAG} failed: ${build.stderr.trim()}`);
  }
}

interface Incident {
  root: string;
  sessions: SessionSandboxes;
  provider: FlakyProvider;
  manager: Awaited<ReturnType<typeof startSessionCleanupChannel>>;
  agentId: string;
  conversationId: string;
  sandboxId: string;
  secretsDir: string;
}

const incidents: Incident[] = [];

async function setup(failDestroy = false): Promise<Incident> {
  const root = await mkdtemp(join(tmpdir(), 'session-cleanup-docker-'));
  const dirs = {
    workspaceDir: join(root, 'workspace'),
    outputsDir: join(root, 'outputs'),
    inputsDir: join(root, 'inputs'),
    memoryDir: join(root, 'memory'),
    sessionsDir: join(root, 'sessions'),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  const secretsDir = join(dirs.workspaceDir, '.claude');
  await mkdir(secretsDir, { recursive: true });
  await writeFile(
    join(secretsDir, '.mcp.json'),
    '{"mcpServers":{"fake":{"env":{"TOKEN":"fake-not-real"}}}}',
  );

  const provider = new FlakyProvider(
    new DockerSandboxProvider({ memory: '256m', cpus: 1, pids: 64, egress: 'none' }),
  );
  provider.failDestroy = failDestroy;
  const sessions = new SessionSandboxes({
    provider,
    idleTimeoutMs: 60_000,
    maxActive: 32,
    logger: pino({ level: 'silent' }),
    resolveRuntimeEnvironment: async () => ({
      environmentId: 'env_docker',
      environmentName: '默认环境',
      versionId: 'ver_docker',
      imageId: IMAGE_TAG,
    }),
  });
  const manager = await startSessionCleanupChannel({
    redisUrl: REDIS_URL,
    logger: pino({ level: 'silent' }),
    sessions,
    requestChannel: REQUEST_CHANNEL,
  });

  const agentId = newId('agent');
  const conversationId = newId('conversation');
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `delete-docker-${agentId.slice(4)}`,
    name: 'delete docker',
    model: 'test',
    createdBy: 'delete-docker-owner',
    ownerBusinessId: 'delete-docker-owner',
  });
  await repo.chat.createConversation(db, {
    id: conversationId,
    agentId,
    title: 'delete docker',
    subject: { kind: 'user', businessId: 'delete-docker-owner' },
  });

  const lease = await sessions.acquire(
    {
      agentId,
      conversationId,
      runtimeEnvironmentId: null,
      ...dirs,
    },
    new AbortController().signal,
    `run-${randomUUID()}`,
  );
  await lease.release({ reuse: true });
  const sandboxId = lease.sandboxId;
  await db.insert(schema.agentRuns).values({
    id: newId('run'),
    conversationId,
    agentId,
    status: 'succeeded',
    subjectKind: 'user',
    initiatedBy: 'delete-docker-owner',
    sandboxId,
  });

  const incident: Incident = {
    root,
    sessions,
    provider,
    manager,
    agentId,
    conversationId,
    sandboxId,
    secretsDir,
  };
  incidents.push(incident);
  return incident;
}

function deleteWithClose(incident: Incident): Promise<boolean> {
  return deleteConversationWithSandboxes({
    client,
    redisUrl: REDIS_URL,
    deletion: {
      id: incident.conversationId,
      access: { businessId: 'delete-docker-owner', scopes: ['own_data'] },
    },
  }).then((snapshot) => snapshot !== null);
}

afterAll(async () => {
  for (const incident of incidents) {
    await incident.manager.close().catch(() => undefined);
    await incident.sessions.close().catch(() => undefined);
    if (containerExists(incident.sandboxId)) docker(['rm', '-f', incident.sandboxId]);
    await db.delete(schema.agents).where(eq(schema.agents.id, incident.agentId));
    await rm(incident.root, { recursive: true, force: true });
  }
  if (buildContext !== '') {
    docker(['rmi', '-f', IMAGE_TAG]);
    await rm(buildContext, { recursive: true, force: true });
  }
  await stopRedisContainer(isolatedRedis);
  await client.close();
  await isolatedDb?.close();
});

describe.skipIf(!dockerReady || !imageReady || !dbReady)('session cleanup real docker', () => {
  beforeAll(async () => {
    isolatedRedis = await startRedisContainer();
    if (isolatedRedis === null) throw new Error('isolated Redis container unavailable');
    REDIS_URL = isolatedRedis.url;
    await buildTestImage();
  });
  it('closes the idle supervisor before deleting rows and directories', async () => {
    const incident = await setup();
    expect(containerExists(incident.sandboxId)).toBe(true);
    expect(await readFile(join(incident.secretsDir, '.mcp.json'), 'utf8')).toContain(
      'fake-not-real',
    );

    await expect(deleteWithClose(incident)).resolves.toBe(true);

    expect(containerExists(incident.sandboxId)).toBe(false);
    expect(await repo.chat.getConversation(db, incident.conversationId)).toBeNull();
    await expect(
      requestClose([{ conversationId: incident.conversationId, sandboxIds: [incident.sandboxId] }]),
    ).resolves.toBeUndefined();
    await rm(incident.root, { recursive: true, force: true });
    expect(docker(['inspect', incident.sandboxId]).status).not.toBe(0);
  }, 60_000);

  it('keeps rows and directories when the container cannot be closed, then retries', async () => {
    const incident = await setup(true);

    await expect(deleteWithClose(incident)).rejects.toThrow(/destroy|close failed/);
    expect(await repo.chat.getConversation(db, incident.conversationId)).not.toBeNull();
    expect(containerExists(incident.sandboxId)).toBe(true);
    expect(await readFile(join(incident.secretsDir, '.mcp.json'), 'utf8')).toContain(
      'fake-not-real',
    );

    incident.provider.failDestroy = false;
    await expect(deleteWithClose(incident)).resolves.toBe(true);
    expect(containerExists(incident.sandboxId)).toBe(false);
    expect(await repo.chat.getConversation(db, incident.conversationId)).toBeNull();
    await rm(incident.root, { recursive: true, force: true });
  }, 60_000);

  it('closes a persisted container through the delete API after the worker no longer has an entry', async () => {
    const incident = await setup();
    const { sandboxId } = incident;

    await incident.manager.close();
    const restarted = new SessionSandboxes({
      provider: incident.provider,
      idleTimeoutMs: 60_000,
      maxActive: 32,
      logger: pino({ level: 'silent' }),
      resolveRuntimeEnvironment: async () => ({
        environmentId: 'env_docker',
        environmentName: '默认环境',
        versionId: 'ver_docker',
        imageId: IMAGE_TAG,
      }),
    });
    const restartedChannel = await startSessionCleanupChannel({
      redisUrl: REDIS_URL,
      logger: pino({ level: 'silent' }),
      sessions: restarted,
      requestChannel: REQUEST_CHANNEL,
    });
    try {
      expect(await repo.chat.getConversation(db, incident.conversationId)).not.toBeNull();
      expect(await readFile(join(incident.secretsDir, '.mcp.json'), 'utf8')).toContain(
        'fake-not-real',
      );
      await expect(deleteWithClose(incident)).resolves.toBe(true);
      expect(containerExists(sandboxId)).toBe(false);
      expect(await repo.chat.getConversation(db, incident.conversationId)).toBeNull();
      await rm(incident.root, { recursive: true, force: true });
      await expect(access(incident.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await restartedChannel.close();
      await restarted.close().catch(() => undefined);
    }
  }, 60_000);
});
