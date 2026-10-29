import { createFileRoute } from '@tanstack/react-router';
import { RuntimeEnvironmentDetailPage } from '../../pages/runtime-environment-detail.js';
import { runtimeEnvironmentDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/runtime-environments/$environmentId')({
  validateSearch: runtimeEnvironmentDetailSearchSchema,
  component: RuntimeEnvironmentDetailPage,
});
