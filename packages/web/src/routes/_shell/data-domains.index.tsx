import { createFileRoute } from '@tanstack/react-router';
import { DataDomainsPage } from '../../pages/data-domains/index.js';
import { dataDomainsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/data-domains/')({
  validateSearch: dataDomainsSearchSchema,
  component: DataDomainsPage,
});
