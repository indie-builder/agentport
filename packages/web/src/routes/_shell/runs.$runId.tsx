import { createFileRoute } from '@tanstack/react-router';
import { RunDetailPage } from '../../pages/run-detail.js';
import { runDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/runs/$runId')({
  validateSearch: runDetailSearchSchema,
  component: RunDetailPage,
});
