import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '../../pages/audit.js';
import { auditSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/audit')({
  validateSearch: auditSearchSchema,
  component: AuditPage,
});
