import { createFileRoute } from '@tanstack/react-router';
import { IntegrationsPage } from '../../pages/integrations.js';

export const Route = createFileRoute('/_shell/integrations')({
  component: IntegrationsPage,
});
