import { createFileRoute } from '@tanstack/react-router';
import { DataDomainDetailPage } from '../../pages/data-domains/data-domain-detail.js';
import { dataDomainDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/data-domains/$dataDomainId')({
  validateSearch: dataDomainDetailSearchSchema,
  component: DataDomainDetailPage,
});
