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
function sameFiles(current: PluginFileInput[], next: PluginFileInput[]): boolean {
  if (current.length !== next.length) return false;
  const byPath = new Map(current.map((file) => [file.path, file]));
  return next.every((file) => {
    const stored = byPath.get(file.path);
    return (
      stored !== undefined &&
      stored.content === file.content &&
      (stored.executable ?? false) === (file.executable ?? false)
    );
  });
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
  const parsed = parsePluginFiles({ files: params.files, slug: params.slug });
  const { files: parsedFiles, ...input } = parsed.input;
  if (existing) {
    const current = await pluginFiles(deps.db, existing.id);
    if (existing.version === parsed.input.version && sameFiles(current, parsedFiles)) {
      return reusedPlugin(deps.db, existing);
    }
    const updated = await repo.replacePluginWithFiles(
      deps.db,
      existing.id,
      toPluginWrite(input, params.pluginId),
      parsedFiles,
    );
    if (!updated) return fail('NOT_FOUND', '插件已被删除，请重试');
    await pluginRepo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'plugin.updated',
      target: updated.id,
      input: { slug: updated.slug, sourceId: params.pluginId, files: parsedFiles.length },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { plugin: toApi(updated, parsedFiles), warnings: parsed.warnings, reused: true };
  }
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
