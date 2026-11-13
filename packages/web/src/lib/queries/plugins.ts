import type {
  ConnectorCatalogItem,
  NativePluginImportInput,
  NativePluginInstallInput,
  Plugin,
  PluginInput,
  PluginWithAgentCount,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type NativePlugins } from '../api.js';

export const pluginsQuery = queryOptions<PluginWithAgentCount[]>({
  queryKey: ['plugins'],
  queryFn: api.plugins,
});

export const nativePluginsQuery = queryOptions<NativePlugins>({
  queryKey: ['plugins-native'],
  queryFn: api.nativePlugins,
});

/** 详情挂在 `['plugins']` 前缀下，列表与详情的失效一次覆盖。 */
export const pluginQuery = (id: string) =>
  queryOptions<Plugin>({
    queryKey: ['plugins', id],
    queryFn: () => api.plugin(id),
  });

export const connectorCatalogQuery = queryOptions<ConnectorCatalogItem[]>({
  queryKey: ['connector-catalog'],
  queryFn: api.connectorCatalog,
  staleTime: 5 * 60_000,
});

export function usePlugins(enabled = true) {
  return useQuery({ ...pluginsQuery, enabled });
}

export function usePlugin(id: string) {
  return useQuery(pluginQuery(id));
}

export function useNativePlugins(enabled = true) {
  // 列表要起一次沙盒，只在「已安装」页签可见时请求。
  return useQuery({ ...nativePluginsQuery, enabled });
}

export function useUpdatePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<PluginInput>; expectedUpdatedAt?: string }) =>
      api.updatePlugin(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useImportPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: Blob; slug: string }) => api.importPlugin(vars.file, vars.slug),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

/** 安装与纳入都不要草稿缓存，只让两份列表失效。 */
export function useInstallNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginInstallInput) => api.installNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins-native'] });
      void client.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useImportNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginImportInput) => api.importNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins-native'] });
      void client.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useDeletePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
