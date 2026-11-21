import { notFound } from '@agentport/core';
import { type Database, repo } from '@agentport/db';

export function agentSlug(db: Database, agentId: string): Promise<string | null> {
  return repo.agents.findAgentSlug(db, agentId);
}

export async function requireAgentSlug(db: Database, agentId: string): Promise<string> {
  const slug = await agentSlug(db, agentId);
  if (slug === null) notFound('agent');
  return slug;
}
