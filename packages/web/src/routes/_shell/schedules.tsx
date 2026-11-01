import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '../../pages/ops.js';
import { schedulesSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/schedules')({
  validateSearch: schedulesSearchSchema,
  component: SchedulesPage,
});
