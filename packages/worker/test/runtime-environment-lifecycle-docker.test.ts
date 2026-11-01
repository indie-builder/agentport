import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, repo } from '@agentport/db';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRuntimeEnvironmentBuild } from '../src/runtime-environments/build.js';
import { createRuntimeEnvironmentResolver } from '../src/runtime-environments/resolve.js';
import { DockerSandboxProvider } from '../src/sandbox/docker.js';
import {
  SessionSandboxes,
  type SessionSandboxLease,
  type SessionSandboxSpec,
} from '../src/sandbox/sessions.js';

/**
 * 真实证据：DB 线上指针发布/回退 + 两个真实派生镜像 + 真实 SessionSandboxes。
 * 容器选择只看 lease 身份、docker inspect 的镜像 ID 与 /opt/env-version 标记；
 * 不调模型，supervisor 启动到 ready 即可。基座与派生 tag 都独占，绝不覆盖 dev。
 */
const BASE_IMAGE =
  process.env.RUNTIME_ENV_LIFECYCLE_BASE ?? 'agentport/sandbox:runtime-env-bash-20261029';
const IDLE_TIMEOUT_MS = 1_500;
const EVIDENCE_FILE = '/tmp/runtime-environment-lifecycle-docker.json';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: string[], timeout = 30_000): CommandResult {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function imageId(image: string): string | null {
  const result = docker(['image', 'inspect', '--format', '{{.Id}}', image], 10_000);
  return result.status === 0 ? result.stdout.trim() : null;
}

function dockerReadyNow(): boolean {
  return docker(['info', '--format', '{{.ServerVersion}}'], 10_000).status === 0;
}

function containerExists(name: string): boolean {
  return docker(['container', 'inspect', '--format', '{{.Id}}', name], 10_000).status === 0;
}

function required(args: string[]): string {
  const result = docker(args);
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGone(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (containerExists(name)) {
    if (Date.now() >= deadline) throw new Error(`container ${name} was not reclaimed in time`);
    await delay(50);
  }
}

function dockerfileFor(marker: string): string {
  return [
    'ARG RUNTIME_BASE_IMAGE',
    `FROM \${RUNTIME_BASE_IMAGE}`,
    'USER root',
    `RUN printf '%s\\n' '${marker}' > /opt/env-version`,
    'USER node',
    '',
  ].join('\n');
}

interface BuiltVersion {
  versionId: string;
  imageId: string;
  imageTag: string;
  marker: string;
}

interface ContainerEvidence {
  step: string;
  conversationId: string;
  containerName: string;
  containerId: string;
  actualImageId: string;
  marker: string;
  leaseEnvironmentId: string;
  leaseVersionId: string;
  leaseImageId: string;
}

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db, pool } = dbHandle;
const dbReady = await pool.query('select 1').then(
  () => true,
  () => false,
);
const dockerReady = dockerReadyNow();
const baseImageReady = dockerReady && imageId(BASE_IMAGE) !== null;

let environmentRoot = '';
let environmentId = '';
let environmentName = '';
const builtVersions: BuiltVersion[] = [];
const imageTagsToRemove: string[] = [];
const imageIdsToRemove: string[] = [];
const createdContainers: string[] = [];
const evidence: ContainerEvidence[] = [];
let sessions: SessionSandboxes | null = null;
let provider: DockerSandboxProvider | null = null;

async function buildVersion(marker: string): Promise<BuiltVersion> {
  const dockerfile = dockerfileFor(marker);
  const updated = await repo.runtimeEnvironments.updateRuntimeEnvironment(db, environmentId, {
    dockerfile,
  });
  if (updated === null) throw new Error('runtime environment update returned null');
  const queued = await repo.runtimeEnvironments.enqueueRuntimeEnvironmentBuild(
    db,
    environmentId,
    BASE_IMAGE,
  );
  if (queued === null) throw new Error('runtime environment enqueue returned null');
  const claimed = await repo.runtimeEnvironments.claimRuntimeEnvironmentBuild(db, queued.id);
  if (claimed === null) throw new Error('runtime environment claim returned null');

  const built = await executeRuntimeEnvironmentBuild({
    versionId: queued.id,
    dockerfile,
    baseImageId: BASE_IMAGE,
  });
  if (!built.ok) throw new Error(`build ${marker} failed: ${built.error}`);
  imageTagsToRemove.push(built.imageTag);
  imageIdsToRemove.push(built.imageId);

  const ready = await repo.runtimeEnvironments.completeRuntimeEnvironmentBuild(db, queued.id, {
    imageTag: built.imageTag,
    imageId: built.imageId,
    baseImageId: built.baseImageId,
  });
  if (ready === null) throw new Error('runtime environment complete returned null');

  return {
    versionId: queued.id,
    imageId: built.imageId,
    imageTag: built.imageTag,
    marker,
  };
}

async function publish(version: BuiltVersion): Promise<void> {
  const published = await repo.runtimeEnvironments.publishRuntimeEnvironmentVersion(
    db,
    environmentId,
    version.versionId,
  );
  if (published === null) throw new Error('runtime environment publish returned null');
  expect(published.onlineVersionId).toBe(version.versionId);
  const online = await repo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, environmentId);
  expect(online).toMatchObject({
    environmentId,
    environmentName,
    versionId: version.versionId,
    imageId: version.imageId,
  });
}

