import type {
  ApiTool,
  ApiToolInput,
  Server,
  ServerInput,
  ServerTestResult,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useInvalidate } from './shared.js';

export const serversQuery = queryOptions<Server[]>({
  queryKey: ['servers'],
  queryFn: api.servers,
});

export function useServers(enabled = true) {
  return useQuery({ ...serversQuery, enabled });
}

export const toolsQuery = (serverId: string) =>
  queryOptions({
    queryKey: ['tools', serverId],
    queryFn: () => api.tools(serverId),
    staleTime: 60_000,
  });

export function useTools(serverId: string | null) {
  return useQuery({ ...toolsQuery(serverId ?? ''), enabled: serverId !== null });
}

export function useUpdateServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<ServerInput>; expectedUpdatedAt?: string }) =>
      api.updateServer(vars.id, vars.input, vars.expectedUpdatedAt),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: ['servers'] });
      const previous = client.getQueryData<Server[]>(['servers']);
      client.setQueryData<Server[]>(['servers'], (old) =>
        old?.map((server) => (server.id === id ? ({ ...server, ...input } as Server) : server)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(['servers'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useCreateServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ServerInput) => api.createServer(input),
    onSuccess: () => {
      invalidate('servers');
      invalidate('overview');
    },
  });
}

export function useDeleteServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: ['servers'] });
      const previous = client.getQueryData<Server[]>(['servers']);
      client.setQueryData<Server[]>(['servers'], (old) =>
        old?.filter((server) => server.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) client.setQueryData(['servers'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
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
    // 后端把最近一次试连身份写进 server；刷新后卡片仍能显示这次实际用的环境。
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

/** 批量启停：成功后失效工具列表，勾选状态由调用方清空。 */
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
    mutationFn: (vars: { toolId: string; enabled?: boolean; requiresApproval?: boolean }) =>
      api.updateTool(serverId, vars.toolId, {
        ...(vars.enabled === undefined ? {} : { enabled: vars.enabled }),
        ...(vars.requiresApproval === undefined ? {} : { requiresApproval: vars.requiresApproval }),
      }),
    onSuccess: (tool) => {
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
    },
  });
}

/** 编辑工具定义（名称/方法/路径/参数/schema）；与启停分开，互不覆盖。 */
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
