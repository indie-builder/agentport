import { createFileRoute } from '@tanstack/react-router';
import { SecurityPage } from '../../pages/security.js';
import { securitySearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/security')({
  validateSearch: securitySearchSchema,
  component: SecurityPage,
});
