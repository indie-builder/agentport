import { createFileRoute } from '@tanstack/react-router';
import { RolesPage } from '../../pages/roles.js';

export const Route = createFileRoute('/_shell/roles')({
  component: RolesPage,
});
