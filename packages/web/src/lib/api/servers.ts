import type {
  ApiTool,
  ApiToolInput,
  ConnectorCatalogItem,
  Server,
  ServerInput,
  ServerTestResult,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

/** OpenAPI 解析预览：tools 为可直接创建的工具定义，warnings 不阻断导入。 */
export interface OpenApiPreviewResult {
  tools: ApiToolInput[];
  warnings: string[];
  total: number;
}

export interface OpenApiImportResult {
  created: ApiTool[];
  warnings: string[];
}

/** 单工具试跑结果；ok 为 false 时 error 说明上游返回或请求失败的原因。 */
export interface TestInvokeResult {
  ok: boolean;
  text?: string | undefined;
  isError?: boolean | undefined;
  error?: string | undefined;
  durationMs: number;
}

/** `.mcp.json` 导入结果；secretKeys 只有键名，值不会回显。 */
export interface McpImportResult {
  servers: Array<{
    id: string;
    name: string;
    kind: 'stdio' | 'http' | 'generated';
    secretKeys: string[];
  }>;
  warnings: string[];
}

export default {
  servers: (): Promise<Server[]> => rpc.servers.list(),
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
  testServer: (id: string, runtimeEnvironmentId?: string | null): Promise<ServerTestResult> =>
    rpc.servers.test({
      params: { id },
      ...(runtimeEnvironmentId === undefined || runtimeEnvironmentId === null
        ? {}
        : { body: { runtimeEnvironmentId } }),
    }),
  importMcpFile: (content: string): Promise<McpImportResult> =>
    rpc.servers.importFile({ body: { mcpJson: content } }),
  /**
   * wire 上掩码字段叫 maskedToken（rotate 的 token 是明文，两者不能同名）。
   * 这里映射回 `token`，页面把「掩码」和「刚轮换的明文」放进同一处渲染。
   */
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
  /** 与 createTool 同字段，全部可选：编辑只提交改动的字段。 */
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
