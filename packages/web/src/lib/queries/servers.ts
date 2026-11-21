import type {
  ApiTool,
  ApiToolInput,
  CursorPage,
  Server,
  ServerInput,
  ServerTestResult,
} from '@agentport/shared';
import {
  type InfiniteData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../api.js';
import { AGENTS_QUERY_KEY } from './agents.js';
import { OVERVIEW_QUERY_KEY } from './overview.js';
import { useCursorList, useInvalidate } from './shared.js';

const SERVERS_QUERY_KEY = ['servers'] as const;

type ServerPages = InfiniteData<CursorPage<Server>, string | undefined>;

function mapServerItems(
  data: ServerPages | undefined,
  update: (server: Server) => Server,
): ServerPages | undefined {
  return data === undefined
    ? undefined
    : {
        ...data,
        pages: data.pages.map((page) => ({ ...page, items: page.items.map(update) })),
      };
}

export function useServers(enabled = true) {
  return useCursorList({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: (cursor, signal) => api.servers(cursor, signal),
    enabled,
    select: (data) => data.pages.flatMap((page) => page.items ?? []),
  });
}

export const toolsQuery = (serverId: string) =>
  queryOptions({
    queryKey: ['tools', serverId],
    queryFn: () => api.tools(serverId),
    staleTime: 60_000,
  });

export function useTools(serverId: string | null) {
  return useQuery({
    ...toolsQuery(serverId ?? ''),
    enabled: serverId !== null,
  });
}

export function useServerImpact(id: string) {
  return useQuery({
    queryKey: ['server-impact', id],
    queryFn: () => api.serverImpact(id),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useUpdateServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<ServerInput>; expectedUpdatedAt?: string }) =>
      api.updateServer(vars.id, vars.input, vars.expectedUpdatedAt),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: SERVERS_QUERY_KEY });
      const previous = client.getQueryData<ServerPages>(SERVERS_QUERY_KEY);
      client.setQueryData<ServerPages>(SERVERS_QUERY_KEY, (old) =>
        mapServerItems(old, (server) =>
          server.id === id ? ({ ...server, ...input } as Server) : server,
        ),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(SERVERS_QUERY_KEY, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
  });
}

export function useCreateServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ServerInput) => api.createServer(input),
    onSuccess: () => {
      invalidate('servers');
      invalidate(OVERVIEW_QUERY_KEY[0]);
    },
  });
}

export function useDeleteServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: SERVERS_QUERY_KEY });
      const previous = client.getQueryData<ServerPages>(SERVERS_QUERY_KEY);
      client.setQueryData<ServerPages>(SERVERS_QUERY_KEY, (old) =>
        old === undefined
          ? undefined
          : {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                items: page.items.filter((server) => server.id !== id),
              })),
            },
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) client.setQueryData(SERVERS_QUERY_KEY, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
  });
}

export function useTestServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      runtimeEnvironmentId?: string | null;
    }): Promise<ServerTestResult> => api.testServer(vars.id, vars.runtimeEnvironmentId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useImportMcpFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importMcpFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useServerToken(serverId: string) {
  return useQuery({
    queryKey: ['server-token', serverId],
    queryFn: () => api.serverToken(serverId),
    staleTime: 0,
  });
}

export function useRotateServerToken(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotateServerToken(serverId),
    onSuccess: (data) => {
      client.setQueryData(['server-token', serverId], data);
      void client.invalidateQueries({ queryKey: ['servers'] });
    },
  });
}

export function useBatchSetToolsEnabled(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { toolIds: string[]; enabled: boolean }) =>
      api.batchSetToolsEnabled(serverId, vars.toolIds, vars.enabled),
    onSuccess: () => invalidate('tools'),
  });
}

export function useTestInvokeTool(serverId: string) {
  return useMutation({
    mutationFn: (vars: { toolId: string; args: Record<string, unknown> }) =>
      api.testInvokeTool(serverId, vars.toolId, vars.args),
  });
}

export function useCreateTool(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ApiToolInput) => api.createTool(serverId, input),
    onSuccess: () => invalidate('tools'),
  });
}

export function usePreviewOpenApi(serverId: string) {
  return useMutation({
    mutationFn: (spec: string) => api.previewOpenApiTools(serverId, spec),
  });
}

export function useImportOpenApi(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { spec: string; selectedNames: string[] }) =>
      api.importOpenApiTools(serverId, vars.spec, vars.selectedNames),
    onSuccess: () => invalidate('tools'),
  });
}

export function useSetToolEnabled(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      toolId: string;
      enabled?: boolean;
      approvalMode?: ApiTool['approvalMode'];
    }) =>
      api.updateTool(serverId, vars.toolId, {
        ...(vars.enabled === undefined ? {} : { enabled: vars.enabled }),
        ...(vars.approvalMode === undefined ? {} : { approvalMode: vars.approvalMode }),
      }),
    onSuccess: (tool) => {
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
    },
  });
}

export function useUpdateTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { toolId: string; patch: Partial<ApiToolInput> & { enabled?: boolean } }) =>
      api.updateTool(serverId, vars.toolId, vars.patch),
    onSuccess: (tool) => {
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
    },
  });
}

export function useDeleteTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (toolId: string) => api.deleteTool(serverId, toolId),
    onMutate: async (toolId) => {
      await client.cancelQueries({ queryKey: ['tools', serverId] });
      const previous = client.getQueryData<ApiTool[]>(['tools', serverId]);
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.filter((tool) => tool.id !== toolId),
      );
      return { previous };
    },
    onError: (_error, _toolId, context) => {
      if (context?.previous) client.setQueryData(['tools', serverId], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
    },
  });
}
