import { pluginsContract } from '@agentport/contract/plugins';
import { fail } from '@agentport/core';
import { repo as pluginRepo } from '@agentport/db';
import type { NativeInstalledPlugin, PluginWithAgentCount } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { toApi } from './api.js';
import { runNativePluginAction } from './native.js';
import { adoptNativePlugin, reusedPlugin } from './use-cases.js';

const repo = pluginRepo.plugins;
function notFound() {
  return fail('NOT_FOUND', '插件不存在，可能已被删除；请刷新后重试');
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
  list: os.list.handler(async ({ context }) => {
    const rows = await repo.listPlugins(context.db);
    return rows.map(
      (row): PluginWithAgentCount => ({
        ...toApi(row, []),
        agentCount: row.agentCount,
      }),
    );
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
      { db: context.db, log: context.log, actor: actorOf(context), requestId: context.requestId },
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
    if (existing) return { status: 200, body: await reusedPlugin(context.db, existing) };
    const output = await runNativePluginAction(context.config.REDIS_URL, context.log, {
      action: 'read',
      pluginId,
    });
    if (!output.ok) return nativeFailure(output.error);
    if (!('files' in output)) {
      return fail('UPSTREAM_FAILED', '读取器没有返回插件文件，请稍后重试');
    }
    const body = await adoptNativePlugin(
      { db: context.db, log: context.log, actor: actorOf(context), requestId: context.requestId },
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
    const row = await repo.getPlugin(context.db, routeInput.params.id);
    if (!row) return notFound();
    const files = await repo.listPluginFiles(context.db, row.id);
    return toApi(
      row,
      files.map((file) => ({
        path: file.path,
        content: file.content,
        executable: file.executable,
      })),
    );
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
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
      if (row === null) return notFound();
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
    const deleted = await repo.deletePlugin(context.db, routeInput.params.id);
    if (!deleted) return notFound();
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
