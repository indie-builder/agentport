import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../../pages/overview.js';

export const Route = createFileRoute('/_shell/operations')({
  component: OverviewPage,
});
