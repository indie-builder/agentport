import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../../pages/overview.js';
import { operationsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/operations')({
  validateSearch: operationsSearchSchema,
  component: OverviewPage,
});
