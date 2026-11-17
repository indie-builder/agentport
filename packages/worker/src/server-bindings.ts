import { unionById } from '@agentport/core';
import type { AgentDefinitionServer } from '@agentport/shared';

export function loadRunServerBindings(bindingsByAgent: Map<string, AgentDefinitionServer[]>) {
  const serverNamesByAgent = new Map(
    [...bindingsByAgent].map(([owner, rows]) => [owner, rows.map((row) => row.name)] as const),
  );
  const serverRows = unionById([...bindingsByAgent.values()]);

  return { serverNamesByAgent, serverRows };
}
