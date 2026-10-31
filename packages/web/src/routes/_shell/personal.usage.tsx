import { createFileRoute } from '@tanstack/react-router';
import { PersonalUsagePage } from '../../pages/personal-usage.js';
import { personalUsageSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/personal/usage')({
  validateSearch: personalUsageSearchSchema,
  component: PersonalUsagePage,
});
