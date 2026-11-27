import { runtimeEnvironmentsContract } from '@agentport/contract/runtime-environments';
import { fail, NOT_FOUND_MESSAGES } from '@agentport/core';
import { repo } from '@agentport/db';
import type { PermissionId, ResourceAccessLevel } from '@agentport/shared';
import { implement } from '@orpc/server';
import { authorizeResourceAccess, requireUser, resourceAccessFilter } from '../../http/access.js';
import { actorOf, type RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { requestRuntimeEnvironmentBuild } from './use-cases.js';

const os = implement(runtimeEnvironmentsContract).$context<RequestContext>();
const envs = repo.runtimeEnvironments;

async function authorizedEnvironment(
  context: RequestContext,
  id: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
): Promise<repo.runtimeEnvironments.RuntimeEnvironmentRow> {
  const row = await envs.getRuntimeEnvironmentRow(context.db, id);
  if (!row) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
  await authorizeResourceAccess(
    context,
    permissionId,
    {
      kind: 'runtime_environment',
      resourceId: row.id,
      ownerBusinessId: row.ownerBusinessId,
      level,
    },
    NOT_FOUND_MESSAGES.runtimeEnvironment,
  );
  return row;
}

export const runtimeEnvironmentsRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const access = await resourceAccessFilter(
      context,
      'runtime_environments.read',
      'runtime_environment',
      'read',
    );
    return requireCursorPage(
      await envs.listRuntimeEnvironmentPage(context.db, {
        access,
        ...cursorOption(input.query.cursor),
        limit: input.query.limit,
      }),
    );
  }),

  create: os.create.handler(async ({ input, context }) => {
    const env = await envs.createRuntimeEnvironment(
      context.db,
      input.body,
      requireUser(context).businessId,
    );
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
    const row = await authorizedEnvironment(
      context,
      input.params.id,
      'runtime_environments.read',
      'read',
    );
    return envs.toRuntimeEnvironment(row);
  }),

  update: os.update.handler(async ({ input, context }) => {
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.update', 'manage');
    const env = await envs.updateRuntimeEnvironment(context.db, input.params.id, input.body);
    if (!env) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
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
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.delete', 'manage');
    const ok = await envs.deleteRuntimeEnvironment(context.db, input.params.id);
    if (!ok) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
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
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.read', 'read');
    return envs.listRuntimeEnvironmentVersions(context.db, input.params.id);
  }),

  build: os.build.handler(async ({ input, context }) => {
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.build', 'manage');
    const version = await requestRuntimeEnvironmentBuild(
      context.db,
      context.config,
      context.log,
      input.params.id,
    );
    if (!version) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
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
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.read', 'read');
    const version = await envs.getRuntimeEnvironmentVersion(
      context.db,
      input.params.id,
      input.params.versionId,
    );
    if (!version) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironmentVersion);
    return version;
  }),

  publish: os.publish.handler(async ({ input, context }) => {
    await authorizedEnvironment(context, input.params.id, 'runtime_environments.publish', 'manage');
    const env = await envs.publishRuntimeEnvironmentVersion(
      context.db,
      input.params.id,
      input.body.versionId,
    );
    if (!env) fail('NOT_FOUND', NOT_FOUND_MESSAGES.runtimeEnvironment);
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
