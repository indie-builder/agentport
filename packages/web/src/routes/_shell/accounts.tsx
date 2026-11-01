import { createFileRoute } from '@tanstack/react-router';
import { AccountsPage } from '../../pages/accounts.js';
import { accountsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/accounts')({
  validateSearch: accountsSearchSchema,
  component: AccountsPage,
});
