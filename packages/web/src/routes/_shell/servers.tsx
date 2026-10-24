import { createFileRoute } from '@tanstack/react-router';
import { ServersPage } from '../../pages/servers.js';
import { serversSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/servers')({
  validateSearch: serversSearchSchema,
  component: ServersPage,
});
