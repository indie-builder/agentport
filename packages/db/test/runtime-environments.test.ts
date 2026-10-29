import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { isIdOfType, newId } from '../src/id.js';
import * as agentVersionsRepo from '../src/repo/agent-versions.js';
import {
  type AgentWrite,
  createAgent,
  duplicateAgent,
  getAgent,
  updateAgent,
} from '../src/repo/agents.js';
import * as repo from '../src/repo/runtime-environments.js';
import { agents, runtimeEnvironments, runtimeEnvironmentVersions, servers } from '../src/schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://unreachable@127.0.0.1:1/unavailable';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

describe.skipIf(!ready)('runtime environment repo', () => {
  const environmentIds: string[] = [];
  const agentIds: string[] = [];
  const serverIds: string[] = [];

  const uniqueName = (prefix: string) => `${prefix}-${newId('runtimeEnvironment')}`;

  async function makeEnvironment(prefix = 'env') {
    const environment = await repo.createRuntimeEnvironment(db, {
      name: uniqueName(prefix),
      dockerfile: 'FROM scratch\n',
    });
    environmentIds.push(environment.id);
    return environment;
  }

  function agentWrite(slug: string, runtimeEnvironmentId: string | null): AgentWrite {
    return {
      slug,
      name: slug,
      role: '通用助手',
      description: '',
      model: 'claude-test',
      systemPromptMd: '',
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'default',
      uiFormat: 'markdown',
      effort: null,
      enabled: true,
      maxTurns: 20,
      maxBudgetUsd: '2',
      timeoutMs: 600_000,
      runtimeEnvironmentId,
    };
  }

  async function makeReadyVersion(environmentId: string, suffix: string) {
    const version = await repo.enqueueRuntimeEnvironmentBuild(db, environmentId, 'base:test');
    if (!version) throw new Error('enqueue returned null');
    await repo.claimRuntimeEnvironmentBuild(db, version.id);
    const done = await repo.completeRuntimeEnvironmentBuild(db, version.id, {
      imageTag: `image:${suffix}`,
      imageId: `sha256:${suffix}`,
      baseImageId: `sha256:base-${suffix}`,
    });
    if (!done) throw new Error('complete returned null');
    return done;
  }

  afterAll(async () => {
    for (const id of agentIds) await db.delete(agents).where(eq(agents.id, id));
    for (const id of serverIds) await db.delete(servers).where(eq(servers.id, id));
    for (const id of environmentIds) {
      await db
        .update(runtimeEnvironments)
        .set({ onlineVersionId: null })
        .where(eq(runtimeEnvironments.id, id));
      await db
        .delete(runtimeEnvironmentVersions)
        .where(eq(runtimeEnvironmentVersions.environmentId, id));
      await db.delete(runtimeEnvironments).where(eq(runtimeEnvironments.id, id));
    }
    await pool.end();
  });

  it('creates with a TypeID, updates draft and rejects duplicate names', async () => {
    const environment = await makeEnvironment('basic');
    expect(environment.id).toMatch(/^rte_/);
    expect(isIdOfType(environment.id, 'runtimeEnvironment')).toBe(true);
    expect(environment.isDefault).toBe(false);
    expect(environment.onlineVersionId).toBeNull();

    const updated = await repo.updateRuntimeEnvironment(db, environment.id, {
      dockerfile: 'FROM alpine:3.24\n',
    });
    expect(updated?.dockerfile).toBe('FROM alpine:3.24\n');
    expect((await repo.getRuntimeEnvironment(db, environment.id))?.name).toBe(environment.name);
    expect((await repo.getRuntimeEnvironmentByName(db, environment.name))?.id).toBe(environment.id);
    expect((await repo.listRuntimeEnvironments(db)).some((row) => row.id === environment.id)).toBe(
      true,
    );

    await expect(
      repo.createRuntimeEnvironment(db, {
        name: environment.name,
        dockerfile: 'FROM alpine:3.24\n',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await repo.updateRuntimeEnvironment(db, newId('runtimeEnvironment'), { name: 'x' }),
    ).toBe(null);
  });

  it('builds one immutable version per build and publishes only ready versions', async () => {
    const environment = await makeEnvironment('build');
    expect(await repo.enqueueRuntimeEnvironmentBuild(db, newId('runtimeEnvironment'), 'base')).toBe(
      null,
    );

    const version = await repo.enqueueRuntimeEnvironmentBuild(db, environment.id, 'base:test');
    if (!version) throw new Error('enqueue returned null');
    expect(version.status).toBe('queued');
    expect(version.dockerfile).toBe('FROM scratch\n');
    expect(version.imageId).toBeNull();

    const claimed = await repo.claimRuntimeEnvironmentBuild(db, version.id);
    expect(claimed?.status).toBe('building');
    expect(await repo.claimRuntimeEnvironmentBuild(db, version.id)).toBeNull();

    await repo.appendRuntimeEnvironmentBuildLog(db, version.id, 'step 1\n');
    const done = await repo.completeRuntimeEnvironmentBuild(db, version.id, {
      imageTag: 'image:v1',
      imageId: 'sha256:v1',
      baseImageId: 'sha256:actual-base',
    });
    expect(done).toMatchObject({
      status: 'ready',
      imageTag: 'image:v1',
      imageId: 'sha256:v1',
      baseImageId: 'sha256:actual-base',
    });
    expect(
      await repo.completeRuntimeEnvironmentBuild(db, version.id, {
        imageTag: 'image:v1',
        imageId: 'sha256:v1',
        baseImageId: 'sha256:actual-base',
      }),
    ).toBeNull();

    const published = await repo.publishRuntimeEnvironmentVersion(db, environment.id, version.id);
    expect(published?.onlineVersionId).toBe(version.id);
    expect(await repo.resolveOnlineRuntimeEnvironment(db, environment.id)).toEqual({
      environmentId: environment.id,
      environmentName: environment.name,
      versionId: version.id,
      imageId: 'sha256:v1',
    });

    const detail = await repo.getRuntimeEnvironmentVersion(db, environment.id, version.id);
    expect(detail?.buildLog).toBe('step 1\n');
    const summaries = await repo.listRuntimeEnvironmentVersions(db, environment.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('buildLog');
    expect(summaries[0]).not.toHaveProperty('dockerfile');

    const failed = await repo.enqueueRuntimeEnvironmentBuild(db, environment.id, 'base:test');
    if (!failed) throw new Error('enqueue returned null');
    await repo.failRuntimeEnvironmentBuild(db, failed.id, 'compile failed');
    await expect(
      repo.publishRuntimeEnvironmentVersion(db, environment.id, failed.id),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repo.getRuntimeEnvironment(db, environment.id))?.onlineVersionId).toBe(
      version.id,
    );
  });

  it('keeps online pointers inside their own environment', async () => {
    const first = await makeEnvironment('owner');
    const second = await makeEnvironment('foreign');
    const foreignVersion = await makeReadyVersion(second.id, 'foreign');

    expect(await repo.getRuntimeEnvironmentVersion(db, first.id, foreignVersion.id)).toBeNull();
    await expect(
      repo.publishRuntimeEnvironmentVersion(db, first.id, foreignVersion.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // 直接写库也过不了复合外键：线上版本必须属于本环境。
    await expect(
      db
        .update(runtimeEnvironments)
        .set({ onlineVersionId: foreignVersion.id })
        .where(eq(runtimeEnvironments.id, first.id)),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('truncates oversized build logs and marks them', async () => {
    const environment = await makeEnvironment('logs');
    const version = await repo.enqueueRuntimeEnvironmentBuild(db, environment.id, 'base');
    if (!version) throw new Error('enqueue returned null');
    await repo.claimRuntimeEnvironmentBuild(db, version.id);
    const chunk = 'x'.repeat(60_000);
    await repo.appendRuntimeEnvironmentBuildLog(db, version.id, chunk);
    await repo.appendRuntimeEnvironmentBuildLog(db, version.id, chunk);
    await repo.appendRuntimeEnvironmentBuildLog(db, version.id, 'tail-marker\n');

    const detail = await repo.getRuntimeEnvironmentVersion(db, environment.id, version.id);
    expect(detail?.buildLog.length).toBe(repo.RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT);
    // 失败原因通常在最后：截断保留尾部而不是前缀。
    expect(detail?.buildLog.endsWith('tail-marker\n')).toBe(true);
    expect(detail?.logTruncated).toBe(true);
  });

  it('lists only queued and building versions for crash recovery', async () => {
    const environment = await makeEnvironment('pending');
    const queued = await repo.enqueueRuntimeEnvironmentBuild(db, environment.id, 'base:queued');
    const building = await repo.enqueueRuntimeEnvironmentBuild(db, environment.id, 'base:building');
    const ready = await makeReadyVersion(environment.id, 'pending-ready');
    if (!queued || !building) throw new Error('enqueue returned null');
    await repo.claimRuntimeEnvironmentBuild(db, building.id);
    await repo.failRuntimeEnvironmentBuild(db, ready.id, 'unused');

    const rows = await repo.listPendingRuntimeEnvironmentBuilds(db);
    const own = rows.filter((row) => row.id === queued.id || row.id === building.id);
    expect(own).toEqual(
      expect.arrayContaining([
        {
          id: queued.id,
          status: 'queued',
          createdAt: expect.any(Date),
          startedAt: null,
        },
        {
          id: building.id,
          status: 'building',
          createdAt: expect.any(Date),
          startedAt: expect.any(Date),
        },
      ]),
    );
    expect(rows.some((row) => row.id === ready.id)).toBe(false);
  });

  it('stores the resolved runtime environment on a server test snapshot', async () => {
    const id = newId('server');
    serverIds.push(id);
    const runtimeEnvironment = {
      environmentId: newId('runtimeEnvironment'),
      environmentName: 'snapshot-env',
      versionId: newId('runtimeEnvironmentVersion'),
      imageId: 'sha256:snapshot',
    };
    await db.insert(servers).values({
      id,
      name: uniqueName('server'),
      kind: 'stdio',
      config: {},
      lastTestRuntimeEnvironment: runtimeEnvironment,
    });

    const [row] = await db
      .select({ value: servers.lastTestRuntimeEnvironment })
      .from(servers)
      .where(eq(servers.id, id));
    expect(row?.value).toEqual(runtimeEnvironment);
  });

  it('refuses to delete default, bound or still-building environments', async () => {
    const bound = await makeEnvironment('bound');
    const agent = await createAgent(db, agentWrite(uniqueName('agent'), bound.id), [], [], [], []);
    agentIds.push(agent.id);
    expect(agent.runtimeEnvironmentId).toBe(bound.id);
    await expect(repo.deleteRuntimeEnvironment(db, bound.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await updateAgent(db, agent.id, { runtimeEnvironmentId: null });
    expect(await repo.deleteRuntimeEnvironment(db, bound.id)).toBe(true);
    expect(await repo.getRuntimeEnvironment(db, bound.id)).toBeNull();

    const building = await makeEnvironment('building');
    const version = await repo.enqueueRuntimeEnvironmentBuild(db, building.id, 'base');
    if (!version) throw new Error('enqueue returned null');
    await expect(repo.deleteRuntimeEnvironment(db, building.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await repo.failRuntimeEnvironmentBuild(db, version.id, 'cancelled');
    expect(await repo.deleteRuntimeEnvironment(db, building.id)).toBe(true);

    expect(await repo.deleteRuntimeEnvironment(db, newId('runtimeEnvironment'))).toBe(false);
  });

  it('registers the default environment once without following SANDBOX_IMAGE', async () => {
    const registered = await repo.ensureDefaultRuntimeEnvironment(db, {
      imageTag: 'base:one',
      imageId: 'sha256:base-one',
    });
    environmentIds.push(registered.id);
    expect(registered.isDefault).toBe(true);
    expect(registered.onlineVersionId).not.toBeNull();
    expect(await repo.resolveOnlineRuntimeEnvironment(db, null)).toEqual({
      environmentId: registered.id,
      environmentName: registered.name,
      versionId: registered.onlineVersionId,
      imageId: 'sha256:base-one',
    });
    // 默认版本记录的是实际基座 ID，不能把入队用的 tag 谎报成身份。
    const defaultVersion = await repo.getRuntimeEnvironmentVersion(
      db,
      registered.id,
      registered.onlineVersionId ?? '',
    );
    expect(defaultVersion).toMatchObject({
      baseImageId: 'sha256:base-one',
      imageTag: 'base:one',
      imageId: 'sha256:base-one',
    });

    const again = await repo.ensureDefaultRuntimeEnvironment(db, {
      imageTag: 'base:two',
      imageId: 'sha256:base-two',
    });
    expect(again.id).toBe(registered.id);
    expect(again.onlineVersionId).toBe(registered.onlineVersionId);
    await expect(repo.deleteRuntimeEnvironment(db, registered.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('keeps the environment binding across duplicate and version restore', async () => {
    const environment = await makeEnvironment('binding');
    const slug = uniqueName('agent');
    const agent = await createAgent(db, agentWrite(slug, environment.id), [], [], [], []);
    agentIds.push(agent.id);

    const clone = await duplicateAgent(db, agent.id, { slug: `${slug}-copy`, name: 'copy' });
    if (!clone) throw new Error('duplicate returned null');
    agentIds.push(clone.id);
    expect(clone.runtimeEnvironmentId).toBe(environment.id);
    expect((await getAgent(db, clone.id))?.runtimeEnvironmentId).toBe(environment.id);

    const version = await agentVersionsRepo.getAgentVersion(db, agent.id, 1);
    expect(version?.snapshot.runtimeEnvironmentId).toBe(environment.id);

    // 回滚就是把这些快照字段写回；绑定随版本保留。
    await updateAgent(db, agent.id, { runtimeEnvironmentId: null });
    expect((await getAgent(db, agent.id))?.runtimeEnvironmentId).toBeNull();
    await updateAgent(db, agent.id, {
      runtimeEnvironmentId: version?.snapshot.runtimeEnvironmentId ?? null,
    });
    expect((await getAgent(db, agent.id))?.runtimeEnvironmentId).toBe(environment.id);
  });
});
