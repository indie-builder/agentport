import { createFileRoute } from '@tanstack/react-router';
import { NotFoundPage } from '../../pages/not-found.js';

export const Route = createFileRoute('/_shell/$')({
  component: NotFoundPage,
});
