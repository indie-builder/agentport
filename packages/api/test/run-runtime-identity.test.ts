import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface RuntimeIdentity {
  environmentId: string;
  environmentName: string;
  versionId: string;
  imageId: string;
}

interface RunDetailBody {
  run: { runtimeEnvironment: RuntimeIdentity | null };
}

describe.skipIf(!ready)('run runtime environment identity', () => {
  let app: FastifyInstance;
  let cookie: string;
  let agentId: string;
  let environmentId: string;
  let oldVersionId: string;
  let startedRunId: string;
  let queuedRunId: string;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    const agent = (await createAgent(app, cookie, { track: agentSlugs })).json<{ id: string }>();
    agentId = agent.id;

    environmentId = unique('rt-identity-env');
    oldVersionId = unique('rt-identity-version');
    const onlineVersionId = unique('rt-identity-online');
    await app.pool.query('insert into runtime_environments (id, name) values ($1, $2)', [
      environmentId,
      environmentId,
    ]);
    await app.pool.query(
      `insert into runtime_environment_versions
         (id, environment_id, dockerfile, base_image_id, status, image_id)
       values ($1, $3, 'FROM scratch', 'base:test', 'ready', $2),
              ($4, $3, 'FROM scratch', 'base:test', 'ready', $5)`,
      [
        oldVersionId,
        `sha256:${'1'.repeat(64)}`,
        environmentId,
        onlineVersionId,
        `sha256:${'2'.repeat(64)}`,
      ],
    );
    await app.pool.query('update runtime_environments set online_version_id = $1 where id = $2', [
      onlineVersionId,
      environmentId,
    ]);
    await app.pool.query('update agents set runtime_environment_id = $1 where id = $2', [
      environmentId,
      agentId,
    ]);

    const conversationId = unique('rt-identity-conv');
    startedRunId = unique('rt-identity-run');
    queuedRunId = unique('rt-identity-queued');
    runIds.push(startedRunId, queuedRunId);
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      agentId,
    ]);
    await app.pool.query(
      `insert into agent_runs
         (id, conversation_id, agent_id, status, runtime_environment_id,
          runtime_environment_name, runtime_environment_version_id, runtime_environment_image_id)
       values ($1, $2, $3, 'succeeded', $4, $5, $6, $7),
              ($8, $2, $3, 'queued', null, null, null, null)`,
      [
        startedRunId,
        conversationId,
        agentId,
        environmentId,
        '旧环境',
        oldVersionId,
        `sha256:${'1'.repeat(64)}`,
        queuedRunId,
      ],
    );
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, runIds });
    await app.pool.query('update runtime_environments set online_version_id = null where id = $1', [
      environmentId,
    ]);
    await app.pool.query('delete from runtime_environment_versions where environment_id = $1', [
      environmentId,
    ]);
    await app.pool.query('delete from runtime_environments where id = $1', [environmentId]);
    await app.close();
  });

  async function detail(runId: string): Promise<RuntimeIdentity | null> {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<RunDetailBody>().run.runtimeEnvironment;
  }

  it('returns the identity stored on the run, not the environment online pointer', async () => {
    expect(await detail(startedRunId)).toEqual({
      environmentId,
      environmentName: '旧环境',
      versionId: oldVersionId,
      imageId: `sha256:${'1'.repeat(64)}`,
    });
  });

  it('returns null before the run has created a container', async () => {
    expect(await detail(queuedRunId)).toBeNull();
  });
});
