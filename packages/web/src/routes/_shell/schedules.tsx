import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '../../pages/ops.js';

export const Route = createFileRoute('/_shell/schedules')({
  component: SchedulesPage,
});
