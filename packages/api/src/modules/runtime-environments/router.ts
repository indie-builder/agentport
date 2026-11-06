import { runtimeEnvironmentsContract } from '@agentport/contract/runtime-environments';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { requestRuntimeEnvironmentBuild } from './use-cases.js';

const os = implement(runtimeEnvironmentsContract).$context<RequestContext>();
const envs = repo.runtimeEnvironments;

const notFoundMessage = '运行环境不存在，可能已被删除；请刷新后重试';
const versionNotFoundMessage = '该构建版本不存在，可能已被清理；请刷新版本列表';

export const runtimeEnvironmentsRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    return envs.listRuntimeEnvironments(context.db);
  }),

  create: os.create.handler(async ({ input, context }) => {
    const env = await envs.createRuntimeEnvironment(context.db, input.body);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'runtime_environment.created',
      target: env.id,
      input: { name: env.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return env;
  }),

  detail: os.detail.handler(async ({ input, context }) => {
    const env = await envs.getRuntimeEnvironment(context.db, input.params.id);
    if (!env) fail('NOT_FOUND', notFoundMessage);
    return env;
  }),

  update: os.update.handler(async ({ input, context }) => {
    const env = await envs.updateRuntimeEnvironment(context.db, input.params.id, input.body);
    if (!env) fail('NOT_FOUND', notFoundMessage);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'runtime_environment.updated',
      target: env.id,
      input: { name: env.name },
      status: 'ok',
      requestId: context.requestId,
    });
    return env;
  }),

  remove: os.remove.handler(async ({ input, context }) => {
    const ok = await envs.deleteRuntimeEnvironment(context.db, input.params.id);
    if (!ok) fail('NOT_FOUND', notFoundMessage);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'runtime_environment.deleted',
      target: input.params.id,
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),

  versions: os.versions.handler(async ({ input, context }) => {
    if (!(await envs.getRuntimeEnvironment(context.db, input.params.id))) {
      fail('NOT_FOUND', notFoundMessage);
    }
    return envs.listRuntimeEnvironmentVersions(context.db, input.params.id);
  }),

  build: os.build.handler(async ({ input, context }) => {
    const version = await requestRuntimeEnvironmentBuild(
      context.db,
      context.config,
      context.log,
      input.params.id,
    );
    if (!version) fail('NOT_FOUND', notFoundMessage);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'runtime_environment.build.requested',
      target: input.params.id,
      input: { versionId: version.id },
      status: 'ok',
      requestId: context.requestId,
    });
    return version;
  }),

  versionDetail: os.versionDetail.handler(async ({ input, context }) => {
    const version = await envs.getRuntimeEnvironmentVersion(
      context.db,
      input.params.id,
      input.params.versionId,
    );
    if (!version) fail('NOT_FOUND', versionNotFoundMessage);
    return version;
  }),

  publish: os.publish.handler(async ({ input, context }) => {
    const env = await envs.publishRuntimeEnvironmentVersion(
      context.db,
      input.params.id,
      input.body.versionId,
    );
    if (!env) fail('NOT_FOUND', notFoundMessage);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'runtime_environment.published',
      target: env.id,
      input: { versionId: input.body.versionId },
      status: 'ok',
      requestId: context.requestId,
    });
    return env;
  }),
});
