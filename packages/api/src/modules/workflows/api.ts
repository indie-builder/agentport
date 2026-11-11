import { fail, parseWorkflowMeta } from '@agentport/core';
import type { repo } from '@agentport/db';
import { type AgentWorkflow, agentWorkflowInputSchema } from '@agentport/shared';
import { isPgCode } from '../../http/errors.js';

type WorkflowRow = NonNullable<Awaited<ReturnType<typeof repo.workflows.getWorkflow>>>;

export function rethrowConflict(err: unknown): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', '该 slug 已被其他工作流占用，请换一个');
  throw err;
}

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

/** meta 是 name/description 的唯一来源，客户端提交的同名字段不参与写入。 */
export function toWorkflowWrite(slug: string, content: string) {
  const meta = parseWorkflowMeta(content);
  return agentWorkflowInputSchema.parse({ slug, ...meta, content });
}
