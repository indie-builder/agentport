import { createFileRoute } from '@tanstack/react-router';
import { GovernancePage } from '../../pages/governance.js';
import { governanceSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/governance')({
  validateSearch: governanceSearchSchema,
  component: GovernancePage,
});
