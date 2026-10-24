import { createFileRoute } from '@tanstack/react-router';
import { AgentDetailPage } from '../../pages/agents.js';

export const Route = createFileRoute('/_shell/agents/$agentId')({
  component: AgentDetailPage,
});
