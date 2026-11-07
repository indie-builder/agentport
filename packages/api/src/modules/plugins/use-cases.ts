import { fail } from '@agentport/core';
import { repo as pluginRepo } from '@agentport/db';
import type { PluginFileInput } from '@agentport/shared';
import type { Logger } from 'pino';
import { isPgCode } from '../../http/errors.js';
import { type Db, type PluginRow, pluginFiles, toApi, toPluginWrite } from './api.js';
import { parsePluginFiles } from './parse.js';

const repo = pluginRepo.plugins;
type PluginWriteDependencies = {
  db: Db;
  log: Logger;
  actor: string;
  requestId: string;
};
export async function reusedPlugin(db: Db, row: PluginRow, warnings: string[] = []) {
  return { plugin: toApi(row, await pluginFiles(db, row.id)), warnings, reused: true };
}
export async function adoptNativePlugin(
  deps: PluginWriteDependencies,
  params: {
    slug: string;
    pluginId: string;
    files: PluginFileInput[];
    action: string;
  },
) {
  const existing = await repo.getPluginBySourceId(deps.db, params.pluginId);
  if (existing) return reusedPlugin(deps.db, existing);
  const parsed = parsePluginFiles({ files: params.files, slug: params.slug });
  const { files: parsedFiles, ...input } = parsed.input;
  try {
    const row = await repo.createPluginWithFiles(
      deps.db,
      toPluginWrite(input, params.pluginId),
      parsedFiles,
    );
    await pluginRepo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: params.action,
      target: row.id,
      input: { slug: row.slug, sourceId: params.pluginId, files: parsedFiles.length },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { plugin: toApi(row, parsedFiles), warnings: parsed.warnings, reused: false };
  } catch (err) {
    if (!isPgCode(err, '23505')) throw err;
    const raced = await repo.getPluginBySourceId(deps.db, params.pluginId);
    if (raced) return reusedPlugin(deps.db, raced);
    return fail('CONFLICT', '已有同名插件占用该 slug 或名称，请先删除或换一个 slug');
  }
}
