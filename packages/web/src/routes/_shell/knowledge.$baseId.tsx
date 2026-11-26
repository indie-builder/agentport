import { createFileRoute } from '@tanstack/react-router';
import { KnowledgeDetailPage } from '../../pages/knowledge/detail/knowledge-detail-page.js';
import { knowledgeDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/knowledge/$baseId')({
  validateSearch: knowledgeDetailSearchSchema,
  component: KnowledgeDetailPage,
});
