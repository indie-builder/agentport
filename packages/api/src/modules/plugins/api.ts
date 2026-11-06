import { repo as pluginRepo } from '@agentport/db';
import {
  type Plugin,
  type PluginFileInput,
  type PluginInput,
  pluginInputSchema,
} from '@agentport/shared';

const repo = pluginRepo.plugins;
export function toPluginWrite(
  input: Omit<PluginInput, 'files'>,
  sourceId?: string,
): Parameters<typeof repo.createPluginWithFiles>[1] {
  return {
    slug: input.slug,
    runtimeName: input.runtimeName ?? input.slug,
    name: input.name,
    description: input.description,
    version: input.version,
    manifest: input.capabilities,
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}
export function toApi(
  row: Awaited<ReturnType<typeof repo.getPlugin>> extends infer R ? NonNullable<R> : never,
  files: PluginFileInput[],
): Plugin {
  return {
    id: row.id,
    slug: row.slug,
    runtimeName: row.runtimeName,
    name: row.name,
    description: row.description,
    version: row.version,
    capabilities: pluginInputSchema.shape.capabilities.parse(row.manifest),
    files,
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type Db = Parameters<typeof repo.listPluginFiles>[0];
export type PluginRow = NonNullable<Awaited<ReturnType<typeof repo.getPlugin>>>;
export async function pluginFiles(db: Db, pluginId: string): Promise<PluginFileInput[]> {
  const files = await repo.listPluginFiles(db, pluginId);
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    executable: file.executable,
  }));
}
