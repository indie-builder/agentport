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
import { useCursorList } from './client.js';
import { OVERVIEW_QUERY_KEY } from './overview.js';

export const SERVERS_QUERY_KEY = ['servers'] as const;

export const serverKeys = {
  all: SERVERS_QUERY_KEY,
  tools: (id: string) => ['tools', id] as const,
  impact: (id: string) => ['server-impact', id] as const,
  token: (id: string) => ['server-token', id] as const,
};

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
    queryKey: serverKeys.all,
    queryFn: (cursor, signal) => api.servers(cursor, signal),
    enabled,
    select: (data) => data.pages.flatMap((page) => page.items ?? []),
  });
}

export const toolsQuery = (serverId: string) =>
  queryOptions({
    queryKey: serverKeys.tools(serverId),
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
    queryKey: serverKeys.impact(id),
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
      await client.cancelQueries({ queryKey: serverKeys.all });
      const previous = client.getQueryData<ServerPages>(serverKeys.all);
      client.setQueryData<ServerPages>(serverKeys.all, (old) =>
        mapServerItems(old, (server) =>
          server.id === id ? ({ ...server, ...input } as Server) : server,
        ),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(serverKeys.all, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: serverKeys.all });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
  });
}

export function useCreateServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ServerInput) => api.createServer(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: serverKeys.all });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
  });
}

export function useDeleteServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: serverKeys.all });
      const previous = client.getQueryData<ServerPages>(serverKeys.all);
      client.setQueryData<ServerPages>(serverKeys.all, (old) =>
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
      if (context?.previous) client.setQueryData(serverKeys.all, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: serverKeys.all });
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
    onSuccess: () => void client.invalidateQueries({ queryKey: serverKeys.all }),
  });
}

export function useImportMcpFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importMcpFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: serverKeys.all }),
  });
}

export function useServerToken(serverId: string) {
  return useQuery({
    queryKey: serverKeys.token(serverId),
    queryFn: () => api.serverToken(serverId),
    staleTime: 0,
  });
}

export function useRotateServerToken(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotateServerToken(serverId),
    onSuccess: (data) => {
      client.setQueryData(serverKeys.token(serverId), data);
      void client.invalidateQueries({ queryKey: serverKeys.all });
    },
  });
}

export function useBatchSetToolsEnabled(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { toolIds: string[]; enabled: boolean }) =>
      api.batchSetToolsEnabled(serverId, vars.toolIds, vars.enabled),
    onSuccess: () => void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) }),
  });
}

export function useTestInvokeTool(serverId: string) {
  return useMutation({
    mutationFn: (vars: { toolId: string; args: Record<string, unknown> }) =>
      api.testInvokeTool(serverId, vars.toolId, vars.args),
  });
}

export function useCreateTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiToolInput) => api.createTool(serverId, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) }),
  });
}

export function usePreviewOpenApi(serverId: string) {
  return useMutation({
    mutationFn: (spec: string) => api.previewOpenApiTools(serverId, spec),
  });
}

export function useImportOpenApi(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { spec: string; selectedNames: string[] }) =>
      api.importOpenApiTools(serverId, vars.spec, vars.selectedNames),
    onSuccess: () => void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) }),
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
      client.setQueryData<ApiTool[]>(serverKeys.tools(serverId), (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) });
    },
  });
}

export function useUpdateTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { toolId: string; patch: Partial<ApiToolInput> & { enabled?: boolean } }) =>
      api.updateTool(serverId, vars.toolId, vars.patch),
    onSuccess: (tool) => {
      client.setQueryData<ApiTool[]>(serverKeys.tools(serverId), (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) });
    },
  });
}

export function useDeleteTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (toolId: string) => api.deleteTool(serverId, toolId),
    onMutate: async (toolId) => {
      await client.cancelQueries({ queryKey: serverKeys.tools(serverId) });
      const previous = client.getQueryData<ApiTool[]>(serverKeys.tools(serverId));
      client.setQueryData<ApiTool[]>(serverKeys.tools(serverId), (old) =>
        old?.filter((tool) => tool.id !== toolId),
      );
      return { previous };
    },
    onError: (_error, _toolId, context) => {
      if (context?.previous) client.setQueryData(serverKeys.tools(serverId), context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: serverKeys.tools(serverId) });
    },
  });
}
