import { createFileRoute } from '@tanstack/react-router';
import { PersonalMemoryPage } from '../../pages/personal-memory.js';

export const Route = createFileRoute('/_shell/personal/memory')({
  component: PersonalMemoryPage,
});
