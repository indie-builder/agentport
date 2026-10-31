import { createFileRoute } from '@tanstack/react-router';
import { PersonalReviewsPage } from '../../pages/personal-memory.js';
import { personalReviewsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/personal/reviews')({
  validateSearch: personalReviewsSearchSchema,
  component: PersonalReviewsPage,
});
