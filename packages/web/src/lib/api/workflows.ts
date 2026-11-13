import type { AgentWorkflow } from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  agentWorkflows: (id: string): Promise<AgentWorkflow[]> => rpc.workflows.list({ params: { id } }),
  createAgentWorkflow: (
    id: string,
    input: { slug: string; content: string },
  ): Promise<AgentWorkflow> => rpc.workflows.create({ params: { id }, body: input }),
  updateAgentWorkflow: (
    id: string,
    workflowId: string,
    input: { content: string; expectedUpdatedAt?: string },
  ): Promise<AgentWorkflow> =>
    rpc.workflows.update({
      params: { id, workflowId },
      body: {
        content: input.content,
        ...(input.expectedUpdatedAt === undefined
          ? {}
          : { expectedUpdatedAt: input.expectedUpdatedAt }),
      },
    }),
  deleteAgentWorkflow: (id: string, workflowId: string): Promise<void> =>
    rpc.workflows.delete({ params: { id, workflowId } }),
};
