import { parseWorkflowMeta } from '@agentport/core';
import type { repo } from '@agentport/db';
import { type AgentWorkflow, agentWorkflowInputSchema } from '@agentport/shared';

type WorkflowRow = NonNullable<Awaited<ReturnType<typeof repo.workflows.getWorkflow>>>;

export function toApi(row: WorkflowRow): AgentWorkflow {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWorkflowWrite(slug: string, content: string) {
  const meta = parseWorkflowMeta(content);
  return agentWorkflowInputSchema.parse({ slug, ...meta, content });
}
