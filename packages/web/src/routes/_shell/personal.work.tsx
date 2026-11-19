import { createFileRoute } from '@tanstack/react-router';
import { PersonalWorkPage } from '../../pages/personal/work.js';
import { personalWorkSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/personal/work')({
  validateSearch: personalWorkSearchSchema,
  component: PersonalWorkPage,
});
