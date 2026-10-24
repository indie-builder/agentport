import { createFileRoute } from '@tanstack/react-router';
import { RunsPage } from '../../pages/runs.js';
import { runsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/runs/')({
  validateSearch: runsSearchSchema,
  component: RunsPage,
});
