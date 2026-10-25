import { createFileRoute } from '@tanstack/react-router';
import { AgentDetailPage } from '../../pages/agents.js';
import { agentDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/agents/$agentId')({
  validateSearch: agentDetailSearchSchema,
  component: AgentDetailPage,
});
