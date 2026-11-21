import { pluginsContract } from '@agentport/contract/plugins';
import { fail, NOT_FOUND_MESSAGES } from '@agentport/core';
import { repo as pluginRepo } from '@agentport/db';
import type {
  NativeInstalledPlugin,
  PermissionId,
  PluginWithAgentCount,
  ResourceAccessLevel,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import {
  actorOf,
  authorizeResourceAccess,
  requireUser,
  resourceAccessFilter,
} from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { requireCursorPage } from '../../http/pagination.js';
import { pluginFiles, toApi } from './api.js';
import { runNativePluginAction } from './native.js';
import { adoptNativePlugin, reusedPlugin } from './use-cases.js';

const repo = pluginRepo.plugins;
async function requirePlugin(
  context: RequestContext,
  id: string,
  permissionId: PermissionId,
  level: ResourceAccessLevel,
) {
  const row = await repo.getPlugin(context.db, id);
  if (!row) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.plugin);
  await authorizeResourceAccess(
    context,
    permissionId,
    { kind: 'plugin', resourceId: row.id, ownerBusinessId: row.ownerBusinessId, level },
    NOT_FOUND_MESSAGES.plugin,
  );
  return row;
}
function nativeFailure(error: string) {
  const unavailable = /无法启动|沙盒|安装缓存|docker|Docker|镜像|worker/i.test(error);
  return fail(unavailable ? 'SERVICE_UNAVAILABLE' : 'INVALID_INPUT', error);
}
function nameOfPluginId(pluginId: string): string {
  return pluginId.split('@')[0] ?? pluginId;
}
const os = implement(pluginsContract).$context<RequestContext>();
export const pluginsRouter = os.router({
  list: os.list.handler(async ({ context, input: routeInput }) => {
    const access = await resourceAccessFilter(context, 'plugins.read', 'plugin', 'read');
    const { cursor, limit } = routeInput.query;
    const page = requireCursorPage(await repo.listPlugins(context.db, { access, limit, cursor }));
    return {
      items: page.items.map(
        (row): PluginWithAgentCount => ({
          ...toApi(row, []),
          agentCount: row.agentCount,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }),
  native: os.native.handler(async ({ context }) => {
    const output = await runNativePluginAction(context.config.REDIS_URL, context.log, {
      action: 'list',
    });
    if (!output.ok) return nativeFailure(output.error);
    if (!('installed' in output)) {
      return fail('UPSTREAM_FAILED', '安装器没有返回已安装列表，请稍后重试');
    }
    const importedSourceIds = await repo.getImportedPluginSourceIds(
      context.db,
      output.installed.map((plugin) => plugin.pluginId),
    );
    const installed: Array<
      NativeInstalledPlugin & {
        imported: boolean;
      }
    > = output.installed.map((plugin) => ({
      ...plugin,
      imported: importedSourceIds.has(plugin.pluginId),
    }));
    return { installed };
  }),
  install: os.install.handler(async ({ context, input: routeInput }) => {
    const { marketplace, plugin, slug } = routeInput.body;
    const output = await runNativePluginAction(context.config.REDIS_URL, context.log, {
      action: 'install',
      marketplace,
      plugin,
    });
    if (!output.ok) return nativeFailure(output.error);
    if (!('files' in output)) {
      return fail('UPSTREAM_FAILED', '安装器没有返回插件文件，请稍后重试');
    }
    const body = await adoptNativePlugin(
      {
        context,
        db: context.db,
        log: context.log,
        actor: actorOf(context),
        ownerBusinessId: requireUser(context).businessId,
        requestId: context.requestId,
      },
      {
        slug: slug ?? nameOfPluginId(output.plugin.pluginId),
        pluginId: output.plugin.pluginId,
        files: output.files,
        action: 'plugin.installed',
      },
    );
    return { status: body.reused ? 200 : 201, body };
  }),
  importNative: os.importNative.handler(async ({ context, input: routeInput }) => {
    const { pluginId, slug } = routeInput.body;
    const existing = await repo.getPluginBySourceId(context.db, pluginId);
    if (existing) {
      await authorizeResourceAccess(
        context,
        'plugins.read',
        {
          kind: 'plugin',
          resourceId: existing.id,
          ownerBusinessId: existing.ownerBusinessId,
          level: 'read',
        },
        NOT_FOUND_MESSAGES.plugin,
      );
      return { status: 200, body: await reusedPlugin(context.db, existing) };
    }
    const output = await runNativePluginAction(context.config.REDIS_URL, context.log, {
      action: 'read',
      pluginId,
    });
    if (!output.ok) return nativeFailure(output.error);
    if (!('files' in output)) {
      return fail('UPSTREAM_FAILED', '读取器没有返回插件文件，请稍后重试');
    }
    const body = await adoptNativePlugin(
      {
        context,
        db: context.db,
        log: context.log,
        actor: actorOf(context),
        ownerBusinessId: requireUser(context).businessId,
        requestId: context.requestId,
      },
      {
        slug: slug ?? nameOfPluginId(output.plugin.pluginId),
        pluginId: output.plugin.pluginId,
        files: output.files,
        action: 'plugin.adopted',
      },
    );
    return { status: body.reused ? 200 : 201, body };
  }),
  get: os.get.handler(async ({ context, input: routeInput }) => {
    const { id } = routeInput.params;
    await requirePlugin(context, id, 'plugins.read', 'read');
    const row = await repo.getPluginWithAgentCount(context.db, id);
    if (row === null) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.plugin);
    const files = await pluginFiles(context.db, row.id);
    return { ...toApi(row, files), agentCount: row.agentCount };
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
    await requirePlugin(context, routeInput.params.id, 'plugins.update', 'manage');
    const { expectedUpdatedAt, ...patch } = routeInput.body;
    try {
      const row = await repo.updatePluginMeta(
        context.db,
        routeInput.params.id,
        {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.version === undefined ? {} : { version: patch.version }),
        },
        expectedUpdatedAt === undefined ? undefined : new Date(expectedUpdatedAt),
      );
      if (row === null) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.plugin);
      await pluginRepo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'plugin.updated',
        target: row.id,
        input: patch,
        status: 'ok',
        requestId: context.requestId,
      });
      const files = await repo.listPluginFiles(context.db, row.id);
      return toApi(
        row,
        files.map((file) => ({
          path: file.path,
          content: file.content,
          executable: file.executable,
        })),
      );
    } catch (err) {
      if (isPgCode(err, '23505')) {
        return fail('CONFLICT', '插件名或版本与已有插件冲突');
      }
      throw err;
    }
  }),
  delete: os.delete.handler(async ({ context, input: routeInput }) => {
    await requirePlugin(context, routeInput.params.id, 'plugins.delete', 'manage');
    const deleted = await repo.deletePlugin(context.db, routeInput.params.id);
    if (!deleted) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.plugin);
    await pluginRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'plugin.deleted',
      target: routeInput.params.id,
      input: {},
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
});
