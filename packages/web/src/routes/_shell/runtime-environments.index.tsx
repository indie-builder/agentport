import { createFileRoute } from '@tanstack/react-router';
import { RuntimeEnvironmentsPage } from '../../pages/runtime-environments.js';
import { runtimeEnvironmentsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/runtime-environments/')({
  validateSearch: runtimeEnvironmentsSearchSchema,
  component: RuntimeEnvironmentsPage,
});
