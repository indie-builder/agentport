import { repo } from '@agentport/db';
import {
  idParams,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  runtimeEnvironmentInputSchema,
  runtimeEnvironmentOnlineVersionInputSchema,
  runtimeEnvironmentPatchSchema,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { getRuntimeEnvironmentBuildQueue } from '../../queue/producer.js';
import { typed } from '../../types.js';

const versionParams = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
});

function notFound(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', '运行环境不存在，可能已被删除；请刷新后重试');
}

function versionNotFound(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', '该构建版本不存在，可能已被清理；请刷新版本列表');
}

/** 构建任务失败不自动重试：jobId=versionId 保证重复投递同一次构建不会多跑一份。 */
const buildJobOptions = (versionId: string) => ({
  jobId: versionId,
  attempts: 1,
  removeOnComplete: 100,
  removeOnFail: 200,
});

export function registerRuntimeEnvironmentRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };
  const envs = repo.runtimeEnvironments;

  app.get('/api/runtime-environments', auth, async () => envs.listRuntimeEnvironments(app.db));

  app.post(
    '/api/runtime-environments',
    { ...auth, schema: { body: runtimeEnvironmentInputSchema } },
    async (request, reply) => {
      const env = await envs.createRuntimeEnvironment(app.db, request.body);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'runtime_environment.created',
        target: env.id,
        input: { name: env.name },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(env);
    },
  );

  app.get(
    '/api/runtime-environments/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const env = await envs.getRuntimeEnvironment(app.db, request.params.id);
      return env ?? notFound(reply);
    },
  );

  app.patch(
    '/api/runtime-environments/:id',
    { ...auth, schema: { params: idParams, body: runtimeEnvironmentPatchSchema } },
    async (request, reply) => {
      const env = await envs.updateRuntimeEnvironment(app.db, request.params.id, request.body);
      if (!env) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'runtime_environment.updated',
        target: env.id,
        input: { name: env.name },
        status: 'ok',
        requestId: request.id,
      });
      return env;
    },
  );

  app.delete(
    '/api/runtime-environments/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const ok = await envs.deleteRuntimeEnvironment(app.db, request.params.id);
      if (!ok) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'runtime_environment.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/runtime-environments/:id/versions',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      if (!(await envs.getRuntimeEnvironment(app.db, request.params.id))) return notFound(reply);
      return envs.listRuntimeEnvironmentVersions(app.db, request.params.id);
    },
  );

  /**
   * 一次构建 = 一个不可覆盖版本：入队时把当前 Dockerfile 冻进版本行。
   * 构建成功也不改线上指针，发布/回退统一走 online-version。
   */
  app.post(
    '/api/runtime-environments/:id/versions',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const version = await envs.enqueueRuntimeEnvironmentBuild(
        app.db,
        request.params.id,
        app.config.SANDBOX_IMAGE,
      );
      if (!version) return notFound(reply);
      try {
        await getRuntimeEnvironmentBuildQueue().add(
          'build',
          { versionId: version.id },
          buildJobOptions(version.id),
        );
      } catch {
        // 入队失败必须落真实终态，不能留下永远 queued 的假构建。
        await envs
          .failRuntimeEnvironmentBuild(app.db, version.id, '构建任务入队失败，请稍后重试')
          .catch(() => null);
        request.log.warn(
          { environmentId: request.params.id, versionId: version.id },
          `runtime environment build enqueue failed (queue ${RUNTIME_ENVIRONMENT_BUILDS_QUEUE})`,
        );
        return reject(reply, 'SERVICE_UNAVAILABLE', '构建任务入队失败，请稍后重试');
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'runtime_environment.build.requested',
        target: request.params.id,
        input: { versionId: version.id },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(202).send(version);
    },
  );

  app.get(
    '/api/runtime-environments/:id/versions/:versionId',
    { ...auth, schema: { params: versionParams } },
    async (request, reply) => {
      const version = await envs.getRuntimeEnvironmentVersion(
        app.db,
        request.params.id,
        request.params.versionId,
      );
      return version ?? versionNotFound(reply);
    },
  );

  // 发布与回退同一个接口：只移动线上指针，存活容器不受影响。
  app.put(
    '/api/runtime-environments/:id/online-version',
    { ...auth, schema: { params: idParams, body: runtimeEnvironmentOnlineVersionInputSchema } },
    async (request, reply) => {
      const env = await envs.publishRuntimeEnvironmentVersion(
        app.db,
        request.params.id,
        request.body.versionId,
      );
      // 失败版本/跨环境由 repo 抛 409/404；null 只剩环境不存在。
      if (!env) return notFound(reply);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'runtime_environment.published',
        target: env.id,
        input: { versionId: request.body.versionId },
        status: 'ok',
        requestId: request.id,
      });
      return env;
    },
  );
}