function observe(
  step: string,
  conversationId: string,
  lease: SessionSandboxLease,
  expected: BuiltVersion,
): ContainerEvidence {
  createdContainers.push(lease.sandboxId);
  const containerId = required(['container', 'inspect', '--format', '{{.Id}}', lease.sandboxId]);
  const actualImageId = required([
    'container',
    'inspect',
    '--format',
    '{{.Image}}',
    lease.sandboxId,
  ]);
  const marker = required(['exec', lease.sandboxId, 'cat', '/opt/env-version']);

  expect(lease.runtimeEnvironment).toEqual({
    environmentId,
    environmentName,
    versionId: expected.versionId,
    imageId: expected.imageId,
  });
  expect(actualImageId).toBe(expected.imageId);
  expect(marker).toBe(expected.marker);

  const record: ContainerEvidence = {
    step,
    conversationId,
    containerName: lease.sandboxId,
    containerId,
    actualImageId,
    marker,
    leaseEnvironmentId: lease.runtimeEnvironment.environmentId,
    leaseVersionId: lease.runtimeEnvironment.versionId,
    leaseImageId: lease.runtimeEnvironment.imageId,
  };
  evidence.push(record);
  return record;
}

function specFor(conversationId: string, root: string): SessionSandboxSpec {
  return {
    agentId: `agent-${randomUUID()}`,
    conversationId,
    runtimeEnvironmentId: environmentId,
    workspaceDir: join(root, 'workspace'),
    outputsDir: join(root, 'outputs'),
    inputsDir: join(root, 'inputs'),
    memoryDir: join(root, 'memory'),
    sessionsDir: join(root, 'sessions'),
  };
}

