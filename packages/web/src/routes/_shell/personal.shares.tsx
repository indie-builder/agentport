import { createFileRoute } from '@tanstack/react-router';
import { PersonalSharesPage } from '../../pages/personal-shares.js';
import { personalSharesSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/personal/shares')({
  validateSearch: personalSharesSearchSchema,
  component: PersonalSharesPage,
});
