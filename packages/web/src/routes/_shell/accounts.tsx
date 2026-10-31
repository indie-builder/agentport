import { createFileRoute } from '@tanstack/react-router';
import { AccountsPage } from '../../pages/accounts.js';

export const Route = createFileRoute('/_shell/accounts')({
  component: AccountsPage,
});
