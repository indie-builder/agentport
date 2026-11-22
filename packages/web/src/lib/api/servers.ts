import type {
  ApiTool,
  ApiToolInput,
  ConnectorCatalogItem,
  CursorPage,
  Server,
  ServerInput,
  ServerTestResult,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions } from './shared.js';

type OpenApiPreviewResult = ApiOutput<ApiClient['servers']['tools']['previewOpenApi']>;

type OpenApiImportResult = ApiOutput<ApiClient['servers']['tools']['importOpenApi']>;

type TestInvokeResult = ApiOutput<ApiClient['servers']['tools']['testInvoke']>;

type McpImportResult = ApiOutput<ApiClient['servers']['importFile']>;

type ServerImpact = ApiOutput<ApiClient['servers']['impact']>;

export default {
  servers: (cursor?: string, signal?: AbortSignal): Promise<CursorPage<Server>> =>
    rpc.servers.list({ query: cursor === undefined ? {} : { cursor } }, clientOptions(signal)),
  server: (id: string): Promise<Server> => rpc.servers.get({ params: { id } }),
  connectorCatalog: (): Promise<ConnectorCatalogItem[]> => rpc.servers.catalog(),
  createServer: (input: ServerInput): Promise<Server> => rpc.servers.create({ body: input }),
  updateServer: (
    id: string,
    input: Partial<ServerInput>,
    expectedUpdatedAt?: string,
  ): Promise<Server> =>
    rpc.servers.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deleteServer: (id: string): Promise<void> => rpc.servers.delete({ params: { id } }),
  serverImpact: (id: string): Promise<ServerImpact> => rpc.servers.impact({ params: { id } }),
  testServer: (id: string, runtimeEnvironmentId?: string | null): Promise<ServerTestResult> =>
    rpc.servers.test({
      params: { id },
      ...(runtimeEnvironmentId === undefined || runtimeEnvironmentId === null
        ? {}
        : { body: { runtimeEnvironmentId } }),
    }),
  importMcpFile: (content: string): Promise<McpImportResult> =>
    rpc.servers.importFile({ body: { mcpJson: content } }),
  serverToken: async (id: string): Promise<{ token: string; endpoint: string }> => {
    const { maskedToken, endpoint } = await rpc.servers.token({ params: { id } });
    return { token: maskedToken, endpoint };
  },
  rotateServerToken: (id: string): Promise<{ token: string; endpoint: string }> =>
    rpc.servers.rotateToken({ params: { id } }),
  tools: (serverId: string): Promise<ApiTool[]> =>
    rpc.servers.tools.list({ params: { id: serverId } }),
  createTool: (serverId: string, input: ApiToolInput): Promise<ApiTool> =>
    rpc.servers.tools.create({ params: { id: serverId }, body: input }),
  deleteTool: (serverId: string, toolId: string): Promise<void> =>
    rpc.servers.tools.delete({ params: { id: serverId, toolId } }),
  updateTool: (
    serverId: string,
    toolId: string,
    patch: Partial<ApiToolInput> & { enabled?: boolean },
  ): Promise<ApiTool> =>
    rpc.servers.tools.update({ params: { id: serverId, toolId }, body: patch }),
  previewOpenApiTools: (serverId: string, spec: string): Promise<OpenApiPreviewResult> =>
    rpc.servers.tools.previewOpenApi({ params: { id: serverId }, body: { spec } }),
  importOpenApiTools: (
    serverId: string,
    spec: string,
    selectedNames?: string[],
  ): Promise<OpenApiImportResult> =>
    rpc.servers.tools.importOpenApi({
      params: { id: serverId },
      body: selectedNames ? { spec, selectedNames } : { spec },
    }),
  batchSetToolsEnabled: (
    serverId: string,
    toolIds: string[],
    enabled: boolean,
  ): Promise<{ updated: number }> =>
    rpc.servers.tools.batchSetEnabled({ params: { id: serverId }, body: { toolIds, enabled } }),
  testInvokeTool: (
    serverId: string,
    toolId: string,
    args: Record<string, unknown>,
  ): Promise<TestInvokeResult> =>
    rpc.servers.tools.testInvoke({ params: { id: serverId, toolId }, body: { args } }),
};
