import { createFileRoute } from '@tanstack/react-router';
import { MemoryPage } from '../../pages/memory.js';
import { memorySearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/memory')({
  validateSearch: memorySearchSchema,
  component: MemoryPage,
});
