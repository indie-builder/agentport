import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SearchPage } from '../../pages/search.js';

const searchPageSchema = z.object({
  q: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_shell/search')({
  validateSearch: searchPageSchema,
  component: SearchPage,
});
