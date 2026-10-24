import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '../../pages/status.js';

export const Route = createFileRoute('/_shell/status')({
  component: StatusPage,
});
