import { createFileRoute } from '@tanstack/react-router';
import { ObservabilityPage } from '../../pages/observability.js';
import { observabilitySearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/observability')({
  validateSearch: observabilitySearchSchema,
  component: ObservabilityPage,
});
