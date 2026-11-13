import { createFileRoute } from '@tanstack/react-router';
import { RunsPage } from '../../pages/runs/index.js';
import { runsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/runs/')({
  validateSearch: runsSearchSchema,
  component: RunsPage,
});
