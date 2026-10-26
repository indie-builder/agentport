import { createFileRoute } from '@tanstack/react-router';
import { KnowledgePage } from '../../pages/knowledge.js';
import { knowledgeSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/knowledge/')({
  validateSearch: knowledgeSearchSchema,
  component: KnowledgePage,
});