describe.skipIf(!dockerReady || !baseImageReady || !dbReady)(
  'runtime environment online pointer lifecycle',
  () => {
    beforeAll(async () => {
      environmentRoot = await mkdtemp(join(tmpdir(), 'runtime-env-lifecycle-'));
      await Promise.all(
        ['workspace', 'outputs', 'inputs', 'memory', 'sessions'].map((name) =>
          mkdir(join(environmentRoot, name), { recursive: true }),
        ),
      );

      environmentName = `lifecycle-${randomUUID().slice(0, 8)}`;
      const environment = await repo.runtimeEnvironments.createRuntimeEnvironment(db, {
        name: environmentName,
        dockerfile: dockerfileFor('placeholder'),
      });
      environmentId = environment.id;

      builtVersions.push(await buildVersion(`runtime-env-A-${randomUUID()}`));
      await publish(builtVersions[0] as BuiltVersion);

      provider = new DockerSandboxProvider({
        memory: '512m',
        cpus: 1,
        pids: 128,
        egress: 'none',
      });
      sessions = new SessionSandboxes({
        provider,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        maxActive: 32,
        logger: pino({ level: 'silent' }),
        resolveRuntimeEnvironment: createRuntimeEnvironmentResolver((id) =>
          repo.runtimeEnvironments.resolveOnlineRuntimeEnvironment(db, id),
        ),
      });
    }, 300_000);

    afterAll(async () => {
      if (sessions !== null) {
        try {
          await sessions.close();
        } catch {
          // 用例失败时 close 可能已报过；下面仍按名字兜底清理本用例容器。
        }
      }
      if (provider !== null) {
        try {
          await provider.destroyAll();
        } catch {
          // 同上；容器名兜底仍会执行。
        }
      }
      for (const name of createdContainers) docker(['rm', '-f', name], 20_000);
      if (environmentId !== '') {
        await repo.runtimeEnvironments
          .deleteRuntimeEnvironment(db, environmentId)
          .catch(() => undefined);
      }
      await pool.end().catch(() => undefined);
      for (const tag of imageTagsToRemove) docker(['rmi', '-f', tag], 60_000);
      for (const id of imageIdsToRemove) docker(['rmi', '-f', id], 60_000);
      if (environmentRoot !== '') {
        await rm(environmentRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      await writeFile(
        EVIDENCE_FILE,
        `${JSON.stringify(
          {
            ranAt: new Date().toISOString(),
            baseImage: BASE_IMAGE,
            baseImageId: imageId(BASE_IMAGE),
            environmentId,
            environmentName,
            versions: builtVersions.map(({ versionId, imageId, imageTag, marker }) => ({
              versionId,
              imageId,
              imageTag,
              marker,
            })),
            evidence,
            agentRunsVerified: false,
          },
          null,
          2,
        )}\n`,
        'utf8',
      ).catch(() => undefined);
    }, 300_000);

    it('reuses the live container across publish, rebuilds with the new online version, and keeps it across rollback', {
      timeout: 300_000,
    }, async () => {
      if (sessions === null) throw new Error('session manager was not initialized');
      const versionA = builtVersions[0] as BuiltVersion;
      const versionB = await buildVersion(`runtime-env-B-${randomUUID()}`);
      builtVersions.push(versionB);

      const signal = new AbortController().signal;
      const conversationId = randomUUID();
      const spec = specFor(conversationId, environmentRoot);

      // 1. 线上 A 时新建容器：lease、docker 镜像 ID、实际标记三者一致。
      const first = await sessions.acquire(spec, signal, `run-${randomUUID()}`);
      const firstEvidence = observe('create-with-A', conversationId, first, versionA);
      await first.release({ reuse: true });

      // 2. 发布 B 后同一会话复用存活容器：仍是 A 的容器/镜像/标记，不读新线上。
      await publish(versionB);
      const reused = await sessions.acquire(spec, signal, `run-${randomUUID()}`);
      const reusedEvidence = observe('reuse-after-publish-B', conversationId, reused, versionA);
      expect(reused.sandboxId).toBe(first.sandboxId);
      expect(reusedEvidence.containerId).toBe(firstEvidence.containerId);
      await reused.release({ reuse: true });

      // 3. 新会话在 B 线上创建：必须换容器并用 B。
      const otherConversationId = randomUUID();
      const otherSpec = specFor(otherConversationId, environmentRoot);
      const second = await sessions.acquire(otherSpec, signal, `run-${randomUUID()}`);
      const secondEvidence = observe(
        'new-conversation-with-B',
        otherConversationId,
        second,
        versionB,
      );
      expect(second.sandboxId).not.toBe(first.sandboxId);
      expect(secondEvidence.containerId).not.toBe(firstEvidence.containerId);
      await second.release({ reuse: false });
      await waitForGone(second.sandboxId, 20_000);

      // 4. 原会话空闲被真实回收后重建：此时线上仍是 B，新容器必须是 B。
      await waitForGone(first.sandboxId, IDLE_TIMEOUT_MS + 20_000);
      expect(containerExists(first.sandboxId)).toBe(false);
      const rebuilt = await sessions.acquire(spec, signal, `run-${randomUUID()}`);
      const rebuiltEvidence = observe('idle-rebuild-with-B', conversationId, rebuilt, versionB);
      expect(rebuilt.sandboxId).not.toBe(first.sandboxId);
      expect(rebuiltEvidence.containerId).not.toBe(firstEvidence.containerId);
      await rebuilt.release({ reuse: true });

      // 5. 回退 A 不替换存活的 B 容器；再新建会话才用 A。
      await publish(versionA);
      const kept = await sessions.acquire(spec, signal, `run-${randomUUID()}`);
      const keptEvidence = observe('survives-rollback-to-A', conversationId, kept, versionB);
      expect(kept.sandboxId).toBe(rebuilt.sandboxId);
      expect(keptEvidence.containerId).toBe(rebuiltEvidence.containerId);
      await kept.release({ reuse: true });

      const thirdConversationId = randomUUID();
      const thirdSpec = specFor(thirdConversationId, environmentRoot);
      const third = await sessions.acquire(thirdSpec, signal, `run-${randomUUID()}`);
      const thirdEvidence = observe(
        'new-conversation-after-rollback-A',
        thirdConversationId,
        third,
        versionA,
      );
      expect(third.sandboxId).not.toBe(kept.sandboxId);
      expect(thirdEvidence.containerId).not.toBe(keptEvidence.containerId);
      await third.release({ reuse: false });
      await waitForGone(third.sandboxId, 20_000);

      expect(evidence.map((item) => item.marker)).toEqual([
        versionA.marker,
        versionA.marker,
        versionB.marker,
        versionB.marker,
        versionB.marker,
        versionA.marker,
      ]);
      // 同一会话跨发布/回退复用同一个容器 ID；只有回收后的重建才换 ID。
      expect(reusedEvidence.containerId).toBe(firstEvidence.containerId);
      expect(rebuiltEvidence.containerId).not.toBe(firstEvidence.containerId);
      expect(keptEvidence.containerId).toBe(rebuiltEvidence.containerId);
    });
  },
);
