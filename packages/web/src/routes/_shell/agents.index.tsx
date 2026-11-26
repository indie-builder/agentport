import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AgentsPage } from '../../pages/agents/agents-page.js';
import { agentsSearchSchema as baseAgentsSearchSchema } from '../-search.js';

const agentsSearchSchema = baseAgentsSearchSchema.extend({
  tag: z.string().optional().catch(undefined),
  favorite: z.enum(['1']).optional().catch(undefined),
  lifecycle: z.enum(['active', 'archived', 'deleted']).optional().catch(undefined),
  order: z.enum(['recent']).optional().catch(undefined),
});

export const Route = createFileRoute('/_shell/agents/')({
  validateSearch: agentsSearchSchema,
  component: AgentsPage,
});
