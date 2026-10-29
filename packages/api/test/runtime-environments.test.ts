import type {
  RuntimeEnvironment,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { DEFAULT_RUNTIME_DOCKERFILE } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getRuntimeEnvironmentBuildQueue } from '../src/queue/producer.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

/** 与 repo 一致的内容 ID 形状；resolveOnline 只认非空 image_id。 */
function imageId(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

describe.skipIf(!ready)('runtime environments', () => {
  let app: FastifyInstance;
  let cookie: string;
  const envIds: string[] = [];
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) {
        await cleanup(app, { agentSlugs });
        if (envIds.length > 0) {
          // 复合外键：先清线上指针，再删版本，最后删环境。
          await app.pool.query(
            'update runtime_environments set online_version_id = null where id = any($1::text[])',
            [envIds],
          );
          await app.pool.query(
            'delete from runtime_environment_versions where environment_id = any($1::text[])',
            [envIds],
          );
          await app.pool.query('delete from runtime_environments where id = any($1::text[])', [
            envIds,
          ]);
          await app.pool.query('delete from audit_log where target = any($1::text[])', [envIds]);
        }
      }
    } finally {
      await app?.close();
    }
  });

  const auth = () => ({ cookie });

  async function createEnv(
    overrides: { name?: string; dockerfile?: string } = {},
  ): Promise<RuntimeEnvironment> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/runtime-environments',
      headers: auth(),
      payload: { name: overrides.name ?? unique('rtenv'), ...overrides },
    });
    expect(res.statusCode, res.body).toBe(201);
    const env = res.json<RuntimeEnvironment>();
    envIds.push(env.id);
    return env;
  }

  async function queueBuild(envId: string): Promise<RuntimeEnvironmentVersion> {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/runtime-environments/${envId}/versions`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json<RuntimeEnvironmentVersion>();
  }

  async function markReady(versionId: string, seed: string): Promise<void> {
    await app.pool.query(
      `update runtime_environment_versions
          set status = 'ready', image_tag = $2, image_id = $3, finished_at = now()
        where id = $1`,
      [versionId, `runtime-env-${versionId}`, imageId(seed)],
    );
  }

  async function publish(envId: string, versionId: string) {
    return inject(app, {
      method: 'PUT',
      url: `/api/runtime-environments/${envId}/online-version`,
      headers: auth(),
      payload: { versionId },
    });
  }

  it('requires authentication', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/runtime-environments' });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('creates, lists, patches and deletes an environment', async () => {
    const created = await createEnv();
    expect(created).toMatchObject({
      name: expect.stringMatching(/^rtenv-/),
      isDefault: false,
      onlineVersionId: null,
      dockerfile: DEFAULT_RUNTIME_DOCKERFILE,
    });

    const list = await inject(app, {
      method: 'GET',
      url: '/api/runtime-environments',
      headers: auth(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<RuntimeEnvironment[]>().some((env) => env.id === created.id)).toBe(true);

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/runtime-environments/${created.id}`,
      headers: auth(),
      payload: { name: `${created.name}-renamed`, dockerfile: 'FROM scratch\n' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<RuntimeEnvironment>()).toMatchObject({
      name: `${created.name}-renamed`,
      dockerfile: 'FROM scratch\n',
    });

    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/runtime-environments/${created.id}`,
      headers: auth(),
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const missing = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${created.id}`,
      headers: auth(),
    });
    expectProblem(missing, 'NOT_FOUND');
  });

  it('freezes the draft into an immutable version and does not publish automatically', async () => {
    const env = await createEnv({ dockerfile: 'FROM base:v1\nRUN echo one\n' });
    const version = await queueBuild(env.id);

    expect(version).toMatchObject({
      environmentId: env.id,
      dockerfile: 'FROM base:v1\nRUN echo one\n',
      status: 'queued',
      imageTag: null,
      imageId: null,
      error: null,
    });

    // 草稿后续修改不影响已经冻结的版本快照。
    await inject(app, {
      method: 'PATCH',
      url: `/api/runtime-environments/${env.id}`,
      headers: auth(),
      payload: { dockerfile: 'FROM base:v2\n' },
    });
    await markReady(version.id, 'a');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${env.id}/versions/${version.id}`,
      headers: auth(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<RuntimeEnvironmentVersion>()).toMatchObject({
      id: version.id,
      status: 'ready',
      dockerfile: 'FROM base:v1\nRUN echo one\n',
    });

    // 构建成功只产生 ready 版本，不改线上指针。
    const beforePublish = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${env.id}`,
      headers: auth(),
    });
    expect(beforePublish.json<RuntimeEnvironment>().onlineVersionId).toBeNull();

    const published = await publish(env.id, version.id);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<RuntimeEnvironment>().onlineVersionId).toBe(version.id);
  });

  it('publishes and rolls back through the same endpoint', async () => {
    const env = await createEnv();
    const first = await queueBuild(env.id);
    const second = await queueBuild(env.id);
    await markReady(first.id, 'b');
    await markReady(second.id, 'c');

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${env.id}/versions`,
      headers: auth(),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    const summaries = versions.json<RuntimeEnvironmentVersionSummary[]>();
    expect(summaries.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(summaries[0]).not.toHaveProperty('dockerfile');
    expect(summaries[0]).not.toHaveProperty('buildLog');

    expect((await publish(env.id, first.id)).json<RuntimeEnvironment>().onlineVersionId).toBe(
      first.id,
    );
    expect((await publish(env.id, second.id)).json<RuntimeEnvironment>().onlineVersionId).toBe(
      second.id,
    );
    // 回退：把指针移回旧版本，版本历史保持不变。
    expect((await publish(env.id, first.id)).json<RuntimeEnvironment>().onlineVersionId).toBe(
      first.id,
    );
  });

  it('rejects failed and cross-environment versions without moving the pointer', async () => {
    const envA = await createEnv();
    const readyVersion = await queueBuild(envA.id);
    await markReady(readyVersion.id, 'd');
    expect((await publish(envA.id, readyVersion.id)).statusCode).toBe(200);

    const envB = await createEnv();
    const failedVersion = await queueBuild(envB.id);
    await app.pool.query(
      `update runtime_environment_versions
          set status = 'failed', error = 'base image missing', finished_at = now()
        where id = $1`,
      [failedVersion.id],
    );

    // 失败构建永远不能上线。
    expectProblem(await publish(envB.id, failedVersion.id), 'CONFLICT');
    // 跨环境版本不能挂到别的环境上。
    expectProblem(await publish(envA.id, failedVersion.id), 'NOT_FOUND');

    const envAfter = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${envA.id}`,
      headers: auth(),
    });
    expect(envAfter.json<RuntimeEnvironment>().onlineVersionId).toBe(readyVersion.id);
  });

  it('blocks deleting the default, bound and building environments', async () => {
    const defaultEnv = await createEnv();
    await app.pool.query('update runtime_environments set is_default = true where id = $1', [
      defaultEnv.id,
    ]);
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/runtime-environments/${defaultEnv.id}`,
        headers: auth(),
      }),
      'CONFLICT',
    );

    const boundEnv = await createEnv();
    const version = await queueBuild(boundEnv.id);
    await markReady(version.id, 'e');
    await publish(boundEnv.id, version.id);
    const slug = unique('rtenv-agent');
    agentSlugs.push(slug);
    const agent = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Bound agent', runtimeEnvironmentId: boundEnv.id },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/runtime-environments/${boundEnv.id}`,
        headers: auth(),
      }),
      'CONFLICT',
    );

    const buildingEnv = await createEnv();
    await queueBuild(buildingEnv.id);
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/runtime-environments/${buildingEnv.id}`,
        headers: auth(),
      }),
      'CONFLICT',
    );
  });

  it('validates agent bindings explicitly instead of silently falling back', async () => {
    const slug = unique('rtenv-bind');
    agentSlugs.push(slug);

    const missing = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Missing env', runtimeEnvironmentId: 'rte_missing' },
    });
    expectProblem(missing, 'INVALID_INPUT');

    const offline = await createEnv();
    const noOnline = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Offline env', runtimeEnvironmentId: offline.id },
    });
    expectProblem(noOnline, 'INVALID_INPUT');

    const version = await queueBuild(offline.id);
    await markReady(version.id, 'f');
    await publish(offline.id, version.id);
    const bound = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: 'Bound env', runtimeEnvironmentId: offline.id },
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const agent = bound.json<{ id: string; runtimeEnvironmentId: string | null }>();
    expect(agent.runtimeEnvironmentId).toBe(offline.id);

    const unbound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { runtimeEnvironmentId: null },
    });
    expect(unbound.statusCode, unbound.body).toBe(200);
    expect(unbound.json<{ runtimeEnvironmentId: string | null }>().runtimeEnvironmentId).toBeNull();

    const rebindMissing = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { runtimeEnvironmentId: 'rte_missing' },
    });
    expectProblem(rebindMissing, 'INVALID_INPUT');
  });

  it('marks the version failed with a readable error when enqueueing fails', async () => {
    const env = await createEnv();
    const queue = getRuntimeEnvironmentBuildQueue();
    const add = vi
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('redis://:secret@127.0.0.1:1 refused'));
    let res: Awaited<ReturnType<typeof inject>>;
    try {
      res = await inject(app, {
        method: 'POST',
        url: `/api/runtime-environments/${env.id}/versions`,
        headers: auth(),
      });
    } finally {
      add.mockRestore();
    }

    expectProblem(res, 'SERVICE_UNAVAILABLE');
    expect(res.body).not.toContain('redis://');

    // 不能留下永远 queued 的假构建。
    const versions = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${env.id}/versions`,
      headers: auth(),
    });
    const [failed] = versions.json<RuntimeEnvironmentVersionSummary[]>();
    if (!failed) throw new Error('failed build version was not recorded');
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('入队失败');
    expect(failed.imageId).toBeNull();

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/runtime-environments/${env.id}/versions/${failed.id}`,
      headers: auth(),
    });
    expect(detail.json<RuntimeEnvironmentVersion>().dockerfile).toBe(DEFAULT_RUNTIME_DOCKERFILE);
  });
});
