import { type Database, repo } from '@agentport/db';
import type { AgentDefinition } from '@agentport/shared';
import type { Logger } from 'pino';

export async function resolveAgentVersionSnapshot(
  db: Database,
  run: {
    agentId: string;
    agentVersion: number | null;
    definitionSnapshot: AgentDefinition | null;
  },
  options: { requireVersion?: boolean; logger?: Logger } = {},
): Promise<AgentDefinition | null> {
  if (run.definitionSnapshot !== null) return run.definitionSnapshot;
  if (run.agentVersion === null) return null;
  const version = await repo.agentVersions.getAgentVersion(db, run.agentId, run.agentVersion);
  if (!version) {
    if (options.requireVersion) {
      throw new Error(`agent ${run.agentId} version ${run.agentVersion} not found`);
    }
    return null;
  }
  if (version.definition === null) {
    options.logger?.warn(
      { agentVersion: run.agentVersion },
      'legacy agent version has no definition snapshot',
    );
  }
  return version.definition;
}
