import { createFileRoute } from '@tanstack/react-router';
import { GatewaysPage } from '../../pages/gateways.js';
import { gatewaysSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/gateways')({
  validateSearch: gatewaysSearchSchema,
  component: GatewaysPage,
});
