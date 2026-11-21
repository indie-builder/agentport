import type { AgentDefinitionServer } from '@agentport/shared';

type ApprovalMode = 'allow' | 'ask' | 'deny';

export interface ApprovalTool {
  server: string;
  tool: string;
}

export function collectApprovalTools(
  serverRows: readonly Pick<AgentDefinitionServer, 'name' | 'tools'>[],
  approvalModes: ReadonlyArray<{
    serverId: string;
    toolName: string;
    approvalMode: ApprovalMode;
  }>,
  serverNamesById: ReadonlyMap<string, string>,
  mode: 'ask' | 'deny',
): ApprovalTool[] {
  return [
    ...serverRows.flatMap((server) =>
      (server.tools ?? [])
        .filter((tool) => tool.enabled && tool.approvalMode === mode)
        .map((tool) => ({ server: server.name, tool: tool.name })),
    ),
    ...approvalModes.flatMap((tool) => {
      const server = serverNamesById.get(tool.serverId);
      return tool.approvalMode === mode && server !== undefined
        ? [{ server, tool: tool.toolName }]
        : [];
    }),
  ];
}
