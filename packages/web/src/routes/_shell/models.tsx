import { createFileRoute } from '@tanstack/react-router';
import { ModelsPage } from '../../pages/models.js';
import { modelsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/models')({
  validateSearch: modelsSearchSchema,
  component: ModelsPage,
});
