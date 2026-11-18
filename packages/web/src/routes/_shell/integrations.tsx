import { createFileRoute } from '@tanstack/react-router';
import { IntegrationsPage } from '../../pages/integrations.js';
import { integrationsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/integrations')({
  validateSearch: integrationsSearchSchema,
  component: IntegrationsPage,
});
