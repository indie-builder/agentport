import type {
  NativePluginImportInput,
  NativePluginInstallInput,
  Plugin,
  PluginInput,
  PluginWithAgentCount,
  NativeInstalledPlugin as SharedNativeInstalledPlugin,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { nativeRequest } from './shared.js';

/** 插件 ZIP 导入结果：warnings 提示被忽略的官方组件，不阻断导入。 */
export interface PluginImportResult {
  plugin: Plugin;
  warnings: string[];
}

/** 官方 CLI 缓存里的插件；imported 表示同一来源已经加入平台插件库。 */
export interface NativeInstalledPlugin extends SharedNativeInstalledPlugin {
  imported: boolean;
}

export interface NativePlugins {
  installed: NativeInstalledPlugin[];
}

/** 原生安装/纳入结果；reused 表示库里已有同一来源，未覆盖原对象。 */
export type NativePluginImportResult = PluginImportResult & { reused: boolean };

export default {
  plugins: (): Promise<PluginWithAgentCount[]> => rpc.plugins.list({}),
  plugin: (id: string): Promise<Plugin> => rpc.plugins.get({ params: { id } }),
  updatePlugin: (
    id: string,
    input: Partial<PluginInput>,
    expectedUpdatedAt?: string,
  ): Promise<Plugin> =>
    rpc.plugins.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deletePlugin: (id: string): Promise<void> => rpc.plugins.delete({ params: { id } }),
  importPlugin: (file: Blob, slug: string, signal?: AbortSignal): Promise<PluginImportResult> =>
    nativeRequest(`/plugins/import?slug=${encodeURIComponent(slug)}`, 'POST', file, signal),
  nativePlugins: (): Promise<NativePlugins> => rpc.plugins.native({}),
  installNativePlugin: async (input: NativePluginInstallInput): Promise<NativePluginImportResult> =>
    (await rpc.plugins.install({ body: input })).body,
  importNativePlugin: async (input: NativePluginImportInput): Promise<NativePluginImportResult> =>
    (await rpc.plugins.importNative({ body: input })).body,
};
