import { newId } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import { AGENT_PACKAGE_SIDECAR, DEFAULT_RUNTIME_DOCKERFILE } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePackage } from '../src/features/agent-package-zip.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import { unzipPackage } from './package-fixtures.js';

const ready = await infraReady;

interface ImportResult {
  agent: Agent;
  warnings: string[];
}

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

describe.skipIf(!ready)('agent package runtime environment binding', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const environmentIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    if (environmentIds.length > 0) {
      await app.pool.query('delete from agents where runtime_environment_id = any($1::text[])', [
        environmentIds,
      ]);
      // 先断开线上指针，复合外键才允许删除版本。
      await app.pool.query(
        'update runtime_environments set online_version_id = null where id = any($1::text[])',
        [environmentIds],
      );
      await app.pool.query(
        'delete from runtime_environment_versions where environment_id = any($1::text[])',
        [environmentIds],
      );
      await app.pool.query('delete from runtime_environments where id = any($1::text[])', [
        environmentIds,
      ]);
    }
    await app.close();
  });

  /** 直接落一个已发布环境：导入/绑定只需要环境行与可解析的线上版本。 */
  const createEnvironment = async (
    withOnlineVersion = true,
  ): Promise<{ id: string; name: string }> => {
    const id = newId('runtimeEnvironment');
    const name = unique('env');
    environmentIds.push(id);
    await app.pool.query(
      'insert into runtime_environments (id, name, dockerfile) values ($1, $2, $3)',
      [id, name, DEFAULT_RUNTIME_DOCKERFILE],
    );
    if (!withOnlineVersion) return { id, name };
    const versionId = newId('runtimeEnvironmentVersion');
    await app.pool.query(
      `insert into runtime_environment_versions
         (id, environment_id, dockerfile, base_image_id, status, image_tag, image_id, finished_at)
       values ($1, $2, $3, $4, 'ready', $4, $5, now())`,
      [versionId, id, DEFAULT_RUNTIME_DOCKERFILE, name, IMAGE_ID],
    );
    await app.pool.query('update runtime_environments set online_version_id = $2 where id = $1', [
      id,
      versionId,
    ]);
    return { id, name };
  };

  const createBoundAgent = async (runtimeEnvironmentId: string | null): Promise<Agent> => {
    const slug = unique('agent');
    agentSlugs.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug,
        name: `Agent ${slug}`,
        systemPrompt: 'prompt',
        runtimeEnvironmentId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Agent>();
  };

  const exportFiles = async (agentId: string): Promise<Map<string, string>> => {
    const res = await injectZip(app, 'GET', `/api/export/agents/${agentId}`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return unzipPackage(res.rawPayload);
  };

  const importZip = (files: Map<string, string>, query = '') =>
    injectZip(
      app,
      'POST',
      `/api/import/agents${query}`,
      cookie,
      encodePackage(Object.fromEntries(files)),
    );

  const sidecarOf = (
    files: Map<string, string>,
  ): {
    agent: { slug: string; runtimeEnvironmentName?: string };
  } => JSON.parse(files.get(AGENT_PACKAGE_SIDECAR) ?? '{}');

  /** 导入会占用包 slug，重复时改用 slug-2 等；只数这一族，避免并行套件新增的智能体干扰全表计数。 */
  const countPackageAgents = async (slug: string): Promise<number> => {
    const rows = await app.pool.query<{ count: string }>(
      'select count(*) from agents where slug = $1 or slug like $2',
      [slug, `${slug.slice(0, 60)}-%`],
    );
    return Number(rows.rows[0]?.count);
  };

  it('exports only the environment name and imports into the same-name environment', async () => {
    const environment = await createEnvironment();
    const agent = await createBoundAgent(environment.id);

    const files = await exportFiles(agent.id);
    const sidecar = sidecarOf(files);
    expect(sidecar.agent.runtimeEnvironmentName).toBe(environment.name);
    // 镜像与版本历史不随包导出。
    const contents = [...files.values()].join('\n');
    expect(contents).not.toContain(environment.id);
    expect(contents).not.toContain(IMAGE_ID);

    const res = await importZip(files);
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json<ImportResult>();
    agentSlugs.push(result.agent.slug);
    expect(result.agent.runtimeEnvironmentId).toBe(environment.id);
  });

  it('maps explicitly to the selected target environment instead of the package name', async () => {
    const source = await createEnvironment();
    const target = await createEnvironment();
    const agent = await createBoundAgent(source.id);
    const files = await exportFiles(agent.id);

    const res = await importZip(files, `?runtimeEnvironmentId=${target.id}`);
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json<ImportResult>();
    agentSlugs.push(result.agent.slug);
    expect(result.agent.runtimeEnvironmentId).toBe(target.id);
  });

  it('fails clearly when the explicitly selected environment does not exist', async () => {
    const environment = await createEnvironment();
    const agent = await createBoundAgent(environment.id);
    const files = await exportFiles(agent.id);

    const res = await importZip(files, `?runtimeEnvironmentId=${newId('runtimeEnvironment')}`);
    const problem = expectProblem(res, 'INVALID_REFERENCE');
    expect(problem.message).toContain('不存在');
  });

  it('fails clearly when the package environment is missing, without falling back to default', async () => {
    const environment = await createEnvironment();
    const agent = await createBoundAgent(environment.id);
    const files = await exportFiles(agent.id);
    const sidecar = sidecarOf(files);
    const missing = unique('missing-env');
    sidecar.agent.runtimeEnvironmentName = missing;
    files.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);

    const countBefore = await countPackageAgents(sidecar.agent.slug);
    expect(countBefore).toBe(1);
    const res = await importZip(files);
    const problem = expectProblem(res, 'INVALID_REFERENCE');
    expect(problem.message).toContain(missing);

    expect(await countPackageAgents(sidecar.agent.slug)).toBe(countBefore);
  });

  it('leaves the agent on the platform default environment when the package has no reference', async () => {
    const agent = await createBoundAgent(null);
    const files = await exportFiles(agent.id);
    expect(sidecarOf(files).agent.runtimeEnvironmentName).toBeUndefined();

    const res = await importZip(files);
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json<ImportResult>();
    agentSlugs.push(result.agent.slug);
    expect(result.agent.runtimeEnvironmentId).toBeNull();
  });

  it('rejects an environment without an online version and never starts a build', async () => {
    const environment = await createEnvironment(false);
    const agent = await createBoundAgent(null);
    const files = await exportFiles(agent.id);
    const sidecar = sidecarOf(files);
    sidecar.agent.runtimeEnvironmentName = environment.name;
    files.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);

    const res = await importZip(files);
    const problem = expectProblem(res, 'INVALID_REFERENCE');
    expect(problem.message).toContain('线上版本');

    const versions = await app.pool.query<{ count: string }>(
      'select count(*) from runtime_environment_versions where environment_id = $1',
      [environment.id],
    );
    expect(versions.rows[0]?.count).toBe('0');
  });
});
