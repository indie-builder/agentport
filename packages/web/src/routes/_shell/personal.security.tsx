import { createFileRoute } from '@tanstack/react-router';
import { PersonalSecurityPage } from '../../pages/personal-security.js';
import { personalSecuritySearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/personal/security')({
  validateSearch: personalSecuritySearchSchema,
  component: PersonalSecurityPage,
});
