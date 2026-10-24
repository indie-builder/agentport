import { createFileRoute } from '@tanstack/react-router';
import { AgentsPage } from '../../pages/agents.js';
import { agentsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/agents/')({
  validateSearch: agentsSearchSchema,
  component: AgentsPage,
});
