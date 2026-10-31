import { createFileRoute } from '@tanstack/react-router';
import { RolesPage } from '../../pages/roles.js';
import { rolesSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/roles')({
  validateSearch: rolesSearchSchema,
  component: RolesPage,
});
