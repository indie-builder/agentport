import type { AgentDefinitionServer } from '@agentport/shared';

type ApprovalMode = 'allow' | 'ask' | 'deny';

interface LiveToolApproval {
  serverId: string;
  toolName: string;
  approvalMode: ApprovalMode;
}

export interface ApprovalTool {
  server: string;
  tool: string;
}

export function collectApprovalTools(
  serverRows: readonly Pick<AgentDefinitionServer, 'name' | 'tools'>[],
  approvalModes: ReadonlyArray<LiveToolApproval>,
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

export function unambiguousDeniedToolNames(
  serverRows: readonly Pick<AgentDefinitionServer, 'name' | 'tools'>[],
  approvalModes: ReadonlyArray<LiveToolApproval>,
  serverNamesById: ReadonlyMap<string, string>,
): string[] {
  const ownersByName = new Map<string, Set<string>>();
  const record = (server: string, tool: string) => {
    const name = `mcp__${server}__${tool}`;
    const owners = ownersByName.get(name) ?? new Set<string>();
    owners.add(`${server}\u0000${tool}`);
    ownersByName.set(name, owners);
  };
  serverRows.forEach((server) => {
    (server.tools ?? []).forEach((tool) => {
      record(server.name, tool.name);
    });
  });
  approvalModes.forEach(({ serverId, toolName }) => {
    const server = serverNamesById.get(serverId);
    if (server !== undefined) {
      record(server, toolName);
    }
  });
  return collectApprovalTools(serverRows, approvalModes, serverNamesById, 'deny')
    .map(({ server, tool }) => `mcp__${server}__${tool}`)
    .filter((name) => ownersByName.get(name)?.size === 1);
}
