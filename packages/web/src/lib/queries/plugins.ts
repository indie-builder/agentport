import type {
  ConnectorCatalogItem,
  NativePluginImportInput,
  NativePluginInstallInput,
  PluginInput,
  PluginWithAgentCount,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type NativePlugins } from '../api.js';
import { AGENTS_QUERY_KEY } from './agents.js';
import { useCursorList } from './shared.js';

export const pluginKeys = {
  all: ['plugins'] as const,
  detail: (id: string) => ['plugins', id] as const,
  native: ['plugins-native'] as const,
};

const nativePluginsQuery = queryOptions<NativePlugins>({
  queryKey: pluginKeys.native,
  queryFn: api.nativePlugins,
});

export const pluginQuery = (id: string) =>
  queryOptions<PluginWithAgentCount>({
    queryKey: pluginKeys.detail(id),
    queryFn: () => api.plugin(id),
  });

export const connectorCatalogQuery = queryOptions<ConnectorCatalogItem[]>({
  queryKey: ['connector-catalog'],
  queryFn: api.connectorCatalog,
  staleTime: 5 * 60_000,
});

export function usePlugins(options: { enabled?: boolean | undefined } = {}) {
  return useCursorList({
    queryKey: pluginKeys.all,
    queryFn: (cursor) => api.plugins(cursor === undefined ? {} : { cursor }),
    enabled: options.enabled ?? true,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function usePlugin(id: string) {
  return useQuery(pluginQuery(id));
}

export function useNativePlugins(enabled = true) {
  return useQuery({ ...nativePluginsQuery, enabled });
}

export function useUpdatePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<PluginInput>; expectedUpdatedAt?: string }) =>
      api.updatePlugin(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}

export function useImportPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: Blob; slug: string }) => api.importPlugin(vars.file, vars.slug),
    onSuccess: () => void client.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}

export function useInstallNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginInstallInput) => api.installNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: pluginKeys.native });
      void client.invalidateQueries({ queryKey: pluginKeys.all });
    },
  });
}

export function useImportNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginImportInput) => api.importNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: pluginKeys.native });
      void client.invalidateQueries({ queryKey: pluginKeys.all });
    },
  });
}

export function useDeletePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: pluginKeys.all });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}
